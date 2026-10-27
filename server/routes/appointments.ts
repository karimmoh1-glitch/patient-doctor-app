import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { runAsSystem } from "../dbContext";
import { requireApprovedDoctor, requirePatientOrApprovedDoctor } from "../middleware/doctor";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";
import { getVideoProvider, videoAvailable } from "../services/videoService";
import { bookSlot, getOpenSlots, MAX_HORIZON_DAYS, SLOT_MINUTES } from "../services/schedulingService";

const router = Router();

const APPOINTMENT_TYPES = ["Video Visit", "Phone Call", "In-Person"] as const;

const createAppointmentSchema = z.object({
  pairingRequestId: z.string().min(1),
  // A video visit can only be booked once a real video provider is configured.
  type: z.enum(APPOINTMENT_TYPES).refine((t) => t !== "Video Visit" || videoAvailable(), "Video visits aren't available in Avela yet. Please choose a phone call or an in-person visit."),
  reason: z.string().trim().min(3).max(1000),
  scheduledAt: z.string().datetime(),
});

async function getAcceptedPairingForPatient(patientUserId: string, pairingRequestId: string) {
  const pairing = await storage.getPairingRequest(pairingRequestId);
  if (!pairing || pairing.patientUserId !== patientUserId || pairing.status !== "accepted") return null;
  return pairing;
}

const BOOKING_FAILURE_MESSAGES = {
  no_availability: {
    status: 409,
    message: "This doctor hasn't published appointment times yet. You can send them a message to ask when they're free.",
  },
  slot_unavailable: {
    status: 409,
    message: "That time is no longer available. Please choose another time.",
  },
  not_connected: {
    status: 409,
    message: "You're no longer connected with this doctor.",
  },
} as const;

// Times a connected patient may actually book with this doctor. Only the
// slot times are returned — nothing about other patients' appointments.
router.get("/slots", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const pairingRequestId = typeof req.query.pairingRequestId === "string" ? req.query.pairingRequestId : "";
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? "14"), 10) || 14, 1), MAX_HORIZON_DAYS);
  const pairing = await getAcceptedPairingForPatient(patientUserId, pairingRequestId);
  if (!pairing) {
    return res.status(404).json({ message: "You must be connected with this doctor to see their available times" });
  }
  const open = await getOpenSlots(pairing.doctorProfileId, days);
  res.json({
    doctorTimezone: open.timezone,
    hasPublishedAvailability: open.hasPublishedAvailability,
    slotMinutes: SLOT_MINUTES,
    slots: open.slots.map((d) => d.toISOString()),
  });
});

router.post("/", requireAuth, requireRole("patient"), async (req, res) => {
  const parsed = createAppointmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid appointment request" });
  }
  const patientUserId = (req as any).userId as string;
  const pairing = await getAcceptedPairingForPatient(patientUserId, parsed.data.pairingRequestId);
  if (!pairing) {
    return res.status(404).json({ message: "You must be connected with this doctor before booking an appointment" });
  }

  const result = await bookSlot({
    pairing,
    type: parsed.data.type,
    reason: parsed.data.reason,
    start: new Date(parsed.data.scheduledAt),
  });
  if (!result.ok) {
    const failure = BOOKING_FAILURE_MESSAGES[result.reason];
    return res.status(failure.status).json({ message: failure.message, code: result.reason });
  }

  await logAudit({ actorUserId: patientUserId, action: "appointment.requested", targetType: "appointment", targetId: result.appointment.id });

  res.status(201).json(result.appointment);
});

const rescheduleSchema = z.object({ scheduledAt: z.string().datetime() });

