import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db } from "../db";
import { runAsSystem } from "../dbContext";
import { fixtureAccountsAllowed } from "../config";
import { healthEntries, notifications, personalReminderDeliveries, personalReminders, users, PERSONAL_KINDS, type PersonalKind, type PersonalReminder } from "@shared/schema";
import {
  inQuietHours, nextRenewal, personalOccurrences, renewalOccurrences,
  type PersonalSchedule, type Recurrence, type RenewalInterval, type RenewalSchedule,
} from "../lib/personalSchedule";
import { isValidZone } from "../lib/localTime";
import { sendEmail } from "./emailService";

/**
 * Reminders a person sets for themselves (medicines they listed, appointments, tasks, bills, subscriptions).
 *
 * A reminder is a nudge, not a record: it never says a dose was taken, a bill was paid or a subscription cancelled, it charges
 * nothing, and it changes no medical instruction. What it says about delivery is exactly what happened:
 *   in-app  "sent"      a notice was placed in the person's Avela inbox
 *   e-mail  "sent"      the e-mail provider accepted the message (Avela cannot see an inbox)
 *   e-mail  "suppressed" quiet hours held it back, for good (a late reminder is worse than none)
 * E-mail is generic by default: it says there is a reminder, not what it is, unless the person chose to include the title.
 */

export const MAX_ACTIVE_PER_PERSON = 100;
export const LOOKBACK_MINUTES = Number(process.env.REMINDER_LOOKBACK_MINUTES) || 180;
const MAX_EMAIL_ATTEMPTS = 3;
const ABANDONED_AFTER_MINUTES = 10;

// ---------------------------------------------------------------------------------------------- input

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:00");
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date")
  .refine((v) => DateTime.fromISO(v).isValid, "That date doesn't exist")
  // A reminder concerns now and the years ahead; a date outside this range is a typo.
  .refine((v) => v >= "2000-01-01" && v <= `${new Date().getUTCFullYear() + 10}-12-31`, "That date is too far away");
const zone = z.string().refine((v) => isValidZone(v), "That time zone isn't valid");

const common = {
  title: z.string().trim().min(1, "Give it a name").max(120),
  notes: z.string().trim().max(500).nullable().optional(),
  timezone: zone.optional(),
  emailEnabled: z.boolean().default(false),
  showTitleInEmail: z.boolean().default(false),
  quietStart: hhmm.nullable().optional(),
  quietEnd: hhmm.nullable().optional(),
};

const repeating = z.object({
  ...common,
  kind: z.enum(["medication", "appointment", "task", "other"]),
  recurrence: z.enum(["once", "daily", "weekly", "monthly", "yearly"]),
  times: z.array(hhmm).min(1, "Choose at least one time").max(6).refine((t) => new Set(t).size === t.length, "Each time must be different"),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  anchorDate: day,
  endDate: day.nullable().optional(),
  healthEntryId: z.string().max(64).nullable().optional(),
}).strict();

const renewing = z.object({
  ...common,
  kind: z.enum(["bill", "subscription"]),
  renewalDate: day,
  renewalInterval: z.enum(["weekly", "monthly", "quarterly", "yearly"]).nullable().optional(),
  offsetsDays: z.array(z.number().int().min(0).max(60)).min(1, "Choose when to be reminded").max(5).refine((t) => new Set(t).size === t.length, "Each reminder day must be different"),
  cancelByDate: day.nullable().optional(),
  time: hhmm.default("09:00"),
  endDate: day.nullable().optional(),
  amountMinor: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code like EGP or USD").nullable().optional(),
}).strict();

