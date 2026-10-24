import { Router } from "express";
import bcrypt from "bcryptjs";
import { makeLimiter } from "../middleware/rateLimit";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { isDemoMode } from "../config";
import { logAudit } from "../services/auditService";
import { getAvailability, isValidTimezone, replaceAvailability, validateAvailabilityWindows } from "../services/schedulingService";
import { insertDoctorApplicationSchema } from "@shared/schema";
import { SPECIALTIES, US_STATES } from "@shared/specialties";
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
router.get("/me/availability", requireAuth, requireRole("doctor"), async (req, res) => {
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

router.put("/me/availability", requireAuth, requireRole("doctor"), async (req, res) => {
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

// Public directory listing — never includes phone; that's only revealed
// once a pairing request is accepted (see routes/pairings.ts).
router.get("/", async (_req, res) => {
  // A profile with no login can never read or answer a request. Outside
  // demo mode it is not listed at all, rather than letting a patient wait
  // forever on someone who isn't there.
  const profiles = (await storage.getActiveDoctorProfiles()).filter((p) => p.userId || isDemoMode());
  res.json(
    profiles.map((p) => ({
      isDemoProfile: !p.userId,
      id: p.id,
      name: p.name,
      specialty: p.specialty,
      state: p.state,
      bio: p.bio,
    })),
  );
});

const applicationBodySchema = insertDoctorApplicationSchema
  .omit({ passwordHash: true })
  .extend({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(8).max(200),
    specialty: z.enum(SPECIALTIES),
    licensedStates: z.array(z.enum(US_STATES)).min(1),
  });

router.post("/applications", applyLimiter, async (req, res) => {
  const parsed = applicationBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid application" });
  }
  const { password, ...rest } = parsed.data;

  const existingUser = await storage.getUserByEmail(rest.email);
  if (existingUser) {
    return res.status(409).json({ message: "An account with this email already exists" });
  }
  const existingApplication = await storage.getDoctorApplicationByEmail(rest.email);
  if (existingApplication && existingApplication.status === "pending") {
    return res.status(409).json({ message: "An application with this email is already pending review" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const application = await storage.createDoctorApplication({ ...rest, passwordHash });

  sendDoctorApplicationReceivedEmail(application.email, application.name).catch(() => {});
  for (const adminEmail of getAdminNotificationEmails()) {
    sendNewDoctorApplicationAdminEmail(adminEmail, application.name, application.specialty).catch(() => {});
  }

  res.status(201).json({ id: application.id, status: application.status });
});

export default router;
