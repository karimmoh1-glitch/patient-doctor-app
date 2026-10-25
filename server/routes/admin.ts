import { Router } from "express";
import { defaultTimezoneForState } from "@shared/timezones";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";
import { normalizeLang } from "../services/serverText";
import {
  sendDoctorApplicationApprovedEmail,
  sendDoctorApplicationRejectedEmail,
  sendDoctorInfoRequestedEmail,
  sendDoctorSuspendedEmail,
} from "../services/emailService";

const router = Router();

// Administrators are provisioned out of band (`npm run admin:create`); there
// is no public way to become one. Every route here re-checks the role live.
const adminOnly = [requireAuth, requireRole("admin")] as const;

type Application = NonNullable<Awaited<ReturnType<typeof storage.getDoctorApplication>>>;

// Emails go out in the language the applicant chose for their account.
async function applicantLang(a: Application) {
  return normalizeLang(a.userId ? (await storage.getUser(a.userId))?.language : undefined);
}

// Licence numbers, NPIs and contact details are sensitive, so the list is
// audited and carries only what a reviewer needs.
function reviewerView(a: Application) {
  return {
    id: a.id,
    name: a.name,
    displayName: a.displayName,
    email: a.email,
    professionalRole: a.professionalRole,
    specialty: a.specialty,
    licenseNumber: a.licenseNumber,
    licensingBody: a.licensingBody,
    licensedStates: a.licensedStates ?? [],
    npiNumber: a.npiNumber,
    qualifications: a.qualifications,
    languages: a.languages ?? [],
    yearsExperience: a.yearsExperience,
    clinic: a.clinic,
    modalities: a.modalities ?? [],
    phone: a.phone,
    bio: a.bio,
    status: a.status,
    infoRequest: a.infoRequest,
    reviewerNotes: a.reviewerNotes,
    submittedAt: a.submittedAt,
    createdAt: a.createdAt,
  };
}

const FILTERS: Record<string, string[]> = {
  open: ["pending", "needs_info"],
  pending: ["pending"],
  needs_info: ["needs_info"],
  approved: ["approved"],
  suspended: ["suspended"],
  rejected: ["rejected"],
  incomplete: ["incomplete"],
};

router.get("/doctor-applications", ...adminOnly, async (req, res) => {
  const filter = typeof req.query.status === "string" ? req.query.status : "open";
  const statuses = FILTERS[filter];
  if (!statuses) return res.status(400).json({ message: "Unknown filter" });
  const [applications, counts] = await Promise.all([
    storage.listDoctorApplications(statuses),
    storage.countDoctorApplicationsByStatus(),
  ]);
  await logAudit({ actorUserId: (req as any).userId as string, action: "doctor_applications.listed", metadata: { filter } });
  res.json({ filter, counts, applications: applications.map(reviewerView) });
});

router.post("/doctor-applications/:id/approve", ...adminOnly, async (req, res) => {
  const reviewerId = (req as any).userId as string;
  const application = await storage.getDoctorApplication(req.params.id);
  if (!application) return res.status(404).json({ message: "Application not found" });

  const result = await storage.approveDoctorApplication(
    application.id,
    reviewerId,
    defaultTimezoneForState(application.licensedStates?.[0] ?? "NY"),
  );
  if (!result.ok) {
    return res.status(409).json({
      message:
        result.reason === "incomplete_application"
          ? "This application is missing required details."
          : "This application is not waiting for review.",
    });
  }
  await logAudit({ actorUserId: reviewerId, action: "doctor_application.approved", targetType: "doctor_application", targetId: application.id, subjectUserId: null });
  sendDoctorApplicationApprovedEmail(application.email, application.name, await applicantLang(application)).catch(() => {});
  res.json({ id: application.id, status: "approved" });
});

const messageSchema = z.object({ message: z.string().trim().min(5, "Tell the applicant what you need").max(1000) });
const reasonSchema = z.object({ reason: z.string().trim().max(1000).optional() });

router.post("/doctor-applications/:id/request-info", ...adminOnly, async (req, res) => {
  const reviewerId = (req as any).userId as string;
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0]?.message || "A message is required" });
  const updated = await storage.requestDoctorApplicationInfo(req.params.id, reviewerId, parsed.data.message);
  if (!updated) return res.status(409).json({ message: "This application is not waiting for review." });
  await logAudit({ actorUserId: reviewerId, action: "doctor_application.info_requested", targetType: "doctor_application", targetId: updated.id, subjectUserId: null });
  sendDoctorInfoRequestedEmail(updated.email, updated.name, parsed.data.message, await applicantLang(updated)).catch(() => {});
  res.json({ id: updated.id, status: "needs_info" });
});

router.post("/doctor-applications/:id/reject", ...adminOnly, async (req, res) => {
  const reviewerId = (req as any).userId as string;
  const parsed = reasonSchema.safeParse(req.body);
  const reason = parsed.success ? parsed.data.reason : undefined;
  const updated = await storage.rejectDoctorApplication(req.params.id, reviewerId, reason);
  if (!updated) return res.status(409).json({ message: "This application is not waiting for review." });
  await logAudit({ actorUserId: reviewerId, action: "doctor_application.rejected", targetType: "doctor_application", targetId: updated.id, subjectUserId: null });
  sendDoctorApplicationRejectedEmail(updated.email, updated.name, reason, await applicantLang(updated)).catch(() => {});
  res.json({ id: updated.id, status: "rejected" });
});

router.post("/doctor-applications/:id/suspend", ...adminOnly, async (req, res) => {
  const reviewerId = (req as any).userId as string;
  const parsed = reasonSchema.safeParse(req.body);
  const reason = parsed.success ? parsed.data.reason : undefined;
  const updated = await storage.suspendDoctor(req.params.id, reviewerId, reason);
  if (!updated) return res.status(409).json({ message: "Only an approved doctor can be suspended." });
  await logAudit({ actorUserId: reviewerId, action: "doctor.suspended", targetType: "doctor_application", targetId: updated.id, subjectUserId: null });
  sendDoctorSuspendedEmail(updated.email, updated.name, await applicantLang(updated)).catch(() => {});
  res.json({ id: updated.id, status: "suspended" });
});

router.post("/doctor-applications/:id/reinstate", ...adminOnly, async (req, res) => {
  const reviewerId = (req as any).userId as string;
  const updated = await storage.reinstateDoctor(req.params.id, reviewerId);
  if (!updated) return res.status(409).json({ message: "Only a suspended doctor can be reinstated." });
  await logAudit({ actorUserId: reviewerId, action: "doctor.reinstated", targetType: "doctor_application", targetId: updated.id, subjectUserId: null });
  res.json({ id: updated.id, status: "approved" });
});

// Recent platform events, for the reviewer. Names and actions only: audit
// metadata is never returned here.
router.get("/audit", ...adminOnly, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
  const rows = await storage.getRecentAuditLogs(limit);
  const actorIds = Array.from(new Set(rows.map((r) => r.actorUserId).filter(Boolean) as string[]));
  const actors = new Map<string, { name: string; role: string }>();
  for (const id of actorIds) {
    const u = await storage.getUser(id);
    if (u) actors.set(id, { name: u.name, role: u.role });
  }
  res.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      targetType: r.targetType,
      createdAt: r.createdAt,
      actor: r.actorUserId ? actors.get(r.actorUserId) ?? null : null,
    })),
  );
});

export default router;