router.patch("/:id/reschedule", requireAuth, requireRole("patient"), async (req, res) => {
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "A new time is required" });
  const patientUserId = (req as any).userId as string;
  const appointment = await storage.getAppointment(req.params.id);
  if (!appointment || appointment.patientUserId !== patientUserId) {
    return res.status(404).json({ message: "Appointment not found" });
  }
  if (appointment.status !== "requested" && appointment.status !== "confirmed") {
    return res.status(409).json({ message: "This appointment can no longer be rescheduled" });
  }
  const pairing = await getAcceptedPairingForPatient(patientUserId, appointment.pairingRequestId);
  if (!pairing) {
    return res.status(409).json({ message: "You're no longer connected with this doctor" });
  }

  const result = await bookSlot({
    pairing,
    type: appointment.type,
    reason: appointment.reason,
    start: new Date(parsed.data.scheduledAt),
    rescheduleAppointmentId: appointment.id,
  });
  if (!result.ok) {
    const failure = BOOKING_FAILURE_MESSAGES[result.reason];
    return res.status(failure.status).json({ message: failure.message, code: result.reason });
  }

  await logAudit({
    actorUserId: patientUserId,
    action: "appointment.rescheduled",
    targetType: "appointment",
    targetId: appointment.id,
  });
  res.json(result.appointment);
});

function serializeWithDoctor(appointment: Awaited<ReturnType<typeof storage.getAppointment>>, doctor: any) {
  if (!appointment) return null;
  return {
    ...appointment,
    doctor: doctor ? { id: doctor.id, name: doctor.name, specialty: doctor.specialty } : null,
  };
}

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const list = await storage.getAppointmentsByPatient(patientUserId);
  const results = await Promise.all(
    list.map(async (a) => {
      const doctor = await storage.getDoctorProfile(a.doctorProfileId);
      return serializeWithDoctor(a, doctor);
    }),
  );
  res.json(results);
});

router.get("/doctor", requireAuth, requireApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  if (!doctorProfile) return res.status(404).json({ message: "No doctor profile for this account" });
  const list = await storage.getAppointmentsByDoctorProfile(doctorProfile.id);
  const results = await Promise.all(
    list.map(async (a) => {
      const patient = await storage.getUser(a.patientUserId);
      return { ...a, patientName: patient?.name || "Unknown patient" };
    }),
  );
  res.json(results);
});

router.get("/:id", requireAuth, requirePatientOrApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const role = (req as any).userRole as string;
  const appointment = await storage.getAppointment(req.params.id);
  if (!appointment) return res.status(404).json({ message: "Appointment not found" });

  if (role === "patient" && appointment.patientUserId !== userId) {
    return res.status(404).json({ message: "Appointment not found" });
  }
  if (role === "doctor") {
    const doctorProfile = await storage.getDoctorProfileByUserId(userId);
    if (!doctorProfile || doctorProfile.id !== appointment.doctorProfileId) {
      return res.status(404).json({ message: "Appointment not found" });
    }
  }

  const doctor = await storage.getDoctorProfile(appointment.doctorProfileId);
  const patient = await storage.getUser(appointment.patientUserId);
  res.json({
    ...appointment,
    doctor: doctor ? { id: doctor.id, name: doctor.name, specialty: doctor.specialty, bio: doctor.bio } : null,
    patientName: patient?.name || "Patient",
  });
});

// What happened to this appointment and when, for the two people it concerns. Reads the append-only audit record; who did it is
// shown as a role ("patient", "doctor"), never a name or an account id.
router.get("/:id/history", requireAuth, requirePatientOrApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const role = (req as any).userRole as string;
  const appointment = await storage.getAppointment(req.params.id);
  if (!appointment) return res.status(404).json({ message: "Appointment not found" });
  if (role === "patient" && appointment.patientUserId !== userId) return res.status(404).json({ message: "Appointment not found" });
  if (role === "doctor") {
    const doctorProfile = await storage.getDoctorProfileByUserId(userId);
    if (!doctorProfile || doctorProfile.id !== appointment.doctorProfileId) return res.status(404).json({ message: "Appointment not found" });
  }
  // Authorised above: the audit table itself is not readable by an ordinary person, so this one read is made as the system.
  const rows = await runAsSystem(() => storage.getAuditLogsForTarget("appointment", appointment.id));
  const patientId = appointment.patientUserId;
  const events = rows
    .filter((r) => r.action.startsWith("appointment.") && r.action !== "appointment.video_joined")
    .map((r) => ({ action: r.action.slice("appointment.".length), at: r.createdAt, by: r.actorUserId === patientId ? "patient" : "doctor" }));
  res.json(events);
});

