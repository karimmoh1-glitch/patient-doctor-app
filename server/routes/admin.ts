import { Router } from "express";
import { defaultTimezoneForState } from "@shared/timezones";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";
import { reminderHealth } from "../services/reminderService";
import { normalizeLang } from "../services/serverText";
import { runAsSystem } from "../dbContext";
import { verificationInput, verifyCredential, rejectCredential, suspendCredential, listCredentials, credentialHistory } from "../services/credentialService";
import { listForReview, orgVerification, setOrgStatus } from "../services/orgs";
import { personalReminderHealth } from "../services/personalReminderHealth";
import { integrationRegistry } from "../services/integrations";
import { emailDeliverySummary } from "../services/emailDeliveries";
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
    userId: a.userId,
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

  // Approving is also verifying the licence: the reviewer must say how it was checked, what they saw, and until when it is valid.
  const verification = verificationInput.safeParse(req.body?.verification);
  if (!verification.success) {
    return res.status(400).json({ message: verification.error.issues[0]?.message || "Say how the licence was checked", code: "verification_required" });
  }
  const result = await storage.approveDoctorApplication(
    application.id,
    reviewerId,
    defaultTimezoneForState(application.licensedStates?.[0] ?? "NY"),
    verification.data,
  );
  if (!result.ok) {
    return res.status(409).json({
      message:
        result.reason === "incomplete_application"
          ? "This application is missing required details."
          : "This application is not waiting for review.",
    });
  }
  await logAudit({ actorUserId: reviewerId, action: "doctor_application.approved", targetType: "doctor_application", targetId: application.id, subjectUserId: null, metadata: { credentialSource: verification.data.source, expiresAt: verification.data.expiresAt.toISOString() } });
  sendDoctorApplicationApprovedEmail(application.email, application.name, await applicantLang(application)).catch(() => {});
  res.json({ id: application.id, status: "approved" });
});

const messageSchema = z.object({ message: z.string().trim().min(5, "Tell the applicant what you need").max(1000) });
const reasonSchema = z.object({ reason: z.string().trim().max(1000).optional() });

router.post("/doctor-applications/:id/request-info", ...adminOnly, async (req, res) => {
  const reviewerId = (req as any).userId as string;
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "A message is required" });
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

// Is automatic reminder delivery really working? Counts and timestamps only:
// nothing here names a patient or a medicine.
router.get("/reminders/status", ...adminOnly, async (_req, res) => {
  // Counts only, across everyone's reminders: an operational read, not a view of anyone's record.
  res.json({ ...(await runAsSystem(() => reminderHealth())), personal: await personalReminderHealth() });
});

// Credentials: who has been checked, how, and when each stops being valid. Evidence notes are for reviewers only.
router.get("/credentials", ...adminOnly, async (req, res) => {
  const filter = ["all", "expiring", "expired", "open"].includes(String(req.query.filter)) ? (String(req.query.filter) as "all" | "expiring" | "expired" | "open") : "all";
  res.json(await listCredentials(filter));
});

router.get("/credentials/:id/history", ...adminOnly, async (req, res) => {
  res.json(await credentialHistory(req.params.id));
});

router.post("/credentials/:id/verify", ...adminOnly, async (req, res) => {
  const parsed = verificationInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Say how it was checked" });
  const updated = await verifyCredential(req.params.id, (req as any).userId, parsed.data);
  if (!updated) return res.status(409).json({ message: "This credential cannot be verified from its current state." });
  await logAudit({ actorUserId: (req as any).userId, action: "credential.verified", targetType: "credential", targetId: updated.id, subjectUserId: updated.userId });
  res.json({ id: updated.id, status: "verified" });
});

const noteSchema = z.object({ note: z.string().trim().min(5, "Say why").max(1000) });
router.post("/credentials/:id/reject", ...adminOnly, async (req, res) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Say why" });
  const updated = await rejectCredential(req.params.id, (req as any).userId, parsed.data.note);
  if (!updated) return res.status(409).json({ message: "This credential cannot be rejected from its current state." });
  await logAudit({ actorUserId: (req as any).userId, action: "credential.rejected", targetType: "credential", targetId: updated.id, subjectUserId: updated.userId });
  res.json({ id: updated.id, status: "rejected" });
});

