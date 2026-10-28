import { DateTime } from "luxon";
import type { Request } from "express";
import { defaultTimezoneForState } from "@shared/timezones";
import { storage } from "../storage";
import { withScope } from "../dbContext";
import type { User } from "@shared/schema";

export function isValidZone(tz: unknown): tz is string {
  return typeof tz === "string" && tz.length > 0 && tz.length <= 64 && DateTime.local().setZone(tz).isValid;
}

/** "2026-10-24" for the instant `now` as it reads on a wall clock in `tz`. */
export function dateKeyInZone(now: Date, tz: string): string {
  return DateTime.fromJSDate(now, { zone: tz }).toFormat("yyyy-LL-dd");
}

/** "20:05" for the instant `now` on a wall clock in `tz` (matches stored dose times). */
export function clockInZone(now: Date, tz: string): string {
  return DateTime.fromJSDate(now, { zone: tz }).toFormat("HH:mm");
}

/**
 * The patient's own time zone. "Today", "next dose" and "overdue" all depend
 * on it: dose times are wall-clock times ("20:00"), so computing the day in
 * UTC makes a California evening look like tomorrow.
 *
 * Order of trust: the browser's zone sent with the request (and remembered),
 * then the last remembered zone, then a default for the patient's state.
 */
export async function resolvePatientTimezone(req: Request | null, user: User & { state?: string | null }): Promise<string> {
  const header = req?.headers["x-timezone"];
  const fromBrowser = Array.isArray(header) ? header[0] : header;
  if (isValidZone(fromBrowser)) {
    if (user.timezone !== fromBrowser) await storage.setUserTimezone(user.id, fromBrowser);
    return fromBrowser;
  }
  if (isValidZone(user.timezone)) return user.timezone;
  return defaultTimezoneForState(user.state ?? null);
}

export async function patientTimezoneById(patientUserId: string): Promise<string> {
  // Reading the person's own state (to pick a default zone) is the server's doing: the answer is a time zone, never the state.
  const user = await withScope("contact", () => storage.getUserPrivate(patientUserId));
  if (!user) return "America/New_York";
  return resolvePatientTimezone(null, user);
}

/**
 * Is this medicine meant to be taken on `dateKey`, a calendar day in `tz`?
 * Start and end are compared as days on the PATIENT's calendar. Comparing them
 * as UTC days made a prescription authorized on a US evening (already
 * "tomorrow" in UTC) vanish from that patient's list until the next day.
 */
export function isMedicationActiveOn(
  med: { startDate: Date | string; endDate: Date | string | null; active: boolean },
  dateKey: string,
  tz: string,
): boolean {
  if (!med.active) return false;
  if (dateKey < dateKeyInZone(new Date(med.startDate), tz)) return false;
  if (med.endDate && dateKey > dateKeyInZone(new Date(med.endDate), tz)) return false;
  return true;
}
