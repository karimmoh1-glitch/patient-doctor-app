import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { exportProfile } from "../services/healthProfile";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { makeLimiter, userKey } from "../middleware/rateLimit";
import { logAudit } from "../services/auditService";

const router = Router();

const exportLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 5, keyGenerator: userKey, message: "You can download your data a few times an hour. Please try again later." });
const deleteLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 5, failuresOnly: true, keyGenerator: userKey, message: "Too many attempts. Please try again later." });

// A patient's own information, as a file they can keep. It contains only what
// belongs to them: never another person's details, never a doctor's private
// notes, and no file contents (the list of saved papers, not the papers).
router.get("/export", requireAuth, requireRole("patient"), exportLimiter, async (req, res) => {
  const userId = (req as any).userId as string;
  const user = (await storage.getUser(userId))!;
  const [reports, pairings, appointments, prescriptions, medications, reminders, docs, followUps, grants, circle, ai] = await Promise.all([
    storage.getSymptomReportsByPatient(userId),
    storage.getPairingRequestsByPatient(userId),
    storage.getAppointmentsByPatient(userId),
    storage.getPrescriptionsByPatient(userId), // authorized records only; drafts are never the patient's
    storage.getMedicationsByPatient(userId),
    storage.getRemindersByPatient(userId),
    storage.getDocumentsByPatient(userId),
    storage.getFollowUpTasksByPatient(userId),
    storage.getSharingGrantsByPatient(userId),
    storage.getCareCircleByPatient(userId),
    storage.getAiMessagesByUser(userId, 1000),
  ]);

  const doctorName = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!doctorName.has(id)) doctorName.set(id, (await storage.getDoctorProfile(id))?.name ?? "");
    return doctorName.get(id)!;
  };
  const messages: unknown[] = [];
  for (const p of pairings) {
    for (const m of await storage.getMessagesByPairing(p.id)) {
      messages.push({ with: await nameOf(p.doctorProfileId), from: m.senderUserId === userId ? "you" : "doctor", sentAt: m.createdAt, text: m.body });
    }
  }

  await logAudit({ actorUserId: userId, action: "account.exported", targetType: "user", targetId: userId });
  res.setHeader("Content-Disposition", `attachment; filename="avela-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    note: "This file holds your own information from Avela. It does not include other people's details or doctors' private notes, and saved files are listed but not included.",
    account: {
      name: user.name, email: user.email, state: user.state, phone: user.phone, language: user.language, timezone: user.timezone,
      emergencyContact: { name: user.emergencyContactName, phone: user.emergencyContactPhone },
      allergies: user.allergiesText, emergencyNotes: user.emergencyNotes, createdAt: user.createdAt,
    },
    whatYouWroteWhenAskingForHelp: reports.map((r) => ({ at: r.createdAt, state: r.state, text: r.symptomText, how: r.inputMethod })),
    doctorConnections: await Promise.all(pairings.map(async (p) => ({ doctor: await nameOf(p.doctorProfileId), status: p.status, requestedAt: p.requestedAt, respondedAt: p.respondedAt }))),
    messages,
    appointments: await Promise.all(appointments.map(async (a) => ({
      doctor: await nameOf(a.doctorProfileId), type: a.type, reason: a.reason, scheduledAt: a.scheduledAt, status: a.status,
      visitNotesFromDoctor: a.doctorNotes, followUpInstructions: a.followUpInstructions, followUpDate: a.followUpDate,
    }))),
    prescriptions: await Promise.all(prescriptions.map(async (p) => ({
      doctor: await nameOf(p.doctorProfileId), medication: p.medicationName, strength: p.strength, dose: p.dose, route: p.route, instructions: p.instructions,
      warnings: p.warnings, status: p.status, authorizedAt: p.authorizedAt, startDate: p.startDate, endDate: p.endDate, sentToPharmacy: p.transmission !== "not_sent",
    }))),
    medicines: medications.map((m) => ({ name: m.name, instructions: m.instructions, times: m.scheduleTimes, startDate: m.startDate, endDate: m.endDate, tracked: m.active })),
    reminders: reminders.map((r) => ({ times: r.times, weekdays: r.weekdays, timezone: r.timezone, enabled: r.enabled, emailEnabled: r.emailEnabled })),
    savedPapers: docs.map((d) => ({ title: d.title, category: d.category, fileName: d.fileName, notes: d.notes, savedAt: d.createdAt })),
    followUpTasks: followUps.map((f) => ({ title: f.title, detail: f.detail, due: f.dueDate, status: f.status })),
    whoCanSeeWhat: grants.map((g) => ({ shared: { medicines: g.shareMedications, documents: g.shareDocuments, appointments: g.shareAppointments, everything: g.shareFullHistory }, since: g.grantedAt, endedAt: g.revokedAt })),
    careCircle: circle.map((c) => ({ name: c.name, relationship: c.relationshipLabel, status: c.status })),
    healthInformation: await exportProfile(userId),
    assistantConversation: ai.map((m) => ({ role: m.role, text: m.content, at: m.createdAt })),
  });
});

// Closing an account. It takes effect NOW (the person is signed out everywhere
// and cannot sign in), and a durable request is recorded for an operator to
// erase the records. The password is asked for again so a stolen session
// cannot quietly close someone's account.
router.post("/delete-request", requireAuth, requireRole("patient"), deleteLimiter, async (req, res) => {
  const parsed = z.object({ password: z.string().min(1), confirm: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Please confirm and enter your password." });
  const userId = (req as any).userId as string;
  const user = (await storage.getUser(userId))!;
  if (!(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    // 403, not 401: a 401 would make the app think the session had ended and sign the person out.
    return res.status(403).json({ message: "That password isn't right." });
  }
  const request = await storage.createDataRequest(userId, "deletion");
  await storage.deactivateUser(userId);
  await logAudit({ actorUserId: userId, action: "account.deletion_requested", targetType: "user", targetId: userId });
  res.status(202).json({ id: request.id });
});

export default router;
