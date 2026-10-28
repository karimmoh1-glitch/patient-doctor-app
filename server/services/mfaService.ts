import crypto from "crypto";
import jwt from "jsonwebtoken";
import { storage } from "../storage";
import { generateSecret, otpauthUri, verifyTotp } from "../lib/totp";

/**
 * Multi-factor sign-in for the roles that can act on other people's health information (clinicians) or on who may
 * (administrators). Password first; then, before any session exists, a six-digit code from an authenticator app (or a
 * single-use recovery code).
 *
 * Design points that matter:
 *  - No session is issued until the second factor is proven. The password step returns a short-lived CHALLENGE, signed with
 *    a different key from sessions and carrying no device: it can be exchanged for a session only by proving the code,
 *    and a session token can never be presented as a challenge or the reverse.
 *  - The authenticator secret is stored encrypted (AES-256-GCM) with the user's id as authenticated data, so a ciphertext
 *    copied onto another account does not decrypt.
 *  - A code seen once is never accepted again (the time-step is remembered); five wrong attempts lock the account's second
 *    factor for 15 minutes; recovery codes are 80-bit, hashed, single-use.
 *  - A person who loses both phone and recovery codes is reset by an administrator (audited), or by the operator for an
 *    administrator. There is no self-service bypass.
 */

/** Roles that must use a second factor. Patients and caregivers may be offered it later; clinicians, organization staff and administrators must. */
export const MFA_ROLES = new Set(["doctor", "admin", "staff"]);
export const roleRequiresMfa = (role: string) => MFA_ROLES.has(role);

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODES = 10;
const CHALLENGE_TTL = "5m";

// ---------------------------------------------------------------------------------------------- keys

