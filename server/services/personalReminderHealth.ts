import { sql } from "drizzle-orm";
import { db } from "../db";
import { withScope } from "../dbContext";
import { overdueCount } from "./personalReminders";

/** Counts only, for the operations screen: what happened to personal reminders in the last day. Names no one and no reminder. */
export async function personalReminderHealth(now = new Date()) {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const rows = await withScope("ops", () =>
    db.execute(sql`SELECT channel, status, count(*)::int AS n FROM personal_reminder_deliveries WHERE due_at > ${since} GROUP BY channel, status`),
  );
  const count = (channel: string, status: string) => Number((rows.rows as any[]).find((r) => r.channel === channel && r.status === status)?.n ?? 0);
  const active = await withScope("ops", () => db.execute(sql`SELECT count(*)::int AS n FROM personal_reminders WHERE status = 'active'`));
  return {
    activeReminders: Number((active.rows[0] as any)?.n ?? 0),
    last24h: {
      inAppDelivered: count("in_app", "sent"),
      emailAccepted: count("email", "sent"),
      emailFailed: count("email", "failed"),
      emailHeldForQuietHours: count("email", "suppressed"),
      overdue: await overdueCount(now),
    },
  };
}
