import { Router } from "express";
import { storage } from "../storage";
import { requireApprovedDoctor } from "../middleware/doctor";
import { getAvailability } from "../services/schedulingService";
import { requireAuth, requireRole } from "../middleware/auth";
import { clockInZone, dateKeyInZone, isMedicationActiveOn, resolvePatientTimezone } from "../lib/localTime";

const router = Router();


// Single-call aggregator answering "what do I need to know or do today?" —
// every field here is a real fact pulled from the patient's own data, never
// inferred or AI-generated.
router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const patientUser = await storage.getUser(patientUserId);
  const tz = await resolvePatientTimezone(req, patientUser!);
  const todayKey = () => dateKeyInZone(new Date(), tz);

  const [appointments, medications, todayLogs, prescriptions, followUps, pairings] = await Promise.all([
    storage.getAppointmentsByPatient(patientUserId),
    storage.getMedicationsByPatient(patientUserId),
    storage.getMedicationLogsByPatientAndDate(patientUserId, todayKey()),
    storage.getPrescriptionsByPatient(patientUserId),
    storage.getFollowUpTasksByPatient(patientUserId),
    storage.getAcceptedPairingsByPatient(patientUserId),
  ]);

  const upcoming = appointments
    .filter((a) => a.status === "requested" || a.status === "confirmed")
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())[0];
  let upcomingAppointment = null;
  if (upcoming) {
    const doctor = await storage.getDoctorProfile(upcoming.doctorProfileId);
    upcomingAppointment = { ...upcoming, doctorName: doctor?.name || "your doctor" };
  }

  const logBySlot = new Map(todayLogs.map((l) => [`${l.medicationId}:${l.doseTime}`, l.status]));
  const todaysSchedule = medications
    .filter((m) => isMedicationActiveOn(m, todayKey(), tz))
    .flatMap((m) => m.scheduleTimes.map((time) => ({ medicationName: m.name, time, status: logBySlot.get(`${m.id}:${time}`) || "upcoming" })))
    .sort((a, b) => a.time.localeCompare(b.time));
  const nextMedicationReminder = todaysSchedule.find((d) => d.status === "upcoming") || null;
  const dosesRemainingToday = todaysSchedule.filter((d) => d.status === "upcoming").length;

  let recentDoctorMessage: { pairingId: string; doctorName: string; body: string; createdAt: Date | null; fromDoctor: boolean } | null = null;
  let recentDoctorMessageAt = 0;
  for (const pairing of pairings) {
    const msgs = await storage.getMessagesByPairing(pairing.id);
    const last = msgs[msgs.length - 1];
    const lastAt = last?.createdAt ? new Date(last.createdAt).getTime() : 0;
    if (last && lastAt > recentDoctorMessageAt) {
      const doctor = await storage.getDoctorProfile(pairing.doctorProfileId);
      recentDoctorMessage = { pairingId: pairing.id, doctorName: doctor?.name || "your doctor", body: last.body, createdAt: last.createdAt, fromDoctor: last.senderUserId !== patientUserId };
      recentDoctorMessageAt = lastAt;
    }
  }

  const outstandingFollowUp = followUps.find((f) => f.status === "open") || null;

  const activePrescriptionsCount = prescriptions.filter((p) => p.status === "active").length;

  res.json({
    upcomingAppointment,
    nextMedicationReminder,
    dosesRemainingToday,
    recentDoctorMessage,
    outstandingFollowUp,
    activePrescriptionsCount,
    careTeamCount: pairings.length,
  });
});

router.get("/doctor", requireAuth, requireApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  if (!doctorProfile) return res.status(404).json({ message: "No doctor profile for this account" });

  const [appointments, pairings, prescriptions] = await Promise.all([
    storage.getAppointmentsByDoctorProfile(doctorProfile.id),
    storage.getPairingRequestsByDoctorProfile(doctorProfile.id),
    storage.getPrescriptionsByDoctorProfile(doctorProfile.id),
  ]);

  // A doctor's "today" is their own working day, in their own time zone.
  const tz = doctorProfile.timezone;
  const today = dateKeyInZone(new Date(), tz);
  const todaysAppointments = [];
  for (const a of appointments) {
    if ((a.status === "requested" || a.status === "confirmed") && dateKeyInZone(new Date(a.scheduledAt), tz) === today) {
      const patient = await storage.getUser(a.patientUserId);
      todaysAppointments.push({ ...a, patientName: patient?.name || "Patient" });
    }
  }

  // Upcoming = the next seven days after today, soonest first.
  const upcoming = [];
  const horizon = Date.now() + 7 * 86_400_000;
  for (const a of appointments.sort((x, y) => new Date(x.scheduledAt).getTime() - new Date(y.scheduledAt).getTime())) {
    const at = new Date(a.scheduledAt).getTime();
    if ((a.status === "requested" || a.status === "confirmed") && at > Date.now() && at <= horizon && dateKeyInZone(new Date(a.scheduledAt), tz) !== today) {
      const patient = await storage.getUser(a.patientUserId);
      upcoming.push({ ...a, patientName: patient?.name || "Patient" });
      if (upcoming.length >= 8) break;
    }
  }
  const hours = await getAvailability(doctorProfile.id);

  res.json({
    todaysAppointments: todaysAppointments.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()),
    upcomingAppointments: upcoming,
    pendingConnectionRequests: pairings.filter((p) => p.status === "requested").length,
    pendingAppointmentConfirmations: appointments.filter((a) => a.status === "requested").length,
    activePatients: pairings.filter((p) => p.status === "accepted").length,
    activePrescriptionsWritten: prescriptions.filter((p) => p.status === "active").length,
    // Drafts the doctor started but has not reviewed and authorized yet.
    draftPrescriptions: prescriptions.filter((p) => p.status === "draft").length,
    // Without published hours, nobody can book this doctor, and the page says so.
    hasPublishedHours: hours.length > 0,
  });
});

export default router;
