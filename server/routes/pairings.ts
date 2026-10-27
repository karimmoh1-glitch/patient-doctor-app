import { Router } from "express";
import { makeLimiter, userKey } from "../middleware/rateLimit";
import { z } from "zod";
import { tellPatientAboutOrganizationStaff } from "../services/orgs";
import { storage } from "../storage";
import { runAsSystem } from "../dbContext";
import { requireApprovedDoctor } from "../middleware/doctor";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit, logAuditStrict } from "../services/auditService";
import { normalizeLang } from "../services/serverText";
import { sendPairingRequestedEmail, sendPairingAcceptedEmail } from "../services/emailService";

const router = Router();

// Each connection request can email a doctor, so one account can't fire them
// off without limit (also stops cancel-and-re-request spam).
const requestLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 12, keyGenerator: userKey, message: "You've sent a lot of requests. Please wait a while before sending more." });
const messageLimiter = makeLimiter({ windowMs: 60 * 1000, limit: 30, keyGenerator: userKey, message: "You're sending messages very quickly. Please slow down." });

const createPairingSchema = z.object({
  doctorProfileId: z.string().min(1),
  symptomReportId: z.string().min(1).optional(),
});

router.post("/", requireAuth, requireRole("patient"), requestLimiter, async (req, res) => {
  const parsed = createPairingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "doctorProfileId is required" });
  }
  const patientUserId = (req as any).userId as string;

  const doctor = await storage.getListableDoctorProfile(parsed.data.doctorProfileId);
  if (!doctor) {
    return res.status(404).json({ message: "Doctor not found" });
  }
  // Someone who has blocked, or been blocked by, this doctor cannot open a new connection. Same answer as "no such doctor".
  if (doctor.userId && (await storage.isBlockedEitherWay(patientUserId, doctor.userId))) {
    return res.status(404).json({ message: "Doctor not found" });
  }

  if (parsed.data.symptomReportId) {
    const report = await storage.getSymptomReport(parsed.data.symptomReportId);
    if (!report || report.patientUserId !== patientUserId) {
      return res.status(404).json({ message: "Symptom report not found" });
    }
  }

  let request;
  try {
    request = await storage.createPairingRequest({
      patientUserId,
      doctorProfileId: doctor.id,
      symptomReportId: parsed.data.symptomReportId || null,
    });
  } catch (err: any) {
    // Unique-index violation — an open request to this doctor already exists.
    // drizzle-orm wraps the raw pg error as `.cause`, so the code can land
    // on either the outer error or the wrapped one depending on driver
    // version — check both rather than assuming a shape.
    if (err?.code === "23505" || err?.cause?.code === "23505") {
      return res.status(409).json({ message: "You already have an open request with this doctor" });
    }
    throw err;
  }

  await logAudit({ actorUserId: patientUserId, action: "pairing.requested", targetType: "pairing_request", targetId: request.id });

  if (doctor.userId) {
    // Writing to the clinician is the server's doing (their address is private to them and the server), not a read by the patient.
    const contacts = await runAsSystem(() => storage.getUserContacts([doctor.userId!, patientUserId]));
    const doctorUser = contacts.get(doctor.userId);
    const patientUser = contacts.get(patientUserId);
    if (doctorUser && patientUser) {
      sendPairingRequestedEmail(doctorUser.email, doctor.name, patientUser.name, normalizeLang(doctorUser.language)).catch(() => {});
    }
  }

  res.status(201).json({ id: request.id, status: request.status });
});

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const requests = await storage.getPairingRequestsByPatient(patientUserId);

  const results = await Promise.all(
    requests.map(async (r) => {
      const doctor = await storage.getDoctorProfile(r.doctorProfileId);
      return {
        id: r.id,
        status: r.status,
        requestedAt: r.requestedAt,
        respondedAt: r.respondedAt,
        relationshipLabel: r.relationshipLabel,
        doctor: doctor && {
          id: doctor.id,
          name: doctor.name,
          specialty: doctor.specialty,
          state: doctor.state,
          bio: doctor.bio,
          // Only revealed once the doctor has accepted — server-enforced,
          // not just hidden client-side.
          phone: r.status === "accepted" ? doctor.phone : null,
        },
      };
    }),
  );

  res.json(results);
});

router.get("/doctor", requireAuth, requireApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  if (!doctorProfile) {
    return res.status(404).json({ message: "No doctor profile for this account" });
  }
  const requests = await storage.getPairingRequestsByDoctorProfile(doctorProfile.id);

  const results = await Promise.all(
    requests.map(async (r) => {
      const patient = await storage.getUser(r.patientUserId);
      return {
        id: r.id,
        status: r.status,
        requestedAt: r.requestedAt,
        patientUserId: r.patientUserId,
        patientName: patient?.name || "Unknown patient",
        symptomReportId: r.symptomReportId,
      };
    }),
  );

  res.json(results);
});

