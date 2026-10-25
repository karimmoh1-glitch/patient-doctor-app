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
}

/**
 * Delivers every reminder that came due in the last `lookbackMinutes`.
 *
 * Safe to run as often as you like, and safe if two runs overlap: each
 * (reminder, due time, channel) is claimed by inserting a row under a unique
 * key, and only the run that inserted it acts. That also means delivery is
 * at-most-once: a crash after claiming loses that one notification rather than
 * sending it twice.
 *
 * A reminder is a nudge, not a record. Nothing here marks a dose as taken or
 * missed, and nothing changes any schedule.
 */
export async function dispatchDueReminders(
  now: Date,
  opts: { lookbackMinutes?: number; emailEnabled?: boolean } = {},
): Promise<DispatchResult> {
  const lookback = opts.lookbackMinutes ?? 180;
  const from = new Date(now.getTime() - lookback * 60_000);
  const result: DispatchResult = { considered: 0, due: 0, inApp: 0, emailSent: 0, emailFailed: 0 };

  const reminders = await storage.getDispatchableReminders();
  result.considered = reminders.length;

  for (const { reminder, medicationName, email, language } of reminders) {
    const due = occurrencesInWindow(reminder, from, now);
    for (const dueAt of due) {
      result.due++;
      const inAppId = await storage.claimReminderDelivery(reminder.id, dueAt, "in_app");
      if (inAppId) {
        const clock = DateTime.fromJSDate(dueAt, { zone: reminder.timezone }).toFormat("HH:mm");
        await storage.createNotification({
          userId: reminder.patientUserId,
          kind: "reminder.due",
          // The medicine's name is stored only if the patient chose to show it.
          params: reminder.showMedicationName ? { time: clock, medicationName } : { time: clock },
          link: "/medications",
        });
        await storage.finishReminderDelivery(inAppId, "sent");
        result.inApp++;
      }

      if (reminder.emailEnabled && opts.emailEnabled) {
        const emailId = await storage.claimReminderDelivery(reminder.id, dueAt, "email");
        if (emailId) {
          const text = MESSAGES[language] ?? MESSAGES.en;
          const body = reminder.showMedicationName ? text.bodyNamed(medicationName) : text.body;
          const ok = await sendEmail({ to: email, subject: text.subject, body, html: `<p style="font-size:16px;line-height:1.6">${escapeHtml(body)}</p>` });
          await storage.finishReminderDelivery(emailId, ok ? "sent" : "failed", ok ? undefined : "send_failed");
          if (ok) result.emailSent++;
          else result.emailFailed++;
        }
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

/** Whether automatic delivery is really running: "active" only if a run happened recently. */
export async function reminderDeliveryStatus(now = new Date()): Promise<"active" | "stale" | "not_configured"> {
  if (!process.env.CRON_SECRET) return "not_configured";
  const run = await storage.getJobRun(REMINDER_JOB);
  if (!run) return "stale";
  return now.getTime() - run.lastRunAt.getTime() <= 2 * 60 * 60_000 ? "active" : "stale";
}

export { dateKeyInZone };
