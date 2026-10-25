import { Router } from "express";
import bcrypt from "bcryptjs";
import { makeLimiter } from "../middleware/rateLimit";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole, createDeviceForLogin, signToken } from "../middleware/auth";
import { requireApprovedDoctor } from "../middleware/doctor";
import { doctorStatusFor } from "../services/doctorStatus";
import { normalizeLang } from "../services/serverText";
import { isDemoMode } from "../config";
import { logAudit } from "../services/auditService";
import { getAvailability, getOpenSlots, isValidTimezone, replaceAvailability, validateAvailabilityWindows } from "../services/schedulingService";
import { SPECIALTIES, US_STATES } from "@shared/specialties";
import { LANGUAGE_CODES, MODALITIES, PROFESSIONAL_ROLES } from "@shared/languages";
import {
  sendDoctorApplicationReceivedEmail,
  sendNewDoctorApplicationAdminEmail,
  getAdminNotificationEmails,
} from "../services/emailService";

const router = Router();

const applyLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many attempts. Please try again later.",
});

// A doctor's own published weekly hours. Registered before any "/:id" style
// route so "me" is never treated as an id.
router.get("/me/availability", requireAuth, requireApprovedDoctor, async (req, res) => {
  const profile = await storage.getDoctorProfileByUserId((req as any).userId as string);
  if (!profile) return res.status(404).json({ message: "No doctor profile for this account" });
  res.json({ timezone: profile.timezone, windows: await getAvailability(profile.id) });
});

const availabilitySchema = z.object({
  timezone: z.string().min(1).max(64),
  windows: z.array(z.object({
    weekday: z.number().int(),
    startMinute: z.number().int(),
    endMinute: z.number().int(),
  })).max(28),
});

router.put("/me/availability", requireAuth, requireApprovedDoctor, async (req, res) => {
  const userId = (req as any).userId as string;
  const profile = await storage.getDoctorProfileByUserId(userId);
  if (!profile) return res.status(404).json({ message: "No doctor profile for this account" });
  const parsed = availabilitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid availability" });
  if (!isValidTimezone(parsed.data.timezone)) return res.status(400).json({ message: "That time zone isn't recognised" });
  const problem = validateAvailabilityWindows(parsed.data.windows);
  if (problem) return res.status(400).json({ message: problem });

  await replaceAvailability(profile.id, parsed.data.timezone, parsed.data.windows);
  await logAudit({ actorUserId: userId, action: "doctor.availability_updated", targetType: "doctor_profile", targetId: profile.id });
  res.json({ timezone: parsed.data.timezone, windows: parsed.data.windows });
});

// Public directory listing, filterable. Never includes the phone number; that
// is only revealed once a connection is accepted (see routes/pairings.ts).
// `reviewedByAvela` means an administrator approved the application; it does
// NOT mean the licence was checked against a registry, and the interface says
// so. Seeded demonstration profiles are never marked reviewed.
const directoryQuery = z.object({
  specialty: z.enum(SPECIALTIES).optional(),
  language: z.enum(LANGUAGE_CODES).optional(),
  modality: z.enum(MODALITIES).optional(),
  state: z.enum(US_STATES).optional(),
  available: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(80).optional(),
});

router.get("/", async (req, res) => {
  const parsed = directoryQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ message: "Those filters aren't valid" });
  const f = parsed.data;

  // A profile with no login can never read or answer a request. Outside
  // demo mode it is not listed at all, rather than letting a patient wait
  // forever on someone who isn't there.
  let profiles = (await storage.getActiveDoctorProfiles()).filter((p) => p.userId || isDemoMode());
  if (f.specialty) profiles = profiles.filter((p) => p.specialty === f.specialty);
  if (f.state) profiles = profiles.filter((p) => p.state === f.state);
  if (f.language) profiles = profiles.filter((p) => (p.languages ?? []).includes(f.language!));
  if (f.modality) profiles = profiles.filter((p) => (p.modalities ?? []).includes(f.modality!));
  if (f.q) {
    const needle = f.q.toLowerCase();
    profiles = profiles.filter((p) => p.name.toLowerCase().includes(needle) || (p.clinic ?? "").toLowerCase().includes(needle));
  }
  profiles = profiles.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);

  // Only a time is revealed, never which slots are taken or by whom.
  const withNext = await Promise.all(
    profiles.map(async (p) => {
      const open = await getOpenSlots(p.id, 14);
      return { p, nextAvailable: open.slots[0]?.toISOString() ?? null };
    }),
  );
  const rows = f.available === "true" ? withNext.filter((r) => r.nextAvailable) : withNext;

  res.json(
    rows.map(({ p, nextAvailable }) => ({
      isDemoProfile: !p.userId,
      id: p.id,
      name: p.name,
      specialty: p.specialty,
      state: p.state,
      bio: p.bio,
      clinic: p.clinic,
      languages: p.languages ?? [],
      modalities: p.modalities ?? [],
      yearsExperience: p.yearsExperience,
      reviewedByAvela: !!p.verifiedAt,
      timezone: p.timezone,
      nextAvailable,
    })),
  );
});

