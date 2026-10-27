import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import type { Express } from "express";
import { getApp, auth, uniqueEmail, signIn, operatorPool } from "./helpers";
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

// Fixtures are made by the operator, on the owner connection: the application's own role may neither create an administrator
// nor mark an account as a fixture (migration 0024), and that is exactly what a test must not paper over.
async function fixtureAccount(role: "admin" | "patient" | "doctor") {
  const email = uniqueEmail(`fixture-${role}`);
  const { rows } = await operatorPool().query(
    "INSERT INTO users (name, email, password_hash, role, state, is_demo) VALUES ($1, $2, $3, $4, $5, true) RETURNING id, email",
    [`Fixture ${role}`, email, await bcrypt.hash(KNOWN_PASSWORD, 4), role, role === "admin" ? null : "CA"],
  );
  return { id: rows[0].id as string, email };
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
    const token = (await signIn(admin.email, KNOWN_PASSWORD)).token; // an administrator also completes the second factor
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
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    IDENTITY_KEY_ID: "k20261027", IDENTITY_KEY: Buffer.alloc(32, 9).toString("base64"),
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

  it("refuses to run without a proper key for the stored authenticator secrets, or with the test-only reuse switch", () => {
    expect(ids({ ...good, MFA_ENCRYPTION_KEY: undefined })).toContain("mfa-key");
    expect(ids({ ...good, MFA_ENCRYPTION_KEY: "short" })).toContain("mfa-key");
    expect(ids({ ...good, MFA_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") })).toContain("mfa-key"); // wrong length
    expect(ids({ ...good, MFA_ALLOW_CODE_REUSE: "1" })).toEqual(["mfa-reuse"]);
  });

  it("refuses the restricted role without a signing key for the identity the database verifies, or with the development key", () => {
    expect(ids({ ...good, IDENTITY_KEY: undefined })).toEqual(["identity-key"]);
    expect(ids({ ...good, IDENTITY_KEY_ID: undefined })).toEqual(["identity-key"]);
    expect(ids({ ...good, IDENTITY_KEY: Buffer.alloc(16, 1).toString("base64") })).toEqual(["identity-key"]);
    expect(ids({ ...good, IDENTITY_KEY_ID: "dev" })).toEqual(["identity-key-dev"]);
    // The owner-role exception needs no signing key: nothing is being verified.
    expect(ids({ ...good, APP_DATABASE_URL: undefined, DB_ENFORCE_RLS: undefined, IDENTITY_KEY: undefined, ALLOW_OWNER_DATABASE_ROLE: "true" })).toEqual([]);
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
    expect(all).toEqual(expect.arrayContaining(["demo-mode", "database-url", "jwt-secret", "app-url", "owner-role", "mfa-key"]));
  });
});

describe("the readiness check before real patients", () => {
  const realEnv = {
    NODE_ENV: "production", JWT_SECRET: "x".repeat(40), APP_URL: "https://avela.example.org", CRON_SECRET: "y".repeat(30),
    RESEND_API_KEY: "re_x", EMAIL_FROM: "Avela <care@example.org>", SUPPORT_EMAIL: "help@example.org", EMERGENCY_DATA_REVIEWED_BY: "Test Reviewer", EMERGENCY_DATA_REVIEWED_VERSION: "2026-10-26", EMERGENCY_DATA_REVIEWED_COUNTRIES: "US,EG",
  } as NodeJS.ProcessEnv;

  it("blocks a deployment that still has fixture accounts, a demo setting, an owner connection, or no scheduler", async () => {
    await fixtureAccount("admin"); // an active fixture account in this database
    const checks = await checkReadiness({ ...realEnv, DEMO_MODE: "true", CRON_SECRET: "" }, pool);
    const failing = checks.filter((c) => c.level === "fail").map((c) => c.id);
    expect(failing).toEqual(expect.arrayContaining(["demo-absent", "demo-accounts", "cron-secret", "rls-enforced", "app-role", "scheduler-history"]));
  });

  it("does not mistake a manual check, a daily cron, GitHub's schedule or a look-alike label for a scheduler", async () => {
    const insert = async (source: string, n: number) => {
      for (let i = 0; i < n; i += 24) {
        await pool.query(
          "INSERT INTO job_run_history (job, run_id, source, started_at, outcome) SELECT 'reminders', gen_random_uuid()::text, $1, now() - (g || ' minutes')::interval, 'ok' FROM generate_series($2::int, $3::int) g",
          [source, i, Math.min(i + 23, n - 1)],
        );
      }
    };
    await pool.query("DELETE FROM job_run_history");
    await insert("manual-verification", 300);
    await insert("vercel-cron", 1);
    await insert("github-actions", 40);
    let checks = await checkReadiness(realEnv, pool);
    expect(checks.find((c) => c.id === "scheduler-history")!.level).toBe("fail");
    expect(checks.find((c) => c.id === "scheduler-caller")!.level).toBe("fail");

    // A look-alike label from a holder of the general secret is recorded as a claim and counts for nothing, however often it is made.
    await pool.query("DELETE FROM job_run_history");
    await insert("claimed:cloudflare-worker", 290);
    checks = await checkReadiness(realEnv, pool);
    expect(checks.find((c) => c.id === "scheduler-caller")!.level).toBe("fail");
    await pool.query("DELETE FROM job_run_history");
    await insert("cloudflare-worker", 280);
    checks = await checkReadiness(realEnv, pool);
    expect(checks.find((c) => c.id === "scheduler-history")!.level).toBe("ok");
    expect(checks.find((c) => c.id === "scheduler-caller")!.level).toBe("ok");
    await pool.query("DELETE FROM job_run_history");
  });

  it("treats no e-mail provider, or the built-in sender address, as a blocker (a locked-out person must have a way back)", async () => {
    const level = async (env: NodeJS.ProcessEnv, id: string) => (await checkReadiness(env, pool)).find((c) => c.id === id)!.level;
    expect(await level({ ...realEnv, RESEND_API_KEY: undefined }, "email")).toBe("fail");
    expect(await level({ ...realEnv, EMAIL_FROM: undefined }, "email-from")).toBe("fail");
    expect(await level(realEnv, "email")).toBe("ok");
    expect(await level(realEnv, "email-from")).toBe("ok");
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
    await operatorPool().query("UPDATE users SET is_demo = true WHERE id = $1", [fixtureDoc.id]);
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
