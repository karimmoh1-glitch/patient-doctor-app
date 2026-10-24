import { Router } from "express";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { clockInZone, dateKeyInZone, resolvePatientTimezone } from "../lib/localTime";

const router = Router();


// Single-call aggregator answering "what do I need to know or do today?" —
// every field here is a real fact pulled from the patient's own data, never
// inferred or AI-generated.
router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const patientUser = await storage.getUser(patientUserId);
  const tz = await resolvePatientTimezone(req, patientUser!);
  const todayKey = () => dateKeyInZone(new Date(), tz);

  const [appointments, medications, todayLogs, prescriptions, pharmacyOrders, followUps, pairings] = await Promise.all([
    storage.getAppointmentsByPatient(patientUserId),
    storage.getMedicationsByPatient(patientUserId),
    storage.getMedicationLogsByPatientAndDate(patientUserId, todayKey()),
    storage.getPrescriptionsByPatient(patientUserId),
    storage.getPharmacyOrdersByPatient(patientUserId),
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
    .filter((m) => m.active)
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

  const activePharmacyOrder = pharmacyOrders.find((o) => o.status !== "delivered" && o.status !== "picked_up") || pharmacyOrders[0] || null;
  let pharmacyStatus = null;
  if (activePharmacyOrder) {
    const prescription = await storage.getPrescription(activePharmacyOrder.prescriptionId);
    pharmacyStatus = { orderId: activePharmacyOrder.id, medicationName: prescription?.medicationName || "medication", status: activePharmacyOrder.status, fulfillmentType: activePharmacyOrder.fulfillmentType };
  }

  res.json({
    upcomingAppointment,
    nextMedicationReminder,
    dosesRemainingToday,
    recentDoctorMessage,
    outstandingFollowUp,
    activePrescriptionsCount,
    pharmacyStatus,
    careTeamCount: pairings.length,
  });
});

router.get("/doctor", requireAuth, requireRole("doctor"), async (req, res) => {
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

  res.json({
    todaysAppointments: todaysAppointments.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()),
    pendingConnectionRequests: pairings.filter((p) => p.status === "requested").length,
    pendingAppointmentConfirmations: appointments.filter((a) => a.status === "requested").length,
    activePatients: pairings.filter((p) => p.status === "accepted").length,
    activePrescriptionsWritten: prescriptions.filter((p) => p.status === "active").length,
  });
});

export default router;
