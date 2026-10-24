import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";

const router = Router();

// The Privacy Center: every doctor a patient has an accepted connection
// with (who already sees messages + the symptom report that started it),
// plus any additional categories the patient has explicitly granted, and
// when. This is the single place that answers "who has access, to what,
// since when" — the same question audit_logs answers for *actions*, here
// answered for standing *access*.
router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const [pairings, grants] = await Promise.all([
    storage.getAcceptedPairingsByPatient(patientUserId),
    storage.getActiveSharingGrantsByPatient(patientUserId),
  ]);
  const grantByDoctor = new Map(grants.map((g) => [g.sharedWithDoctorProfileId, g]));

  const results = await Promise.all(
    pairings.map(async (p) => {
      const doctor = await storage.getDoctorProfile(p.doctorProfileId);
      const grant = grantByDoctor.get(p.doctorProfileId);
      return {
        doctorProfileId: p.doctorProfileId,
        doctorName: doctor?.name || "Doctor",
        specialty: doctor?.specialty || "",
        relationshipLabel: p.relationshipLabel || doctor?.specialty || "Care team",
        connectedSince: p.respondedAt,
        alwaysShared: ["messages", "symptom_report"],
        grant: grant
          ? {
              shareMedications: grant.shareMedications,
              shareDocuments: grant.shareDocuments,
              shareAppointments: grant.shareAppointments,
              shareFullHistory: grant.shareFullHistory,
              grantedAt: grant.grantedAt,
            }
          : null,
      };
    }),
  );

  res.json(results);
});

const grantSchema = z.object({
  shareMedications: z.boolean().optional(),
  shareDocuments: z.boolean().optional(),
  shareAppointments: z.boolean().optional(),
  shareFullHistory: z.boolean().optional(),
});

router.put("/:doctorProfileId", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid sharing scope" });

  const pairings = await storage.getAcceptedPairingsByPatient(patientUserId);
  const isConnected = pairings.some((p) => p.doctorProfileId === req.params.doctorProfileId);
  if (!isConnected) return res.status(404).json({ message: "You're not connected with this doctor" });

  const grant = await storage.upsertSharingGrant({
    patientUserId,
    sharedWithDoctorProfileId: req.params.doctorProfileId,
    shareMedications: parsed.data.shareMedications ?? false,
    shareDocuments: parsed.data.shareDocuments ?? false,
    shareAppointments: parsed.data.shareAppointments ?? false,
    shareFullHistory: parsed.data.shareFullHistory ?? false,
  });

  await logAudit({
    actorUserId: patientUserId,
    action: "sharing_grant.updated",
    targetType: "doctor_profile",
    targetId: req.params.doctorProfileId,
    metadata: parsed.data,
  });

  res.json(grant);
});

router.delete("/:doctorProfileId", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const grant = await storage.getActiveSharingGrantFor(patientUserId, req.params.doctorProfileId);
  if (!grant) return res.status(404).json({ message: "No active sharing grant with this doctor" });

  const updated = await storage.revokeSharingGrant(grant.id);
  await logAudit({ actorUserId: patientUserId, action: "sharing_grant.revoked", targetType: "doctor_profile", targetId: req.params.doctorProfileId });
  res.json(updated);
});

router.get("/shared-with-me", requireAuth, requireRole("doctor"), async (req, res) => {
  const userId = (req as any).userId as string;
  const doctorProfile = await storage.getDoctorProfileByUserId(userId);
  if (!doctorProfile) return res.status(404).json({ message: "No doctor profile for this account" });

  const allGrants = await storage.getActiveSharingGrantsByDoctorProfile(doctorProfile.id);
  const grants: typeof allGrants = [];
  for (const g of allGrants) {
    const connections = await storage.getAcceptedPairingsByPatient(g.patientUserId);
    if (connections.some((c) => c.doctorProfileId === doctorProfile.id)) grants.push(g);
  }
  const results = await Promise.all(
    grants.map(async (g) => {
      const patient = await storage.getUser(g.patientUserId);
      return {
        patientUserId: g.patientUserId,
        patientName: patient?.name || "Patient",
        shareMedications: g.shareMedications,
        shareDocuments: g.shareDocuments,
        shareAppointments: g.shareAppointments,
        shareFullHistory: g.shareFullHistory,
        grantedAt: g.grantedAt,
      };
    }),
  );
  res.json(results);
});

export default router;
