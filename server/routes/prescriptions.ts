import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireApprovedDoctor } from "../middleware/doctor";
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

// Routes in this file that write clinical records are for the doctor of
// record only (an approved doctor connected to the patient). The patient sees
// a prescription only after it has been authorized, and only their own.
const ROUTES = ["oral", "topical", "inhaled", "nasal", "ophthalmic", "otic", "rectal", "subcutaneous", "intramuscular", "other"] as const;

const text = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));

const prescriptionFields = z.object({
  medicationName: z.string().trim().min(2).max(200),
  activeIngredient: text(200),
  strength: text(100),
  formulation: text(100),
  dose: z.string().trim().min(1, "Enter the dose").max(200),
  route: z.enum(ROUTES),
  frequencyPerDay: z.number().int().min(1).max(4),
  durationDays: z.number().int().min(1).max(365).optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  refillsAllowed: z.number().int().min(0).max(12).optional(),
  instructions: z.string().trim().min(3).max(1000),
  warnings: text(1000),
  notes: text(1000),
  appointmentId: z.string().min(1).optional(),
  // The prescriber must answer this explicitly. Avela is not a channel for
  // controlled substances, which need jurisdiction-specific e-prescribing.
  controlledSubstance: z.boolean(),
});

const createSchema = prescriptionFields.extend({ pairingRequestId: z.string().min(1) });
const editSchema = prescriptionFields.omit({ appointmentId: true }).partial().extend({ controlledSubstance: z.boolean() });

const CONTROLLED_MESSAGE =
  "Controlled substances can't be recorded in Avela. Prescribe them through your jurisdiction's approved electronic prescribing system.";

function draftFields(d: z.infer<typeof prescriptionFields>) {
  return {
    medicationName: d.medicationName,
    activeIngredient: d.activeIngredient,
    strength: d.strength,
    formulation: d.formulation,
    dose: d.dose,
    route: d.route,
    frequencyPerDay: d.frequencyPerDay,
    durationDays: d.durationDays ?? null,
    quantity: d.quantity ?? null,
    refillsAllowed: d.refillsAllowed ?? 0,
    instructions: d.instructions,
    warnings: d.warnings,
    notes: d.notes,
  };
}

// Creates a DRAFT. Nothing is visible to the patient until it is authorized.
router.post("/", requireAuth, requireApprovedDoctor, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid prescription" });
  if (parsed.data.controlledSubstance) return res.status(422).json({ message: CONTROLLED_MESSAGE, code: "controlled_substance" });

  const userId = (req as any).userId as string;
  const doctorProfile = (req as any).doctorProfile;
  const pairing = await storage.getPairingRequest(parsed.data.pairingRequestId);
  if (!pairing || pairing.doctorProfileId !== doctorProfile.id || pairing.status !== "accepted") {
    return res.status(404).json({ message: "You must be connected with this patient to prescribe" });
  }
  if (parsed.data.appointmentId) {
    const appt = await storage.getAppointment(parsed.data.appointmentId);
    if (!appt || appt.doctorProfileId !== doctorProfile.id || appt.patientUserId !== pairing.patientUserId) {
      return res.status(404).json({ message: "Appointment not found" });
    }
  }

  const prescription = await storage.createPrescription({
    pairingRequestId: pairing.id,
    patientUserId: pairing.patientUserId,
    doctorProfileId: doctorProfile.id,
    appointmentId: parsed.data.appointmentId || null,
    ...draftFields(parsed.data),
    status: "draft",
  });
  await storage.addPrescriptionEvent(prescription.id, userId, "drafted");
  await logAudit({ actorUserId: userId, action: "prescription.drafted", targetType: "prescription", targetId: prescription.id });
  res.status(201).json(prescription);
});

async function ownDraftOrActive(req: any, res: any) {
  const doctorProfile = req.doctorProfile;
  const prescription = await storage.getPrescription(req.params.id);
  if (!prescription || prescription.doctorProfileId !== doctorProfile.id) {
    res.status(404).json({ message: "Prescription not found" });
    return null;
  }
  return prescription;
}

