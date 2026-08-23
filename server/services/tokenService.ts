import crypto from "crypto";

// A cryptographically random raw value goes into the email link and is
// never persisted; only its SHA-256 hash is stored. A database read alone
// (backup leak, misconfigured access) exposes only hashes, which are
// useless without the original. Distinct from bcrypt (for passwords,
// deliberately slow to resist guessing low-entropy secrets) — these
// tokens already have 256 bits of entropy, so a fast, deterministic hash
// is correct here.
export function generateSecureToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