// Joining a video visit. Today no provider is configured, so this says so
// plainly and tells the caller what to do instead; the screens never offer a
// join button unless this returns available: true.
router.get("/:id/video", requireAuth, requirePatientOrApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const role = (req as any).userRole as string;
  const appointment = await storage.getAppointment(req.params.id);
  if (!appointment) return res.status(404).json({ message: "Appointment not found" });
  let allowed = role === "patient" && appointment.patientUserId === userId;
  if (role === "doctor") {
    const profile = await storage.getDoctorProfileByUserId(userId);
    allowed = !!profile && profile.id === appointment.doctorProfileId;
  }
  if (!allowed) return res.status(404).json({ message: "Appointment not found" });
  if (appointment.status !== "confirmed") {
    return res.status(409).json({ available: false, message: "Video can only be used for a visit the doctor has confirmed." });
  }

  const provider = getVideoProvider();
  if (!provider) {
    return res.json({
      available: false,
      fallback: "phone",
      message: "Video calling isn't set up in Avela yet. Your doctor will phone you, or send you a link, at the time of your visit.",
    });
  }
  const user = await storage.getUser(userId);
  const room = await provider.joinRoom({
    appointmentId: appointment.id,
    participantUserId: userId,
    participantName: user?.name ?? "Participant",
    startsAt: appointment.scheduledAt,
    endsAt: new Date(appointment.scheduledAt.getTime() + appointment.durationMinutes * 60_000),
  });
  await logAudit({ actorUserId: userId, action: "appointment.video_joined", targetType: "appointment", targetId: appointment.id });
  res.json({ available: true, joinUrl: room.joinUrl, expiresAt: room.expiresAt });
});

router.patch("/:id/confirm", requireAuth, requireApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  const appointment = await storage.getAppointment(req.params.id);
  if (!doctorProfile || !appointment || appointment.doctorProfileId !== doctorProfile.id) {
    return res.status(404).json({ message: "Appointment not found" });
  }
  const updated = await storage.transitionAppointmentStatus(appointment.id, ["requested"], "confirmed");
  if (!updated) {
    return res.status(409).json({ message: "This appointment has already been responded to" });
  }
  await logAudit({ actorUserId: userId, action: "appointment.confirmed", targetType: "appointment", targetId: appointment.id });
  res.json(updated);
});

router.patch("/:id/cancel", requireAuth, requirePatientOrApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const role = (req as any).userRole as string;
  const appointment = await storage.getAppointment(req.params.id);
  if (!appointment) return res.status(404).json({ message: "Appointment not found" });

  if (role === "patient" && appointment.patientUserId !== userId) {
    return res.status(404).json({ message: "Appointment not found" });
  }
  if (role === "doctor") {
    const doctorProfile = await storage.getDoctorProfileByUserId(userId);
    if (!doctorProfile || doctorProfile.id !== appointment.doctorProfileId) {
      return res.status(404).json({ message: "Appointment not found" });
    }
  }
  const updated = await storage.transitionAppointmentStatus(appointment.id, ["requested", "confirmed"], "cancelled");
  if (!updated) {
    return res.status(409).json({ message: "This appointment can no longer be cancelled" });
  }
  await logAudit({ actorUserId: userId, action: "appointment.cancelled", targetType: "appointment", targetId: appointment.id });
  res.json(updated);
});

const questionsSchema = z.object({ questionsForDoctor: z.array(z.string().trim().min(1).max(500)).max(20) });

