import { sendEmail } from "./emailService";

/**
 * Outbound signals that something is wrong (or that everything is fine), sent
 * to systems that are independent of Avela and of whatever calls the scheduler.
 * Only a failing run can tell us it failed; a run that never happens can only be
 * noticed by something waiting for a signal that stops arriving. That is the
 * heartbeat: point it at a dead-man's-switch monitor (Healthchecks.io, Better
 * Stack, Cronitor, Uptime Kuma "push", ...) that alerts when pings stop.
 *
 * Nothing here ever carries a name, an address, a medicine or a secret.
 */

const HEARTBEAT_TIMEOUT_MS = 5_000;

/** Pings SCHEDULER_HEARTBEAT_URL after a successful run, or `<url>/fail` after a failed one. Never throws. */
export async function pingHeartbeat(ok: boolean): Promise<"sent" | "not_configured" | "failed"> {
  const base = process.env.SCHEDULER_HEARTBEAT_URL?.trim();
  if (!base) return "not_configured";
  let url: URL;
  try {
    url = new URL(ok ? base : `${base.replace(/\/+$/, "")}/fail`);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) return "failed";
  } catch {
    console.error("[scheduler] heartbeat url is invalid");
    return "failed";
  }
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS), redirect: "error" });
    if (!res.ok) {
      console.error(`[scheduler] heartbeat answered ${res.status}`);
      return "failed";
    }
    return "sent";
  } catch (err: any) {
    console.error("[scheduler] heartbeat failed:", err?.name || "Error");
    return "failed";
  }
}

/** Emails OPS_ALERT_EMAIL (if set and an email provider is configured). Returns whether the provider accepted it. */
export async function emailOpsAlert(subject: string, lines: string[]): Promise<boolean> {
  const to = process.env.OPS_ALERT_EMAIL?.trim();
  if (!to) return false;
  return sendEmail({ to, subject: `[Avela] ${subject}`, body: lines.join("\n"), purpose: "ops_alert" });
}

/**
 * Failure e-mails are sent when a failure streak begins and then once an hour at
 * most (a five-minute scheduler failing continuously would otherwise send 12 an
 * hour). A recovery e-mail follows the first good run.
 */
export function shouldAlertOnFailure(consecutiveFailures: number): boolean {
  return consecutiveFailures === 1 || (consecutiveFailures > 1 && consecutiveFailures % 12 === 0);
}
