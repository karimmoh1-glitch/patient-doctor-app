import crypto from "crypto";

/**
 * A signed statement of who a database transaction is for.
 *
 * Row-level security decides by "who is asking". That answer used to be a plain session setting the application wrote, which anyone
 * able to run SQL as the application's database role could write too, so the policies could be made to see any person (or the
 * server itself). The application now presents an ASSERTION instead: a short-lived value signed with a key that lives in two places,
 * the application's environment and a table the application's role cannot read. The database verifies the signature
 * (migration 0025, avela_identity_check) and ignores everything else. Whoever can run SQL as the role but does not hold the key can no longer
 * choose an identity. See docs/IDENTITY_BOUNDARY.md for exactly what this does and does not defend against.
 *
 * Format:  v1.<kid>.<mode>.<sub>.<exp>.<mac>
 *   mode  "user" (sub = the person's id) or "system" (sub = "-", for the server's own pre-sign-in and background work)
 *   exp   seconds since the epoch; the database rejects anything expired or further ahead than its configured limit
 *   mac   base64url(HMAC-SHA256(key, "avela-identity-v1\n" kid "\n" mode "\n" sub "\n" exp))
 */
export interface SignedIdentity {
  userId?: string;
  system?: boolean;
}

export const ASSERTION_TTL_SECONDS = 60;
const KID = /^[a-z0-9_-]{1,32}$/;
const SUB = /^[A-Za-z0-9_-]{1,64}$/;

export interface IdentityKey {
  kid: string;
  key: Buffer;
}

/**
 * The signing key. Production must configure it (IDENTITY_KEY_ID, IDENTITY_KEY: 32 random bytes, base64); the server refuses to
 * start without it. Development and tests use a fixed, publicly known key (registered in local databases only) so nothing extra has to be
 * set up; it is never accepted in production.
 */
export function identityKey(env: NodeJS.ProcessEnv = process.env): IdentityKey | null {
  if (env.IDENTITY_KEY) {
    const key = Buffer.from(env.IDENTITY_KEY, "base64");
    const kid = env.IDENTITY_KEY_ID ?? "";
    if (key.length !== 32 || !KID.test(kid)) throw new Error("IDENTITY_KEY must be 32 random bytes, base64 encoded, and IDENTITY_KEY_ID a short lowercase id.");
    return { kid, key };
  }
  if (env.NODE_ENV === "production") return null;
  return devIdentityKey();
}

/** A fixed, publicly known key for local databases only: tests, e2e and development. Production never accepts it and the database there never holds it. */
export function devIdentityKey(): IdentityKey {
  return { kid: "dev", key: crypto.createHash("sha256").update("avela-dev-identity-key-NOT-A-SECRET").digest() };
}

/** The two HMAC pad blocks the database stores instead of the key itself (RFC 2104), so it can compute HMAC with its built-in sha256. */
export function hmacPads(key: Buffer): { ipad: Buffer; opad: Buffer } {
  const block = Buffer.alloc(64);
  key.copy(block);
  return { ipad: Buffer.from(block.map((b) => b ^ 0x36)), opad: Buffer.from(block.map((b) => b ^ 0x5c)) };
}

const message = (kid: string, mode: string, sub: string, exp: number) => `avela-identity-v1\n${kid}\n${mode}\n${sub}\n${exp}`;

/** An assertion for this identity, or null for "nobody" (which is simply not asserted: the database then sees no one). */
export function signAssertion(id: SignedIdentity | undefined, k: IdentityKey, nowMs = Date.now(), ttl = ASSERTION_TTL_SECONDS): string | null {
  const mode = id?.system ? "system" : id?.userId ? "user" : null;
  if (!mode) return null;
  const sub = mode === "system" ? "-" : id!.userId!;
  if (mode === "user" && !SUB.test(sub)) throw new Error("This user id cannot be asserted.");
  const exp = Math.floor(nowMs / 1000) + ttl;
  const mac = crypto.createHmac("sha256", k.key).update(message(k.kid, mode, sub, exp)).digest("base64url");
  return ["v1", k.kid, mode, sub, exp, mac].join(".");
}