// ---------------------------------------------------------------------------
// Registration and verification.
//
// Registering creates an account and an application in status "incomplete".
// The doctor can sign in, finish their professional details and submit them;
// an administrator then approves, asks for more information, or rejects.
// Until approval there is no doctor profile, so the account is not in the
// directory and requireApprovedDoctor refuses every clinical route.
// Nothing here is checked against a licensing registry: what the applicant
// types is self-reported, and the interface says so.
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
  language: z.enum(["en", "ar"]).optional(),
});

router.post("/register", applyLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid registration" });
  const { name, email, password, language } = parsed.data;

  if (await storage.getUserByEmail(email)) {
    return res.status(409).json({ message: "An account with this email already exists" });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  let created;
  try {
    created = await storage.registerDoctor(
      { name, email, passwordHash, role: "doctor", state: null, phone: null, deactivatedAt: null, emailVerifiedAt: null } as any,
      language ?? "en",
    );
  } catch (err: any) {
    if (err?.code === "23505" || err?.cause?.code === "23505") {
      return res.status(409).json({ message: "An account with this email already exists" });
    }
    throw err;
  }
  const deviceId = await createDeviceForLogin(created.user.id, req);
  const token = signToken(created.user.id, "doctor", deviceId);
  await logAudit({ actorUserId: created.user.id, action: "doctor.registered", targetType: "doctor_application", targetId: created.application.id, subjectUserId: null });
  res.status(201).json({
    token,
    user: { id: created.user.id, name: created.user.name, email: created.user.email, role: "doctor", state: null, language: created.user.language, doctorStatus: "incomplete" },
  });
});

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v === "" ? null : v));

const applicationDraftSchema = z
  .object({
    displayName: optionalText(120),
    professionalRole: z.enum(PROFESSIONAL_ROLES).optional(),
    specialty: z.enum(SPECIALTIES).optional(),
    licenseNumber: optionalText(100),
    licensingBody: optionalText(200),
    state: z.enum(US_STATES).optional(),
    npiNumber: optionalText(20),
    qualifications: optionalText(1000),
    languages: z.array(z.enum(LANGUAGE_CODES)).max(10).optional(),
    yearsExperience: z.number().int().min(0).max(70).nullable().optional(),
    clinic: optionalText(200),
    modalities: z.array(z.enum(MODALITIES)).max(3).optional(),
    phone: z.string().trim().regex(/^[+()\d\s.-]{7,25}$/, "Enter a phone number patients can call").optional(),
    bio: optionalText(2000),
  })
  .strict();

function publicApplication(a: NonNullable<Awaited<ReturnType<typeof storage.getDoctorApplication>>>) {
  return {
    id: a.id,
    status: a.status,
    name: a.name,
    displayName: a.displayName,
    professionalRole: a.professionalRole,
    specialty: a.specialty,
    licenseNumber: a.licenseNumber,
    licensingBody: a.licensingBody,
    state: a.licensedStates?.[0] ?? null,
    npiNumber: a.npiNumber,
    qualifications: a.qualifications,
    languages: a.languages ?? [],
    yearsExperience: a.yearsExperience,
    clinic: a.clinic,
    modalities: a.modalities ?? ["phone"],
    phone: a.phone,
    bio: a.bio,
    infoRequest: a.status === "needs_info" ? a.infoRequest : null,
    // The reason is shown to the applicant; it is the reviewer's own words for them.
    decisionNote: a.status === "rejected" || a.status === "suspended" ? a.reviewerNotes : null,
    submittedAt: a.submittedAt,
  };
}