// A doctor opening a paired patient's symptom report — an audited
// PHI-access point, logged every time it's fetched.
router.get("/:id/symptom-report", requireAuth, requireApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!doctorProfile || !pairing || pairing.doctorProfileId !== doctorProfile.id) {
    return res.status(404).json({ message: "Pairing request not found" });
  }
  // The patient attached these symptoms to a request addressed to this
  // doctor, which is what lets the doctor decide whether to accept — but
  // that consent ends the moment the request is declined, cancelled, or the
  // connection is ended.
  if (pairing.status !== "requested" && pairing.status !== "accepted") {
    return res.status(403).json({ message: "This patient's information is no longer shared with you" });
  }
  if (!pairing.symptomReportId) {
    return res.status(404).json({ message: "No symptom report attached to this request" });
  }
  const report = await storage.getSymptomReport(pairing.symptomReportId);
  if (!report) {
    return res.status(404).json({ message: "Symptom report not found" });
  }

  await logAuditStrict({
    actorUserId: userId,
    action: "doctor.viewed_paired_patient",
    targetType: "symptom_report",
    targetId: report.id,
  });

  res.json({ symptomText: report.symptomText, state: report.state, createdAt: report.createdAt });
});

// What a connected doctor may read about the patient beyond the visits they
// share: only the categories the patient has granted, only while the
// connection is live, and every read is recorded in the patient's access log.
// Visit reasons and notes from OTHER doctors are never included.
router.get("/:id/shared-records", requireAuth, requireApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!doctorProfile || !pairing || pairing.doctorProfileId !== doctorProfile.id) {
    return res.status(404).json({ message: "Pairing request not found" });
  }
  if (pairing.status !== "accepted") {
    return res.status(403).json({ message: "This patient's information is no longer shared with you" });
  }

  const grant = await storage.getActiveSharingGrantFor(pairing.patientUserId, doctorProfile.id);
  const all = !!grant?.shareFullHistory;
  const result: Record<string, unknown> = { granted: [] as string[] };
  const granted = result.granted as string[];

  if (grant && (grant.shareMedications || all)) {
    const meds = await storage.getMedicationsByPatient(pairing.patientUserId);
    result.medications = meds.filter((m) => m.active).map((m) => ({ name: m.name, instructions: m.instructions, scheduleTimes: m.scheduleTimes }));
    granted.push("medications");
  }
  if (grant && (grant.shareDocuments || all)) {
    const docs = await storage.getDocumentsByPatient(pairing.patientUserId);
    result.documents = docs.map((d) => ({ id: d.id, title: d.title, category: d.category, hasFile: !!d.filePath, createdAt: d.createdAt }));
    granted.push("documents");
  }
  if (grant && (grant.shareAppointments || all)) {
    const appts = await storage.getAppointmentsByPatient(pairing.patientUserId);
    result.appointments = await Promise.all(
      appts
        .filter((a) => a.doctorProfileId !== doctorProfile.id)
        .map(async (a) => {
          const other = await storage.getDoctorProfile(a.doctorProfileId);
          // Dates, kind and specialty only — never the reason or any notes.
          return { type: a.type, scheduledAt: a.scheduledAt, status: a.status, specialty: other?.specialty ?? null };
        }),
    );
    granted.push("appointments");
  }
  if (grant && all) {
    const rx = await storage.getPrescriptionsByPatient(pairing.patientUserId);
    result.prescriptions = rx.filter((p) => p.doctorProfileId !== doctorProfile.id).map((p) => ({ medicationName: p.medicationName, status: p.status }));
    granted.push("prescriptions");
  }

  if (granted.length > 0) {
    await logAuditStrict({ actorUserId: userId, action: "doctor.viewed_shared_records", targetType: "user", targetId: pairing.patientUserId, metadata: { categories: granted } });
  }
  res.json(result);
});

async function respondToPairing(req: any, res: any, status: "accepted" | "declined") {
  const userId = req.userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!doctorProfile || !pairing || pairing.doctorProfileId !== doctorProfile.id) {
    return res.status(404).json({ message: "Pairing request not found" });
  }
  const updated = await storage.transitionPairingStatus(pairing.id, ["requested"], status);
  if (!updated) {
    return res.status(409).json({ message: "This request has already been responded to" });
  }

  await logAudit({ actorUserId: userId, action: `pairing.${status}`, targetType: "pairing_request", targetId: pairing.id });

  if (status === "accepted") {
    const patient = (await runAsSystem(() => storage.getUserContacts([pairing.patientUserId]))).get(pairing.patientUserId);
    if (patient) {
      sendPairingAcceptedEmail(patient.email, patient.name, doctorProfile.name, normalizeLang(patient.language)).catch(() => {});
    }
    // If this clinician belongs to an organization, the patient is told its staff can see their name and appointment times.
    await tellPatientAboutOrganizationStaff(pairing.patientUserId, userId, doctorProfile.name).catch(() => {});
  }

  res.json({ id: updated?.id, status: updated?.status });
}

