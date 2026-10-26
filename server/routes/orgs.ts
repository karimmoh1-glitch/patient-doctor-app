import { Router, type NextFunction, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireApprovedDoctor } from "../middleware/doctor";
import { issueSession } from "../middleware/auth";
import { systemAccess } from "../middleware/systemAccess";
import { makeLimiter, userKey } from "../middleware/rateLimit";
import { storage } from "../storage";
import { weakPasswordReason } from "../lib/password";
import { sendOrgInviteEmail } from "../services/emailService";
import { logAudit } from "../services/auditService";
import { normalizeLang } from "../services/serverText";
import { ORG_ROLES, type Permission } from "@shared/permissions";
import * as orgs from "../services/orgs";

/**
 * Organization endpoints. Every route under /:orgId names the permission it needs, and `access()` is the only thing that says yes.
 * Members are organization staff (their own kind of account) and approved clinicians.
 */
const router = Router();
const writeLimiter = makeLimiter({ windowMs: 60 * 1000, limit: 60, keyGenerator: userKey, message: "You're saving very quickly. Please wait a moment." });
const inviteLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 30, keyGenerator: userKey, message: "You've sent a lot of invitations. Please wait a while." });
const publicLimiter = makeLimiter({ windowMs: 60 * 1000, limit: 20, failuresOnly: true, message: "Too many tries. Please wait a minute." });

function orgUser(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const role = (req as any).userRole as string;
    if (role === "staff") return next();
    if (role === "doctor") return requireApprovedDoctor(req, res, next);
    return res.status(403).json({ message: "Not allowed" });
  });
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof orgs.OrgError) return res.status(err.status).json({ message: err.message, code: err.code });
      next(err);
    }
  };
}
const uid = (req: Request) => (req as any).userId as string;
const need = (req: Request, p: Permission) => orgs.access(uid(req), req.params.orgId, p);

// ---------------------------------------------------------------------------------------------- invitations (before sign-in)

router.post("/invitations/preview", systemAccess, publicLimiter, handle(async (req, res) => {
  res.json(await orgs.previewInvitation(String(req.body?.token ?? "")));
}));

// A brand-new staff account, created by the person the invitation was sent to. A clinician joins with their clinician account instead.
router.post("/invitations/accept-new", systemAccess, publicLimiter, handle(async (req, res) => {
  const parsed = z.object({ token: z.string().max(100), name: z.string().trim().min(1).max(100), password: z.string().min(8).max(200), language: z.enum(["en", "ar"]).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Your name and a password of at least 8 characters are needed" });
  const inv = await orgs.claimInvitationForNewAccount(parsed.data.token);
  const weak = weakPasswordReason(parsed.data.password, { email: inv.email, name: parsed.data.name });
  if (weak) return res.status(400).json({ message: weak });
  let user;
  try {
    user = await storage.createUser({
      name: parsed.data.name, email: inv.email, passwordHash: await bcrypt.hash(parsed.data.password, 10), role: "staff", state: null, phone: null,
      language: parsed.data.language ?? "en", deactivatedAt: null, emailVerifiedAt: new Date(), // the invitation reached this address
    } as any);
  } catch (err: any) {
    if (err?.code === "23505" || err?.cause?.code === "23505") return res.status(409).json({ message: "An account with this e-mail already exists. Sign in, then accept the invitation." });
    throw err;
  }
  await orgs.acceptWithAccount(user.id, parsed.data.token);
  await logAudit({ actorUserId: user.id, action: "staff.registered", targetType: "user", targetId: user.id });
  // Staff have a second factor like clinicians: no session until it is set up.
  await issueSession(req, res, { id: user.id, role: "staff" }, { user: { id: user.id, name: user.name, email: user.email, role: "staff", state: null, language: user.language } }, 201);
}));

// An existing account (a clinician, or staff already registered) joins; its e-mail must be the invited one.
router.post("/invitations/accept", orgUser, writeLimiter, handle(async (req, res) => {
  const token = String(req.body?.token ?? "");
  res.json(await orgs.acceptWithAccount(uid(req), token));
}));

// ---------------------------------------------------------------------------------------------- organizations

router.get("/", orgUser, handle(async (req, res) => res.json(await orgs.myOrganizations(uid(req)))));

router.post("/", orgUser, writeLimiter, handle(async (req, res) => {
  const parsed = orgs.orgInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Those details aren't valid" });
  const org = await orgs.createOrg(uid(req), parsed.data);
  await logAudit({ actorUserId: uid(req), action: "org.created", targetType: "organization", targetId: org.id });
  res.status(201).json(org);
}));

router.get("/:orgId", orgUser, handle(async (req, res) => {
  const a = await need(req, "org.view");
  res.json({ ...a.org, role: a.role });
}));

router.patch("/:orgId", orgUser, writeLimiter, handle(async (req, res) => {
  const a = await need(req, "org.settings.edit");
  const parsed = orgs.orgInput.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Those details aren't valid" });
  res.json(await orgs.updateOrg(a, parsed.data));
}));

router.get("/:orgId/dashboard", orgUser, handle(async (req, res) => res.json(await orgs.dashboard(await need(req, "org.dashboard.view")))));

// ---- staff
router.get("/:orgId/staff", orgUser, handle(async (req, res) => res.json(await orgs.listStaff(await need(req, "org.staff.view")))));

router.post("/:orgId/staff/invitations", orgUser, inviteLimiter, handle(async (req, res) => {
  const a = await need(req, "org.staff.invite");
  const parsed = orgs.inviteInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "An e-mail address and a role are needed" });
  const created = await orgs.invite(a, parsed.data.email, parsed.data.role);
  const origin = process.env.APP_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
  // The token is in the fragment so opening the link sends it to no server. It is shown to the inviter once, in case e-mail is not set up.
  const link = `${origin}/join-team#${created.token}`;
  const recipient = await storage.getUserByEmail(parsed.data.email);
  const emailAccepted = await sendOrgInviteEmail(parsed.data.email, a.org.name, parsed.data.role, link, normalizeLang(recipient?.language)).catch(() => false);
  res.status(201).json({ id: created.id, link, expiresAt: created.expiresAt, emailAccepted });
}));

