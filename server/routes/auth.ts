import { Router } from "express";
import bcrypt from "bcryptjs";
import { makeLimiter, emailKey } from "../middleware/rateLimit";
import { storage } from "../storage";
import { doctorStatusFor } from "../services/doctorStatus";
import { weakPasswordReason } from "../lib/password";
import { logAudit } from "../services/auditService";
import { normalizeLang } from "../services/serverText";
import { signToken, issueSession, completeSession, clearSessionCookie, requireAuth } from "../middleware/auth";
import { beginEnrollment, checkSecondFactor, completeEnrollment, lockMessageMinutes, mfaState, readChallenge, regenerateRecoveryCodes, roleRequiresMfa } from "../services/mfaService";
import { isWebClient, setSessionCookie } from "../middleware/session";
import { insertUserSchema } from "@shared/schema";
import { US_STATES } from "@shared/specialties";
import { generateSecureToken, hashToken } from "../services/tokenService";
import { sendPasswordResetEmail } from "../services/emailService";
import { z } from "zod";
import { fixtureAccountsAllowed } from "../config";
import { systemAccess } from "../middleware/systemAccess";

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
async function sessionUser(user: { id: string; name: string; email: string; role: string; state: string | null; language: string; readReceipts?: boolean }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    state: user.state,
    language: user.language,
    readReceipts: user.readReceipts ?? true,
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

router.post("/signup", systemAccess, authLimiter, async (req, res) => {
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

  await issueSession(req, res, user, { user: await sessionUser(user) }, 201);
});

const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

router.post("/login", systemAccess, loginIpLimiter, loginAccountLimiter, async (req, res) => {
  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Email and password are required" });
  }
  const { email, password } = parsed.data;

  const user = await storage.getUserByEmail(email);

  // Always spend the same bcrypt work whether or not the account exists, so
  // response time can't be used to discover which emails are registered.
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  // A seeded fixture account is refused like a wrong password in production,
  // so its well-known password opens nothing in a real deployment.
  if (!user || !valid || (user.isDemo && !fixtureAccountsAllowed())) {
    return res.status(401).json({ message: "Invalid email or password" });
  }
  // Only someone who proved they know the password is told the account is
  // deactivated; anyone else gets the same generic answer as a wrong password.
  if (user.deactivatedAt) {
    return res.status(401).json({ message: "This account has been deactivated. Please contact support." });
  }

  await issueSession(req, res, user, { user: await sessionUser(user) });
});

// ---------------------------------------------------------------------------------------------------------------
// Second factor (clinicians and administrators). The password step returned a short-lived challenge; these three
// endpoints are the only way to exchange it for a session. See server/services/mfaService.ts.
// ---------------------------------------------------------------------------------------------------------------
const mfaIpLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, limit: 40, message: "Too many attempts. Please wait a few minutes and try again." });
const EXPIRED = "This step has expired. Please sign in again.";
const challengeBody = z.object({ challenge: z.string().min(10).max(2000), code: z.string().trim().min(6).max(40).optional() });

async function mfaFailureResponse(res: any, result: { reason: "invalid" | "locked"; lockedUntil?: Date }) {
  if (result.reason === "locked") {
    return res.status(429).json({ message: `Too many wrong codes. Try again in ${lockMessageMinutes(result.lockedUntil)} minutes, or ask an administrator to reset your sign-in.` });
  }
  return res.status(401).json({ message: "That code isn't right. Check your authenticator app and try again." });
}

router.post("/mfa/setup", systemAccess, mfaIpLimiter, async (req, res) => {
  const parsed = challengeBody.safeParse(req.body);
  const userId = parsed.success ? readChallenge(parsed.data.challenge, "setup") : null;
  if (!userId) return res.status(401).json({ message: EXPIRED });
  const user = await storage.getUser(userId);
  if (!user || user.deactivatedAt) return res.status(401).json({ message: EXPIRED });
  const started = await beginEnrollment(user);
  if (!started) return res.status(409).json({ message: "Sign-in codes are already set up for this account." });
  res.json({ secret: started.secret, otpauthUri: started.otpauthUri, account: user.email });
});

router.post("/mfa/enable", systemAccess, mfaIpLimiter, async (req, res) => {
  const parsed = challengeBody.safeParse(req.body);
  const userId = parsed.success ? readChallenge(parsed.data.challenge, "setup") : null;
  if (!userId || !parsed.success || !parsed.data.code) return res.status(401).json({ message: EXPIRED });
  const user = await storage.getUser(userId);
  if (!user || user.deactivatedAt) return res.status(401).json({ message: EXPIRED });
  const done = await completeEnrollment(userId, parsed.data.code);
  if (!done.ok) {
    if (done.reason === "not_started") return res.status(409).json({ message: "Set up your authenticator app first." });
    return mfaFailureResponse(res, done as { reason: "invalid" | "locked"; lockedUntil?: Date });
  }
  await logAudit({ actorUserId: userId, action: "mfa.enrolled", targetType: "user", targetId: userId });
  await completeSession(req, res, user, { user: await sessionUser(user), recoveryCodes: done.recoveryCodes }, 200, true);
});