export const reminderInput = z.union([repeating, renewing]).superRefine((v, ctx) => {
  if ((v.quietStart && !v.quietEnd) || (!v.quietStart && v.quietEnd)) ctx.addIssue({ code: "custom", message: "Give both ends of quiet hours, or neither" });
  if ("anchorDate" in v && v.endDate && v.endDate < v.anchorDate) ctx.addIssue({ code: "custom", message: "The end date is before the start" });
  if ("recurrence" in v && v.recurrence === "weekly" && v.weekdays.length === 7) ctx.addIssue({ code: "custom", message: "Every day of the week is a daily reminder. Choose \"Every day\", or pick fewer days." });
  if ("renewalDate" in v) {
    if (v.cancelByDate && v.cancelByDate > v.renewalDate && v.renewalInterval == null) ctx.addIssue({ code: "custom", message: "The cancellation deadline is after the renewal" });
    if ((v.amountMinor == null) !== (v.currency == null)) ctx.addIssue({ code: "custom", message: "Give both the amount and the currency, or neither" });
  }
});
export type ReminderInput = z.infer<typeof reminderInput>;

export class ReminderError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------- schedule glue

const isRenewal = (r: Pick<PersonalReminder, "kind">) => r.kind === "bill" || r.kind === "subscription";

export interface Occurrence { instant: Date; occurrence: "due" | "renewal" | "cancel_by"; offsetDays: number | null }

export function occurrencesOf(r: PersonalReminder, from: Date, to: Date): Occurrence[] {
  const out: Occurrence[] = [];
  if (isRenewal(r)) {
    const s: RenewalSchedule = {
      renewalDate: r.renewalDate!, interval: (r.renewalInterval as RenewalInterval | null) ?? null, offsetsDays: r.offsetsDays, cancelByDate: r.cancelByDate,
      time: r.times[0] ?? "09:00", timezone: r.timezone, endDate: r.endDate,
    };
    for (const o of renewalOccurrences(s, from, to)) {
      // A deadline and a renewal can fall at the same instant: a minute apart keeps each delivery under its own key.
      const instant = o.kind === "cancel_by" ? new Date(o.instant.getTime() + 60_000) : o.instant;
      if (instant > from && instant <= to) out.push({ instant, occurrence: o.kind, offsetDays: o.offsetDays });
    }
  } else {
    const s: PersonalSchedule = { recurrence: r.recurrence as Recurrence, times: r.times, weekdays: r.weekdays, timezone: r.timezone, anchorDate: r.anchorDate!, startDate: r.startDate, endDate: r.endDate };
    for (const instant of personalOccurrences(s, from, to)) out.push({ instant, occurrence: "due", offsetDays: null });
  }
  // A snooze is one extra occurrence at the moment the person chose.
  if (r.snoozedUntil && r.snoozedUntil > from && r.snoozedUntil <= to) out.push({ instant: r.snoozedUntil, occurrence: "due", offsetDays: null });
  out.sort((a, b) => a.instant.getTime() - b.instant.getTime());
  // Each delivery is recorded under (reminder, instant, channel). Two occurrences at the same instant (a deadline and a renewal, or two
  // renewals a week apart with offsets 0 and 7) would lose one notice, so later ones are moved a minute on, always the same way.
  for (let i = 1; i < out.length; i++) {
    if (out[i].instant.getTime() <= out[i - 1].instant.getTime()) out[i] = { ...out[i], instant: new Date(out[i - 1].instant.getTime() + 60_000) };
  }
  return out;
}

