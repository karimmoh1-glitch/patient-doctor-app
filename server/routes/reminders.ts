import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { dateKeyInZone, resolvePatientTimezone } from "../lib/localTime";
import { LOOKBACK_MINUTES, nextOccurrence, occurrencesInWindow, reminderDeliveryStatus } from "../services/reminderService";
import { logAudit } from "../services/auditService";

const router = Router();

// A reminder belongs to the patient who set it. Doctors and caregivers can't
// create or read them: caregivers are read-only by design.
const patientOnly = [requireAuth, requireRole("patient")] as const;

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const reminderSchema = z.object({
  times: z.array(z.string().regex(HH_MM, "Use a time like 08:00")).min(1, "Choose at least one time").max(6).refine((t) => new Set(t).size === t.length, "Each time must be different"),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, "Choose at least one day").max(7),
  enabled: z.boolean(),
  emailEnabled: z.boolean().default(false),
  showMedicationName: z.boolean().default(false),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

function emailAvailable() {
  return !!process.env.RESEND_API_KEY;
}

// Each tracked medicine with its reminder (if any) and when the next one is
// due. Honest about delivery: `delivery` says whether anything is actually
// sending them right now.
router.get("/", ...patientOnly, async (req, res) => {
  const userId = (req as any).userId as string;
  const [medications, reminders, delivery] = await Promise.all([
    storage.getMedicationsByPatient(userId),
    storage.getRemindersByPatient(userId),
    reminderDeliveryStatus(),
  ]);
  const byMedication = new Map(reminders.map((r) => [r.medicationId, r]));
  const now = new Date();
  // What actually happened to each reminder lately, per channel, so the screen can
  // say "shown in Avela" or "the email service accepted it" and never more than that.
  const recent = await storage.getRecentDeliveriesForReminders(reminders.map((r) => r.id), 4);
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const cutoff = new Date(now.getTime() - LOOKBACK_MINUTES * 60_000);
  const mine = new Set(reminders.map((r) => r.id));
  const inAppDelivered = new Set(
    (await storage.getDeliveriesSince(since)).filter((d) => mine.has(d.reminderId) && d.channel === "in_app").map((d) => `${d.reminderId}|${d.dueAt.getTime()}`),
  );
  res.json({
    delivery,
    emailAvailable: emailAvailable(),
    medications: medications
      .filter((m) => m.active)
      .map((m) => {
        const r = byMedication.get(m.id);
        return {
          medicationId: m.id,
          medicationName: m.name,
          suggestedTimes: m.scheduleTimes,
          reminder: r
            ? {
                times: r.times,
                weekdays: r.weekdays,
                enabled: r.enabled,
                emailEnabled: r.emailEnabled,
                showMedicationName: r.showMedicationName,
                timezone: r.timezone,
                endDate: r.endDate,
                nextDueAt: r.enabled ? nextOccurrence(r, now)?.toISOString() ?? null : null,
                recent: recent.filter((d) => d.reminderId === r.id).slice(0, 4).map((d) => ({ dueAt: d.dueAt.toISOString(), channel: d.channel, status: d.status, attempts: d.attempts })),
                // Times in the last day that passed without a notice being delivered.
                overdue: r.enabled
                  ? occurrencesInWindow(r, since, now).filter((due) => due < cutoff && !inAppDelivered.has(`${r.id}|${due.getTime()}`)).map((d) => d.toISOString())
                  : [],
              }
            : null,
        };
      }),
  });
});

router.put("/:medicationId", ...patientOnly, async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = reminderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid reminder" });
  const medication = await storage.getMedication(req.params.medicationId);
  if (!medication || medication.patientUserId !== userId) return res.status(404).json({ message: "Medication not found" });
  if (!medication.active) return res.status(409).json({ message: "This medicine isn't being tracked right now" });
  if (parsed.data.emailEnabled && !emailAvailable()) {
    return res.status(409).json({ message: "Email reminders aren't available on this service." });
  }

  const user = (await storage.getUser(userId))!;
  const timezone = await resolvePatientTimezone(req, user);
  const existing = await storage.getReminderByMedication(medication.id);
  const reminder = await storage.upsertReminder({
    patientUserId: userId,
    medicationId: medication.id,
    times: [...parsed.data.times].sort(),
    weekdays: Array.from(new Set(parsed.data.weekdays)).sort(),
    timezone,
    startDate: existing?.startDate ?? dateKeyInZone(new Date(), timezone),
    endDate: parsed.data.endDate ?? null,
    enabled: parsed.data.enabled,
    emailEnabled: parsed.data.emailEnabled,
    showMedicationName: parsed.data.showMedicationName,
  });
  await logAudit({ actorUserId: userId, action: "reminder.saved", targetType: "medication", targetId: medication.id });
  res.json({ ...reminder, nextDueAt: reminder.enabled ? nextOccurrence(reminder, new Date())?.toISOString() ?? null : null });
});

router.delete("/:medicationId", ...patientOnly, async (req, res) => {
  const userId = (req as any).userId as string;
  const removed = await storage.deleteReminderByMedication(req.params.medicationId, userId);
  if (!removed) return res.status(404).json({ message: "Reminder not found" });
  await logAudit({ actorUserId: userId, action: "reminder.removed", targetType: "medication", targetId: req.params.medicationId });
  res.json({ ok: true });
});

export default router;
