import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, ENTRY_KINDS, PROFILE_SECTIONS, type EntryKind, type ProfileSection } from "@shared/schema";
import { requireAuth, requireRole } from "../middleware/auth";
import { makeLimiter, userKey } from "../middleware/rateLimit";
import { logAudit } from "../services/auditService";
import * as profile from "../services/healthProfile";

/**
 * A patient's own health information. Everything here is the patient's, about the patient: the identity comes from the session,
 * never from the URL, so there is no patient id to guess. A clinician's access is a separate router (assistedProfile.ts).
 */
const router = Router();
const patientOnly = [requireAuth, requireRole("patient")] as const;
const writeLimiter = makeLimiter({ windowMs: 60 * 1000, limit: 60, keyGenerator: userKey, message: "You're saving very quickly. Please wait a moment." });

export function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof profile.ProfileError) return res.status(err.status).json({ message: err.message, code: err.code });
      next(err);
    }
  };
}
const me = (req: Request): profile.Actor => ({ userId: (req as any).userId as string, role: "patient" });

router.get("/", ...patientOnly, handle(async (req, res) => res.json(await profile.overview(me(req).userId))));

// ----------------------------------------------------------------------------------------- basic information and preferences
const validZone = (z0: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: z0 });
    return true;
  } catch {
    return false;
  }
};

const basicSchema = z.object({
  preferredName: z.string().trim().max(100).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
    .refine((v) => {
      if (!v) return true;
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && d.getTime() <= Date.now() && d.getUTCFullYear() >= new Date().getUTCFullYear() - 120;
    }, "That date of birth isn't valid"),
  country: z.enum(["EG", "US"]).nullable().optional(),
  timezone: z.string().trim().max(60).nullable().optional().refine((v) => !v || validZone(v), "That time zone isn't valid"),
  contactMethod: z.enum(["email", "phone", "in_app"]).nullable().optional(),
  phone: z.string().trim().regex(/^[+()\d\s.-]{7,25}$/, "That phone number isn't valid").nullable().optional(),
  accessibilityNotes: z.string().trim().max(500).nullable().optional(),
}).strict();

router.get("/basic", ...patientOnly, handle(async (req, res) => {
  const [u] = await db.select().from(users).where(eq(users.id, me(req).userId));
  res.json({
    name: u.name, preferredName: u.preferredName, dateOfBirth: u.dateOfBirth, country: u.country, timezone: u.timezone, language: u.language,
    contactMethod: u.contactMethod, phone: u.phone, accessibilityNotes: u.accessibilityNotes,
  });
}));

router.put("/basic", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const parsed = basicSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Those details aren't valid" });
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) set[k] = v === "" ? null : v;
  if (Object.keys(set).length) await db.update(users).set(set).where(eq(users.id, me(req).userId));
  await profile.setSectionStatus(me(req).userId, "basic", "in_progress");
  await logAudit({ actorUserId: me(req).userId, action: "health_profile.basic_updated", targetType: "patient", targetId: me(req).userId, subjectUserId: me(req).userId, metadata: { fields: Object.keys(set) } });
  res.json({ ok: true });
}));

const preferencesSchema = z.object({
  emergencyContactName: z.string().trim().max(200).nullable().optional(),
  emergencyContactPhone: z.string().trim().regex(/^[+()\d\s.-]{7,25}$/, "That phone number isn't valid").nullable().optional(),
  emergencyContactRelationship: z.string().trim().max(100).nullable().optional(),
  preferredClinic: z.string().trim().max(200).optional(),
  appointmentFormat: z.enum(["phone", "in_person", "messaging", "any"]).optional(),
  caregiverNote: z.string().trim().max(500).optional(),
}).strict();

router.get("/preferences", ...patientOnly, handle(async (req, res) => {
  const [u] = await db.select().from(users).where(eq(users.id, me(req).userId));
  res.json({
    emergencyContactName: u.emergencyContactName, emergencyContactPhone: u.emergencyContactPhone, emergencyContactRelationship: u.emergencyContactRelationship,
    preferredClinic: u.carePreferences?.preferredClinic ?? "", appointmentFormat: u.carePreferences?.appointmentFormat ?? "any", caregiverNote: u.carePreferences?.caregiverNote ?? "",
  });
}));

router.put("/preferences", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const parsed = preferencesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Those details aren't valid" });
  const { preferredClinic, appointmentFormat, caregiverNote, ...contact } = parsed.data;
  const [u] = await db.select().from(users).where(eq(users.id, me(req).userId));
  const care = { ...(u.carePreferences ?? {}) } as Record<string, string>;
  if (preferredClinic !== undefined) care.preferredClinic = preferredClinic;
  if (appointmentFormat !== undefined) care.appointmentFormat = appointmentFormat;
  if (caregiverNote !== undefined) care.caregiverNote = caregiverNote;
  const set: Record<string, unknown> = { carePreferences: care };
  for (const [k, v] of Object.entries(contact)) if (v !== undefined) set[k] = v === "" ? null : v;
  await db.update(users).set(set).where(eq(users.id, me(req).userId));
  await profile.setSectionStatus(me(req).userId, "preferences", "in_progress");
  await logAudit({ actorUserId: me(req).userId, action: "health_profile.preferences_updated", targetType: "patient", targetId: me(req).userId, subjectUserId: me(req).userId });
  res.json({ ok: true });
}));