router.patch("/:id/cancel", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!pairing || pairing.patientUserId !== userId) {
    return res.status(404).json({ message: "Pairing request not found" });
  }
  const updated = await storage.transitionPairingStatus(pairing.id, ["requested"], "cancelled");
  if (!updated) {
    return res.status(409).json({ message: "This request has already been responded to" });
  }
  await logAudit({ actorUserId: userId, action: "pairing.cancelled", targetType: "pairing_request", targetId: pairing.id });

  res.json({ id: updated?.id, status: updated?.status });
});

// The patient can always withdraw a doctor's access. Ending the connection stops, at once and in the database as well as here, everything
// that depended on it: the conversation, the symptom report, shared records, follow-up tasks. What the clinician authored or provided stays
// theirs (prescriptions they wrote; visits they provide or provided: docs/CONNECTION_END.md), and the patient keeps their whole history.
//
// Visits that have not happened yet are never dealt with silently: if there are any, the patient is told which and must say whether to
// cancel them or keep them (a kept visit stays workable by the clinician until it is over). Nothing else about the request decides it.
const endSchema = z.object({ upcomingVisits: z.enum(["cancel", "keep"]).optional() }).strict();

router.patch("/:id/end", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = endSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: "Say whether to cancel or keep the upcoming visits." });
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!pairing || pairing.patientUserId !== userId) {
    return res.status(404).json({ message: "Connection not found" });
  }
  if (pairing.status !== "accepted") return res.status(409).json({ message: "This connection is not active" });

  const decision = parsed.data.upcomingVisits;
  const result = await storage.endPairing(pairing.id, userId, pairing.doctorProfileId, decision, new Date());
  if (result.kind === "inactive") return res.status(409).json({ message: "This connection is not active" });
  if (result.kind === "decide") {
    return res.status(409).json({
      code: "decide_upcoming_visits",
      message: "You have visits booked with this clinician. Choose whether to cancel them or keep them before ending the connection.",
      upcoming: result.upcoming.map((a) => ({ id: a.id, type: a.type, scheduledAt: a.scheduledAt, status: a.status })),
    });
  }
  const updated = result.pairing;
  const visits = result.visits;
  const cancelled = result.cancelled.length;
  for (const a of result.cancelled) {
    await logAudit({ actorUserId: userId, action: "appointment.cancelled", targetType: "appointment", targetId: a.id, metadata: { because: "connection_ended" } });
  }
  await logAudit({
    actorUserId: userId, action: "pairing.ended", targetType: "pairing_request", targetId: pairing.id,
    metadata: { upcomingVisits: visits.length === 0 ? "none" : decision, cancelled, kept: visits.length - cancelled },
  });
  // The clinician is told, plainly and without the patient's name or any reason.
  const doctor = await storage.getDoctorProfile(pairing.doctorProfileId);
  if (doctor?.userId) {
    await storage.createNotification({ userId: doctor.userId, kind: "pairing.ended", params: { cancelled, kept: visits.length - cancelled }, link: "/doctor/patients" }).catch(() => {});
  }
  res.json({ id: updated.id, status: updated.status, visitsCancelled: cancelled, visitsKept: visits.length - cancelled });
});

const relationshipLabelSchema = z.object({ relationshipLabel: z.string().trim().max(60).nullable() });

router.patch("/:id/relationship-label", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = relationshipLabelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid label" });
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!pairing || pairing.patientUserId !== userId) {
    return res.status(404).json({ message: "Connection not found" });
  }
  const updated = await storage.setPairingRelationshipLabel(pairing.id, parsed.data.relationshipLabel || null);
  res.json(updated);
});

router.patch("/:id/accept", requireAuth, requireApprovedDoctor, (req, res) => respondToPairing(req, res, "accepted"));
router.patch("/:id/decline", requireAuth, requireApprovedDoctor, (req, res) => respondToPairing(req, res, "declined"));

// Chat is only ever available to the two parties on an accepted pairing —
// resolved here from the live userId/role, not a client-supplied claim.
async function getAuthorizedPairing(req: any) {
  const userId = req.userId as string;
  const role = req.userRole as string;
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!pairing) return null;
  if (role === "patient" && pairing.patientUserId === userId) return pairing;
  if (role === "doctor") {
    const doctorProfile = await storage.getDoctorProfileByUserId(userId);
    if (doctorProfile?.active && pairing.doctorProfileId === doctorProfile.id) return pairing;
  }
  return null;
}

