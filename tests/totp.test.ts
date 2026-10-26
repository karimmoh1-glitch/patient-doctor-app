import { describe, it, expect } from "vitest";
import { base32Decode, base32Encode, generateSecret, hotp, otpauthUri, stepAt, totp, verifyTotp } from "../server/lib/totp";

// RFC 4226 appendix D (HOTP) and RFC 6238 appendix B (TOTP): the published values every implementation must reproduce.
const ascii = (s: string) => Buffer.from(s, "ascii");

describe("one-time passwords", () => {
  it("reproduces the HOTP test vectors of RFC 4226", () => {
    const secret = ascii("12345678901234567890");
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(secret, counter), `counter ${counter}`).toBe(code));
  });

  it("reproduces the TOTP test vectors of RFC 6238 (8 digits, all three hashes)", () => {
    const vectors: [number, string, "sha1" | "sha256" | "sha512"][] = [
      [59, "94287082", "sha1"], [1111111109, "07081804", "sha1"], [1111111111, "14050471", "sha1"], [1234567890, "89005924", "sha1"], [2000000000, "69279037", "sha1"],
      [59, "46119246", "sha256"], [1111111109, "68084774", "sha256"], [1234567890, "91819424", "sha256"],
      [59, "90693936", "sha512"], [1111111109, "25091201", "sha512"], [1234567890, "93441116", "sha512"],
    ];
    const seeds = { sha1: "12345678901234567890", sha256: "12345678901234567890123456789012", sha512: "1234567890123456789012345678901234567890123456789012345678901234" };
    for (const [time, code, algo] of vectors) {
      expect(hotp(ascii(seeds[algo]), Math.floor(time / 30), algo, 8), `${algo} at ${time}`).toBe(code);
    }
  });

  it("round-trips base32 and rejects what is not base32", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(base32Decode("jbsw y3dp-ehpk 3pxp").toString("hex")).toBe("48656c6c6f21deadbeef"); // case, spaces and dashes are ignored
    expect(() => base32Decode("not base32!")).toThrow();
  });

  it("accepts the current code and one step either side, and nothing further", () => {
    const secret = generateSecret();
    const t = 1_700_000_000_000;
    const now = stepAt(t);
    const at = (offset: number) => totp(secret, t + offset * 30_000);
    expect(verifyTotp(secret, at(0), t)).toBe(now);
    expect(verifyTotp(secret, at(-1), t)).toBe(now - 1);
    expect(verifyTotp(secret, at(1), t)).toBe(now + 1);
    expect(verifyTotp(secret, at(-2), t)).toBeNull();
    expect(verifyTotp(secret, at(2), t)).toBeNull();
  });

  it("refuses anything that is not exactly six digits, or the wrong code", () => {
    const secret = generateSecret();
    const t = Date.now();
    const good = totp(secret, t);
    for (const bad of ["", "12345", "1234567", "abcdef", ` ${good}`, `${good} `, "000000" === good ? "000001" : "000000"]) expect(verifyTotp(secret, bad, t), JSON.stringify(bad)).toBeNull();
    expect(verifyTotp(generateSecret(), good, t)).toBeNull(); // another person's secret
  });

  it("builds the address an authenticator app reads, with the account name escaped", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "dr.o'brien+test@example.org");
    expect(uri).toBe("otpauth://totp/Avela:dr.o'brien%2Btest%40example.org?secret=JBSWY3DPEHPK3PXP&issuer=Avela&algorithm=SHA1&digits=6&period=30");
  });
});
