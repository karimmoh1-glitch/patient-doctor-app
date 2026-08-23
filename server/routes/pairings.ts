import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";
import { sendPairingRequestedEmail, sendPairingAcceptedEmail } from "../services/emailService";

const router = Router();

const createPairingSchema = z.object({
  doctorProfileId: z.string().min(1),
  symptomReportId: z.string().min(1).optional(),
});

router.post("/", requireAuth, requireRole("patient"), async (req, res) => {
  const parsed = createPairingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "doctorProfileId is required" });
  }
  const patientUserId = (req as any).userId as string;

  const doctor = await storage.getDoctorProfile(parsed.data.doctorProfileId);
  if (!doctor || !doctor.active) {
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
    const doctorUser = await storage.getUser(doctor.userId);
    const patientUser = await storage.getUser(patientUserId);
    if (doctorUser && patientUser) {
      sendPairingRequestedEmail(doctorUser.email, doctor.name, patientUser.name).catch(() => {});
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
        doctor: doctor && {
          id: doctor.id,
          name: doctor.name,
          specialty: doctor.specialty,
          state: doctor.state,
          // Only revealed once the doctor has accepted — server-enforced,
          // not just hidden client-side.
          phone: r.status === "accepted" ? doctor.phone : null,
        },
      };
    }),
  );

  res.json(results);
});

router.get("/doctor", requireAuth, requireRole("doctor"), async (req, res) => {
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
        patientName: patient?.name || "Unknown patient",
        symptomReportId: r.symptomReportId,
      };
    }),
  );

  res.json(results);
});

// A doctor opening a paired patient's symptom report — an audited
// PHI-access point, logged every time it's fetched.
router.get("/:id/symptom-report", requireAuth, requireRole("doctor"), async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!doctorProfile || !pairing || pairing.doctorProfileId !== doctorProfile.id) {
    return res.status(404).json({ message: "Pairing request not found" });
  }
  if (!pairing.symptomReportId) {
    return res.status(404).json({ message: "No symptom report attached to this request" });
  }
  const report = await storage.getSymptomReport(pairing.symptomReportId);
  if (!report) {
    return res.status(404).json({ message: "Symptom report not found" });
  }

  await logAudit({
    actorUserId: userId,
    action: "doctor.viewed_paired_patient",
    targetType: "symptom_report",
    targetId: report.id,
  });

  res.json({ symptomText: report.symptomText, state: report.state, createdAt: report.createdAt });
});

async function respondToPairing(req: any, res: any, status: "accepted" | "declined") {
  const userId = req.userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!doctorProfile || !pairing || pairing.doctorProfileId !== doctorProfile.id) {
    return res.status(404).json({ message: "Pairing request not found" });
  }
  if (pairing.status !== "requested") {
    return res.status(409).json({ message: "This request has already been responded to" });
  }

  const updated = await storage.updatePairingRequestStatus(pairing.id, status);

  await logAudit({ actorUserId: userId, action: `pairing.${status}`, targetType: "pairing_request", targetId: pairing.id });

  if (status === "accepted") {
    const patient = await storage.getUser(pairing.patientUserId);
    if (patient) {
      sendPairingAcceptedEmail(patient.email, patient.name, doctorProfile.name).catch(() => {});
    }
  }

  res.json({ id: updated?.id, status: updated?.status });
}

router.patch("/:id/cancel", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const pairing = await storage.getPairingRequest(req.params.id);
  if (!pairing || pairing.patientUserId !== userId) {
    return res.status(404).json({ message: "Pairing request not found" });
  }
  if (pairing.status !== "requested") {
    return res.status(409).json({ message: "This request has already been responded to" });
  }

  const updated = await storage.updatePairingRequestStatus(pairing.id, "cancelled");
  await logAudit({ actorUserId: userId, action: "pairing.cancelled", targetType: "pairing_request", targetId: pairing.id });

  res.json({ id: updated?.id, status: updated?.status });
});

router.patch("/:id/accept", requireAuth, requireRole("doctor"), (req, res) => respondToPairing(req, res, "accepted"));
router.patch("/:id/decline", requireAuth, requireRole("doctor"), (req, res) => respondToPairing(req, res, "declined"));

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
    if (doctorProfile && pairing.doctorProfileId === doctorProfile.id) return pairing;
  }
  return null;
}

const sendMessageSchema = z.object({ body: z.string().trim().min(1).max(4000) });

router.get("/:id/messages", requireAuth, async (req, res) => {
  const pairing = await getAuthorizedPairing(req);
  if (!pairing) return res.status(404).json({ message: "Pairing request not found" });
  if (pairing.status !== "accepted") {
    return res.status(403).json({ message: "Messaging is only available once the doctor has accepted" });
  }
  const list = await storage.getMessagesByPairing(pairing.id);
  res.json(list.map((m) => ({ id: m.id, senderUserId: m.senderUserId, body: m.body, createdAt: m.createdAt })));
});

router.post("/:id/messages", requireAuth, async (req, res) => {
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
  const message = await storage.createMessage({ pairingRequestId: pairing.id, senderUserId: userId, body: parsed.data.body });
  res.status(201).json({ id: message.id, senderUserId: message.senderUserId, body: message.body, createdAt: message.createdAt });
});

export default router;
