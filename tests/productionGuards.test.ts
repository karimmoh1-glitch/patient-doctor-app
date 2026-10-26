import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import type { Express } from "express";
import { getApp, auth, uniqueEmail } from "./helpers";
import { storage } from "../server/storage";
import { assertProductionConfig, productionConfigProblems } from "../server/config";
import { checkReadiness } from "../server/services/readiness";
import { pool } from "../server/db";

// There is no demo mode. The only fixture accounts are in development and test databases, and they must be
// worthless in production: even if one were seeded there by mistake, its well-known password opens nothing.

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
const realNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  (process.env as any).NODE_ENV = realNodeEnv;
});
const inProduction = () => ((process.env as any).NODE_ENV = "production");

const KNOWN_PASSWORD = "DemoPass123!"; // published in the repository for the development fixtures

async function fixtureAccount(role: "admin" | "patient" | "doctor") {
  return storage.createUser({
    name: `Fixture ${role}`, email: uniqueEmail(`fixture-${role}`), passwordHash: await bcrypt.hash(KNOWN_PASSWORD, 4), role,
    state: role === "admin" ? null : "CA", phone: null, deactivatedAt: null, emailVerifiedAt: null, isDemo: true,
  });
}

describe("fixture accounts in production", () => {
  it("sign in normally in development and test, so the automated suites can use them", async () => {
    const admin = await fixtureAccount("admin");
    expect((await request(app).post("/api/auth/login").send({ email: admin.email, password: KNOWN_PASSWORD })).status).toBe(200);
  });

  it("cannot sign in with their published password in production, and the refusal looks like any wrong password", async () => {
    const admin = await fixtureAccount("admin");
    inProduction();
    const refused = await request(app).post("/api/auth/login").send({ email: admin.email, password: KNOWN_PASSWORD });
    const wrong = await request(app).post("/api/auth/login").send({ email: admin.email, password: "not-the-password" });
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual(wrong.body); // nothing reveals that the account exists, or why it was refused
  });

  it("lose a session they already had the moment the same database is served in production", async () => {
    const patient = await fixtureAccount("patient");
    const login = await request(app).post("/api/auth/login").send({ email: patient.email, password: KNOWN_PASSWORD });
    expect((await request(app).get("/api/auth/me").set(auth(login.body.token))).status).toBe(200);
    inProduction();
    expect((await request(app).get("/api/auth/me").set(auth(login.body.token))).status).toBe(401);
  });

  it("cannot reach administrator functions in production", async () => {
    const admin = await fixtureAccount("admin");
    const token = (await request(app).post("/api/auth/login").send({ email: admin.email, password: KNOWN_PASSWORD })).body.token;
    expect((await request(app).get("/api/admin/doctor-applications").set(auth(token))).status).toBe(200);
    inProduction();
    for (const path of ["/api/admin/doctor-applications", "/api/admin/audit", "/api/admin/reminders/status"]) {
      expect((await request(app).get(path).set(auth(token))).status, path).toBe(401);
    }
  });

  it("do not affect an ordinary account that shares a name or domain with them", async () => {
    const real = await storage.createUser({
      name: "Real Person", email: uniqueEmail("real"), passwordHash: await bcrypt.hash("a-long-private-passphrase", 4), role: "patient",
      state: "CA", phone: null, deactivatedAt: null, emailVerifiedAt: null,
    });
    inProduction();
    expect((await request(app).post("/api/auth/login").send({ email: real.email, password: "a-long-private-passphrase" })).status).toBe(200);
  });
});

