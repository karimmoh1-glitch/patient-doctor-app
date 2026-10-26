import { DateTime } from "luxon";

/**
 * When a personal reminder is due. Pure functions: no database, no clock except the arguments.
 *
 * Times are wall-clock times in the reminder's own zone, so "08:00" stays 08:00 on the person's clock across daylight-saving
 * changes. A time that does not exist on a spring-forward day fires at the next valid minute; a time that happens twice on a
 * fall-back day fires once, at the first. Dates are calendar dates in that zone.
 *
 * Months and years are calendar arithmetic, not 30- or 365-day blocks:
 *  - "monthly on the 31st" is the last day of a shorter month (Feb 28/29, Apr 30, ...);
 *  - "yearly on Feb 29" is Feb 28 in a year with no Feb 29.
 * Both are computed from the ORIGINAL anchor date each time, so a clamp in February does not drag March to the 28th.
 */

export type Recurrence = "once" | "daily" | "weekly" | "monthly" | "yearly";
export type RenewalInterval = "weekly" | "monthly" | "quarterly" | "yearly";

export interface PersonalSchedule {
  recurrence: Recurrence;
  times: string[]; // "HH:mm"
  weekdays: number[]; // 0 = Sunday; used by daily and weekly
  timezone: string;
  anchorDate: string; // YYYY-MM-DD: the day (once), day of month (monthly), month and day (yearly), or the first day (daily, weekly)
  startDate: string | null;
  endDate: string | null;
}

export interface RenewalSchedule {
  renewalDate: string; // the next charge or due date, YYYY-MM-DD
  interval: RenewalInterval | null; // null: a single date
  offsetsDays: number[]; // remind this many days before each renewal (0 = on the day)
  cancelByDate: string | null; // an optional deadline, reminded with the same offsets
  time: string; // "HH:mm"
  timezone: string;
  endDate: string | null; // stop after this date
}

const parseDay = (key: string, zone: string) => DateTime.fromISO(key, { zone }).startOf("day");
const fmt = (d: DateTime) => d.toFormat("yyyy-LL-dd");

function at(day: DateTime, time: string, zone: string): Date | null {
  const [hour, minute] = time.split(":").map(Number);
  const due = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour, minute }, { zone });
  return due.isValid ? due.toJSDate() : null;
}

/** Day of month `d` clamped to the month's length. */
const clampDay = (year: number, month: number, d: number) => Math.min(d, DateTime.fromObject({ year, month }).daysInMonth!);

export function occursOnDay(s: PersonalSchedule, day: DateTime): boolean {
  const key = fmt(day);
  if (s.startDate && key < s.startDate) return false;
  if (s.endDate && key > s.endDate) return false;
  const anchor = parseDay(s.anchorDate, s.timezone);
  switch (s.recurrence) {
    case "once":
      return key === s.anchorDate;
    case "daily":
    case "weekly":
      return key >= s.anchorDate && s.weekdays.includes(day.weekday % 7);
    case "monthly":
      return key >= s.anchorDate && day.day === clampDay(day.year, day.month, anchor.day);
    case "yearly":
      return key >= s.anchorDate && day.month === anchor.month && day.day === clampDay(day.year, day.month, anchor.day);
  }
}

/** Every instant in (from, to] at which this reminder is due. */
export function personalOccurrences(s: PersonalSchedule, from: Date, to: Date): Date[] {
  const first = DateTime.fromJSDate(from, { zone: s.timezone }).startOf("day");
  const last = DateTime.fromJSDate(to, { zone: s.timezone }).startOf("day");
  const out: Date[] = [];
  // Bounded: a window is a few hours in practice, and callers asking for a year are asking for 366 days.
  for (let day = first, n = 0; day <= last && n < 400; day = day.plus({ days: 1 }), n++) {
    if (!occursOnDay(s, day)) continue;
    for (const time of s.times) {
      const instant = at(day, time, s.timezone);
      if (instant && instant > from && instant <= to) out.push(instant);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

const STEP: Record<RenewalInterval, { months?: number; weeks?: number }> = { weekly: { weeks: 1 }, monthly: { months: 1 }, quarterly: { months: 3 }, yearly: { months: 12 } };

/** The n-th renewal date, always counted from the first one so month-end clamping never accumulates. */
export function renewalDate(anchor: DateTime, interval: RenewalInterval | null, n: number): DateTime {
  if (!interval || n === 0) return anchor;
  const step = STEP[interval];
  return step.weeks ? anchor.plus({ weeks: step.weeks * n }) : anchor.plus({ months: step.months! * n });
}

export interface RenewalOccurrence { instant: Date; kind: "renewal" | "cancel_by"; target: string; offsetDays: number }

/** Reminders for renewal dates (and the cancellation deadline) whose reminder moment falls in (from, to]. */
export function renewalOccurrences(s: RenewalSchedule, from: Date, to: Date): RenewalOccurrence[] {
  const first = DateTime.fromJSDate(from, { zone: s.timezone }).startOf("day");
  const last = DateTime.fromJSDate(to, { zone: s.timezone }).startOf("day");
  const maxOffset = Math.max(0, ...s.offsetsDays);
  const anchor = parseDay(s.renewalDate, s.timezone);
  const out: RenewalOccurrence[] = [];
  const targets: { date: DateTime; kind: "renewal" | "cancel_by" }[] = [];

  // Renewals that could have a reminder in [first, last]: from `first` up to `last + maxOffset`.
  for (let n = 0; n < 5000; n++) {
    const d = renewalDate(anchor, s.interval, n);
    if (d > last.plus({ days: maxOffset })) break;
    if (d >= first) targets.push({ date: d, kind: "renewal" });
    if (!s.interval) break;
  }
  if (s.cancelByDate) targets.push({ date: parseDay(s.cancelByDate, s.timezone), kind: "cancel_by" });

  for (const t of targets) {
    for (const offset of s.offsetsDays) {
      const day = t.date.minus({ days: offset });
      if (day < first || day > last) continue;
      if (s.endDate && fmt(t.date) > s.endDate) continue;
      const instant = at(day, s.time, s.timezone);
      if (instant && instant > from && instant <= to) out.push({ instant, kind: t.kind, target: fmt(t.date), offsetDays: offset });
    }
  }
  return out.sort((a, b) => a.instant.getTime() - b.instant.getTime());
}

/** The first renewal date that is not before `today`, for showing "next charge". Null for a single date already past. */
export function nextRenewal(s: Pick<RenewalSchedule, "renewalDate" | "interval" | "timezone">, today: Date): string | null {
  const anchor = parseDay(s.renewalDate, s.timezone);
  const day = DateTime.fromJSDate(today, { zone: s.timezone }).startOf("day");
  for (let n = 0; n < 5000; n++) {
    const d = renewalDate(anchor, s.interval, n);
    if (d >= day) return fmt(d);
    if (!s.interval) return null;
  }
  return null;
}

/** Is this local clock time inside the quiet window? Windows may cross midnight (22:00 to 07:00). */
export function inQuietHours(instant: Date, zone: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  const t = DateTime.fromJSDate(instant, { zone }).toFormat("HH:mm");
  return start < end ? t >= start && t < end : t >= start || t < end;
}
