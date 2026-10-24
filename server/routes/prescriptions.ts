import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";

const router = Router();

// Even spacing across a typical waking day — a simple, explainable
// heuristic for turning "N times a day" into clock times. Never a real
// clinical dosing schedule; patients can edit nothing dosage-related here,
// only the demo tracking schedule.
function scheduleTimesForFrequency(frequencyPerDay: number): string[] {
  const table: Record<number, string[]> = {
    1: ["08:00"],
    2: ["08:00", "20:00"],
    3: ["08:00", "14:00", "20:00"],
    4: ["08:00", "12:00", "16:00", "20:00"],
  };
  return table[frequencyPerDay] || table[1];
}

const createPrescriptionSchema = z.object({
  pairingRequestId: z.string().min(1),
  appointmentId: z.string().min(1).optional(),
  medicationName: z.string().trim().min(2).max(200),
  instructions: z.string().trim().min(3).max(1000),
  frequencyPerDay: z.number().int().min(1).max(4),
  durationDays: z.number().int().min(1).max(365).optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  refillsAllowed: z.number().int().min(0).max(12).optional(),
  notes: z.string().trim().max(1000).optional(),
});

router.post("/", requireAuth, requireRole("doctor"), async (req, res) => {
  const parsed = createPrescriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid prescription" });
  }
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  if (!doctorProfile) return res.status(404).json({ message: "No doctor profile for this account" });

  const pairing = await storage.getPairingRequest(parsed.data.pairingRequestId);
  if (!pairing || pairing.doctorProfileId !== doctorProfile.id || pairing.status !== "accepted") {
    return res.status(404).json({ message: "You must be connected with this patient to prescribe" });
  }

  const startDate = new Date();
  const endDate = parsed.data.durationDays
    ? new Date(startDate.getTime() + parsed.data.durationDays * 24 * 60 * 60 * 1000)
    : null;

  const prescription = await storage.createPrescription({
    pairingRequestId: pairing.id,
    patientUserId: pairing.patientUserId,
    doctorProfileId: doctorProfile.id,
    appointmentId: parsed.data.appointmentId || null,
    medicationName: parsed.data.medicationName,
    instructions: parsed.data.instructions,
    frequencyPerDay: parsed.data.frequencyPerDay,
    durationDays: parsed.data.durationDays ?? null,
    quantity: parsed.data.quantity ?? null,
    refillsAllowed: parsed.data.refillsAllowed ?? 0,
    notes: parsed.data.notes || null,
    startDate,
    endDate,
  });

  await logAudit({ actorUserId: userId, action: "prescription.created", targetType: "prescription", targetId: prescription.id });

  res.status(201).json(prescription);
});

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const list = await storage.getPrescriptionsByPatient(patientUserId);
  const results = await Promise.all(
    list.map(async (p) => {
      const doctor = await storage.getDoctorProfile(p.doctorProfileId);
      const medication = await storage.getMedicationByPrescriptionId(p.id);
      return {
        ...p,
        doctor: doctor ? { id: doctor.id, name: doctor.name, specialty: doctor.specialty } : null,
        tracked: !!medication,
        trackedMedicationId: medication?.id ?? null,
      };
    }),
  );
  res.json(results);
});

router.get("/doctor", requireAuth, requireRole("doctor"), async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  if (!doctorProfile) return res.status(404).json({ message: "No doctor profile for this account" });
  const list = await storage.getPrescriptionsByDoctorProfile(doctorProfile.id);
  const results = await Promise.all(
    list.map(async (p) => {
      const patient = await storage.getUser(p.patientUserId);
      return { ...p, patientName: patient?.name || "Patient" };
    }),
  );
  res.json(results);
});

router.patch("/:id/cancel", requireAuth, requireRole("doctor"), async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  const prescription = await storage.getPrescription(req.params.id);
  if (!doctorProfile || !prescription || prescription.doctorProfileId !== doctorProfile.id) {
    return res.status(404).json({ message: "Prescription not found" });
  }
  const updated = await storage.updatePrescriptionStatus(prescription.id, "cancelled");
  await logAudit({ actorUserId: userId, action: "prescription.cancelled", targetType: "prescription", targetId: prescription.id });
  res.json(updated);
});

router.post("/:id/refill", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const prescription = await storage.getPrescription(req.params.id);
  if (!prescription || prescription.patientUserId !== userId) {
    return res.status(404).json({ message: "Prescription not found" });
  }
  if (prescription.status !== "active") {
    return res.status(409).json({ message: "This prescription is no longer active" });
  }
  if (prescription.refillsUsed >= prescription.refillsAllowed) {
    return res.status(409).json({ message: "No refills remaining — contact your doctor" });
  }
  const updated = await storage.incrementPrescriptionRefills(prescription.id);
  if (!updated) {
    return res.status(409).json({ message: "No refills remaining — contact your doctor" });
  }
  // The only way a refill request reaches a person today is the patient's
  // message thread with that doctor, so post it there rather than only
  // counting it. (There is no pharmacy or e-prescribing connection.)
  const pairing = await storage.getPairingRequest(prescription.pairingRequestId);
  let notifiedDoctor = false;
  if (pairing && pairing.status === "accepted") {
    await storage.createMessage({
      pairingRequestId: pairing.id,
      senderUserId: userId,
      body: `Refill request: I'd like a refill of ${prescription.medicationName}. (Sent from my prescriptions page.)`,
    });
    notifiedDoctor = true;
  }
  await logAudit({ actorUserId: userId, action: "prescription.refill_requested", targetType: "prescription", targetId: prescription.id });
  res.json({ ...updated, notifiedDoctor });
});

// Adds an active prescription to the patient's daily medication tracking.
router.post("/:id/track", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const prescription = await storage.getPrescription(req.params.id);
  if (!prescription || prescription.patientUserId !== userId) {
    return res.status(404).json({ message: "Prescription not found" });
  }
  if (prescription.status !== "active") {
    return res.status(409).json({ message: "Only active prescriptions can be tracked" });
  }
  const existing = await storage.getMedicationByPrescriptionId(prescription.id);
  if (existing) {
    return res.status(409).json({ message: "This prescription is already being tracked" });
  }

  const medication = await storage.createMedication({
    patientUserId: userId,
    prescriptionId: prescription.id,
    name: prescription.medicationName,
    instructions: prescription.instructions,
    scheduleTimes: scheduleTimesForFrequency(prescription.frequencyPerDay),
    startDate: prescription.startDate,
    endDate: prescription.endDate,
    active: true,
  });

  await logAudit({ actorUserId: userId, action: "medication.tracking_started", targetType: "medication", targetId: medication.id });

  res.status(201).json(medication);
});

export default router;
