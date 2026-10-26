import { describe, it, expect, afterEach } from "vitest";
import crypto from "crypto";
import path from "path";
import { execFile } from "child_process";
import { createDoctor, signIn, operatorPool } from "./helpers";
import { decryptSecret, encryptSecret, secretKeyAge } from "../server/services/mfaService";

// Authenticator secrets are encrypted with MFA_ENCRYPTION_KEY, which used to be impossible to rotate once anyone had enrolled.
// A rotation now keeps the old key as MFA_ENCRYPTION_KEY_PREVIOUS (read-only) while `npm run mfa:rekey` moves everything over.

const key = () => crypto.randomBytes(32).toString("base64");
const A = key();
const B = key();
const saved = { k: process.env.MFA_ENCRYPTION_KEY, p: process.env.MFA_ENCRYPTION_KEY_PREVIOUS };
afterEach(() => {
  for (const [name, v] of [["MFA_ENCRYPTION_KEY", saved.k], ["MFA_ENCRYPTION_KEY_PREVIOUS", saved.p]] as const) {
    if (v === undefined) delete process.env[name]; else process.env[name] = v;
  }
});
const use = (current: string, previous?: string) => {
  process.env.MFA_ENCRYPTION_KEY = current;
  if (previous) process.env.MFA_ENCRYPTION_KEY_PREVIOUS = previous; else delete process.env.MFA_ENCRYPTION_KEY_PREVIOUS;
};

describe("rotating the authenticator-secret key", () => {
  it("still reads what the old key wrote while it is configured as the previous key, and says which key a secret is under", () => {
    use(A);
    const stored = encryptSecret("user-1", "JBSWY3DPEHPK3PXP");
    expect(secretKeyAge(stored)).toBe("current");
    use(B, A);
    expect(decryptSecret("user-1", stored)).toBe("JBSWY3DPEHPK3PXP");
    expect(secretKeyAge(stored)).toBe("previous");
    const fresh = encryptSecret("user-1", "JBSWY3DPEHPK3PXP");
    expect(secretKeyAge(fresh)).toBe("current");
    expect(fresh).not.toBe(stored);
  });

  it("cannot read the old secrets once the previous key is removed, which is why removal comes last", () => {
    use(A);
    const stored = encryptSecret("user-1", "JBSWY3DPEHPK3PXP");
    use(B);
    expect(() => decryptSecret("user-1", stored)).toThrow(/unreadable/);
    expect(secretKeyAge(stored)).toBeNull();
  });

  it("reads the earlier format that carried no key id, with whichever configured key opens it", () => {
    const k = Buffer.from(A, "base64");
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", k, iv);
    c.setAAD(Buffer.from("user-2"));
    const body = Buffer.concat([c.update("LEGACYSECRET234", "utf8"), c.final()]);
    const v1 = ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
    use(B, A);
    expect(decryptSecret("user-2", v1)).toBe("LEGACYSECRET234");
    use(B);
    expect(() => decryptSecret("user-2", v1)).toThrow(/unreadable/);
  });

  it("does not decrypt a secret copied onto another account", () => {
    use(A);
    const stored = encryptSecret("user-1", "JBSWY3DPEHPK3PXP");
    expect(() => decryptSecret("user-2", stored)).toThrow();
  });

  it("re-encrypts every stored secret under the new key, after which the old key can go and sign-in still works", async () => {
    const doctor = await createDoctor(); // enrols a second factor under the test environment's derived key
    const devKey = crypto.createHash("sha256").update(`avela-dev-mfa-key:${process.env.JWT_SECRET || "dev-secret-change-me"}`).digest("base64");
    const before = (await operatorPool().query("SELECT secret_ciphertext FROM user_mfa WHERE user_id = $1", [doctor.id])).rows[0].secret_ciphertext as string;
    expect(before.startsWith("v2.")).toBe(true);

    const run = (args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const c = execFile(path.resolve("node_modules/.bin/tsx"), [path.resolve("script/rekey-mfa.ts"), ...args], {
          cwd: path.resolve("."), timeout: 60_000,
          env: { ...process.env, NODE_ENV: "test", MFA_ENCRYPTION_KEY: B, MFA_ENCRYPTION_KEY_PREVIOUS: devKey },
        }, (err, so, se) => resolve({ code: err ? ((err as any).code ?? 1) : 0, out: `${so}${se}` }));
        c.stdin?.end();
      });
    // The shared test database holds secrets other suites wrote under keys of their own; those are reported as unreadable (exit 1),
    // which is exactly what the tool is for. This test asserts on the account it created.
    const status = await run(["--status"]);
    expect(status.out).toMatch(/"previous":\d+/);
    const done = await run([]);
    expect(done.out).not.toContain(devKey);
    expect(done.out).not.toContain(B);

    const after = (await operatorPool().query("SELECT secret_ciphertext FROM user_mfa WHERE user_id = $1", [doctor.id])).rows[0].secret_ciphertext as string;
    use(B); // the old key is gone
    expect(secretKeyAge(after)).toBe("current");
    const session = await signIn(doctor.email);
    expect(session.token).toBeTruthy();
    const audit = (await operatorPool().query("SELECT metadata FROM audit_logs WHERE action = 'mfa.rekeyed' ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(JSON.stringify(audit.metadata)).not.toMatch(/secret|ciphertext/i);
  });
});