router.delete("/:orgId/staff/invitations/:id", orgUser, writeLimiter, handle(async (req, res) => {
  await orgs.revokeInvitation(await need(req, "org.staff.revoke"), req.params.id);
  res.json({ ok: true });
}));

router.patch("/:orgId/staff/:membershipId", orgUser, writeLimiter, handle(async (req, res) => {
  const a = await need(req, "org.staff.role");
  const parsed = z.object({ role: z.enum(ORG_ROLES) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Choose a role" });
  await orgs.changeRole(a, req.params.membershipId, parsed.data.role);
  res.json({ ok: true });
}));

router.delete("/:orgId/staff/:membershipId", orgUser, writeLimiter, handle(async (req, res) => {
  await orgs.revokeMember(await need(req, "org.staff.revoke"), req.params.membershipId);
  res.json({ ok: true });
}));

// ---- patients, appointments, tasks, notes
router.get("/:orgId/patients", orgUser, handle(async (req, res) => {
  const a = await orgs.access(uid(req), req.params.orgId, "org.dashboard.view");
  // Clinicians see their own patients here; everyone else needs the patients permission.
  if (a.role !== "clinician") await need(req, "org.patients.list");
  res.json(await orgs.listPatients(a));
}));

router.get("/:orgId/appointments", orgUser, handle(async (req, res) => {
  const a = await need(req, "org.appointments.view");
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? "7"), 10) || 7, 1), 31);
  res.json(await orgs.listAppointments(a, days));
}));

router.get("/:orgId/tasks", orgUser, handle(async (req, res) => {
  const a = await need(req, "org.tasks.view");
  const status = ["open", "done", "all"].includes(String(req.query.status)) ? (String(req.query.status) as "open" | "done" | "all") : "open";
  res.json(await orgs.listTasks(a, status));
}));

router.post("/:orgId/tasks", orgUser, writeLimiter, handle(async (req, res) => {
  const a = await need(req, "org.tasks.manage");
  const parsed = orgs.taskInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Those details aren't valid" });
  res.status(201).json(await orgs.createTask(a, parsed.data));
}));

router.patch("/:orgId/tasks/:id", orgUser, writeLimiter, handle(async (req, res) => {
  const a = await need(req, "org.tasks.manage");
  const parsed = z.object({ status: z.enum(["open", "done", "cancelled"]).optional(), assignedToUserId: z.string().max(64).nullable().optional() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Those details aren't valid" });
  res.json(await orgs.updateTask(a, req.params.id, parsed.data));
}));

router.get("/:orgId/patients/:patientId/notes", orgUser, handle(async (req, res) => res.json(await orgs.listNotes(await need(req, "org.notes.read"), req.params.patientId))));

router.post("/:orgId/patients/:patientId/notes", orgUser, writeLimiter, handle(async (req, res) => {
  const a = await need(req, "org.notes.write");
  const parsed = z.object({ body: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Write the note" });
  res.status(201).json(await orgs.addNote(a, req.params.patientId, parsed.data.body));
}));

// ---- audit
router.get("/:orgId/audit", orgUser, handle(async (req, res) => {
  const a = await need(req, "org.audit.view");
  const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);
  res.json(await orgs.searchAudit(a, {
    action: typeof req.query.action === "string" ? req.query.action.slice(0, 60) : undefined,
    actorUserId: typeof req.query.actor === "string" ? req.query.actor.slice(0, 64) : undefined,
    from: date(req.query.from), to: date(req.query.to),
  }));
}));

export default router;