// ----------------------------------------------------------------------------------------- sections
router.put("/sections/:section", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const section = req.params.section as ProfileSection;
  if (!PROFILE_SECTIONS.includes(section)) return res.status(404).json({ message: "Not found" });
  const parsed = z.object({ status: z.enum(["in_progress", "complete", "skipped"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Choose a status" });
  await profile.setSectionStatus(me(req).userId, section, parsed.data.status);
  res.json({ ok: true });
}));

// ----------------------------------------------------------------------------------------- allergies
router.put("/allergies/statement", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const parsed = z.object({ state: z.enum(["none_known", "unknown"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Choose one of the options" });
  await profile.stateAllergies(me(req), me(req).userId, parsed.data.state);
  res.json(await profile.allergyView(me(req).userId));
}));

router.delete("/allergies/statement", ...patientOnly, writeLimiter, handle(async (req, res) => {
  await profile.clearAllergyStatement(me(req), me(req).userId);
  res.json(await profile.allergyView(me(req).userId));
}));

// ----------------------------------------------------------------------------------------- entries
const kindSchema = z.enum(ENTRY_KINDS);

router.get("/entries", ...patientOnly, handle(async (req, res) => {
  const kind = req.query.kind === undefined ? undefined : kindSchema.safeParse(req.query.kind);
  if (kind && !kind.success) return res.status(400).json({ message: "Unknown kind" });
  res.json(await profile.listEntries(me(req), me(req).userId, kind?.data as EntryKind | undefined));
}));

router.post("/entries", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const kind = kindSchema.safeParse(req.body?.kind);
  if (!kind.success) return res.status(400).json({ message: "Unknown kind" });
  res.status(201).json(await profile.createEntry(me(req), me(req).userId, kind.data, req.body?.data));
}));

router.post("/entries/:id/amend", ...patientOnly, writeLimiter, handle(async (req, res) => {
  res.json(await profile.amendEntry(me(req), me(req).userId, req.params.id, req.body?.data));
}));

router.post("/entries/:id/withdraw", ...patientOnly, writeLimiter, handle(async (req, res) => {
  await profile.withdrawEntry(me(req), me(req).userId, req.params.id);
  res.json({ ok: true });
}));

router.post("/entries/:id/dispute", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const parsed = z.object({ note: z.string().trim().min(3).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Say what should be corrected" });
  await profile.disputeEntry(me(req), me(req).userId, req.params.id, parsed.data.note);
  res.json({ ok: true });
}));

router.get("/entries/:id/history", ...patientOnly, handle(async (req, res) => res.json(await profile.entryHistory(me(req), me(req).userId, req.params.id))));

// ----------------------------------------------------------------------------------------- consent
router.get("/consent", ...patientOnly, handle(async (req, res) => res.json({ ...(await profile.currentConsent(me(req).userId)), requiredVersion: profile.CONSENT_VERSION })));
router.post("/consent", ...patientOnly, writeLimiter, handle(async (req, res) => {
  // The person must have seen the wording of THIS version: the client sends it back.
  if (req.body?.version !== profile.CONSENT_VERSION) return res.status(409).json({ message: "The wording has changed. Please read it again.", code: "version_mismatch", requiredVersion: profile.CONSENT_VERSION });
  await profile.giveConsent(me(req).userId);
  res.status(201).json(await profile.currentConsent(me(req).userId));
}));
router.delete("/consent", ...patientOnly, writeLimiter, handle(async (req, res) => {
  await profile.revokeConsent(me(req).userId);
  res.json(await profile.currentConsent(me(req).userId));
}));

// ----------------------------------------------------------------------------------------- clinician help
router.get("/assist", ...patientOnly, handle(async (req, res) => res.json(await profile.listGrants(me(req).userId))));
router.post("/assist", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const parsed = z.object({ doctorProfileId: z.string().min(1).max(64), days: z.number().int().min(1).max(90).default(14) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Choose a doctor and for how long" });
  res.status(201).json(await profile.grantAssist(me(req).userId, parsed.data.doctorProfileId, parsed.data.days));
}));
router.delete("/assist/:id", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const ok = await profile.revokeAssist(me(req).userId, req.params.id);
  if (!ok) return res.status(404).json({ message: "Not found" });
  res.json({ ok: true });
}));

export default router;
