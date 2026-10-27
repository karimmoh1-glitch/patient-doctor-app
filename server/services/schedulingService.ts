import { DateTime } from "luxon";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  appointments,
  doctorAvailability,
  doctorProfiles,
  type Appointment,
  type PairingRequest,
} from "@shared/schema";

export const SLOT_MINUTES = 30;
export const MIN_NOTICE_MINUTES = 120;
export const MAX_HORIZON_DAYS = 60;

export interface AvailabilityRule {
  weekday: number; // 0 = Sunday … 6 = Saturday
  startMinute: number;
  endMinute: number;
}

export interface Interval {
  start: Date;
  end: Date;
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/**
 * Every bookable start time for a doctor over the next `days` days.
 *
 * Rules are wall-clock windows in the doctor's own zone ("Tuesdays 09:00–12:00
 * Pacific"), so a daylight-saving change moves the UTC instant but not the
 * doctor's working hours. Local times that don't exist (the spring-forward
 * gap) are skipped rather than silently shifted. A slot is offered only if it
 * fits entirely inside a window, starts after the minimum notice, and does not
 * overlap an existing live appointment.
 */
export function generateSlots(opts: {
  rules: AvailabilityRule[];
  timezone: string;
  now: Date;
  days: number;
  busy: Interval[];
  slotMinutes?: number;
  minNoticeMinutes?: number;
}): Date[] {
  const slotMinutes = opts.slotMinutes ?? SLOT_MINUTES;
  const earliest = opts.now.getTime() + (opts.minNoticeMinutes ?? MIN_NOTICE_MINUTES) * 60_000;
  const today = DateTime.fromJSDate(opts.now, { zone: opts.timezone }).startOf("day");
  if (!today.isValid) return [];

  const slots = new Map<number, Date>();
  for (let i = 0; i <= Math.min(opts.days, MAX_HORIZON_DAYS); i++) {
    const day = today.plus({ days: i });
    const weekday = day.weekday % 7; // luxon: 1 = Monday … 7 = Sunday
    for (const rule of opts.rules) {
      if (rule.weekday !== weekday) continue;
      for (let m = rule.startMinute; m + slotMinutes <= rule.endMinute; m += slotMinutes) {
        const local = day.set({ hour: Math.floor(m / 60), minute: m % 60, second: 0, millisecond: 0 });
        if (local.hour * 60 + local.minute !== m) continue; // DST gap: this wall time doesn't exist
        const start = local.toJSDate();
        const startMs = start.getTime();
        if (startMs < earliest) continue;
        const endMs = startMs + slotMinutes * 60_000;
        if (opts.busy.some((b) => startMs < b.end.getTime() && endMs > b.start.getTime())) continue;
        slots.set(startMs, start);
      }
    }
  }
  return Array.from(slots.values()).sort((a, b) => a.getTime() - b.getTime());
}

export function validateAvailabilityWindows(windows: AvailabilityRule[]): string | null {
  if (windows.length > 28) return "Too many time windows.";
  const byDay = new Map<number, AvailabilityRule[]>();
  for (const w of windows) {
    if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) return "Each window needs a day of the week.";
    if (!Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute)) return "Times must be whole minutes.";
    if (w.startMinute < 0 || w.endMinute > 1440 || w.startMinute >= w.endMinute) return "Each window must end after it starts.";
    if (w.startMinute % 15 !== 0 || w.endMinute % 15 !== 0) return "Times must be on a 15-minute boundary.";
    if (w.endMinute - w.startMinute < SLOT_MINUTES) return `Each window must be at least ${SLOT_MINUTES} minutes long.`;
    byDay.set(w.weekday, [...(byDay.get(w.weekday) ?? []), w]);
  }
  for (const list of Array.from(byDay.values())) {
    const sorted = [...list].sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startMinute < sorted[i - 1].endMinute) return "Time windows on the same day can't overlap.";
    }
  }
  return null;
}

