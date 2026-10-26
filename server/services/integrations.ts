import { sql } from "drizzle-orm";
import { db } from "../db";
import { runAsSystem } from "../dbContext";
import { videoAvailable } from "./videoService";

/**
 * What each external service is really doing, computed from our own records. Nothing is "verified" because a key is present:
 * verification is evidence that a real provider call or a signed provider event happened, and the facts that prove it are
 * returned with the status so a reader can judge them.
 *
 *   verified              a real call or event succeeded and is recorded
 *   configured_unverified settings present, nothing proves it works
 *   not_configured        settings absent
 *   unavailable           nothing to configure: not built, so it cannot be turned on
 *   failed                the most recent real attempts failed
 */
export type IntegrationStatus = "verified" | "configured_unverified" | "not_configured" | "unavailable" | "failed";

export interface Integration {
  id: string;
  status: IntegrationStatus;
  /** Numbers and timestamps that justify the status. Never addresses, content or secrets. */
  facts: Record<string, number | string | null>;
}

const num = async (query: ReturnType<typeof sql>): Promise<number> => {
  const res = await db.execute(query);
  return Number((res.rows[0] as any)?.n ?? 0);
};

const DEPENDABLE_DAYS = 7;

export async function integrationRegistry(env: NodeJS.ProcessEnv = process.env): Promise<Integration[]> {
  return runAsSystem(async () => {
    const out: Integration[] = [];

    // ---- E-mail
    const sent = await num(sql`SELECT count(*)::int AS n FROM email_deliveries`);
    const delivered = await num(sql`SELECT count(*)::int AS n FROM email_deliveries WHERE status = 'delivered'`);
    const lastFive = await db.execute(sql`SELECT status FROM email_deliveries ORDER BY accepted_at DESC LIMIT 5`);
    const recentBad = lastFive.rows.length >= 3 && lastFive.rows.every((r: any) => ["bounced", "failed"].includes(r.status));
    const emailKey = !!env.RESEND_API_KEY;
    out.push({
      id: "email",
      status: !emailKey ? "not_configured" : recentBad ? "failed" : delivered > 0 ? "verified" : "configured_unverified",
      facts: { accepted: sent, delivered },
    });

    const events = await num(sql`SELECT count(*)::int AS n FROM email_webhook_events`);
    out.push({
      id: "email_receipts",
      status: !env.RESEND_WEBHOOK_SECRET ? "not_configured" : events > 0 ? "verified" : "configured_unverified",
      facts: { eventsReceived: events },
    });

    // ---- Scheduler caller: only a non-GitHub caller seen on enough distinct days counts as dependable.
    const calls24 = await num(sql`SELECT count(*)::int AS n FROM job_run_history WHERE job = 'reminders' AND outcome <> 'skipped_overlap' AND started_at > now() - interval '24 hours'`);
    // A day counts only if a dependable caller made at least 90% of the 288 expected 5-minute calls successfully.
    const dependableDays = await num(sql`SELECT count(*)::int AS n FROM (
      SELECT date_trunc('day', started_at) AS d FROM job_run_history
      WHERE job = 'reminders' AND outcome = 'ok' AND source NOT IN ('github-actions','unknown') AND started_at > now() - interval '14 days'
      GROUP BY 1 HAVING count(*) >= ${Math.ceil(0.9 * 288)}) days`);
    const lastOk = await db.execute(sql`SELECT last_success_at, consecutive_failures FROM job_runs WHERE job = 'reminders'`);
    const jr = lastOk.rows[0] as any;
    out.push({
      id: "scheduler",
      status: !env.CRON_SECRET ? "not_configured" : (jr?.consecutive_failures ?? 0) >= 3 ? "failed" : dependableDays >= DEPENDABLE_DAYS ? "verified" : "configured_unverified",
      facts: { callsLast24h: calls24, daysWithDependableCaller: dependableDays, daysRequired: DEPENDABLE_DAYS, lastSuccessAt: jr?.last_success_at ? new Date(jr.last_success_at).toISOString() : null },
    });

    // ---- Monitoring: only configuration can be known from here; whether an outside monitor really alerts is proven by a drill.
    out.push({ id: "heartbeat", status: env.SCHEDULER_HEARTBEAT_URL ? "configured_unverified" : "not_configured", facts: {} });
    out.push({ id: "ops_alert", status: env.OPS_ALERT_EMAIL && emailKey ? "configured_unverified" : "not_configured", facts: {} });

    // ---- Not built: no setting turns these on.
    out.push({ id: "video", status: videoAvailable() ? "configured_unverified" : "unavailable", facts: {} });
    for (const id of ["sms", "push", "pharmacy", "ehr", "credential_registry", "sso"]) out.push({ id, status: "unavailable", facts: {} });
    return out;
  });
}