const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  // The sending app's own id for this attempt. Reusing it on a retry returns the original instead of sending twice.
  clientMessageId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

const PAGE = 200;

/** The other person in a connection, and whether they let this person see when they have read a message. */
async function counterpartOf(pairing: { patientUserId: string; doctorProfileId: string }, viewerId: string) {
  if (viewerId === pairing.patientUserId) {
    const profile = await storage.getDoctorProfile(pairing.doctorProfileId);
    const user = profile?.userId ? await storage.getUser(profile.userId) : undefined;
    return { userId: profile?.userId ?? null, readReceipts: user?.readReceipts ?? true, name: profile?.name ?? "" };
  }
  const patient = await storage.getUser(pairing.patientUserId);
  return { userId: pairing.patientUserId, readReceipts: patient?.readReceipts ?? true, name: patient?.name ?? "" };
}

router.get("/:id/messages", requireAuth, async (req, res) => {
  const pairing = await getAuthorizedPairing(req);
  if (!pairing) return res.status(404).json({ message: "Pairing request not found" });
  if (pairing.status !== "accepted") {
    return res.status(403).json({ message: "Messaging is only available once the doctor has accepted" });
  }
  const userId = (req as any).userId as string;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), PAGE);
  const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : undefined;
  const list = await storage.getMessagesPage(pairing.id, { before, limit });
  // This person's app has now received these messages, which is the only evidence of "delivered" there is.
  await storage.markMessagesDelivered(pairing.id, userId);
  const other = await counterpartOf(pairing, userId);
  res.json(
    list.map((m) => {
      const mine = m.senderUserId === userId;
      // A sender sees "read" only if the recipient allows it; otherwise the most they learn is "delivered".
      const status = !mine ? undefined : m.readAt && other.readReceipts ? "read" : m.deliveredAt || m.readAt ? "delivered" : "sent";
      return { id: m.id, senderUserId: m.senderUserId, body: m.body, createdAt: m.createdAt, ...(mine ? { status } : {}) };
    }),
  );
});

router.post("/:id/messages", requireAuth, messageLimiter, async (req, res) => {
  const pairing = await getAuthorizedPairing(req);
  if (!pairing) return res.status(404).json({ message: "Pairing request not found" });
  if (pairing.status !== "accepted") {
    return res.status(403).json({ message: "Messaging is only available once the doctor has accepted" });
  }
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Message text is required" });
  }
  const userId = (req as any).userId as string;
  const other = await counterpartOf(pairing, userId);
  if (other.userId && (await storage.isBlockedEitherWay(userId, other.userId))) {
    return res.status(403).json({ message: "You can't send messages in this conversation." });
  }
  const { message, created } = await storage.createMessageIdempotent({
    pairingRequestId: pairing.id,
    senderUserId: userId,
    body: parsed.data.body,
    clientMessageId: parsed.data.clientMessageId ?? null,
  });
  // A retry of something already stored changes nothing and tells nobody twice.
  if (created) {
    // Tell the other person in-app, once until they've seen it (no message text, ever).
    const recipientId = other.userId;
    if (recipientId) {
      const senderName = userId === pairing.patientUserId ? (await storage.getUser(userId))?.name ?? "" : (await storage.getDoctorProfile(pairing.doctorProfileId))?.name ?? "";
      const link = `/chat/${pairing.id}?with=${encodeURIComponent(senderName)}`;
      if (!(await storage.hasUnreadNotification(recipientId, "message.new", link))) {
        await storage.createNotification({ userId: recipientId, kind: "message.new", params: { name: senderName }, link });
      }
    }
  }
  res.status(created ? 201 : 200).json({ id: message.id, senderUserId: message.senderUserId, body: message.body, createdAt: message.createdAt, status: "sent", duplicate: !created });
});

// The person has this conversation open and on screen: everything the other side sent is now read. Recorded only by
// the recipient's own app, and shown to the sender only if the recipient has read receipts on.
router.post("/:id/messages/read", requireAuth, async (req, res) => {
  const pairing = await getAuthorizedPairing(req);
  if (!pairing) return res.status(404).json({ message: "Pairing request not found" });
  if (pairing.status !== "accepted") return res.status(403).json({ message: "Messaging is only available once the doctor has accepted" });
  const userId = (req as any).userId as string;
  const read = await storage.markMessagesRead(pairing.id, userId);
  await storage.markNotificationsReadForLink(userId, `/chat/${pairing.id}`);
  res.json({ read });
});

export default router;