router.post("/credentials/:id/suspend", ...adminOnly, async (req, res) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Say why" });
  const updated = await suspendCredential(req.params.id, (req as any).userId, parsed.data.note);
  if (!updated) return res.status(409).json({ message: "Only a verified credential can be suspended." });
  await logAudit({ actorUserId: (req as any).userId, action: "credential.suspended", targetType: "credential", targetId: updated.id, subjectUserId: updated.userId });
  res.json({ id: updated.id, status: "suspended" });
});

// Organizations: Avela's reviewers record how an organization's existence and contact details were checked. Unverified is a normal state.
router.get("/organizations", ...adminOnly, async (_req, res) => res.json(await listForReview()));
router.post("/organizations/:id/verify", ...adminOnly, async (req, res) => {
  const parsed = orgVerification.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Say how it was checked" });
  try {
    res.json(await setOrgStatus((req as any).userId, req.params.id, "verified", parsed.data));
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
});
router.post("/organizations/:id/suspend", ...adminOnly, async (req, res) => {
  const note = z.object({ note: z.string().trim().min(5).max(1000) }).safeParse(req.body);
  if (!note.success) return res.status(400).json({ message: "Say why" });
  try {
    res.json(await setOrgStatus((req as any).userId, req.params.id, "suspended", undefined, note.data.note));
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
});
router.post("/organizations/:id/unsuspend", ...adminOnly, async (req, res) => {
  try {
    res.json(await setOrgStatus((req as any).userId, req.params.id, "unverified"));
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
});

// What each external service is really doing, with the evidence behind each status. Counts and times only.
router.get("/integrations", ...adminOnly, async (_req, res) => {
  res.json({ integrations: await integrationRegistry(), emailLast7Days: await emailDeliverySummary(7) });
});

// A clinician who has lost both their phone and their recovery codes. Their second factor is removed and every session
// they hold ends; they enrol again at their next sign-in. Audited. An administrator's own second factor is reset only by
// the operator (npm run mfa:reset), so no account can quietly reset its own or a peer's.
router.post("/users/:userId/mfa-reset", ...adminOnly, async (req, res) => {
  const adminId = (req as any).userId as string;
  const target = await storage.getUser(req.params.userId);
  if (!target || target.role !== "doctor") return res.status(404).json({ message: "Not found" });
  await storage.resetMfa(target.id);
  await logAudit({ actorUserId: adminId, action: "mfa.reset_by_admin", targetType: "user", targetId: target.id, subjectUserId: target.id });
  res.json({ message: "Their sign-in codes were removed. They will set them up again the next time they sign in." });
});

// Reports of abusive or unsafe messages. The reviewer sees the reason and ONLY what the reporter chose to attach, never the
// rest of the conversation. Looking at the list is itself recorded.
router.get("/message-reports", ...adminOnly, async (req, res) => {
  const status = req.query.status === "resolved" ? "resolved" : "open";
  const rows = await storage.listMessageReports(status);
  await logAudit({ actorUserId: (req as any).userId as string, action: "message_reports.listed", metadata: { status } });
  res.json(rows.map((r) => ({ id: r.id, reason: r.reason, details: r.details, sharedText: r.sharedText, reporterName: r.reporterName, status: r.status, createdAt: r.createdAt, resolvedAt: r.resolvedAt, resolutionNote: r.resolutionNote })));
});

router.post("/message-reports/:id/resolve", ...adminOnly, async (req, res) => {
  const parsed = z.object({ note: z.string().trim().max(1000).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: "Invalid request" });
  const done = await storage.resolveMessageReport(req.params.id, (req as any).userId as string, parsed.data.note || null);
  if (!done) return res.status(404).json({ message: "Not found" });
  await logAudit({ actorUserId: (req as any).userId as string, action: "message_report.resolved", targetType: "message_report", targetId: done.id });
  res.json({ id: done.id, status: done.status });
});

export default router;
