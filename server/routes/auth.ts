import { Router } from "express";
import bcrypt from "bcryptjs";
import { makeLimiter, emailKey } from "../middleware/rateLimit";
import { storage } from "../storage";
import { doctorStatusFor } from "../services/doctorStatus";
import { weakPasswordReason } from "../lib/password";
import { logAudit } from "../services/auditService";
import { normalizeLang } from "../services/serverText";
import { signToken, createDeviceForLogin, requireAuth } from "../middleware/auth";
import { insertUserSchema } from "@shared/schema";
import { US_STATES } from "@shared/specialties";
import { generateSecureToken, hashToken } from "../services/tokenService";
import { sendPasswordResetEmail } from "../services/emailService";
import { z } from "zod";
import { isDemoMode } from "../config";

const router = Router();

// A valid bcrypt hash of a random throwaway value, compared against when the
// login email doesn't exist (see /login).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(`dummy-${Math.random()}`, 10);

// Public, unauthenticated endpoints that create accounts or sessions are
// the highest-value targets for automated abuse.
const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: "Too many attempts. Please try again later.",
});

// Login is limited twice: per address (generous, because a clinic, library or
// care home puts many real people behind one IP) and per account, counting
// only failures, so one person's password can't be guessed at scale from
// anywhere. The cost is that someone who knows an email can lock that account
// out of sign-in for 15 minutes; that is the accepted trade for this app.
const loginIpLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  message: "Too many sign-in attempts from this connection. Please try again in a few minutes.",
});
const loginAccountLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  failuresOnly: true,
  keyGenerator: emailKey,
  message: "Too many incorrect attempts for this account. Please wait 15 minutes, or reset your password.",
});

// What the client is told about the signed-in person. doctorStatus is how the
// interface knows whether to show the clinician workspace or the verification
// screen; the server enforces it independently on every clinical route.
async function sessionUser(user: { id: string; name: string; email: string; role: string; state: string | null; language: string }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    state: user.state,
    language: user.language,
    ...(user.role === "doctor" ? { doctorStatus: await doctorStatusFor(user.id) } : {}),
  };
}

const signupBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
  state: z.enum(US_STATES),
  phone: z.string().optional(),
  language: z.enum(["en", "ar"]).optional(),
});

