import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import pg from "pg";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, connect, auth, uniqueEmail, operatorPool, completeSecondFactor, PASSWORD, APPROVAL, type TestUser, type TestDoctor } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { assertionFor } from "./identityHelpers";
import { runAsSystem, withScope } from "../server/dbContext";
import { SYSTEM_SCOPES } from "../server/identity";

// The unrestricted "server" scope used to be what every signed-in code path ran on. Nothing in the application asks for it any more, and the
// database can be told to refuse it altogether (npm run identity:enforce -- server-scope off). This proves both halves: the code never asks,
// and the application keeps working when the database refuses.

const ENFORCED = process.env.TEST_AS_APP_ROLE === "1";

describe("the application never asks for the unrestricted scope", () => {
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));

  it("calls runAsSystem in exactly three places, each naming a narrow scope, and never writes the scope \"server\"", () => {
    const hits: string[] = [];
    for (const f of files("server")) {
      const text = fs.readFileSync(f, "utf8");
      if (f.endsWith(path.join("server", "dbContext.ts"))) continue;
      for (const m of text.matchAll(/runAsSystem\(/g)) hits.push(`${f}:${text.slice(0, m.index).split("\n").length}`);
      expect(text, `${f} names the server scope`).not.toMatch(/["']server["']\s*\)|scope:\s*["']server["']|withScope\(\s*["']server["']/);
    }
    expect(hits.map((h) => h.replace(/:\d+$/, "")).sort()).toEqual(["server/middleware/auth.ts", "server/middleware/pgRateLimitStore.ts", "server/middleware/systemAccess.ts"]);
    expect(fs.readFileSync("server/middleware/auth.ts", "utf8")).toMatch(/"session"\)/);
    expect(fs.readFileSync("server/middleware/pgRateLimitStore.ts", "utf8")).toMatch(/"ratelimit"\)/);
  });

  it("makes withScope refuse the unrestricted scope at the type level and gives every other helper site a scope from the list", () => {
    const src = fs.readFileSync("server/dbContext.ts", "utf8");
    expect(src).toMatch(/withScope = <T>\(scope: Exclude<SystemScope, "server">/);
    const used = new Set<string>();
    for (const f of files("server")) for (const m of fs.readFileSync(f, "utf8").matchAll(/withScope\("([a-z]+)"/g)) used.add(m[1]);
    for (const s of used) expect(SYSTEM_SCOPES as readonly string[], s).toContain(s);
    expect([...used].sort()).toEqual(["audit", "blocks", "contact", "mail", "mfa", "notify", "ops", "pairing", "review", "scheduler", "staff", "verify", "webhook"]);
  });

  it("throws in production if code asks for a system identity without a narrow scope", () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => runAsSystem(() => 1)).toThrow(/narrow scope/);
      expect(() => runAsSystem(() => 1, "server")).toThrow(/narrow scope/);
      expect(runAsSystem(() => 1, "auth")).toBe(1);
      expect(withScope("staff", () => 2)).toBe(2);
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe.skipIf(!ENFORCED)("with the database refusing the unrestricted scope", () => {
  let app: Express;
  let app_: pg.Pool;
  let patient: TestUser, patient2: TestUser, doctor: TestDoctor, admin: TestUser, staff: TestUser;
  const outbox: { to: string; link: string }[] = [];
  const setSwitch = (allowed: boolean) => operatorPool().query("UPDATE app_identity_config SET allow_server_scope = $1", [allowed]);
  const who = async (token: string) => {
    const c = await app_.connect();
    try {
      await c.query("SELECT set_config('app.assertion', $1, false)", [token]);
      const r = await c.query("SELECT app_is_system() AS s, app_verified_scope() AS scope");
      return r.rows[0] as { s: boolean; scope: string | null };
    } finally {
      await c.query("RESET ALL").catch(() => {});
      c.release();
    }
  };

  beforeAll(async () => {
    app = await getApp();
    app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 2 });
    // Fixtures are made with the test suite's own unrestricted access, before the database stops accepting it.
    patient = await signupPatient();
    patient2 = await signupPatient();
    doctor = await createDoctor();
    admin = await createAdmin();
    await setSwitch(false);
  });
  afterAll(async () => {
    await setSwitch(true);
    await app_.end();
  });

  it("recognises no one as the unrestricted server, and still recognises every narrow scope, every person and nobody", async () => {
    expect(await who(assertionFor({ system: true }))).toEqual({ s: false, scope: null });
    expect(await who(assertionFor({ scope: "server" }))).toEqual({ s: false, scope: null });
    for (const scope of SYSTEM_SCOPES.filter((s) => s !== "server")) expect(await who(assertionFor({ scope })), scope).toEqual({ s: false, scope });
    expect(await who(assertionFor({ userId: patient.id }))).toEqual({ s: false, scope: null });
    // …and the plain old settings never open it either.
    const c = await app_.connect();
    try {
      await c.query("SELECT set_config('app.system', 'on', false)");
      expect((await c.query("SELECT app_is_system() AS s")).rows[0].s).toBe(false);
    } finally {
      await c.query("RESET ALL").catch(() => {});
      c.release();
    }
  });

  it("reads nothing the unrestricted scope used to read", async () => {
    const c = await app_.connect();
    try {
      await c.query("SELECT set_config('app.assertion', $1, false)", [assertionFor({ system: true })]);
      for (const t of ["medications", "messages", "appointments", "prescriptions", "audit_logs", "user_mfa", "org_notes", "documents"]) {
        expect((await c.query(`SELECT 1 FROM ${t} LIMIT 1`)).rowCount, t).toBe(0);
      }
    } finally {
      await c.query("RESET ALL").catch(() => {});
      c.release();
    }
  });

  it("lets people sign up, sign in, recover a password and be looked up, in their narrow scopes", async () => {
    const email = uniqueEmail("noserver");
    const signup = await request(app).post("/api/auth/signup").send({ name: "No Server", email, password: PASSWORD, state: "CA" });
    expect(signup.status).toBe(201);
    expect((await request(app).post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
    expect((await request(app).post("/api/auth/forgot-password").send({ email })).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set(auth(signup.body.token))).status).toBe(200);
    expect((await request(app).post("/api/auth/email/verify/request").set(auth(signup.body.token))).status).toBeLessThan(500);
  });

  it("connects a patient and a clinician, delivers a message, books a visit and ends the connection with the patient's choice", async () => {
    const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 }));
    expect((await request(app).put("/api/doctors/me/availability").set(auth(doctor.token)).send({ timezone: "America/Los_Angeles", windows: EVERY_DAY })).status).toBe(200);
    const { pairingId } = await connect(patient, doctor);
    expect((await request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(patient.token)).send({ body: "hello" })).status).toBe(201);
    expect((await request(app).get(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token))).status).toBe(200);
    const slots = (await request(app).get(`/api/appointments/slots?pairingRequestId=${pairingId}&days=3`).set(auth(patient.token))).body.slots as string[];
    const booked = await request(app).post("/api/appointments").set(auth(patient.token)).send({ pairingRequestId: pairingId, type: "Phone Call", reason: "Follow-up on cough", scheduledAt: slots[10] });
    expect(booked.status).toBe(201);
    expect((await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(patient.token)).send({})).status).toBe(409);
    const ended = await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(patient.token)).send({ upcomingVisits: "cancel" });
    expect(ended.status).toBe(200);
    expect(ended.body.visitsCancelled).toBe(1);
    expect((await request(app).get(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token))).status).toBeGreaterThanOrEqual(403);
  });

  it("registers a clinician, lets an administrator approve them and review their credential, and lists them", async () => {
    const email = uniqueEmail("newdoc-ns");
    const reg = await request(app).post("/api/doctors/register").send({ name: "New Doc", email, password: PASSWORD });
    expect(reg.status).toBe(201);
    const session = await completeSecondFactor(reg.body, email);
    const COMPLETE = { displayName: "Dr. New Doc", professionalRole: "physician", specialty: "Cardiology", state: "TX", licenseNumber: "TX-5551212", licensingBody: "Texas Medical Board", languages: ["en"], modalities: ["phone"], phone: "+1 555 000 4444", qualifications: "MD", yearsExperience: 5, clinic: "Clinic", bio: "Cardiology." };
    expect((await request(app).put("/api/doctors/me/application").set(auth(session.token)).send(COMPLETE)).status).toBe(200);
    const sub = await request(app).post("/api/doctors/me/application/submit").set(auth(session.token));
    expect(sub.status).toBe(200);
    const applicationId = sub.body.id as string;
    const approve = await request(app).post(`/api/admin/doctor-applications/${applicationId}/approve`).set(auth(admin.token)).send(APPROVAL);
    expect(approve.status).toBe(200);
    expect((await request(app).get("/api/admin/credentials").set(auth(admin.token))).status).toBeLessThan(500);
    expect((await request(app).get("/api/admin/reminders/status").set(auth(admin.token))).status).toBeLessThan(500);
    expect((await request(app).get("/api/doctors")).status).toBe(200);
  });

  it("creates an organization, invites staff, and lets the invitee preview and accept it before signing in", async () => {
    const owner = doctor;
    const made = await request(app).post("/api/orgs").set(auth(owner.token)).send({ name: "No Server Clinic", kind: "clinic", country: "US", contactEmail: "front@example.org", contactPhone: "+1 555 010 2000" });
    expect(made.status).toBe(201);
    const orgId = made.body.id;
    const email = uniqueEmail("ns-staff");
    const inv = await request(app).post(`/api/orgs/${orgId}/staff/invitations`).set(auth(owner.token)).send({ email, role: "coordinator" });
    expect(inv.status).toBe(201);
    const token = String(inv.body.link).split("#")[1];
    expect((await request(app).post("/api/orgs/invitations/preview").send({ token })).body).toMatchObject({ accountExists: false });
    const accepted = await request(app).post("/api/orgs/invitations/accept-new").send({ token, name: "Staff Person", password: PASSWORD });
    expect(accepted.status).toBeLessThan(300);
    expect((await request(app).get(`/api/orgs/${orgId}/staff`).set(auth(owner.token))).status).toBe(200);
    expect((await request(app).get(`/api/orgs/${orgId}/patients`).set(auth(owner.token))).status).toBe(200);
    expect((await request(app).get(`/api/orgs/${orgId}/dashboard`).set(auth(owner.token))).status).toBe(200);
  });

  it("runs the scheduler, the webhook refusal, and the pairing-code and care-circle invitation flows", async () => {
    process.env.CRON_SECRET = "scope-off-secret-0123456789abcdef0123456789";
    const run = await request(app).post("/api/cron/reminders").set({ Authorization: `Bearer ${process.env.CRON_SECRET}` });
    expect(run.status).toBe(200);
    expect((await request(app).post("/api/webhooks/resend").set("content-type", "application/json").send("{}")).status).toBeGreaterThanOrEqual(400);
    const code = await request(app).post("/api/pairing-invitations").set(auth(doctor.token));
    expect(code.status).toBeLessThan(300);
    const pv = await request(app).post("/api/pairing-invitations/preview").set(auth(patient2.token)).send({ code: code.body.code });
    expect(pv.status).toBe(200);
    const ac = await request(app).post("/api/pairing-invitations/accept").set(auth(patient2.token)).send({ confirm: true, code: code.body.code });
    expect(ac.status).toBeLessThan(300);
    expect((await request(app).post("/api/care-circle").set(auth(patient2.token)).send({ name: "Caregiver", inviteEmail: uniqueEmail("ns-cg"), relationshipLabel: "friend" })).status).toBe(201);
  });
});