const LIVE_STATUSES = ["requested", "confirmed"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type Executor = Pick<Tx, "select" | "execute">;

/** pg returns a timestamp-without-time-zone as text; ours are always UTC. */
const asUtc = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v).replace(" ", "T") + (/[zZ]|[+-]\d\d(:?\d\d)?$/.test(String(v)) ? "" : "Z")));

/**
 * When each of these doctors is already booked inside the window: only the start and length, never whose
 * visit it is. Goes through a narrow database function, so a patient looking for a free time can see
 * what is taken without being able to read anyone else's appointment (see migration 0014).
 */
async function busyIntervals(executor: Executor, doctorIds: string[], window: Interval, excludeAppointmentId?: string): Promise<Map<string, Interval[]>> {
  const out = new Map<string, Interval[]>();
  if (!doctorIds.length) return out;
  const ids = sql.join(doctorIds.map((id) => sql`${id}`), sql`, `);
  const res = await executor.execute(sql`
    SELECT doctor_profile_id, scheduled_at, duration_minutes
      FROM app_busy_intervals(ARRAY[${ids}]::text[], ${window.start.toISOString()}::timestamp, ${window.end.toISOString()}::timestamp, ${excludeAppointmentId ?? null}::text)`);
  for (const row of res.rows as { doctor_profile_id: string; scheduled_at: unknown; duration_minutes: number }[]) {
    const start = asUtc(row.scheduled_at);
    const list = out.get(row.doctor_profile_id) ?? [];
    list.push({ start, end: new Date(start.getTime() + row.duration_minutes * 60_000) });
    out.set(row.doctor_profile_id, list);
  }
  return out;
}

async function loadSchedule(executor: Executor, doctorProfileId: string, window: Interval, excludeAppointmentId?: string) {
  const [doctor] = await executor.select().from(doctorProfiles).where(eq(doctorProfiles.id, doctorProfileId));
  const rules = await executor
    .select({ weekday: doctorAvailability.weekday, startMinute: doctorAvailability.startMinute, endMinute: doctorAvailability.endMinute })
    .from(doctorAvailability)
    .where(eq(doctorAvailability.doctorProfileId, doctorProfileId));
  const busy = (await busyIntervals(executor, [doctorProfileId], window, excludeAppointmentId)).get(doctorProfileId) ?? [];
  return { doctor, rules, busy };
}

/**
 * The first open time for each of many doctors, in two queries in total (not
 * three per doctor): this is what the public directory runs on every search.
 * Doctors with no published hours, or no free time in the window, are absent.
 */
export async function getNextOpenSlots(doctors: { id: string; timezone: string }[], days: number, now = new Date()): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!doctors.length) return out;
  const ids = doctors.map((d) => d.id);
  const horizonEnd = new Date(now.getTime() + (Math.min(days, MAX_HORIZON_DAYS) + 2) * 86_400_000);
  const [rules, busyByDoctor] = await Promise.all([
    db.select().from(doctorAvailability).where(inArray(doctorAvailability.doctorProfileId, ids)),
    busyIntervals(db, ids, { start: now, end: horizonEnd }),
  ]);
  for (const d of doctors) {
    const mine = rules.filter((r) => r.doctorProfileId === d.id).map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute }));
    if (!mine.length) continue;
    const busy = busyByDoctor.get(d.id) ?? [];
    const first = generateSlots({ rules: mine, timezone: d.timezone, now, days, busy })[0];
    if (first) out.set(d.id, first);
  }
  return out;
}

/** Open slots for a doctor, for display. Read-only; booking re-checks inside a transaction. */
export async function getOpenSlots(doctorProfileId: string, days: number, now = new Date()) {
  const horizonEnd = new Date(now.getTime() + (Math.min(days, MAX_HORIZON_DAYS) + 2) * 86_400_000);
  const { doctor, rules, busy } = await loadSchedule(db, doctorProfileId, { start: now, end: horizonEnd });
  if (!doctor) return { timezone: null as string | null, hasPublishedAvailability: false, slots: [] as Date[] };
  return {
    timezone: doctor.timezone,
    hasPublishedAvailability: rules.length > 0,
    slots: generateSlots({ rules, timezone: doctor.timezone, now, days, busy }),
  };
}

