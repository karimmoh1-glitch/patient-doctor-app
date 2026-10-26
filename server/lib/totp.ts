import crypto from "crypto";

/**
 * Time-based one-time passwords (RFC 6238, which builds on the HOTP of RFC 4226): the six digits an authenticator
 * app shows, computed from a shared secret and the current 30-second step. Implemented here with Node's own HMAC so
 * there is no third-party code in the sign-in path; checked against the RFC's published test vectors.
 */

export const STEP_SECONDS = 30;
export const DIGITS = 6;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32.indexOf(clean[i]);
    if (idx < 0) throw new Error("not base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32 encoded (what an authenticator app is given). */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** The code for one step. `algorithm` is SHA-1 for authenticator apps; the RFC vectors also use SHA-256/512. */
export function hotp(secret: Buffer, counter: number, algorithm: "sha1" | "sha256" | "sha512" = "sha1", digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(algorithm, secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (timeMs: number) => Math.floor(timeMs / 1000 / STEP_SECONDS);

export function totp(secretBase32: string, timeMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), stepAt(timeMs));
}

/**
 * Checks a submitted code against the current step and one step either side (for clock drift and the moment a code
 * rolls over). Returns the step that matched, or null. Compared in constant time. The caller must remember the matched
 * step and refuse it (and anything older) next time, so a code seen once cannot be replayed.
 */
export function verifyTotp(secretBase32: string, code: string, timeMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = stepAt(timeMs);
  let matched: number | null = null;
  for (let step = now - window; step <= now + window; step++) {
    const expected = Buffer.from(hotp(secret, step));
    const given = Buffer.from(code);
    // Evaluate every step (no early exit) so timing does not reveal which one matched.
    if (crypto.timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  return matched;
}

/** The otpauth:// address that authenticator apps read from a QR code. */
export function otpauthUri(secretBase32: string, account: string, issuer = "Avela"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
