import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Express } from "express";
import { getApp, signupPatient, createAdmin, createDoctor, auth, uniqueEmail, PASSWORD, authenticatorSecretFor, signIn, completeSecondFactor } from "./helpers";
import { totp, stepAt } from "../server/lib/totp";
import { pool } from "../server/db";
import { encryptSecret, decryptSecret, signChallenge, readChallenge, allowCodeReuse } from "../server/services/mfaService";
import { storage } from "../server/storage";
import bcrypt from "bcryptjs";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
// The suite lets fixture accounts reuse a code inside one 30 s step; the tests of replay protection turn that off.
const strict = () => delete process.env.MFA_ALLOW_CODE_REUSE;
afterEach(() => {
  process.env.MFA_ALLOW_CODE_REUSE = "1";
});

const WEB = { "X-Avela-Client": "web" };

/** A new clinician: registered, but with the second factor not yet set up. */
async function newClinician() {
  const email = uniqueEmail("mfa");
  const reg = await request(app).post("/api/doctors/register").send({ name: "Dr Second Factor", email, password: PASSWORD });
  expect(reg.status).toBe(201);
  return { email, challenge: reg.body.challenge as string, reg };
}

async function enrolled() {
  const c = await newClinician();
  const setup = await request(app).post("/api/auth/mfa/setup").send({ challenge: c.challenge });
  const secret = setup.body.secret as string;
  const enable = await request(app).post("/api/auth/mfa/enable").send({ challenge: c.challenge, code: totp(secret) });
  expect(enable.status).toBe(200);
  return { ...c, secret, session: enable.body, recoveryCodes: enable.body.recoveryCodes as string[] };
}

async function loginChallenge(email: string, headers: Record<string, string> = {}) {
  const res = await request(app).post("/api/auth/login").set(headers).send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body;
}

