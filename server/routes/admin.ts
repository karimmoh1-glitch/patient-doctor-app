import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";
import { sendDoctorApplicationApprovedEmail, sendDoctorApplicationRejectedEmail } from "../services/emailService";

const router = Router();

router.get("/doctor-applications", requireAuth, requireRole("admin"), async (_req, res) => {
  const applications = await storage.getPendingDoctorApplications();
  res.json(
    applications.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      licenseNumber: a.licenseNumber,
      licensedStates: a.licensedStates,
      npiNumber: a.npiNumber,
      specialty: a.specialty,
      phone: a.phone,
      bio: a.bio,
      status: a.status,
      createdAt: a.createdAt,
    })),
  );
});

router.post("/doctor-applications/:id/approve", requireAuth, requireRole("admin"), async (req, res) => {
  const reviewerId = (req as any).userId as string;
  const application = await storage.getDoctorApplication(req.params.id);
  if (!application || application.status !== "pending") {
    return res.status(404).json({ message: "Application not found or already reviewed" });
  }

  const existingUser = await storage.getUserByEmail(application.email);
  if (existingUser) {
    return res.status(409).json({ message: "An account with this email already exists" });
  }

  // Role is hardcoded here, never taken from request input.
  const user = await storage.createUser({
    name: application.name,
    email: application.email,
    passwordHash: application.passwordHash,
    role: "doctor",
    state: application.licensedStates[0] || null,
    phone: application.phone,
    deactivatedAt: null,
    emailVerifiedAt: null,
  });

  await storage.createDoctorProfile({
    userId: user.id,
    name: application.name,
    specialty: application.specialty,
    state: application.licensedStates[0],
    licenseNumber: application.licenseNumber,
    npiNumber: application.npiNumber,
    phone: application.phone,
    bio: application.bio,
    active: true,
    source: "application",
  });

  await storage.updateDoctorApplicationStatus(application.id, "approved", reviewerId);
  await logAudit({ actorUserId: reviewerId, action: "doctor_application.approved", targetType: "doctor_application", targetId: application.id });

  sendDoctorApplicationApprovedEmail(application.email, application.name).catch(() => {});

  res.json({ id: application.id, status: "approved" });
});

const rejectBodySchema = z.object({ reason: z.string().max(1000).optional() });

router.post("/doctor-applications/:id/reject", requireAuth, requireRole("admin"), async (req, res) => {
  const reviewerId = (req as any).userId as string;
  const parsed = rejectBodySchema.safeParse(req.body);
  const application = await storage.getDoctorApplication(req.params.id);
  if (!application || application.status !== "pending") {
    return res.status(404).json({ message: "Application not found or already reviewed" });
  }

  await storage.updateDoctorApplicationStatus(application.id, "rejected", reviewerId, parsed.success ? parsed.data.reason : undefined);
  await logAudit({ actorUserId: reviewerId, action: "doctor_application.rejected", targetType: "doctor_application", targetId: application.id });

  sendDoctorApplicationRejectedEmail(application.email, application.name, parsed.success ? parsed.data.reason : undefined).catch(() => {});

  res.json({ id: application.id, status: "rejected" });
});

export default router;
