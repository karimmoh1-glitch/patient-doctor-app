import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { clockInZone, dateKeyInZone, resolvePatientTimezone } from "../lib/localTime";

const router = Router();

// "Today" is the patient's own today (see lib/localTime.ts), never UTC.
async function patientToday(req: any): Promise<{ tz: string; today: string }> {
  const user = await storage.getUser(req.userId as string);
  const tz = await resolvePatientTimezone(req, user!);
  return { tz, today: dateKeyInZone(new Date(), tz) };
}

function isMedicationActiveOn(med: { startDate: Date | string; endDate: Date | string | null; active: boolean }, dateKey: string): boolean {
  if (!med.active) return false;
  const start = new Date(med.startDate).toISOString().slice(0, 10);
  if (dateKey < start) return false;
  if (med.endDate) {
    const end = new Date(med.endDate).toISOString().slice(0, 10);
    if (dateKey > end) return false;
  }
  return true;
}

// Builds today's dose schedule for a patient: every scheduled time from
// every currently-active medication, merged with any recorded log for that
// slot ("taken"/"skipped"), defaulting to "upcoming" when nothing was
// logged yet. Nothing is pre-populated as rows — this is computed on read.
router.get("/today", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const { today: dateKey } = await patientToday(req);
  const [medications, logs] = await Promise.all([
    storage.getMedicationsByPatient(patientUserId),
    storage.getMedicationLogsByPatientAndDate(patientUserId, dateKey),
  ]);

  const logBySlot = new Map(logs.map((l) => [`${l.medicationId}:${l.doseTime}`, l]));

  const schedule = medications
    .filter((m) => isMedicationActiveOn(m, dateKey))
    .flatMap((m) =>
      m.scheduleTimes.map((time) => {
        const log = logBySlot.get(`${m.id}:${time}`);
        return {
          medicationId: m.id,
          medicationName: m.name,
          instructions: m.instructions,
          time,
          status: log?.status ?? "upcoming",
        };
      }),
    )
    .sort((a, b) => a.time.localeCompare(b.time));

  res.json({ date: dateKey, schedule });
});

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const medications = await storage.getMedicationsByPatient(patientUserId);
  res.json(medications);
});

router.patch("/:id/active", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "active must be a boolean" });
  const medication = await storage.getMedication(req.params.id);
  if (!medication || medication.patientUserId !== patientUserId) {
    return res.status(404).json({ message: "Medication not found" });
  }
  const updated = await storage.setMedicationActive(medication.id, parsed.data.active);
  res.json(updated);
});

const logSchema = z.object({
  doseTime: z.string().regex(/^\d{2}:\d{2}$/),
  status: z.enum(["taken", "skipped"]),
});

router.post("/:id/log", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const parsed = logSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid dose log" });
  const medication = await storage.getMedication(req.params.id);
  if (!medication || medication.patientUserId !== patientUserId) {
    return res.status(404).json({ message: "Medication not found" });
  }
  if (!medication.scheduleTimes.includes(parsed.data.doseTime)) {
    return res.status(400).json({ message: "That time is not part of this medication's schedule" });
  }

  const log = await storage.upsertMedicationLog({
    medicationId: medication.id,
    patientUserId,
    // Always today in the patient's own zone — never a client-chosen date,
    // so history can't be back-filled or pre-filled.
    doseDate: (await patientToday(req)).today,
    doseTime: parsed.data.doseTime,
    status: parsed.data.status,
  });

  res.json(log);
});

// Undo a mis-tap. Removes today's record for that dose, returning it to "not yet logged".
router.delete("/:id/log", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const doseTime = typeof req.query.doseTime === "string" ? req.query.doseTime : "";
  if (!/^\d{2}:\d{2}$/.test(doseTime)) return res.status(400).json({ message: "doseTime is required" });
  const medication = await storage.getMedication(req.params.id);
  if (!medication || medication.patientUserId !== patientUserId) {
    return res.status(404).json({ message: "Medication not found" });
  }
  await storage.deleteMedicationLog(medication.id, (await patientToday(req)).today, doseTime);
  res.json({ ok: true });
});

// Adherence over the last 7 days: how many scheduled doses were logged as
// taken vs. how many were expected. Purely descriptive — no medical
// conclusions are drawn from this number anywhere in the app.
router.get("/adherence", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const medications = await storage.getMedicationsByPatient(patientUserId);
  const active = medications.filter((m) => m.active);

  const { today: todayStr } = await patientToday(req);
  const sinceDate = new Date(`${todayStr}T00:00:00Z`);
  sinceDate.setUTCDate(sinceDate.getUTCDate() - 6);
  const sinceKey = sinceDate.toISOString().slice(0, 10);
  const logs = await storage.getMedicationLogsByPatientRange(patientUserId, sinceKey);
  const takenBySlot = new Set(logs.filter((l) => l.status === "taken").map((l) => `${l.medicationId}:${l.doseDate}:${l.doseTime}`));

  let expected = 0;
  let taken = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(sinceDate);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    if (key > todayStr) continue;
    for (const m of active) {
      if (!isMedicationActiveOn(m, key)) continue;
      for (const time of m.scheduleTimes) {
        expected += 1;
        if (takenBySlot.has(`${m.id}:${key}:${time}`)) taken += 1;
      }
    }
  }

  res.json({ takenCount: taken, expectedCount: expected, windowDays: 7 });
});

export default router;