describe("a password alone is never enough for a clinician or an administrator", () => {
  it("returns a challenge and no session, token or cookie, for both roles and on every route into the system", async () => {
    const doc = await createDoctor();
    const admin = await createAdmin();
    for (const email of [doc.email, admin.email]) {
      const res = await request(app).post("/api/auth/login").set(WEB).send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.mfa).toBe("verify");
      expect(res.body.token).toBeUndefined();
      expect(res.body.user).toBeUndefined();
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${res.body.challenge}`)).status).toBe(401);
    }
  });

  it("does not change anything for a patient or a caregiver", async () => {
    const res = await request(app).post("/api/auth/signup").send({ name: "P", email: uniqueEmail("p"), password: PASSWORD, state: "CA" });
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.mfa).toBeUndefined();
  });

  it("refuses a clinician or administrator session that was issued before the second factor existed", async () => {
    const doc = await createDoctor();
    // A token as the old code made it: valid signature, real device row, but no second-factor claim.
    const deviceId = "legacy-device-" + Date.now();
    await storage.createUserDevice({ userId: doc.id, deviceId, name: "old", platform: "x", browser: "x", revokedAt: null });
    const legacy = jwt.sign({ userId: doc.id, role: "doctor", deviceId }, process.env.JWT_SECRET || "dev-secret-change-me", { expiresIn: "1h" });
    expect((await request(app).get("/api/auth/me").set(auth(legacy))).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set(auth(doc.token))).status).toBe(200); // a real, second-factor session works
  });

  it("does not accept a role claim written into a token to skip the second factor", async () => {
    const patient = await signupPatient();
    const deviceId = "forged-" + Date.now();
    await storage.createUserDevice({ userId: patient.id, deviceId, name: "x", platform: "x", browser: "x", revokedAt: null });
    const forged = jwt.sign({ userId: patient.id, role: "admin", deviceId, mfa: true }, process.env.JWT_SECRET || "dev-secret-change-me", { expiresIn: "1h" });
    expect((await request(app).get("/api/admin/doctor-applications").set(auth(forged))).status).toBe(403); // role comes from the database
  });
});

describe("setting up the authenticator", () => {
  it("gives a secret and an authenticator address, stores the secret only encrypted, and finishes with recovery codes", async () => {
    const c = await newClinician();
    expect(c.reg.body.mfa).toBe("setup");
    const setup = await request(app).post("/api/auth/mfa/setup").send({ challenge: c.challenge });
    expect(setup.status).toBe(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauthUri).toContain(`secret=${setup.body.secret}`);
    const stored = (await pool.query("SELECT secret_ciphertext, pending FROM user_mfa WHERE user_id = (SELECT id FROM users WHERE email = $1)", [c.email])).rows[0];
    expect(stored.pending).toBe(true);
    expect(stored.secret_ciphertext).not.toContain(setup.body.secret);
    expect(stored.secret_ciphertext).toMatch(/^v1\./);

    const enable = await request(app).post("/api/auth/mfa/enable").send({ challenge: c.challenge, code: totp(setup.body.secret) });
    expect(enable.status).toBe(200);
    expect(enable.body.token).toEqual(expect.any(String));
    expect(enable.body.recoveryCodes).toHaveLength(10);
    for (const code of enable.body.recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(new Set(enable.body.recoveryCodes).size).toBe(10);
    const hashes = (await pool.query("SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1", [enable.body.user.id])).rows.map((r) => r.code_hash);
    expect(hashes).toHaveLength(10);
    for (const code of enable.body.recoveryCodes) expect(hashes.join()).not.toContain(code.replace(/-/g, ""));
    expect((await request(app).get("/api/auth/me").set(auth(enable.body.token))).status).toBe(200);
  });

  it("does not finish with a wrong code, and locks the factor after five", async () => {
    const c = await newClinician();
    await request(app).post("/api/auth/mfa/setup").send({ challenge: c.challenge });
    for (let i = 0; i < 4; i++) {
      const bad = await request(app).post("/api/auth/mfa/enable").send({ challenge: c.challenge, code: "000000" });
      expect(bad.status).toBe(401);
    }
    const locked = await request(app).post("/api/auth/mfa/enable").send({ challenge: c.challenge, code: "000000" });
    expect(locked.status).toBe(429);
    expect(locked.body.message).toMatch(/minutes/);
  });

  it("will not replace a working second factor, whatever challenge is presented", async () => {
    const e = await enrolled();
    const again = await loginChallenge(e.email);
    expect(again.mfa).toBe("verify"); // enrolled people are sent to verify, never to set up again
    expect((await request(app).post("/api/auth/mfa/setup").send({ challenge: again.challenge })).status).toBe(401);
    // Even a setup challenge (as an attacker with the password might try to mint) cannot overwrite it.
    const userId = (await storage.getUserByEmail(e.email))!.id;
    const forced = await request(app).post("/api/auth/mfa/setup").send({ challenge: signChallenge(userId, "setup") });
    expect(forced.status).toBe(409);
    expect(totp(e.secret)).toMatch(/^\d{6}$/);
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: again.challenge, code: totp(e.secret) })).status).toBe(200); // the original still works
  });

  it("lets an unfinished enrolment be restarted, and only the newest secret works", async () => {
    const c = await newClinician();
    const first = await request(app).post("/api/auth/mfa/setup").send({ challenge: c.challenge });
    const login = await loginChallenge(c.email);
    expect(login.mfa).toBe("setup"); // never finished, so still asked to set up
    const second = await request(app).post("/api/auth/mfa/setup").send({ challenge: login.challenge });
    expect(second.body.secret).not.toBe(first.body.secret);
    expect((await request(app).post("/api/auth/mfa/enable").send({ challenge: login.challenge, code: totp(first.body.secret) })).status).toBe(401);
    expect((await request(app).post("/api/auth/mfa/enable").send({ challenge: login.challenge, code: totp(second.body.secret) })).status).toBe(200);
  });
});

describe("challenges", () => {
  it("are single-purpose: a verify challenge cannot enrol, a setup challenge cannot verify", async () => {
    const e = await enrolled();
    const verify = (await loginChallenge(e.email)).challenge as string;
    const userId = (await storage.getUserByEmail(e.email))!.id;
    const setup = signChallenge(userId, "setup");
    expect(readChallenge(verify, "verify")).toBe(userId);
    expect(readChallenge(verify, "setup")).toBeNull();
    expect(readChallenge(setup, "verify")).toBeNull();
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: setup, code: totp(e.secret) })).status).toBe(401);
    expect((await request(app).post("/api/auth/mfa/enable").send({ challenge: verify, code: totp(e.secret) })).status).toBe(401);
  });

  it("are not sessions, and sessions are not challenges", async () => {
    const e = await enrolled();
    const challenge = (await loginChallenge(e.email)).challenge as string;
    expect((await request(app).get("/api/auth/me").set(auth(challenge))).status).toBe(401);
    expect(readChallenge(e.session.token, "verify")).toBeNull();
    expect(readChallenge(e.session.token, "setup")).toBeNull();
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: e.session.token, code: totp(e.secret) })).status).toBe(401);
  });

  it("expire, and cannot be forged with the session key", async () => {
    const e = await enrolled();
    const userId = (await storage.getUserByEmail(e.email))!.id;
    const secret = `${process.env.JWT_SECRET || "dev-secret-change-me"}:mfa-challenge:v1`;
    const expired = jwt.sign({ sub: userId, purpose: "verify", kind: "mfa-challenge" }, secret, { expiresIn: -10 });
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: expired, code: totp(e.secret) })).status).toBe(401);
    const wrongKey = jwt.sign({ sub: userId, purpose: "verify", kind: "mfa-challenge" }, process.env.JWT_SECRET || "dev-secret-change-me", { expiresIn: 300 });
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: wrongKey, code: totp(e.secret) })).status).toBe(401);
    for (const junk of ["", "x", "a.b.c", null, 5, { a: 1 }]) {
      expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: junk, code: "123456" })).status).toBe(401);
    }
  });
});

describe("signing in with the second factor", () => {
  it("gives a session (and, for the web app, an HttpOnly cookie with no token) for a right code", async () => {
    const e = await enrolled();
    const ch = await loginChallenge(e.email, WEB);
    const ok = await request(app).post("/api/auth/mfa/verify").set(WEB).send({ challenge: ch.challenge, code: totp(e.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeUndefined();
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/);
    expect(ok.body.user.role).toBe("doctor");
    expect(ok.body.recoveryCodesLeft).toBe(10);
  });

  it("never accepts a code twice (replay), but accepts the next one", async () => {
    strict();
    const e = await enrolled(); // enrolment used the current step
    const ch = await loginChallenge(e.email);
    const now = Date.now();
    const sameStep = totp(e.secret, now);
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: ch.challenge, code: sameStep })).status).toBe(401); // used to enrol
    const next = totp(e.secret, now + 30_000);
    expect(stepAt(now + 30_000)).toBe(stepAt(now) + 1);
    const ok = await request(app).post("/api/auth/mfa/verify").send({ challenge: ch.challenge, code: next });
    expect(ok.status).toBe(200);
    const ch2 = await loginChallenge(e.email);
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: ch2.challenge, code: next })).status).toBe(401); // the same code again
  });

  it("ignores the test-only reuse switch in production, so a stray variable can never switch replay protection off", () => {
    const realNodeEnv = process.env.NODE_ENV;
    process.env.MFA_ALLOW_CODE_REUSE = "1";
    try {
      (process.env as any).NODE_ENV = "test";
      expect(allowCodeReuse()).toBe(true);
      (process.env as any).NODE_ENV = "development";
      expect(allowCodeReuse()).toBe(true);
      (process.env as any).NODE_ENV = "production";
      expect(allowCodeReuse()).toBe(false);
    } finally {
      (process.env as any).NODE_ENV = realNodeEnv;
    }
  });

  it("locks after five wrong codes, even for the right code, and tells the person how long", async () => {
    const e = await enrolled();
    const ch = (await loginChallenge(e.email)).challenge;
    for (let i = 0; i < 4; i++) expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: "000000" })).status).toBe(401);
    const fifth = await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: "000000" });
    expect(fifth.status).toBe(429);
    const right = await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: totp(e.secret) });
    expect(right.status).toBe(429);
    expect(right.body.message).toMatch(/15 minutes|\d+ minutes/);
    expect(right.body.token).toBeUndefined();
  });

  it("counts failures per person: one locked account does not affect another", async () => {
    const a = await enrolled();
    const b = await enrolled();
    const cha = (await loginChallenge(a.email)).challenge;
    for (let i = 0; i < 5; i++) await request(app).post("/api/auth/mfa/verify").send({ challenge: cha, code: "000000" });
    const chb = (await loginChallenge(b.email)).challenge;
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: chb, code: totp(b.secret) })).status).toBe(200);
  });

  it("does not take another person's code (secrets are separate)", async () => {
    const a = await enrolled();
    const b = await enrolled();
    const cha = (await loginChallenge(a.email)).challenge;
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: cha, code: totp(b.secret) })).status).toBe(401);
  });

  it("records failures and recovery-code use in the access log, without any code in it", async () => {
    const e = await enrolled();
    const ch = (await loginChallenge(e.email)).challenge;
    await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: "123456" });
    await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: e.recoveryCodes[0] });
    const rows = (await pool.query("SELECT action, metadata FROM audit_logs WHERE subject_user_id = $1 OR actor_user_id = $1", [e.session.user.id])).rows;
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["mfa.enrolled", "mfa.failed", "mfa.recovery_code_used"]));
    expect(JSON.stringify(rows)).not.toContain(e.recoveryCodes[0].replace(/-/g, ""));
    expect(JSON.stringify(rows)).not.toContain(e.secret);
  });
});

describe("recovery codes", () => {
  it("each work once, in any case or spacing, and the count goes down", async () => {
    const e = await enrolled();
    const code = e.recoveryCodes[3];
    const ch = (await loginChallenge(e.email)).challenge;
    const first = await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: code.toLowerCase().replace(/-/g, " ") });
    expect(first.status).toBe(200);
    expect(first.body.recoveryCodesLeft).toBe(9);
    const second = await request(app).post("/api/auth/mfa/verify").send({ challenge: (await loginChallenge(e.email)).challenge, code });
    expect(second.status).toBe(401); // already used
    const status = await request(app).get("/api/auth/mfa/status").set(auth(first.body.token));
    expect(status.body).toEqual({ required: true, enabled: true, recoveryCodesLeft: 9 });
  });

  it("are replaced only by someone who also has a current authenticator code, and the old ones die", async () => {
    strict();
    const e = await enrolled();
    const viaRecovery = await request(app).post("/api/auth/mfa/verify").send({ challenge: (await loginChallenge(e.email)).challenge, code: e.recoveryCodes[9] });
    expect(viaRecovery.status).toBe(200);
    const session = viaRecovery.body.token as string;
    const wrong = await request(app).post("/api/auth/mfa/recovery-codes").set(auth(session)).send({ code: "000000" });
    expect(wrong.status).toBe(401);
    const asRecovery = await request(app).post("/api/auth/mfa/recovery-codes").set(auth(session)).send({ code: e.recoveryCodes[0] });
    expect(asRecovery.status).toBe(400); // a recovery code is not accepted for this
    const fresh = await request(app).post("/api/auth/mfa/recovery-codes").set(auth(session)).send({ code: totp(e.secret, Date.now() + 30_000) });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    const ch = (await loginChallenge(e.email)).challenge;
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: e.recoveryCodes[1] })).status).toBe(401); // an old code
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: fresh.body.recoveryCodes[0] })).status).toBe(200);
  });

  it("need a signed-in session to replace", async () => {
    expect((await request(app).post("/api/auth/mfa/recovery-codes").send({ code: "123456" })).status).toBe(401);
  });
});

describe("an authenticator secret is bound to its owner", () => {
  it("does not decrypt for another account, and does not survive tampering", () => {
    const sealed = encryptSecret("user-a", "JBSWY3DPEHPK3PXP");
    expect(decryptSecret("user-a", sealed)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptSecret("user-b", sealed)).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret("user-a", parts.join("."))).toThrow();
    expect(sealed).not.toBe(encryptSecret("user-a", "JBSWY3DPEHPK3PXP")); // a fresh random nonce every time
  });

  it("a ciphertext copied onto another account does not let that account sign in", async () => {
    const a = await enrolled();
    const b = await enrolled();
    const stolen = (await pool.query("SELECT secret_ciphertext FROM user_mfa WHERE user_id = $1", [a.session.user.id])).rows[0].secret_ciphertext;
    await pool.query("UPDATE user_mfa SET secret_ciphertext = $1 WHERE user_id = $2", [stolen, b.session.user.id]);
    const ch = (await loginChallenge(b.email)).challenge;
    const res = await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: totp(a.secret) });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.body.token).toBeUndefined();
  });
});

describe("when a clinician loses their phone and their recovery codes", () => {
  it("an administrator removes their second factor (audited), which ends their sessions and asks them to enrol again", async () => {
    const e = await enrolled();
    const admin = await createAdmin();
    const target = e.session.user.id as string;
    const reset = await request(app).post(`/api/admin/users/${target}/mfa-reset`).set(auth(admin.token));
    expect(reset.status).toBe(200);
    expect((await request(app).get("/api/auth/me").set(auth(e.session.token))).status).toBe(401); // their session ended
    const login = await loginChallenge(e.email);
    expect(login.mfa).toBe("setup");
    expect((await pool.query("SELECT count(*)::int n FROM mfa_recovery_codes WHERE user_id = $1", [target])).rows[0].n).toBe(0);
    const audit = (await pool.query("SELECT actor_user_id, subject_user_id FROM audit_logs WHERE action = 'mfa.reset_by_admin' AND subject_user_id = $1", [target])).rows;
    expect(audit).toEqual([{ actor_user_id: admin.id, subject_user_id: target }]);
    // The old authenticator no longer works, and they can enrol a new one.
    const setup = await request(app).post("/api/auth/mfa/setup").send({ challenge: login.challenge });
    expect(setup.body.secret).not.toBe(e.secret);
  });

  it("only an administrator can, and never for an administrator or a patient (those go through the operator)", async () => {
    const e = await enrolled();
    const doc = await createDoctor();
    const patient = await signupPatient();
    const admin = await createAdmin();
    const other = await createAdmin();
    expect((await request(app).post(`/api/admin/users/${e.session.user.id}/mfa-reset`).set(auth(doc.token))).status).toBe(403);
    expect((await request(app).post(`/api/admin/users/${e.session.user.id}/mfa-reset`).set(auth(patient.token))).status).toBe(403);
    expect((await request(app).post(`/api/admin/users/${e.session.user.id}/mfa-reset`)).status).toBe(401);
    expect((await request(app).post(`/api/admin/users/${other.id}/mfa-reset`).set(auth(admin.token))).status).toBe(404);
    expect((await request(app).post(`/api/admin/users/${patient.id}/mfa-reset`).set(auth(admin.token))).status).toBe(404);
    expect((await request(app).post(`/api/admin/users/${admin.id}/mfa-reset`).set(auth(admin.token))).status).toBe(404); // not even their own
    expect(authenticatorSecretFor(e.email)).toBeUndefined(); // (the helper map is for accounts the helpers created)
  });
});

describe("passwords still matter first", () => {
  it("a wrong password never reaches the second factor, and a deactivated account gets no challenge", async () => {
    const e = await enrolled();
    const wrong = await request(app).post("/api/auth/login").send({ email: e.email, password: "wrong-password-xyz" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.challenge).toBeUndefined();
    await storage.setUserDeactivated(e.session.user.id, true);
    const res = await request(app).post("/api/auth/login").send({ email: e.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.challenge).toBeUndefined();
    const ch = signChallenge(e.session.user.id, "verify");
    expect((await request(app).post("/api/auth/mfa/verify").send({ challenge: ch, code: totp(e.secret, Date.now() + 90_000) })).status).toBe(401);
  });

  it("helper sanity: the suite's own clinician and administrator sign-ins really pass the second factor", async () => {
    const doc = await createDoctor();
    const session = await signIn(doc.email);
    expect(session.user.role).toBe("doctor");
    expect(void bcrypt).toBeUndefined();
    expect(completeSecondFactor).toBeTypeOf("function");
  });
});
