import { DateTime } from "luxon";
import { storage } from "../storage";
import { sendEmail } from "./emailService";
import { dateKeyInZone } from "../lib/localTime";

export interface ReminderSchedule {
  times: string[];
  weekdays: number[]; // 0 = Sunday
  timezone: string;
  startDate: string; // YYYY-MM-DD in `timezone`
  endDate: string | null;
}

/**
 * Every instant in (from, to] at which this reminder is due.
 *
 * Times are wall-clock times in the reminder's own zone, so "08:00" stays
 * 08:00 on the patient's clock across daylight-saving changes. A time that
 * doesn't exist on a spring-forward day fires at the next valid minute.
 */
export function occurrencesInWindow(schedule: ReminderSchedule, from: Date, to: Date): Date[] {
  const { timezone: zone } = schedule;
  const first = DateTime.fromJSDate(from, { zone }).startOf("day");
  const last = DateTime.fromJSDate(to, { zone }).startOf("day");
  const out: Date[] = [];
  for (let day = first; day <= last; day = day.plus({ days: 1 })) {
    const key = day.toFormat("yyyy-LL-dd");
    if (key < schedule.startDate) continue;
    if (schedule.endDate && key > schedule.endDate) continue;
    if (!schedule.weekdays.includes(day.weekday % 7)) continue; // luxon: 1 = Monday … 7 = Sunday
    for (const time of schedule.times) {
      const [hour, minute] = time.split(":").map(Number);
      const due = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour, minute }, { zone });
      if (!due.isValid) continue;
      const instant = due.toJSDate();
      if (instant > from && instant <= to) out.push(instant);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** The next instant after `after` at which the reminder is due, within a year. */
export function nextOccurrence(schedule: ReminderSchedule, after: Date): Date | null {
  let from = after;
  for (let i = 0; i < 53; i++) {
    const to = new Date(from.getTime() + 7 * 86_400_000);
    const found = occurrencesInWindow(schedule, from, to);
    if (found.length) return found[0];
    from = to;
  }
  return null;
}

const MESSAGES: Record<string, { subject: string; body: string; bodyNamed: (name: string) => string }> = {
  en: {
    subject: "Reminder from Avela",
    body: "It's time for one of your scheduled medicines. Open Avela to see which.",
    bodyNamed: (n) => `It's time for your scheduled medicine: ${n}.`,
  },
  ar: {
    subject: "تذكير من أفيلا",
    body: "حان وقت أحد أدويتك المجدولة. افتح أفيلا لمعرفة أيّها.",
    bodyNamed: (n) => `حان وقت دوائك المجدول: ${n}.`,
  },
};

export interface DispatchResult {
  considered: number;
  due: number;
  inApp: number;
  emailSent: number;
  emailFailed: number;
  emailRetried: number;
}

/** How far back a run still delivers a reminder. Anything older is reported as overdue, never sent late. */
export const LOOKBACK_MINUTES = Number(process.env.REMINDER_LOOKBACK_MINUTES) || 180;
const MAX_EMAIL_ATTEMPTS = 3;
const ABANDONED_AFTER_MINUTES = 10;

/**
 * Delivers every reminder that came due in the last `lookbackMinutes`.
 *
 * Safe to run as often as you like, and safe if two runs overlap:
 * - the in-app notice and its delivery record are written in ONE transaction
 *   under a unique key (reminder, due instant, channel), so exactly one run
 *   creates them and a crash can never leave one without the other;
 * - an email is claimed under the same key before it is sent; a send that fails
 *   (or a run that died mid-send) is retried by a later run, at most three
 *   attempts in total, and only while the reminder is still inside the lookback
 *   window. Nothing is ever sent after that, because a "time for your medicine"
 *   hours late is worse than none.
 *
 * "sent" for email means the email provider accepted the message. Avela cannot
 * see whether it reached an inbox, and never says it did.
 *
 * A reminder is a nudge, not a record. Nothing here marks a dose as taken or
 * missed, and nothing changes any schedule.
 */
export async function dispatchDueReminders(
  now: Date,
  opts: { lookbackMinutes?: number; emailEnabled?: boolean } = {},
): Promise<DispatchResult> {
  const lookback = opts.lookbackMinutes ?? LOOKBACK_MINUTES;
  const from = new Date(now.getTime() - lookback * 60_000);
  const result: DispatchResult = { considered: 0, due: 0, inApp: 0, emailSent: 0, emailFailed: 0, emailRetried: 0 };

  const reminders = await storage.getDispatchableReminders();
  result.considered = reminders.length;

  for (const { reminder, medicationName, email, language } of reminders) {
    for (const dueAt of occurrencesInWindow(reminder, from, now)) {
      result.due++;
      const clock = DateTime.fromJSDate(dueAt, { zone: reminder.timezone }).toFormat("HH:mm");
      const created = await storage.deliverInApp(reminder.id, dueAt, {
        userId: reminder.patientUserId,
        kind: "reminder.due",
        // The medicine's name is stored only if the patient chose to show it.
        params: reminder.showMedicationName ? { time: clock, medicationName } : { time: clock },
        link: "/medications",
      });
      if (created) result.inApp++;

      if (reminder.emailEnabled && opts.emailEnabled) {
        let deliveryId = await storage.claimReminderDelivery(reminder.id, dueAt, "email");
        let retry = false;
        if (!deliveryId) {
          deliveryId = await storage.retryReminderDelivery(reminder.id, dueAt, "email", MAX_EMAIL_ATTEMPTS, ABANDONED_AFTER_MINUTES);
          retry = !!deliveryId;
        }
        if (!deliveryId) continue;
        if (retry) result.emailRetried++;
        const text = MESSAGES[language] ?? MESSAGES.en;
        const body = reminder.showMedicationName ? text.bodyNamed(medicationName) : text.body;
        let ok = false;
        try {
          ok = await sendEmail({ to: email, subject: text.subject, body, html: `<p style="font-size:16px;line-height:1.6">${escapeHtml(body)}</p>` });
        } catch (err: any) {
          console.error("[reminders] email send threw:", err?.name);
        }
        await storage.finishReminderDelivery(deliveryId, ok ? "sent" : "failed", ok ? undefined : "provider_rejected_or_unavailable");
        if (ok) result.emailSent++;
        else result.emailFailed++;
      }
    }
  }
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * One "your visit is coming up" notice per confirmed appointment in the next
 * 24 hours. The marker column is claimed in a single UPDATE, so overlapping
 * runs cannot send it twice. The notice carries only a kind, the doctor's
 * name and the time: nothing about why the visit is happening.
 */
export async function dispatchAppointmentReminders(now: Date, hours = 24): Promise<number> {
  const due = await storage.claimDueAppointmentReminders(now, hours);
  for (const a of due) {
    const doctor = await storage.getDoctorProfile(a.doctorProfileId);
    await storage.createNotification({
      userId: a.patientUserId,
      kind: "appointment.soon",
      params: { doctorName: doctor?.name ?? "", when: new Date(a.scheduledAt).toISOString() },
      link: `/appointments/${a.id}`,
    });
  }
  return due.length;
}

export const REMINDER_JOB = "reminders";

/** A run counts as recent for this long. The scheduler is expected every 5 minutes; three missed runs is a problem. */
export const MAX_RUN_AGE_MINUTES = Number(process.env.REMINDER_MAX_RUN_AGE_MINUTES) || 20;

export type DeliveryStatus = "active" | "stale" | "failing" | "not_configured";

/**
 * Whether automatic delivery is REALLY happening: only "active" if the last
 * run finished successfully a few minutes ago. A saved reminder with nothing
 * delivering it is never described as working.
 */
export async function reminderDeliveryStatus(now = new Date()): Promise<DeliveryStatus> {
  if (!process.env.CRON_SECRET) return "not_configured";
  const run = await storage.getJobRun(REMINDER_JOB);
  if (!run) return "stale";
  // The latest attempt failed: something is wrong right now, even if an earlier run was fine.
  if (run.consecutiveFailures > 0) return "failing";
  if (!run.lastSuccessAt) return "stale";
  return now.getTime() - run.lastSuccessAt.getTime() <= MAX_RUN_AGE_MINUTES * 60_000 ? "active" : "stale";
}

export interface ReminderHealth {
  status: DeliveryStatus;
  job: { lastRunAt: string | null; lastSuccessAt: string | null; minutesSinceSuccess: number | null; lastError: string | null; consecutiveFailures: number; lastResult: Record<string, unknown> | null };
  last24h: {
    scheduled: number; // reminder times that fell due
    delivered: number; // in-app notices created
    emailAccepted: number; // accepted by the email provider (not "reached an inbox")
    emailFailed: number; // failed, will be retried while inside the window
    emailGaveUp: number; // failed after the last attempt
    stuckPending: number; // claimed but never finished
    overdue: number; // came due, passed the lookback window, and were never delivered
  };
  nextHour: number;
}

/** Everything an operator needs to answer "are reminders actually going out?". Counts only: no names, no medicines. */
export async function reminderHealth(now = new Date()): Promise<ReminderHealth> {
  const run = await storage.getJobRun(REMINDER_JOB);
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const [reminders, deliveries] = await Promise.all([storage.getAllEnabledReminders(), storage.getDeliveriesSince(since)]);
  const inApp = new Set(deliveries.filter((d) => d.channel === "in_app").map((d) => `${d.reminderId}|${d.dueAt.getTime()}`));
  const cutoff = new Date(now.getTime() - LOOKBACK_MINUTES * 60_000);

  let scheduled = 0;
  let overdue = 0;
  let nextHour = 0;
  for (const r of reminders) {
    for (const due of occurrencesInWindow(r, since, now)) {
      scheduled++;
      if (due < cutoff && !inApp.has(`${r.id}|${due.getTime()}`)) overdue++;
    }
    nextHour += occurrencesInWindow(r, now, new Date(now.getTime() + 3_600_000)).length;
  }
  const email = deliveries.filter((d) => d.channel === "email");
  return {
    status: await reminderDeliveryStatus(now),
    job: {
      lastRunAt: run?.lastRunAt.toISOString() ?? null,
      lastSuccessAt: run?.lastSuccessAt?.toISOString() ?? null,
      minutesSinceSuccess: run?.lastSuccessAt ? Math.round((now.getTime() - run.lastSuccessAt.getTime()) / 60_000) : null,
      lastError: run?.lastError ?? null,
      consecutiveFailures: run?.consecutiveFailures ?? 0,
      lastResult: run?.lastResult ?? null,
    },
    last24h: {
      scheduled,
      delivered: deliveries.filter((d) => d.channel === "in_app" && d.status === "sent").length,
      emailAccepted: email.filter((d) => d.status === "sent").length,
      emailFailed: email.filter((d) => d.status === "failed" && d.attempts < MAX_EMAIL_ATTEMPTS).length,
      emailGaveUp: email.filter((d) => d.status === "failed" && d.attempts >= MAX_EMAIL_ATTEMPTS).length,
      stuckPending: email.filter((d) => d.status === "pending" && now.getTime() - d.updatedAt.getTime() > ABANDONED_AFTER_MINUTES * 60_000).length,
      overdue,
    },
    nextHour,
  };
}

export { dateKeyInZone };