export type BookingFailure = "no_availability" | "slot_unavailable" | "not_connected";

export type BookingResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: BookingFailure };

/**
 * Creates (or, when `rescheduleAppointmentId` is given, moves) an appointment
 * only if `start` is a slot the doctor really offers right now. The doctor's
 * row is locked for the duration, so two simultaneous requests for
 * overlapping times are serialised and the second sees the first.
 */
export async function bookSlot(input: {
  pairing: PairingRequest;
  type: string;
  reason: string;
  start: Date;
  rescheduleAppointmentId?: string;
  now?: Date;
}): Promise<BookingResult> {
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM doctor_profiles WHERE id = ${input.pairing.doctorProfileId} FOR UPDATE`);
      // The connection must still be live when the visit is written, and stay so until this commits: ending a connection takes the same row
      // exclusively, so an end either waits for this booking (and then sees it, and asks the patient) or goes first (and this booking is refused).
      const live = await tx.execute(sql`SELECT status FROM pairing_requests WHERE id = ${input.pairing.id} FOR SHARE`);
      if ((live.rows[0] as { status?: string } | undefined)?.status !== "accepted") return { ok: false, reason: "not_connected" } as const;

      const window = {
        start: new Date(input.start.getTime() - 60 * 60_000),
        end: new Date(input.start.getTime() + 60 * 60_000),
      };
      const { doctor, rules, busy } = await loadSchedule(tx, input.pairing.doctorProfileId, window, input.rescheduleAppointmentId);
      if (!doctor || rules.length === 0) return { ok: false, reason: "no_availability" } as const;

      const daysAhead = Math.ceil((input.start.getTime() - now.getTime()) / 86_400_000) + 1;
      const offered = generateSlots({ rules, timezone: doctor.timezone, now, days: daysAhead, busy });
      if (!offered.some((s) => s.getTime() === input.start.getTime())) return { ok: false, reason: "slot_unavailable" } as const;

      if (input.rescheduleAppointmentId) {
        // Moving a visit means the doctor has not agreed to the new time yet.
        const [moved] = await tx
          .update(appointments)
          .set({ scheduledAt: input.start, status: "requested", reminderSentAt: null })
          .where(and(eq(appointments.id, input.rescheduleAppointmentId), inArray(appointments.status, [...LIVE_STATUSES])))
          .returning();
        if (!moved) return { ok: false, reason: "slot_unavailable" } as const;
        return { ok: true, appointment: moved } as const;
      }

      const [created] = await tx
        .insert(appointments)
        .values({
          pairingRequestId: input.pairing.id,
          patientUserId: input.pairing.patientUserId,
          doctorProfileId: input.pairing.doctorProfileId,
          type: input.type,
          reason: input.reason,
          scheduledAt: input.start,
          durationMinutes: SLOT_MINUTES,
          questionsForDoctor: [],
        })
        .returning();
      return { ok: true, appointment: created } as const;
    });
  } catch (err: any) {
    // The unique index on (doctor, start) caught a race the lock didn't.
    if (err?.code === "23505" || err?.cause?.code === "23505") return { ok: false, reason: "slot_unavailable" };
    throw err;
  }
}

export async function replaceAvailability(doctorProfileId: string, timezone: string, windows: AvailabilityRule[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(doctorProfiles).set({ timezone }).where(eq(doctorProfiles.id, doctorProfileId));
    await tx.delete(doctorAvailability).where(eq(doctorAvailability.doctorProfileId, doctorProfileId));
    if (windows.length) {
      await tx.insert(doctorAvailability).values(windows.map((w) => ({ ...w, doctorProfileId })));
    }
  });
}

export async function getAvailability(doctorProfileId: string): Promise<AvailabilityRule[]> {
  return db
    .select({ weekday: doctorAvailability.weekday, startMinute: doctorAvailability.startMinute, endMinute: doctorAvailability.endMinute })
    .from(doctorAvailability)
    .where(eq(doctorAvailability.doctorProfileId, doctorProfileId));
}