function parseKey(name: string, configured: string): Buffer {
  const key = Buffer.from(configured, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 random bytes, base64 encoded.`);
  return key;
}

const keyId = (key: Buffer) => crypto.createHash("sha256").update("avela-mfa-key-id").update(key).digest("hex").slice(0, 8);

/**
 * The key everything is written with, and the one before it, which is only ever READ with. Rotating the key without locking anyone
 * out is: set MFA_ENCRYPTION_KEY_PREVIOUS to the old value and MFA_ENCRYPTION_KEY to the new, deploy, run `npm run mfa:rekey`
 * (re-encrypts every stored secret under the new key), have everyone regenerate or use up their recovery codes, then remove the
 * previous key. Nothing is lost at any step; removing it too early is what locks people out.
 */
function keyRing(): { current: Buffer; previous: Buffer | null } {
  const configured = process.env.MFA_ENCRYPTION_KEY;
  if (configured) {
    const current = parseKey("MFA_ENCRYPTION_KEY", configured);
    const prev = process.env.MFA_ENCRYPTION_KEY_PREVIOUS;
    const previous = prev ? parseKey("MFA_ENCRYPTION_KEY_PREVIOUS", prev) : null;
    return { current, previous: previous && !previous.equals(current) ? previous : null };
  }
  if (process.env.NODE_ENV === "production") throw new Error("MFA_ENCRYPTION_KEY is not set.");
  // Development and tests only: derived from the signing secret so nothing extra has to be configured.
  return { current: crypto.createHash("sha256").update(`avela-dev-mfa-key:${process.env.JWT_SECRET || "dev-secret-change-me"}`).digest(), previous: null };
}
const encryptionKey = () => keyRing().current;

export function encryptSecret(userId: string, secret: string): string {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v2", keyId(key), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** Which key a stored secret was written with: "current", "previous", or null if neither (or not recognisably ours). */
export function secretKeyAge(ciphertext: string): "current" | "previous" | null {
  const ring = keyRing();
  const parts = ciphertext.split(".");
  if (parts[0] === "v2") return parts[1] === keyId(ring.current) ? "current" : ring.previous && parts[1] === keyId(ring.previous) ? "previous" : null;
  return parts[0] === "v1" ? "current" : null; // legacy format carries no key id: tried against both on decryption
}

export function decryptSecret(userId: string, ciphertext: string): string {
  const parts = ciphertext.split(".");
  const ring = keyRing();
  let candidates: Buffer[];
  let iv: string | undefined, tag: string | undefined, body: string | undefined;
  if (parts[0] === "v2" && parts.length === 5) {
    [, , iv, tag, body] = parts;
    candidates = [ring.current, ring.previous].filter((k): k is Buffer => !!k && keyId(k) === parts[1]);
  } else if (parts[0] === "v1" && parts.length === 4) {
    [, iv, tag, body] = parts;
    candidates = [ring.current, ring.previous].filter((k): k is Buffer => !!k);
  } else throw new Error("unreadable secret");
  if (!iv || !tag || !body || candidates.length === 0) throw new Error("unreadable secret");
  for (const key of candidates) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(userId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      // wrong key for a v1 secret: try the next
    }
  }
  throw new Error("unreadable secret");
}

const hmacRecovery = (key: Buffer, normalized: string) => crypto.createHmac("sha256", key).update(`recovery:${normalized}`).digest("hex");
const recoveryHash = (normalized: string) => hmacRecovery(encryptionKey(), normalized);
/** Under every key still accepted, so a recovery code written before a rotation keeps working until the previous key is removed. */
const recoveryHashes = (normalized: string) => {
  const ring = keyRing();
  return [ring.current, ring.previous].filter((k): k is Buffer => !!k).map((k) => hmacRecovery(k, normalized));
};

// ---------------------------------------------------------------------------------------------- challenges

export type ChallengePurpose = "verify" | "setup";

function challengeSecret(): string {
  return `${process.env.JWT_SECRET || "dev-secret-change-me"}:mfa-challenge:v1`;
}

export function signChallenge(userId: string, purpose: ChallengePurpose): string {
  return jwt.sign({ sub: userId, purpose, kind: "mfa-challenge" }, challengeSecret(), { expiresIn: CHALLENGE_TTL });
}

/** The user a challenge was issued to, only if it is genuine, unexpired, and for exactly this purpose. */
export function readChallenge(token: unknown, purpose: ChallengePurpose): string | null {
  if (typeof token !== "string" || token.length > 2000) return null;
  try {
    const p = jwt.verify(token, challengeSecret()) as { sub?: string; purpose?: string; kind?: string; deviceId?: string };
    if (p.kind !== "mfa-challenge" || p.purpose !== purpose || !p.sub || p.deviceId) return null;
    return p.sub;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- state

export async function mfaState(userId: string): Promise<"enabled" | "none"> {
  const row = await storage.getMfa(userId);
  return row && !row.pending && row.enabledAt ? "enabled" : "none";
}

/** Test environments only: lets one fixture account sign in repeatedly inside one 30-second step. Refused in production. */
export const allowCodeReuse = () => process.env.MFA_ALLOW_CODE_REUSE === "1" && process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------------------------------------- enrolment

export async function beginEnrollment(user: { id: string; email: string }): Promise<{ secret: string; otpauthUri: string } | null> {
  const secret = generateSecret();
  const started = await storage.beginMfaEnrollment(user.id, encryptSecret(user.id, secret));
  if (!started) return null; // already enrolled: a working second factor is never replaced through this path
  return { secret, otpauthUri: otpauthUri(secret, user.email) };
}

export function newRecoveryCodes(): { shown: string[]; hashes: string[] } {
  const raw = Array.from({ length: RECOVERY_CODES }, () => generateSecret().slice(0, 16));
  return { shown: raw.map((c) => c.match(/.{4}/g)!.join("-")), hashes: raw.map(recoveryHash) };
}

export type EnrollResult = { ok: true; recoveryCodes: string[] } | { ok: false; reason: "invalid" | "locked" | "not_started"; lockedUntil?: Date };

export async function completeEnrollment(userId: string, code: string, now = Date.now()): Promise<EnrollResult> {
  const row = await storage.getMfa(userId);
  if (!row || !row.pending) return { ok: false, reason: "not_started" };
  if (row.lockedUntil && row.lockedUntil.getTime() > now) return { ok: false, reason: "locked", lockedUntil: row.lockedUntil };
  const step = verifyTotp(decryptSecret(userId, row.secretCiphertext), code.trim(), now);
  if (step === null) {
    const f = await storage.recordMfaFailure(userId, new Date(now), MAX_ATTEMPTS, LOCK_MINUTES);
    return f.lockedUntil ? { ok: false, reason: "locked", lockedUntil: f.lockedUntil } : { ok: false, reason: "invalid" };
  }
  if (!(await storage.enableMfa(userId, step))) return { ok: false, reason: "not_started" };
  const { shown, hashes } = newRecoveryCodes();
  await storage.replaceRecoveryCodes(userId, hashes);
  return { ok: true, recoveryCodes: shown };
}

// ---------------------------------------------------------------------------------------------- sign-in

export type SecondFactorResult =
  | { ok: true; usedRecoveryCode: boolean; recoveryCodesLeft: number }
  | { ok: false; reason: "invalid" | "locked"; lockedUntil?: Date };

/** Checks a six-digit code or a recovery code. Wrong answers count toward a lock-out; right ones can never be reused. */
export async function checkSecondFactor(userId: string, input: string, opts: { totpOnly?: boolean; now?: number } = {}): Promise<SecondFactorResult> {
  const now = opts.now ?? Date.now();
  const row = await storage.getMfa(userId);
  if (!row || row.pending || !row.enabledAt) return { ok: false, reason: "invalid" };
  if (row.lockedUntil && row.lockedUntil.getTime() > now) return { ok: false, reason: "locked", lockedUntil: row.lockedUntil };

  const value = String(input ?? "").trim();
  let accepted = false;
  let usedRecoveryCode = false;
  if (/^\d{6}$/.test(value)) {
    const step = verifyTotp(decryptSecret(userId, row.secretCiphertext), value, now);
    if (step !== null) accepted = await storage.recordMfaSuccess(userId, step, allowCodeReuse());
  } else if (!opts.totpOnly) {
    const normalized = value.replace(/[\s-]/g, "").toUpperCase();
    if (/^[A-Z2-7]{16}$/.test(normalized)) {
      accepted = await storage.consumeRecoveryCode(userId, recoveryHashes(normalized));
      usedRecoveryCode = accepted;
      if (accepted) await storage.clearMfaFailures(userId);
    }
  }
  if (accepted) return { ok: true, usedRecoveryCode, recoveryCodesLeft: await storage.countRecoveryCodes(userId) };

  const f = await storage.recordMfaFailure(userId, new Date(now), MAX_ATTEMPTS, LOCK_MINUTES);
  return f.lockedUntil && f.lockedUntil.getTime() > now ? { ok: false, reason: "locked", lockedUntil: f.lockedUntil } : { ok: false, reason: "invalid" };
}

export async function regenerateRecoveryCodes(userId: string, code: string): Promise<{ ok: true; recoveryCodes: string[] } | Exclude<SecondFactorResult, { ok: true }>> {
  const check = await checkSecondFactor(userId, code, { totpOnly: true });
  if (!check.ok) return check;
  const { shown, hashes } = newRecoveryCodes();
  await storage.replaceRecoveryCodes(userId, hashes);
  return { ok: true, recoveryCodes: shown };
}

export const lockMessageMinutes = (until?: Date) => Math.max(1, Math.ceil(((until?.getTime() ?? Date.now()) - Date.now()) / 60_000));