router.patch("/:id/questions", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = questionsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid questions list" });
  const appointment = await storage.getAppointment(req.params.id);
  if (!appointment || appointment.patientUserId !== userId) {
    return res.status(404).json({ message: "Appointment not found" });
  }
  const updated = await storage.updateAppointmentQuestions(appointment.id, parsed.data.questionsForDoctor);
  res.json(updated);
});

const completeSchema = z.object({
  doctorNotes: z.string().trim().min(1).max(4000),
  followUpInstructions: z.string().trim().max(2000).optional(),
  followUpDate: z.string().datetime().optional(),
});

router.post("/:id/complete", requireAuth, requireApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  const appointment = await storage.getAppointment(req.params.id);
  if (!doctorProfile || !appointment || appointment.doctorProfileId !== doctorProfile.id) {
    return res.status(404).json({ message: "Appointment not found" });
  }
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message || "Doctor notes are required" });
  }

  const followUpDate = parsed.data.followUpDate ? new Date(parsed.data.followUpDate) : null;
  const updated = await storage.completeAppointmentWithNotes(
    appointment.id,
    parsed.data.doctorNotes,
    parsed.data.followUpInstructions || null,
    followUpDate,
  );
  if (!updated) {
    return res.status(409).json({ message: "This visit has already been completed or was cancelled" });
  }

  // Follow-up engine: turn the doctor's plain-language instructions into
  // trackable patient tasks automatically.
  if (parsed.data.followUpInstructions) {
    await storage.createFollowUpTask({
      patientUserId: appointment.patientUserId,
      appointmentId: appointment.id,
      doctorProfileId: doctorProfile.id,
      title: "Follow doctor's instructions",
      detail: parsed.data.followUpInstructions,
      dueDate: null,
      sourceType: "doctor_instruction",
    });
  }
  if (followUpDate) {
    await storage.createFollowUpTask({
      patientUserId: appointment.patientUserId,
      appointmentId: appointment.id,
      doctorProfileId: doctorProfile.id,
      title: `Schedule follow-up with ${doctorProfile.name}`,
      detail: null,
      dueDate: followUpDate,
      sourceType: "appointment",
    });
  }

  await logAudit({ actorUserId: userId, action: "appointment.completed", targetType: "appointment", targetId: appointment.id });
  res.json(updated);
});

// "Prepare for my appointment" — organizes the patient's own authorized
// data around one upcoming visit. Pure aggregation, no diagnosis/inference.
router.get("/:id/prepare", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const appointment = await storage.getAppointment(req.params.id);
  if (!appointment || appointment.patientUserId !== userId) {
    return res.status(404).json({ message: "Appointment not found" });
  }
  const doctor = await storage.getDoctorProfile(appointment.doctorProfileId);
  const [medications, prescriptions, documents, recentMessages] = await Promise.all([
    storage.getMedicationsByPatient(userId),
    storage.getPrescriptionsByPatient(userId),
    storage.getDocumentsByPatient(userId),
    storage.getMessagesByPairing(appointment.pairingRequestId),
  ]);

  res.json({
    appointment,
    doctor: doctor ? { id: doctor.id, name: doctor.name, specialty: doctor.specialty, bio: doctor.bio } : null,
    questionsForDoctor: appointment.questionsForDoctor,
    activeMedications: medications.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, instructions: m.instructions })),
    activePrescriptions: prescriptions
      .filter((p) => p.status === "active" && p.doctorProfileId === appointment.doctorProfileId)
      .map((p) => ({ id: p.id, medicationName: p.medicationName, instructions: p.instructions })),
    recentDocuments: documents.slice(0, 5).map((d) => ({ id: d.id, title: d.title, category: d.category, createdAt: d.createdAt })),
    recentMessages: recentMessages.slice(-5).map((m) => ({ senderUserId: m.senderUserId, body: m.body, createdAt: m.createdAt })),
  });
});

export default router;