router.post("/signup", authLimiter, async (req, res) => {
  const parsed = signupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid signup details" });
  }
  const { name, email, password, state, phone, language } = parsed.data;
  const weak = weakPasswordReason(password, { email, name });
  if (weak) return res.status(400).json({ message: weak });

  const existing = await storage.getUserByEmail(email);
  if (existing) {
    return res.status(409).json({ message: "An account with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let user;
  try {
    user = await storage.createUser({
      name,
      email,
      passwordHash,
      role: "patient",
      state,
      phone: phone || null,
      language: language ?? "en",
      deactivatedAt: null,
      emailVerifiedAt: null,
    });
  } catch (err: any) {
    // The check above isn't atomic with this insert — a concurrent signup
    // for the same email can still race past it, caught here by the DB's
    // unique constraint instead.
    if (err?.code === "23505" || err?.cause?.code === "23505") {
      return res.status(409).json({ message: "An account with this email already exists" });
    }
    throw err;
  }

  const deviceId = await createDeviceForLogin(user.id, req);
  const token = signToken(user.id, user.role, deviceId);

  res.status(201).json({ token, user: await sessionUser(user) });
});

const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

router.post("/login", loginIpLimiter, loginAccountLimiter, async (req, res) => {
  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Email and password are required" });
  }
  const { email, password } = parsed.data;

  const user = await storage.getUserByEmail(email);

  // Always spend the same bcrypt work whether or not the account exists, so
  // response time can't be used to discover which emails are registered.
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  // A seeded demo account is refused like a wrong password when demo mode is off,
  // so its well-known password opens nothing in a real deployment.
  if (!user || !valid || (user.isDemo && !isDemoMode())) {
    return res.status(401).json({ message: "Invalid email or password" });
  }
  // Only someone who proved they know the password is told the account is
  // deactivated; anyone else gets the same generic answer as a wrong password.
  if (user.deactivatedAt) {
    return res.status(401).json({ message: "This account has been deactivated. Please contact support." });
  }

  const deviceId = await createDeviceForLogin(user.id, req);
  const token = signToken(user.id, user.role, deviceId);

  res.json({ token, user: await sessionUser(user) });
});

// One-tap sign-in to the seeded demo accounts. It exists only in demo mode
// (always off for a real deployment), and the demo password never ships in
// the browser bundle — the server does the sign-in.
const DEMO_ACCOUNTS: Record<string, string> = {
  patient: "patient@avela.dev",
  doctor: "doctor@avela.dev",
};

router.post("/demo-login", authLimiter, async (req, res) => {
  if (!isDemoMode()) return res.status(404).json({ message: "Not found" });
  const email = DEMO_ACCOUNTS[String(req.body?.role)];
  const user = email ? await storage.getUserByEmail(email) : undefined;
  if (!user || user.deactivatedAt) {
    return res.status(404).json({ message: "Demo accounts aren't set up. Run `npm run db:seed` first." });
  }
  const deviceId = await createDeviceForLogin(user.id, req);
  const token = signToken(user.id, user.role, deviceId);
  res.json({ token, user: await sessionUser(user) });
});

const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });

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
    // A new link replaces any earlier one, so only the latest email is ever valid.
    await storage.invalidatePasswordResetTokens(email);
    await storage.createPasswordResetToken(email, tokenHash, expiresAt);

    const appUrl = process.env.APP_URL || "http://localhost:3001";
    const resetLink = `${appUrl}/reset-password?token=${token}`;
    sendPasswordResetEmail(user.email, user.name, resetLink, normalizeLang(user.language)).catch(() => {});
  }

  res.json({ message: "If an account with that email exists, we've sent a password reset link." });
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});

router.post("/reset-password", authLimiter, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid request" });
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

  const weak = weakPasswordReason(password, { email: user.email, name: user.name });
  if (weak) return res.status(400).json({ message: weak });
  const passwordHash = await bcrypt.hash(password, 10);
  await storage.updateUserPassword(user.id, passwordHash);
  // One link, one use: this and every other link sent for this address stop working.
  await storage.invalidatePasswordResetTokens(resetToken.email);
  // A reset means the old password may be compromised, so every session
  // issued under it — including a stolen one — is signed out.
  await storage.revokeAllUserDevices(user.id);

  res.json({ message: "Password reset. You can now log in with your new password." });
});

// Signing out client-side alone would leave the JWT valid server-side for
// up to JWT_EXPIRY (24h) — this revokes the device so the token is
// rejected on the very next request (see requireAuth's revokedAt check).
router.post("/logout", requireAuth, async (req, res) => {
  const deviceId = (req as any).deviceId as string | null;
  if (deviceId) {
    await storage.revokeUserDevice(deviceId);
  }
  res.json({ message: "Signed out" });
});

// Ends every session on every device, including this one. For a lost phone, a
// shared computer, or the moment someone suspects their account was used.
router.post("/logout-all", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  await storage.revokeAllUserDevices(userId);
  await logAudit({ actorUserId: userId, action: "account.signed_out_everywhere", targetType: "user", targetId: userId });
  res.json({ message: "Signed out everywhere" });
});

router.get("/me", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const user = await storage.getUser(userId);
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json(await sessionUser(user));
});

// The person's own preferences. Language drives the interface and any
// notification text sent to them.
router.patch("/me/preferences", requireAuth, async (req, res) => {
  const parsed = z.object({ language: z.enum(["en", "ar"]) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Choose English or Arabic" });
  const user = await storage.updateUserLanguage((req as any).userId as string, parsed.data.language);
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json(await sessionUser(user));
});

export default router;
