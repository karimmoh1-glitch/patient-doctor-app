import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import type { Express } from "express";
import { getApp, auth, uniqueEmail } from "./helpers";
import { storage } from "../server/storage";
import { assertProductionConfig } from "../server/config";
import { checkReadiness } from "../server/services/readiness";
import { pool } from "../server/db";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  delete process.env.DEMO_MODE;
});

const KNOWN_PASSWORD = "DemoPass123!"; // the well-known demo password that is published in the README

async function demoAccount(role: "admin" | "patient" | "doctor") {
  return storage.createUser({
    name: `Demo ${role}`, email: uniqueEmail(`demo-${role}`), passwordHash: await bcrypt.hash(KNOWN_PASSWORD, 4), role,
    state: role === "admin" ? null : "CA", phone: null, deactivatedAt: null, emailVerifiedAt: null, isDemo: true,
  });
}

describe("demo accounts in a real deployment", () => {
  it("cannot sign in with their well-known password once demo mode is off, and the refusal looks like any wrong password", async () => {
    const admin = await demoAccount("admin");
    process.env.DEMO_MODE = "true";
    expect((await request(app).post("/api/auth/login").send({ email: admin.email, password: KNOWN_PASSWORD })).status).toBe(200);

    process.env.DEMO_MODE = "false";
    const refused = await request(app).post("/api/auth/login").send({ email: admin.email, password: KNOWN_PASSWORD });
    const wrong = await request(app).post("/api/auth/login").send({ email: admin.email, password: "not-the-password" });
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual(wrong.body); // nothing reveals that the account exists, or why it was refused
  });

  it("loses its existing sessions the moment demo mode is switched off", async () => {
    const patient = await demoAccount("patient");
    process.env.DEMO_MODE = "true";
    const login = await request(app).post("/api/auth/login").send({ email: patient.email, password: KNOWN_PASSWORD });
    expect((await request(app).get("/api/auth/me").set(auth(login.body.token))).status).toBe(200);
    process.env.DEMO_MODE = "false";
    expect((await request(app).get("/api/auth/me").set(auth(login.body.token))).status).toBe(401);
  });

  it("cannot reach administrator functions or any patient's data once demo mode is off", async () => {
    const admin = await demoAccount("admin");
    process.env.DEMO_MODE = "true";
    const token = (await request(app).post("/api/auth/login").send({ email: admin.email, password: KNOWN_PASSWORD })).body.token;
    expect((await request(app).get("/api/admin/doctor-applications").set(auth(token))).status).toBe(200);
    process.env.DEMO_MODE = "false";
    for (const path of ["/api/admin/doctor-applications", "/api/admin/audit", "/api/admin/reminders/status"]) {
      expect((await request(app).get(path).set(auth(token))).status, path).toBe(401);
    }
  });

  it("has no one-tap sign-in when demo mode is off", async () => {
    process.env.DEMO_MODE = "false";
    expect((await request(app).post("/api/auth/demo-login").send({ role: "doctor" })).status).toBe(404);
  });

  it("does not affect an ordinary account that happens to share a name or domain", async () => {
    const real = await storage.createUser({
      name: "Real Person", email: uniqueEmail("real"), passwordHash: await bcrypt.hash("a-long-private-passphrase", 4), role: "patient",
      state: "CA", phone: null, deactivatedAt: null, emailVerifiedAt: null,
    });
    process.env.DEMO_MODE = "false";
    expect((await request(app).post("/api/auth/login").send({ email: real.email, password: "a-long-private-passphrase" })).status).toBe(200);
  });
});

describe("startup in production", () => {
  const base = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  it("refuses to run a demo without the second, explicit acknowledgement", () => {
    expect(() => assertProductionConfig({ ...base, DEMO_MODE: "true" })).toThrow(/DEMO_MODE_ACKNOWLEDGED/);
    expect(() => assertProductionConfig({ ...base, DEMO_MODE: "true", DEMO_MODE_ACKNOWLEDGED: "true" })).not.toThrow();
  });
  it("treats anything but an explicit true as real mode, and never blocks real mode", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
      expect(() => assertProductionConfig({ ...base, DEMO_MODE: value })).not.toThrow();
    }
  });
  it("does not interfere with development or tests", () => {
    expect(() => assertProductionConfig({ NODE_ENV: "development", DEMO_MODE: "true" })).not.toThrow();
  });
});

describe("the readiness check before real patients", () => {
  const realEnv = {
    NODE_ENV: "production", JWT_SECRET: "x".repeat(40), APP_URL: "https://avela.example.org", CRON_SECRET: "y".repeat(30),
    RESEND_API_KEY: "re_x", SUPPORT_EMAIL: "help@example.org", VITE_EMERGENCY_NUMBER: "999",
  } as NodeJS.ProcessEnv;

  it("blocks a deployment that still has demo accounts, demo mode, or no scheduler", async () => {
    await demoAccount("admin"); // active demo account in this database
    const checks = await checkReadiness({ ...realEnv, DEMO_MODE: "true", CRON_SECRET: "" }, pool);
    const failing = checks.filter((c) => c.level === "fail").map((c) => c.id);
    expect(failing).toEqual(expect.arrayContaining(["demo-off", "demo-accounts", "cron-secret", "rls-enforced", "app-role", "scheduler-history"]));
  });

  it("reports each blocker without printing any secret", async () => {
    const checks = await checkReadiness({ ...realEnv, JWT_SECRET: "short" }, pool);
    expect(checks.find((c) => c.id === "jwt-secret")!.level).toBe("fail");
    expect(JSON.stringify(checks)).not.toMatch(/xxxxxxxx|yyyyyyyy|re_x/);
  });
});