/** The next occurrence after `after`, looking up to 14 months ahead. */
export function nextDueAt(r: PersonalReminder, after: Date): Occurrence | null {
  if (r.status !== "active") return null;
  let from = after;
  const horizon = after.getTime() + 430 * 86_400_000;
  while (from.getTime() < horizon) {
    const to = new Date(from.getTime() + 60 * 86_400_000);
    const found = occurrencesOf(r, from, to);
    if (found.length) return found[0];
    from = to;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- CRUD (as the signed-in person)

function toRow(patientUserId: string, input: ReminderInput, fallbackZone: string) {
  const timezone = input.timezone ?? fallbackZone;
  const base = {
    patientUserId, kind: input.kind, title: input.title, notes: input.notes ?? null, timezone,
    emailEnabled: input.emailEnabled, showTitleInEmail: input.showTitleInEmail, quietStart: input.quietStart ?? null, quietEnd: input.quietEnd ?? null,
    updatedAt: new Date(),
  };
  if ("renewalDate" in input) {
    return {
      ...base, recurrence: null, times: [input.time], weekdays: [0, 1, 2, 3, 4, 5, 6], anchorDate: null, startDate: null, endDate: input.endDate ?? null,
      renewalDate: input.renewalDate, renewalInterval: input.renewalInterval ?? null, offsetsDays: [...input.offsetsDays].sort((a, b) => b - a), cancelByDate: input.cancelByDate ?? null,
      amountMinor: input.amountMinor ?? null, currency: input.currency ?? null, healthEntryId: null,
    };
  }
  return {
    ...base, recurrence: input.recurrence, times: [...input.times].sort(), weekdays: input.weekdays, anchorDate: input.anchorDate, startDate: null, endDate: input.endDate ?? null,
    renewalDate: null, renewalInterval: null, offsetsDays: [3], cancelByDate: null, amountMinor: null, currency: null, healthEntryId: input.kind === "medication" ? input.healthEntryId ?? null : null,
  };
}

async function checkHealthEntry(patientUserId: string, id: string | null | undefined) {
  if (!id) return;
  const [e] = await db.select({ id: healthEntries.id }).from(healthEntries).where(and(eq(healthEntries.id, id), eq(healthEntries.patientUserId, patientUserId), eq(healthEntries.kind, "medication"), eq(healthEntries.status, "active")));
  if (!e) throw new ReminderError(404, "not_found", "That medicine is not in your list.");
}

async function requireConfirmedEmailFor(patientUserId: string, input: ReminderInput) {
  if (!input.emailEnabled) return;
  const [u] = await db.select({ at: users.emailVerifiedAt }).from(users).where(eq(users.id, patientUserId));
  if (!u?.at) throw new ReminderError(409, "email_not_verified", "Confirm your e-mail address first, so reminders only go to you.");
}

export async function createReminder(patientUserId: string, input: ReminderInput, fallbackZone: string) {
  await requireConfirmedEmailFor(patientUserId, input);
  if ("healthEntryId" in input) await checkHealthEntry(patientUserId, input.healthEntryId);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(personalReminders).where(and(eq(personalReminders.patientUserId, patientUserId), sql`${personalReminders.status} <> 'cancelled'`));
  if (n >= MAX_ACTIVE_PER_PERSON) throw new ReminderError(409, "too_many", "You have a lot of reminders. Remove some you no longer need.");
  const [row] = await db.insert(personalReminders).values(toRow(patientUserId, input, fallbackZone)).returning();
  return row;
}

export async function replaceReminder(patientUserId: string, id: string, input: ReminderInput, fallbackZone: string) {
  await requireConfirmedEmailFor(patientUserId, input);
  if ("healthEntryId" in input) await checkHealthEntry(patientUserId, input.healthEntryId);
  const row = toRow(patientUserId, input, fallbackZone);
  const [updated] = await db.update(personalReminders).set({ ...row, snoozedUntil: null }).where(and(eq(personalReminders.id, id), eq(personalReminders.patientUserId, patientUserId), sql`${personalReminders.status} <> 'cancelled'`)).returning();
  if (!updated) throw new ReminderError(404, "not_found", "Reminder not found");
  return updated;
}

export async function setStatus(patientUserId: string, id: string, status: "active" | "paused" | "cancelled") {
  const allowedFrom = status === "active" ? ["paused"] : status === "paused" ? ["active"] : ["active", "paused"];
  const [row] = await db
    .update(personalReminders)
    .set({ status, snoozedUntil: status === "active" ? null : null, updatedAt: new Date() })
    .where(and(eq(personalReminders.id, id), eq(personalReminders.patientUserId, patientUserId), inArray(personalReminders.status, allowedFrom)))
    .returning();
  if (!row) throw new ReminderError(404, "not_found", "Reminder not found");
  return row;
}

export async function snooze(patientUserId: string, id: string, minutes: number, now = new Date()) {
  const [row] = await db
    .update(personalReminders)
    .set({ snoozedUntil: new Date(now.getTime() + minutes * 60_000), updatedAt: now })
    .where(and(eq(personalReminders.id, id), eq(personalReminders.patientUserId, patientUserId), eq(personalReminders.status, "active")))
    .returning();
  if (!row) throw new ReminderError(404, "not_found", "Reminder not found");
  return row;
}

export async function removeReminder(patientUserId: string, id: string) {
  const [row] = await db.delete(personalReminders).where(and(eq(personalReminders.id, id), eq(personalReminders.patientUserId, patientUserId))).returning({ id: personalReminders.id });
  if (!row) throw new ReminderError(404, "not_found", "Reminder not found");
}

export async function listReminders(patientUserId: string, now = new Date()) {
  const rows = await db.select().from(personalReminders).where(eq(personalReminders.patientUserId, patientUserId)).orderBy(desc(personalReminders.createdAt));
  const recent = rows.length
    ? await db.select().from(personalReminderDeliveries).where(inArray(personalReminderDeliveries.reminderId, rows.map((r) => r.id))).orderBy(desc(personalReminderDeliveries.dueAt)).limit(300)
    : [];
  return rows.map((r) => {
    const next = nextDueAt(r, now);
    const mine = recent.filter((d) => d.reminderId === r.id);
    return {
      ...r,
      nextDueAt: next?.instant.toISOString() ?? null,
      nextOccurrence: next ? { kind: next.occurrence, offsetDays: next.offsetDays } : null,
      nextRenewal: isRenewal(r) ? nextRenewal({ renewalDate: r.renewalDate!, interval: (r.renewalInterval as RenewalInterval | null) ?? null, timezone: r.timezone }, now) : null,
      recent: mine.slice(0, 6).map((d) => ({ dueAt: d.dueAt.toISOString(), channel: d.channel, status: d.status, attempts: d.attempts, occurrence: d.occurrence })),
    };
  });
}

// ---------------------------------------------------------------------------------------------- delivery

const EMAIL_TEXT: Record<string, { subject: string; generic: string; titled: (t: string) => string }> = {
  en: { subject: "Reminder from Avela", generic: "You have a reminder in Avela. Open the app to see it.", titled: (t) => `Reminder: ${t}` },
  ar: { subject: "تذكير من أفيلا", generic: "لديك تذكير في أفيلا. افتح التطبيق لرؤيته.", titled: (t) => `تذكير: ${t}` },
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface PersonalDispatchResult { considered: number; due: number; inApp: number; emailSent: number; emailFailed: number; emailSuppressed: number; emailRetried: number; errors: number; truncated: boolean }

export const MAX_EMAILS_PER_DAY = 20;

async function emailsInLastDay(patientUserId: string, now: Date): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM personal_reminder_deliveries d JOIN personal_reminders r ON r.id = d.reminder_id
    WHERE r.patient_user_id = ${patientUserId} AND d.channel = 'email' AND d.status IN ('pending','sent') AND d.created_at > ${new Date(now.getTime() - 86_400_000)}`);
  return Number((res.rows[0] as any)?.n ?? 0);
}

async function claimEmail(reminderId: string, dueAt: Date, occurrence: string, offsetDays: number | null): Promise<string | null> {
  const [row] = await db.insert(personalReminderDeliveries).values({ reminderId, dueAt, channel: "email", occurrence, offsetDays }).onConflictDoNothing().returning({ id: personalReminderDeliveries.id });
  return row?.id ?? null;
}

async function retryEmail(reminderId: string, dueAt: Date): Promise<string | null> {
  const [row] = await db
    .update(personalReminderDeliveries)
    .set({ status: "pending", attempts: sql`${personalReminderDeliveries.attempts} + 1`, updatedAt: new Date() })
    .where(and(
      eq(personalReminderDeliveries.reminderId, reminderId), eq(personalReminderDeliveries.dueAt, dueAt), eq(personalReminderDeliveries.channel, "email"),
      sql`${personalReminderDeliveries.attempts} < ${MAX_EMAIL_ATTEMPTS}`,
      sql`(${personalReminderDeliveries.status} = 'failed' OR (${personalReminderDeliveries.status} = 'pending' AND ${personalReminderDeliveries.updatedAt} < now() - make_interval(mins => ${ABANDONED_AFTER_MINUTES})))`,
    ))
    .returning({ id: personalReminderDeliveries.id });
  return row?.id ?? null;
}

/**
 * Delivers every personal reminder that came due in the lookback window. Safe to run as often as you like and if runs overlap:
 * each occurrence and channel is recorded once under a unique key, the in-app notice and its record are written in one
 * transaction, and an e-mail is claimed before it is sent, retried at most three times, and never sent after the window.
 */
export async function dispatchPersonalReminders(now: Date, opts: { lookbackMinutes?: number; emailEnabled?: boolean; deadline?: number } = {}): Promise<PersonalDispatchResult> {
  const lookback = opts.lookbackMinutes ?? LOOKBACK_MINUTES;
  const from = new Date(now.getTime() - lookback * 60_000);
  const result: PersonalDispatchResult = { considered: 0, due: 0, inApp: 0, emailSent: 0, emailFailed: 0, emailSuppressed: 0, emailRetried: 0, errors: 0, truncated: false };

  return runAsSystem(async () => {
    const rows = await db
      .select({ r: personalReminders, email: users.email, emailVerifiedAt: users.emailVerifiedAt, language: users.language })
      .from(personalReminders)
      .innerJoin(users, eq(users.id, personalReminders.patientUserId))
      .where(and(eq(personalReminders.status, "active"), sql`${users.deactivatedAt} IS NULL`, fixtureAccountsAllowed() ? sql`true` : sql`NOT ${users.isDemo}`));
    result.considered = rows.length;

    const settled = new Set<string>();
    for (const d of await db.select().from(personalReminderDeliveries).where(sql`${personalReminderDeliveries.dueAt} > ${from}`)) {
      const done = d.channel === "in_app" || d.status === "sent" || d.status === "suppressed" || (d.status === "failed" && d.attempts >= MAX_EMAIL_ATTEMPTS);
      if (done) settled.add(`${d.reminderId}|${d.dueAt.getTime()}|${d.channel}`);
    }

    const usedToday = new Map<string, number>();
    for (const { r, email, emailVerifiedAt, language } of rows) {
      if (opts.deadline && Date.now() > opts.deadline) {
        result.truncated = true;
        break;
      }
      try {
        for (const occ of occurrencesOf(r, from, now)) {
          // Nothing is delivered for a moment before the reminder was last created, edited or switched on (a snooze is the exception).
          if (occ.instant.getTime() <= r.updatedAt.getTime() && !(r.snoozedUntil && occ.instant.getTime() === r.snoozedUntil.getTime())) continue;
          const key = `${r.id}|${occ.instant.getTime()}`;
          // Only an address the person has confirmed receives reminder e-mail; it may not be theirs otherwise.
          const wantsEmail = r.emailEnabled && !!opts.emailEnabled && !!emailVerifiedAt;
          const inAppDone = settled.has(`${key}|in_app`);
          const emailDone = !wantsEmail || settled.has(`${key}|email`);
          if (inAppDone && emailDone) continue;
          result.due++;

          if (!inAppDone) {
            const clock = DateTime.fromJSDate(occ.instant, { zone: r.timezone }).toFormat("HH:mm");
            const kind = occ.occurrence === "due" ? "personal.due" : occ.occurrence === "renewal" ? "personal.renewal" : "personal.cancel_by";
            const created = await db.transaction(async (tx) => {
              const [row] = await tx.insert(personalReminderDeliveries).values({ reminderId: r.id, dueAt: occ.instant, channel: "in_app", status: "sent", sentAt: new Date(), occurrence: occ.occurrence, offsetDays: occ.offsetDays }).onConflictDoNothing().returning({ id: personalReminderDeliveries.id });
              if (!row) return false;
              await tx.insert(notifications).values({ userId: r.patientUserId, kind, params: { title: r.title, time: clock, days: occ.offsetDays ?? 0 }, link: "/my-reminders" });
              return true;
            });
            if (created) result.inApp++;
          }

          if (!emailDone) {
            // Quiet hours hold back e-mail only (the in-app notice is passive), and what is held back is not sent later.
            if (inQuietHours(occ.instant, r.timezone, r.quietStart, r.quietEnd)) {
              const [row] = await db.insert(personalReminderDeliveries).values({ reminderId: r.id, dueAt: occ.instant, channel: "email", status: "suppressed", occurrence: occ.occurrence, offsetDays: occ.offsetDays }).onConflictDoNothing().returning({ id: personalReminderDeliveries.id });
              if (row) result.emailSuppressed++;
              continue;
            }
            // A ceiling on e-mail per person per day, however many reminders they have.
            if (!usedToday.has(r.patientUserId)) usedToday.set(r.patientUserId, await emailsInLastDay(r.patientUserId, now));
            if (usedToday.get(r.patientUserId)! >= MAX_EMAILS_PER_DAY) continue;
            let id = await claimEmail(r.id, occ.instant, occ.occurrence, occ.offsetDays);
            let retry = false;
            if (!id) {
              id = await retryEmail(r.id, occ.instant);
              retry = !!id;
            }
            if (!id) continue;
            usedToday.set(r.patientUserId, usedToday.get(r.patientUserId)! + 1);
            if (retry) result.emailRetried++;
            const text = EMAIL_TEXT[language] ?? EMAIL_TEXT.en;
            const body = r.showTitleInEmail && emailVerifiedAt ? text.titled(r.title) : text.generic;
            let ok = false;
            try {
              ok = await sendEmail({ to: email, purpose: "personal_reminder", subject: text.subject, body, html: `<p style="font-size:16px;line-height:1.6">${escapeHtml(body)}</p>` });
            } catch (err: any) {
              console.error("[personal-reminders] email send threw:", err?.name);
            }
            await db
              .update(personalReminderDeliveries)
              .set({ status: ok ? "sent" : "failed", sentAt: ok ? new Date() : null, errorCode: ok ? null : "provider_rejected_or_unavailable", updatedAt: new Date() })
              .where(eq(personalReminderDeliveries.id, id));
            if (ok) result.emailSent++;
            else result.emailFailed++;
          }
        }
      } catch (err: any) {
        result.errors++;
        console.error("[personal-reminders] could not process one reminder:", err?.name || "Error");
      }
    }
    return result;
  });
}

/** Overdue: scheduled in the last day, past the lookback window, and no in-app notice was ever delivered. */
export async function overdueCount(now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const cutoff = new Date(now.getTime() - LOOKBACK_MINUTES * 60_000);
  return runAsSystem(async () => {
    const rows = await db.select().from(personalReminders).where(eq(personalReminders.status, "active"));
    const delivered = new Set((await db.select().from(personalReminderDeliveries).where(and(eq(personalReminderDeliveries.channel, "in_app"), sql`${personalReminderDeliveries.dueAt} > ${since}`))).map((d) => `${d.reminderId}|${d.dueAt.getTime()}`));
    let n = 0;
    for (const r of rows) for (const o of occurrencesOf(r, since, cutoff)) if (!delivered.has(`${r.id}|${o.instant.getTime()}`)) n++;
    return n;
  });
}

void PERSONAL_KINDS;
export type { PersonalKind };