const REQUIRED_FOR_SUBMISSION: { key: string; present: (a: any) => boolean }[] = [
  { key: "professionalRole", present: (a) => !!a.professionalRole },
  { key: "specialty", present: (a) => !!a.specialty },
  { key: "state", present: (a) => !!a.licensedStates?.[0] },
  { key: "licenseNumber", present: (a) => !!a.licenseNumber },
  { key: "licensingBody", present: (a) => !!a.licensingBody },
  { key: "languages", present: (a) => (a.languages?.length ?? 0) > 0 },
  { key: "modalities", present: (a) => (a.modalities?.length ?? 0) > 0 },
  { key: "phone", present: (a) => !!a.phone },
];

router.get("/me/application", requireAuth, requireRole("doctor"), async (req, res) => {
  const userId = (req as any).userId as string;
  const application = await storage.getDoctorApplicationByUserId(userId);
  const status = await doctorStatusFor(userId);
  if (!application) return res.json({ status, application: null });
  res.json({ status, application: publicApplication(application) });
});

router.put("/me/application", requireAuth, requireRole("doctor"), async (req, res) => {
  const userId = (req as any).userId as string;
  const application = await storage.getDoctorApplicationByUserId(userId);
  if (!application) return res.status(404).json({ message: "No application for this account" });
  const parsed = applicationDraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid details" });

  const { state, ...rest } = parsed.data;
  const fields: Record<string, unknown> = { ...rest };
  if (state) fields.licensedStates = [state];
  const saved = await storage.saveDoctorApplicationDraft(application.id, fields as any);
  if (!saved) {
    return res.status(409).json({ message: "Your application can't be edited right now. It is already under review or has been decided." });
  }
  res.json(publicApplication(saved));
});

router.post("/me/application/submit", requireAuth, requireRole("doctor"), applyLimiter, async (req, res) => {
  const userId = (req as any).userId as string;
  const application = await storage.getDoctorApplicationByUserId(userId);
  if (!application) return res.status(404).json({ message: "No application for this account" });
  const missing = REQUIRED_FOR_SUBMISSION.filter((r) => !r.present(application)).map((r) => r.key);
  if (missing.length) {
    return res.status(400).json({ message: "Please complete the highlighted details before sending your application.", missing });
  }
  const submitted = await storage.submitDoctorApplication(application.id);
  if (!submitted) return res.status(409).json({ message: "Your application can't be submitted in its current state." });

  await logAudit({ actorUserId: userId, action: "doctor_application.submitted", targetType: "doctor_application", targetId: submitted.id, subjectUserId: null });
  sendDoctorApplicationReceivedEmail(submitted.email, submitted.name, normalizeLang((await storage.getUser(userId))?.language)).catch(() => {});
  for (const adminEmail of getAdminNotificationEmails()) {
    sendNewDoctorApplicationAdminEmail(adminEmail, submitted.name, submitted.specialty ?? "").catch(() => {});
  }
  res.json(publicApplication(submitted));
});

// What an approved doctor may change on their own. Licence, specialty and
// practice region are regulated facts an administrator verified, so changing
// them is deliberately not offered here.
const profileEditSchema = z
  .object({
    bio: optionalText(2000),
    clinic: optionalText(200),
    languages: z.array(z.enum(LANGUAGE_CODES)).min(1).max(10).optional(),
    modalities: z.array(z.enum(MODALITIES)).min(1).max(3).optional(),
    phone: z.string().trim().regex(/^[+()\d\s.-]{7,25}$/).optional(),
  })
  .strict();

router.get("/me/profile", requireAuth, requireApprovedDoctor, async (req, res) => {
  const p = (req as any).doctorProfile;
  res.json({
    id: p.id, name: p.name, specialty: p.specialty, state: p.state, bio: p.bio, clinic: p.clinic,
    languages: p.languages, modalities: p.modalities, phone: p.phone, timezone: p.timezone,
    licenseNumber: p.licenseNumber, licensingBody: p.licensingBody, verifiedAt: p.verifiedAt,
  });
});

router.patch("/me/profile", requireAuth, requireApprovedDoctor, async (req, res) => {
  const parsed = profileEditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid profile" });
  const p = (req as any).doctorProfile;
  const updated = await storage.updateDoctorProfileSelf(p.id, parsed.data as any);
  await logAudit({ actorUserId: (req as any).userId, action: "doctor.profile_updated", targetType: "doctor_profile", targetId: p.id });
  res.json({ id: updated?.id });
});

export default router;
