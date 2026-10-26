import crypto from "crypto";
import { storage } from "../storage";
import { emailOpsAlert, pingHeartbeat, shouldAlertOnFailure } from "./opsAlerts";

/**
 * Wraps a scheduled job so that, however it is called:
 *
 * - only one run executes at a time (a lease in the database; a crashed run's
 *   lease expires by itself), so overlapping callers cannot race each other or
 *   overwrite each other's outcome;
 * - it has a time budget well inside the host's function limit, and stops
 *   cleanly, reporting `truncated`, instead of being killed half way;
 * - every step is attempted even if an earlier one fails, but ANY failed step
 *   makes the whole run a failure, so a broken run can never be reported healthy;
 * - the outcome is recorded once, only by the run that holds the lease;
 * - every call leaves a history row, so "how often does it really run, and who
 *   calls it?" is answered from data;
 * - one structured log line is written per run, with counts only.
 */

/** Stop starting new work after this long. Vercel's function limit here is 30 s. */
export const SCHEDULER_BUDGET_MS = Number(process.env.SCHEDULER_BUDGET_MS) || 20_000;
/** A lease outlives the budget plus the final writes; a dead run frees the job after this. */
const LEASE_MS = Math.max(Number(process.env.SCHEDULER_LEASE_MS) || 90_000, SCHEDULER_BUDGET_MS + 15_000);
const HISTORY_DAYS = 14;

export interface StepReport {
  /** Counts only. Never names, addresses or medicines. */
  counts: Record<string, number | boolean>;
  /** Failures inside the step that did not stop it (for example one reminder that could not be processed). */
  errors?: number;
}
export interface JobContext {
  runId: string;
  /** Epoch ms after which no new work should be started. */
  deadline: number;
}
export type JobStep = { name: string; run: (ctx: JobContext) => Promise<StepReport> };

export type RunSummary =
  | { status: "ok" | "failed"; runId: string; durationMs: number; result: Record<string, unknown>; error?: string; consecutiveFailures: number }
  | { status: "skipped"; runId: string; reason: "already_running" }
  | { status: "superseded"; runId: string; durationMs: number };

/**
 * Callers whose identity the SERVER establishes, by which secret they presented, not by anything they say. Each has its own
 * secret (the environment variable named here), so a caller holding only the general CRON_SECRET (a GitHub workflow, a person
 * testing) cannot pass as one of these however it labels itself. Only these count as a dependable scheduler.
 */
export const ATTESTED_SCHEDULER_SOURCES: Record<string, string> = { CRON_SECRET_CLOUDFLARE: "cloudflare-worker" };
export const attestedSourceNames = (): string[] => Object.values(ATTESTED_SCHEDULER_SOURCES);

/**
 * The label recorded for a call. `attested` is set by the endpoint when the caller proved who it is; otherwise the caller names
 * itself, which is a label for the history and never a credential, and a name that belongs to an attested caller is recorded as
 * a claim (`claimed:cloudflare-worker`), so it can never be mistaken for the real thing.
 */
export function schedulerSource(headers: { get(name: string): string | undefined }, attested?: string | null): string {
  if (attested) return attested;
  const named = headers.get("x-avela-scheduler")?.toLowerCase();
  if (named && /^[a-z0-9][a-z0-9-]{0,31}$/.test(named)) return attestedSourceNames().includes(named) ? `claimed:${named}` : named;
  if (headers.get("user-agent")?.toLowerCase().startsWith("vercel-cron")) return "vercel-cron";
  return "unknown";
}

