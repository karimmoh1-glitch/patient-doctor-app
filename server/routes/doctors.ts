import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { storage } from "../storage";
import { insertDoctorApplicationSchema } from "@shared/schema";
import { SPECIALTIES, US_STATES } from "@shared/specialties";
import {
  sendDoctorApplicationReceivedEmail,
  sendNewDoctorApplicationAdminEmail,
  getAdminNotificationEmails,
} from "../services/emailService";

const router = Router();

const applyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later." },
});

// Public directory listing — never includes phone; that's only revealed
// once a pairing request is accepted (see routes/pairings.ts).
router.get("/", async (_req, res) => {
  const profiles = await storage.getActiveDoctorProfiles();
  res.json(
    profiles.map((p) => ({
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
    password: z.string().min(8),
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
