import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { storage } from "../storage";
import { signToken, createDeviceForLogin, requireAuth } from "../middleware/auth";
import { insertUserSchema } from "@shared/schema";
import { US_STATES } from "@shared/specialties";
import { generateSecureToken, hashToken } from "../services/tokenService";
import { sendPasswordResetEmail } from "../services/emailService";
import { z } from "zod";

const router = Router();

// Public, unauthenticated endpoints that create accounts or sessions are
// the highest-value targets for automated abuse.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later." },
});

const signupBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  state: z.enum(US_STATES),
  phone: z.string().optional(),
});

router.post("/signup", authLimiter, async (req, res) => {
  const parsed = signupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid signup details" });
  }
  const { name, email, password, state, phone } = parsed.data;

  const existing = await storage.getUserByEmail(email);
  if (existing) {
    return res.status(409).json({ message: "An account with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await storage.createUser({
    name,
    email,
    passwordHash,
    role: "patient",
    state,
    phone: phone || null,
    deactivatedAt: null,
    emailVerifiedAt: null,
  });

  const deviceId = await createDeviceForLogin(user.id, req);
  const token = signToken(user.id, user.role, deviceId);

  res.status(201).json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, state: user.state },
  });
});

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", authLimiter, async (req, res) => {
  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Email and password are required" });
  }
  const { email, password } = parsed.data;

  const user = await storage.getUserByEmail(email);
  if (!user) {
    return res.status(401).json({ message: "Invalid email or password" });
  }
  if (user.deactivatedAt) {
    return res.status(401).json({ message: "This account has been deactivated" });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ message: "Invalid email or password" });
  }

  const deviceId = await createDeviceForLogin(user.id, req);
  const token = signToken(user.id, user.role, deviceId);

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, state: user.state },
  });
});

const forgotPasswordSchema = z.object({ email: z.string().email() });

router.post("/forgot-password", authLimiter, async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "A valid email is required" });
  }
  const { email } = parsed.data;

  // Always respond the same way whether or not the account exists — a
  // different response would let anyone enumerate registered emails.
  const user = await storage.getUserByEmail(email);
  if (user) {
    const { token, tokenHash } = generateSecureToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await storage.createPasswordResetToken(email, tokenHash, expiresAt);

    const appUrl = process.env.APP_URL || "http://localhost:3001";
    const resetLink = `${appUrl}/reset-password?token=${token}`;
    sendPasswordResetEmail(user.email, user.name, resetLink).catch(() => {});
  }

  res.json({ message: "If an account with that email exists, we've sent a password reset link." });
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

router.post("/reset-password", authLimiter, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid request" });
  }
  const { token, password } = parsed.data;

  const tokenHash = hashToken(token);
  const resetToken = await storage.getPasswordResetTokenByHash(tokenHash);
  if (!resetToken || resetToken.used || resetToken.expiresAt < new Date()) {
    return res.status(400).json({ message: "This reset link is invalid or has expired" });
  }

  const user = await storage.getUserByEmail(resetToken.email);
  if (!user) {
    return res.status(400).json({ message: "This reset link is invalid or has expired" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await storage.updateUserPassword(user.id, passwordHash);
  await storage.markPasswordResetTokenUsed(resetToken.id);

  res.json({ message: "Password reset. You can now log in with your new password." });
});

router.get("/me", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const user = await storage.getUser(userId);
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, state: user.state });
});

export default router;
