import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, auth, uniqueEmail, PASSWORD } from "./helpers";
import { storage } from "../server/storage";
import { db } from "../server/db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

// Capture reset links instead of sending email.
const sentResetLinks: { to: string; link: string }[] = [];
vi.mock("../server/services/emailService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/services/emailService")>();
  return {
    ...original,
    sendPasswordResetEmail: async (to: string, _name: string, link: string) => {
      sentResetLinks.push({ to, link });
    },
  };
});

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

describe("signup", () => {
  it("creates a patient and returns a working session", async () => {
    const user = await signupPatient();
    const me = await request(app).get("/api/auth/me").set(auth(user.token));
    expect(me.status).toBe(200);
    expect(me.body.role).toBe("patient");
  });

  it("ignores a role supplied in the request body (no self-promotion)", async () => {
    const email = uniqueEmail("sneaky");
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ name: "Sneaky", email, password: PASSWORD, state: "CA", role: "admin" });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("patient");
  });

  it("rejects a duplicate email", async () => {
    const user = await signupPatient();
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ name: "Dup", email: user.email, password: PASSWORD, state: "CA" });
    expect(res.status).toBe(409);
  });

  it("rejects an invalid state and a short password", async () => {
    const bad = await request(app)
      .post("/api/auth/signup")
      .send({ name: "X", email: uniqueEmail("bad"), password: "short", state: "ZZ" });
    expect(bad.status).toBe(400);
  });
});

describe("login", () => {
  it("gives the identical response for a wrong password and an unknown email", async () => {
    const user = await signupPatient();
    const wrongPassword = await request(app).post("/api/auth/login").send({ email: user.email, password: "Wrong-Password-1" });
    const unknownEmail = await request(app).post("/api/auth/login").send({ email: uniqueEmail("nobody"), password: "Wrong-Password-1" });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it("does not reveal that an account exists or is deactivated before the password is verified", async () => {
    const user = await signupPatient();
    await db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, user.id));

    const wrongPassword = await request(app).post("/api/auth/login").send({ email: user.email, password: "Wrong-Password-1" });
    const unknownEmail = await request(app).post("/api/auth/login").send({ email: uniqueEmail("nobody"), password: "Wrong-Password-1" });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it("still blocks a deactivated account that supplies the right password", async () => {
    const user = await signupPatient();
    await db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, user.id));
    const res = await request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it("cuts off an already-issued token the moment the account is deactivated", async () => {
    const user = await signupPatient();
    await db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, user.id));
    const res = await request(app).get("/api/auth/me").set(auth(user.token));
    expect(res.status).toBe(401);
  });
});

describe("sessions", () => {
  it("revokes the token server-side on logout", async () => {
    const user = await signupPatient();
    const out = await request(app).post("/api/auth/logout").set(auth(user.token));
    expect(out.status).toBe(200);
    const after = await request(app).get("/api/auth/me").set(auth(user.token));
    expect(after.status).toBe(401);
  });

  it("rejects missing, malformed and forged tokens", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set({ Authorization: "Bearer not.a.jwt" })).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set({ Authorization: "Basic abc" })).status).toBe(401);
  });
});

describe("password reset", () => {
  it("answers identically whether or not the account exists", async () => {
    const user = await signupPatient();
    const known = await request(app).post("/api/auth/forgot-password").send({ email: user.email });
    const unknown = await request(app).post("/api/auth/forgot-password").send({ email: uniqueEmail("ghost") });
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it("resets the password, consumes the token, and signs out every existing session", async () => {
    const user = await signupPatient();
    sentResetLinks.length = 0;
    await request(app).post("/api/auth/forgot-password").send({ email: user.email });
    await vi.waitFor(() => expect(sentResetLinks.length).toBe(1));
    const token = new URL(sentResetLinks[0].link).searchParams.get("token")!;

    const newPassword = "A-Brand-New-Passphrase-7";
    const reset = await request(app).post("/api/auth/reset-password").send({ token, password: newPassword });
    expect(reset.status).toBe(200);

    // Single use.
    const replay = await request(app).post("/api/auth/reset-password").send({ token, password: "Another-Passphrase-8" });
    expect(replay.status).toBe(400);

    // Old password dead, new password works.
    expect((await request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: user.email, password: newPassword })).status).toBe(200);

    // A session that existed before the reset (e.g. a stolen token) must not survive it.
    const old = await request(app).get("/api/auth/me").set(auth(user.token));
    expect(old.status).toBe(401);
  });

  it("rejects a bogus token", async () => {
    const res = await request(app).post("/api/auth/reset-password").send({ token: "deadbeef", password: "Another-Passphrase-8" });
    expect(res.status).toBe(400);
  });
});

describe("storage sanity", () => {
  it("stores only a bcrypt hash, never the password", async () => {
    const user = await signupPatient();
    const row = await storage.getUserWithCredentials(user.id);
    expect(row!.passwordHash).not.toContain(PASSWORD);
    expect(row!.passwordHash.startsWith("$2")).toBe(true);
  });
});

describe("password rules and recovery links", () => {
  it("refuses the passwords people are attacked with, but allows a memorable phrase", async () => {
    const app = await getApp();
    const attempt = (password: string, email = uniqueEmail("pw")) => request(app).post("/api/auth/signup").send({ name: "Pat Example", email, password, state: "CA" });
    for (const weak of ["password", "12345678", "Password123", "qwertyuiop", "aaaaaaaaa", "DemoPass123!"]) {
      expect((await attempt(weak)).status, weak).toBe(400);
    }
    const email = `maple.tree${Math.floor(Math.random() * 1e6)}@example.org`;
    expect((await attempt(`${email.split("@")[0]}!!`, email)).status).toBe(400); // built from the email address
    expect((await attempt("seven green umbrellas")).status).toBe(201);
  });

  it("makes only the newest reset link work, and each link only once", async () => {
    const app = await getApp();
    const user = await signupPatient();
    const { storage } = await import("../server/storage");
    const { generateSecureToken } = await import("../server/services/tokenService");
    const first = generateSecureToken();
    await storage.createPasswordResetToken(user.email, first.tokenHash, new Date(Date.now() + 3_600_000));
    await request(app).post("/api/auth/forgot-password").send({ email: user.email }); // issues a newer link
    const stale = await request(app).post("/api/auth/reset-password").send({ token: first.token, password: "a brand new passphrase" });
    expect(stale.status).toBe(400);
  });

  it("rejects a weak new password on reset without spending the link", async () => {
    const app = await getApp();
    const user = await signupPatient();
    const { storage } = await import("../server/storage");
    const { generateSecureToken } = await import("../server/services/tokenService");
    const t = generateSecureToken();
    await storage.createPasswordResetToken(user.email, t.tokenHash, new Date(Date.now() + 3_600_000));
    expect((await request(app).post("/api/auth/reset-password").send({ token: t.token, password: "password123" })).status).toBe(400);
    expect((await request(app).post("/api/auth/reset-password").send({ token: t.token, password: "a brand new passphrase" })).status).toBe(200);
    expect((await request(app).post("/api/auth/reset-password").send({ token: t.token, password: "another fresh passphrase" })).status).toBe(400); // used
  });
});