router.patch("/:id", requireAuth, requireApprovedDoctor, async (req, res) => {
  const prescription = await ownDraftOrActive(req, res);
  if (!prescription) return;
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid prescription" });
  if (parsed.data.controlledSubstance) return res.status(422).json({ message: CONTROLLED_MESSAGE, code: "controlled_substance" });
  if (prescription.status !== "draft") {
    return res.status(409).json({ message: "An authorized prescription can't be edited. Cancel it and write a new one." });
  }
  const { controlledSubstance: _ignored, ...rest } = parsed.data;
  const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const updated = await storage.updatePrescriptionDraft(prescription.id, fields as any);
  if (!updated) return res.status(409).json({ message: "An authorized prescription can't be edited. Cancel it and write a new one." });
  await storage.addPrescriptionEvent(prescription.id, (req as any).userId, "edited");
  res.json(updated);
});

// The clinician's explicit authorization. This is the moment the record
// becomes real to the patient, so it demands a deliberate confirmation.
router.post("/:id/authorize", requireAuth, requireApprovedDoctor, async (req, res) => {
  const prescription = await ownDraftOrActive(req, res);
  if (!prescription) return;
  if (req.body?.confirm !== true) {
    return res.status(400).json({ message: "Confirm that you have reviewed this prescription before authorizing it." });
  }
  const userId = (req as any).userId as string;
  const updated = await storage.authorizePrescription(prescription.id, userId, new Date());
  if (!updated) return res.status(409).json({ message: "This prescription is not a draft." });
  await storage.addPrescriptionEvent(prescription.id, userId, "authorized");
  await logAudit({ actorUserId: userId, action: "prescription.authorized", targetType: "prescription", targetId: prescription.id });
  await storage.createNotification({
    userId: prescription.patientUserId,
    kind: "prescription.authorized",
    params: { doctorName: (req as any).doctorProfile.name },
    link: "/prescriptions",
  });
  res.json(updated);
});

router.get("/doctor", requireAuth, requireApprovedDoctor, async (req, res) => {
  const doctorProfile = (req as any).doctorProfile;
  await storage.expireDuePrescriptions(new Date());
  const list = await storage.getPrescriptionsByDoctorProfile(doctorProfile.id);
  const results = await Promise.all(
    list.map(async (p) => {
      const patient = await storage.getUser(p.patientUserId);
      return { ...p, patientName: patient?.name || "Patient" };
    }),
  );
  res.json(results);
});

router.get("/:id/history", requireAuth, requireApprovedDoctor, async (req, res) => {
  const prescription = await ownDraftOrActive(req, res);
  if (!prescription) return;
  const events = await storage.getPrescriptionEvents(prescription.id);
  res.json(events.map((e) => ({ id: e.id, event: e.event, actorUserId: e.actorUserId, createdAt: e.createdAt })));
});

router.patch("/:id/cancel", requireAuth, requireApprovedDoctor, async (req, res) => {
  const prescription = await ownDraftOrActive(req, res);
  if (!prescription) return;
  const userId = (req as any).userId as string;
  const wasAuthorized = prescription.status === "active";
  const updated = await storage.cancelPrescription(prescription.id);
  if (!updated) return res.status(409).json({ message: "This prescription can no longer be cancelled." });
  await storage.addPrescriptionEvent(prescription.id, userId, "cancelled");
  await logAudit({ actorUserId: userId, action: "prescription.cancelled", targetType: "prescription", targetId: prescription.id });
  if (wasAuthorized) {
    await storage.createNotification({
      userId: prescription.patientUserId,
      kind: "prescription.cancelled",
      params: { doctorName: (req as any).doctorProfile.name },
      link: "/prescriptions",
    });
  }
  res.json(updated);
});

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  await storage.expireDuePrescriptions(new Date());
  const list = await storage.getPrescriptionsByPatient(patientUserId);
  const results = await Promise.all(
    list.map(async (p) => {
      const doctor = await storage.getDoctorProfile(p.doctorProfileId);
      const medication = await storage.getMedicationByPrescriptionId(p.id);
      return {
        ...p,
        // Whatever the doctor wrote privately for themselves is not for the patient.
        notes: undefined,
        doctor: doctor ? { id: doctor.id, name: doctor.name, specialty: doctor.specialty } : null,
        tracked: !!medication,
        trackedMedicationId: medication?.id ?? null,
      };
    }),
  );
  res.json(results);
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