router.post("/mfa/verify", systemAccess, mfaIpLimiter, async (req, res) => {
  const parsed = challengeBody.safeParse(req.body);
  const userId = parsed.success ? readChallenge(parsed.data.challenge, "verify") : null;
  if (!userId || !parsed.success || !parsed.data.code) return res.status(401).json({ message: EXPIRED });
  const user = await storage.getUser(userId);
  if (!user || user.deactivatedAt || (user.isDemo && !fixtureAccountsAllowed())) return res.status(401).json({ message: EXPIRED });
  const check = await checkSecondFactor(userId, parsed.data.code);
  if (!check.ok) {
    await logAudit({ actorUserId: userId, action: "mfa.failed", targetType: "user", targetId: userId });
    return mfaFailureResponse(res, check);
  }
  if (check.usedRecoveryCode) await logAudit({ actorUserId: userId, action: "mfa.recovery_code_used", targetType: "user", targetId: userId });
  await completeSession(req, res, user, { user: await sessionUser(user), recoveryCodesLeft: check.recoveryCodesLeft }, 200, true);
});

router.get("/mfa/status", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const user = await storage.getUser(userId);
  const state = await mfaState(userId);
  res.json({ required: !!user && roleRequiresMfa(user.role), enabled: state === "enabled", recoveryCodesLeft: state === "enabled" ? await storage.countRecoveryCodes(userId) : 0 });
});

// Replaces the recovery codes (the old ones stop working). Needs a current six-digit code, so a stolen session alone cannot do it.
router.post("/mfa/recovery-codes", requireAuth, mfaIpLimiter, async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Enter the six-digit code from your authenticator app." });
  const out = await regenerateRecoveryCodes(userId, parsed.data.code);
  if (!out.ok) return mfaFailureResponse(res, out);
  await logAudit({ actorUserId: userId, action: "mfa.recovery_codes_replaced", targetType: "user", targetId: userId });
  res.json({ recoveryCodes: out.recoveryCodes });
});

const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });

router.post("/forgot-password", systemAccess, authLimiter, async (req, res) => {
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

router.post("/reset-password", systemAccess, authLimiter, async (req, res) => {
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
  clearSessionCookie(req, res);
  res.json({ message: "Signed out" });
});

// Ends every session on every device, including this one. For a lost phone, a
// shared computer, or the moment someone suspects their account was used.
router.post("/logout-all", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  await storage.revokeAllUserDevices(userId);
  await logAudit({ actorUserId: userId, action: "account.signed_out_everywhere", targetType: "user", targetId: userId });
  clearSessionCookie(req, res);
  res.json({ message: "Signed out everywhere" });
});

// Moves a browser that still holds a token in script-readable storage (from before sessions lived in a
// cookie) onto the cookie. The old token is proof of an existing, live session; the page deletes it
// from storage once this succeeds. Only the web app calls this.
router.post("/session", requireAuth, async (req, res) => {
  if (!isWebClient(req)) return res.status(400).json({ message: "Not available" });
  if (!req.headers.authorization) return res.status(400).json({ message: "Not available" }); // already on a cookie
  const userId = (req as any).userId as string;
  const deviceId = (req as any).deviceId as string;
  const user = await storage.getUser(userId);
  if (!user) return res.status(401).json({ message: "Your session has ended. Please sign in again." });
  setSessionCookie(req, res, signToken(user.id, user.role, deviceId, (req as any).sessionMfa === true));
  res.json({ user: await sessionUser(user) });
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
  const parsed = z.object({ language: z.enum(["en", "ar"]).optional(), readReceipts: z.boolean().optional() }).strict().safeParse(req.body);
  if (!parsed.success || (parsed.data.language === undefined && parsed.data.readReceipts === undefined)) return res.status(400).json({ message: "Choose English or Arabic, or whether others see when you have read their messages" });
  const userId = (req as any).userId as string;
  if (parsed.data.readReceipts !== undefined) await storage.setReadReceipts(userId, parsed.data.readReceipts);
  if (parsed.data.language !== undefined) await storage.updateUserLanguage(userId, parsed.data.language);
  const user = await storage.getUser(userId);
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json(await sessionUser(user));
});

export default router;