export async function runScheduledJob(opts: {
  job: string;
  source: string;
  steps: JobStep[];
  now?: Date;
  budgetMs?: number;
}): Promise<RunSummary> {
  const started = opts.now ?? new Date();
  const t0 = Date.now();
  const runId = crypto.randomUUID();
  const budget = opts.budgetMs ?? SCHEDULER_BUDGET_MS;

  const got = await storage.acquireJobLease(opts.job, runId, started, LEASE_MS);
  if (!got) {
    await storage.startJobRunHistory({ job: opts.job, runId, source: opts.source, startedAt: started, outcome: "skipped_overlap" }).catch(() => {});
    log({ event: "scheduler.run", job: opts.job, runId, source: opts.source, outcome: "skipped_overlap" });
    return { status: "skipped", runId, reason: "already_running" };
  }
  await storage.startJobRunHistory({ job: opts.job, runId, source: opts.source, startedAt: started }).catch(() => {});
  const previousFailures = (await storage.getJobRun(opts.job).catch(() => undefined))?.consecutiveFailures ?? 0;

  const ctx: JobContext = { runId, deadline: t0 + budget };
  const result: Record<string, unknown> = {};
  let errors = 0;
  let firstError: string | undefined;
  let truncated = false;

  for (const step of opts.steps) {
    try {
      const report = await step.run(ctx);
      Object.assign(result, report.counts);
      if (report.counts.truncated) truncated = true;
      if (report.errors) {
        errors += report.errors;
        firstError ??= `${step.name}_item_errors`;
      }
    } catch (err: any) {
      errors++;
      firstError ??= `${step.name}:${String(err?.name || "Error").slice(0, 40)}`;
      // The kind only: a message can carry a connection string or a name.
      console.error(`[scheduler] step ${step.name} failed:`, err?.name || "Error");
    }
  }
  result.errors = errors;
  result.truncated = truncated;

  const finished = new Date();
  const durationMs = Date.now() - t0;
  const ok = errors === 0;
  const outcome = ok ? ({ ok: true } as const) : ({ ok: false, error: (firstError ?? "failed").slice(0, 60) } as const);
  const recorded = await storage.finishJobRun(opts.job, runId, finished, result, outcome).catch((err: any) => {
    console.error("[scheduler] could not record the outcome:", err?.name || "Error");
    return null;
  });

  if (recorded === false) {
    // Our lease expired and another run took over: leave its record alone.
    await storage.finishJobRunHistory(opts.job, runId, { finishedAt: finished, outcome: "superseded", durationMs, result }).catch(() => {});
    log({ event: "scheduler.run", job: opts.job, runId, source: opts.source, outcome: "superseded", durationMs });
    return { status: "superseded", runId, durationMs };
  }
  if (recorded === null) {
    // We could not write the outcome, so the job must not look healthy: nothing was recorded as a success.
    await storage.finishJobRunHistory(opts.job, runId, { finishedAt: finished, outcome: "failed", durationMs, error: "record_failed", result }).catch(() => {});
    log({ event: "scheduler.run", job: opts.job, runId, source: opts.source, outcome: "failed", durationMs, error: "record_failed" });
    return { status: "failed", runId, durationMs, result, error: "record_failed", consecutiveFailures: 0 };
  }

  await storage.finishJobRunHistory(opts.job, runId, { finishedAt: finished, outcome: ok ? "ok" : "failed", durationMs, error: ok ? undefined : outcome.error, result }).catch(() => {});
  await storage.pruneJobRunHistory(opts.job, new Date(finished.getTime() - HISTORY_DAYS * 86_400_000)).catch(() => {});

  const after = await storage.getJobRun(opts.job).catch(() => undefined);
  const consecutiveFailures = after?.consecutiveFailures ?? (ok ? 0 : 1);
  log({ event: "scheduler.run", job: opts.job, runId, source: opts.source, outcome: ok ? "ok" : "failed", durationMs, ...flatten(result), ...(ok ? {} : { error: outcome.error, consecutiveFailures }) });

  // Signals to systems outside Avela. None of these can change the run's outcome.
  await pingHeartbeat(ok);
  if (!ok && shouldAlertOnFailure(consecutiveFailures)) {
    await emailOpsAlert(`Reminder scheduler is failing (${consecutiveFailures} in a row)`, [
      `Job: ${opts.job}`,
      `Failure kind: ${outcome.error}`,
      `Consecutive failures: ${consecutiveFailures}`,
      "Open /admin/activity for counts. No patient information is included in this message.",
    ]).catch(() => {});
  }
  if (ok && previousFailures > 0) {
    await emailOpsAlert("Reminder scheduler recovered", [`Job: ${opts.job}`, `It succeeded after ${previousFailures} failed run(s).`]).catch(() => {});
  }

  return { status: ok ? "ok" : "failed", runId, durationMs, result, error: ok ? undefined : outcome.error, consecutiveFailures };
}

function flatten(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  return out;
}

function log(line: Record<string, unknown>) {
  console.log(JSON.stringify(line));
}