describe("what a production server refuses to start with", () => {
  const good = {
    NODE_ENV: "production", DATABASE_URL: "postgresql://owner@db/x", APP_DATABASE_URL: "postgresql://runtime@db/x", DB_ENFORCE_RLS: "on",
    JWT_SECRET: "j".repeat(40), APP_URL: "https://avela.example.org",
  } as NodeJS.ProcessEnv;
  const ids = (env: NodeJS.ProcessEnv) => productionConfigProblems(env).map((p) => p.id);

  it("accepts a complete, safe configuration", () => {
    expect(productionConfigProblems(good)).toEqual([]);
    expect(() => assertProductionConfig(good)).not.toThrow();
  });

  it("has no demo mode at all: the old switch and its acknowledgement are both refused", () => {
    expect(ids({ ...good, DEMO_MODE: "true" })).toContain("demo-mode");
    expect(ids({ ...good, DEMO_MODE: "true", DEMO_MODE_ACKNOWLEDGED: "true" })).toEqual(expect.arrayContaining(["demo-mode", "demo-ack"]));
    expect(ids({ ...good, DEMO_MODE_ACKNOWLEDGED: "true" })).toContain("demo-ack");
    for (const value of [undefined, "", "false"]) expect(ids({ ...good, DEMO_MODE: value })).toEqual([]);
    expect(() => assertProductionConfig({ ...good, DEMO_MODE: "true" })).toThrow(/Refusing to start/);
  });

  it("refuses a missing database, a weak signing secret, or a non-https address", () => {
    expect(ids({ ...good, DATABASE_URL: undefined })).toContain("database-url");
    expect(ids({ ...good, JWT_SECRET: "short" })).toContain("jwt-secret");
    expect(ids({ ...good, JWT_SECRET: undefined })).toContain("jwt-secret");
    expect(ids({ ...good, APP_URL: "http://avela.example.org" })).toContain("app-url");
    expect(ids({ ...good, APP_URL: undefined })).toContain("app-url");
  });

  it("refuses to connect as the table owner, unless that is a named, visible exception", () => {
    const owner = { ...good, APP_DATABASE_URL: undefined, DB_ENFORCE_RLS: undefined } as NodeJS.ProcessEnv;
    expect(ids(owner)).toEqual(["owner-role"]);
    expect(ids({ ...owner, ALLOW_OWNER_DATABASE_ROLE: "true" })).toEqual([]);
    expect(ids({ ...owner, ALLOW_OWNER_DATABASE_ROLE: "yes" })).toEqual(["owner-role"]); // only the exact word counts
  });

  it("refuses half of the restricted-role setting, which would look protected without being so", () => {
    expect(ids({ ...good, DB_ENFORCE_RLS: undefined })).toEqual(["rls-half"]);
    expect(ids({ ...good, APP_DATABASE_URL: undefined })).toEqual(["rls-half"]);
    expect(ids({ ...good, ALLOW_OWNER_DATABASE_ROLE: "true" })).toEqual(["owner-role-contradiction"]);
  });

  it("does not interfere with development or tests", () => {
    for (const env of ["development", "test"]) expect(productionConfigProblems({ NODE_ENV: env, DEMO_MODE: "true" })).toEqual([]);
  });

  it("names every problem at once, so an operator fixes them in one pass", () => {
    const all = ids({ NODE_ENV: "production", DEMO_MODE: "true" } as NodeJS.ProcessEnv);
    expect(all).toEqual(expect.arrayContaining(["demo-mode", "database-url", "jwt-secret", "app-url", "owner-role"]));
  });
});

describe("the readiness check before real patients", () => {
  const realEnv = {
    NODE_ENV: "production", JWT_SECRET: "x".repeat(40), APP_URL: "https://avela.example.org", CRON_SECRET: "y".repeat(30),
    RESEND_API_KEY: "re_x", SUPPORT_EMAIL: "help@example.org", EMERGENCY_NUMBER: "999",
  } as NodeJS.ProcessEnv;

  it("blocks a deployment that still has fixture accounts, a demo setting, an owner connection, or no scheduler", async () => {
    await fixtureAccount("admin"); // an active fixture account in this database
    const checks = await checkReadiness({ ...realEnv, DEMO_MODE: "true", CRON_SECRET: "" }, pool);
    const failing = checks.filter((c) => c.level === "fail").map((c) => c.id);
    expect(failing).toEqual(expect.arrayContaining(["demo-absent", "demo-accounts", "cron-secret", "rls-enforced", "app-role", "scheduler-history"]));
  });

  it("reports each blocker without printing any secret", async () => {
    const checks = await checkReadiness({ ...realEnv, JWT_SECRET: "short" }, pool);
    expect(checks.find((c) => c.id === "jwt-secret")!.level).toBe("fail");
    expect(JSON.stringify(checks)).not.toMatch(/xxxxxxxx|yyyyyyyy|re_x/);
  });
});

describe("providers in a production directory", () => {
  it("never lists, and never accepts a request to, a provider whose account is a fixture, whatever else the database holds", async () => {
    const { createDoctor, signupPatient } = await import("./helpers");
    const real = await createDoctor({ name: "Dr. Listed Realperson" });
    const fixtureDoc = await createDoctor({ name: "Dr. Fixture Unlisted" });
    await pool.query("UPDATE users SET is_demo = true WHERE id = $1", [fixtureDoc.id]);
    const patient = await signupPatient();

    // Development and test: fixtures are listed, so the suites can use them.
    expect((await request(app).get("/api/doctors?q=Dr.%20Fixture")).body.map((d: any) => d.name)).toContain("Dr. Fixture Unlisted");

    inProduction();
    const names = (await request(app).get("/api/doctors?q=Dr.")).body.map((d: any) => d.name);
    expect(names).toContain("Dr. Listed Realperson");
    expect(names).not.toContain("Dr. Fixture Unlisted");
    const ask = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: fixtureDoc.profileId });
    expect(ask.status).toBe(404);
    const askReal = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: real.profileId });
    expect(askReal.status).toBe(201);
    void real;
  });
});
