import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, createCaregiverAccount, connect, issuePrescription, prescriptionBody, auth, uniqueEmail, PASSWORD, type TestUser, type TestDoctor } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { storage } from "../server/storage";
import { db } from "../server/db";
import { medications, notifications } from "@shared/schema";
import { runAsNobody, runAsUser, runAsSystem } from "../server/dbContext";

// Database-level protection (migration 0014), attacked directly: these connect as the restricted runtime role
// (avela_app), say who they are the way the application does, and run SQL the application never would.

const ENFORCED = process.env.TEST_AS_APP_ROLE === "1";
type Who = { userId?: string; system?: boolean };

let owner: pg.Pool; // a superuser, only to build fixtures that have no API
let app_: pg.Pool; // the restricted role
let app: Express;

async function as<T>(who: Who, fn: (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
  const c = await app_.connect();
  try {
    await c.query("SELECT set_config('app.user_id', $1, false), set_config('app.system', $2, false)", [who.userId ?? "", who.system ? "on" : ""]);
    return await fn((text, params) => c.query(text, params));
  } finally {
    await c.query("SELECT set_config('app.user_id', '', false), set_config('app.system', '', false)").catch(() => {});
    c.release();
  }
}
const keyOf = (table: string) => (table === "user_mfa" ? "user_id" : "id");
const ids = async (who: Who, table: string, where = "true") => as(who, async (q) => (await q(`SELECT ${keyOf(table)} AS id FROM ${table} WHERE ${where} ORDER BY 1`)).rows.map((r) => r.id as string));
const sees = async (who: Who, table: string, id: string) => (await ids(who, table, `id = '${id}'`)).length === 1;

let A: TestUser, B: TestUser, C: TestUser, admin: TestUser;
let D1: TestDoctor, D2: TestDoctor, D3: TestDoctor;
let pairingAD1: string, reportA: string, pairingBD2: string, reportB: string;
let rxActive: string, rxDraft: string, medA: string, medB: string, apptA: string, msgA: string, docA: string, grantA: string, memberA: string, noteA: string, noteB: string;

beforeAll(async () => {
  app = await getApp();
  owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 4 });

  A = await signupPatient();
  B = await signupPatient();
  D1 = await createDoctor();
  D2 = await createDoctor();
  D3 = await createDoctor();
  C = await createCaregiverAccount();
  admin = await createAdmin();

  ({ pairingId: pairingAD1, symptomReportId: reportA } = await connect(A, D1));
  ({ pairingId: pairingBD2, symptomReportId: reportB } = await connect(B, D2, { accept: false })); // asked, not yet accepted

  rxActive = (await issuePrescription(D1, pairingAD1)).id;
  const draft = await request(app).post("/api/prescriptions").set(auth(D1.token)).send(prescriptionBody(pairingAD1, { medicationName: "Draft Only" }));
  rxDraft = draft.body.id;
  medA = (await request(app).post(`/api/prescriptions/${rxActive}/track`).set(auth(A.token))).body.id;

  // B's own medicine, from a doctor B is connected to.
  const { pairingId: pairingBD3 } = await connect(B, D3);
  const rxB = await issuePrescription(D3, pairingBD3);
  medB = (await request(app).post(`/api/prescriptions/${rxB.id}/track`).set(auth(B.token))).body.id;

  apptA = (await owner.query(
    `INSERT INTO appointments (pairing_request_id, patient_user_id, doctor_profile_id, type, reason, scheduled_at, status)
     VALUES ($1, $2, $3, 'Video Visit', 'private reason', now() + interval '3 days', 'confirmed') RETURNING id`,
    [pairingAD1, A.id, D1.profileId],
  )).rows[0].id;
  msgA = (await owner.query(`INSERT INTO messages (pairing_request_id, sender_user_id, body) VALUES ($1, $2, 'private words') RETURNING id`, [pairingAD1, A.id])).rows[0].id;
  docA = (await request(app).post("/api/documents").set(auth(A.token)).field("title", "A's lab results")).body.id;
  grantA = (await owner.query(`INSERT INTO sharing_grants (patient_user_id, shared_with_doctor_profile_id, share_medications) VALUES ($1, $2, true) RETURNING id`, [A.id, D1.profileId])).rows[0].id;
  memberA = (await owner.query(
    `INSERT INTO care_circle_members (patient_user_id, caregiver_user_id, name, invite_email, relationship_label, status)
     VALUES ($1, $2, 'Caregiver', $3, 'friend', 'active') RETURNING id`,
    [A.id, C.id, uniqueEmail("cg")],
  )).rows[0].id;
  noteA = (await storage.createNotification({ userId: A.id, kind: "test.note", params: {}, link: "/x" })).id;
  noteB = (await storage.createNotification({ userId: B.id, kind: "test.note", params: {}, link: "/x" })).id;
});

afterAll(async () => {
  await owner.end();
  await app_.end();
});

describe("the restricted role really is restricted", () => {
  it("is not a superuser, not the owner, and does not bypass row-level security", async () => {
    const { rows } = await as({ system: true }, (q) =>
      q(`SELECT current_user AS who, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
                (SELECT tableowner FROM pg_tables WHERE tablename = 'users') AS owner
           FROM pg_roles r WHERE r.rolname = current_user`),
    );
    expect(rows[0]).toMatchObject({ who: "avela_app", rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    expect(rows[0].owner).not.toBe("avela_app");
  });

  it("cannot change the structure, empty a table, switch off a guard, or touch the migration record", async () => {
    const refusals: [string, RegExp][] = [
      ["DROP TABLE medications", /must be owner|permission denied/],
      ["TRUNCATE users CASCADE", /permission denied/],
      ["CREATE TABLE sneaky (id int)", /permission denied/],
      ["ALTER TABLE prescriptions DISABLE TRIGGER prescriptions_guard", /must be owner|permission denied/],
      ["ALTER TABLE audit_logs DISABLE TRIGGER ALL", /must be owner|permission denied/],
      ["ALTER TABLE medications DISABLE ROW LEVEL SECURITY", /must be owner/],
      ["DROP POLICY avela_medications_select ON medications", /must be owner/],
      ["ALTER ROLE avela_app BYPASSRLS", /permission denied|must be superuser/],
      ["SELECT * FROM schema_migrations", /permission denied/],
      ["DELETE FROM schema_migrations", /permission denied/],
    ];
    for (const [sql, why] of refusals) {
      await expect(as({ system: true }, (q) => q(sql)), sql).rejects.toThrow(why);
    }
    // A GRANT it has no right to make is not an error in Postgres, only a warning that changes nothing.
    // The effect is what matters: it gains no privilege by trying.
    await as({ system: true }, (q) => q("GRANT ALL ON users TO avela_app"));
    const can = await as({ system: true }, (q) => q("SELECT has_table_privilege('avela_app', 'users', 'TRUNCATE') AS truncate, has_table_privilege('avela_app', 'users', 'TRIGGER') AS trigger, has_schema_privilege('avela_app', 'public', 'CREATE') AS create"));
    expect(can.rows[0]).toEqual({ truncate: false, trigger: false, create: false });
  });

  it("cannot edit or erase the access log or a prescription's history, even as system", async () => {
    const note = await as({ system: true }, (q) => q(`INSERT INTO audit_logs (action, target_type) VALUES ('rls.test', 'test') RETURNING id`));
    const logId = note.rows[0].id;
    await expect(as({ system: true }, (q) => q(`UPDATE audit_logs SET action = 'x' WHERE id = $1`, [logId]))).rejects.toThrow(/permission denied/);
    await expect(as({ system: true }, (q) => q(`DELETE FROM audit_logs WHERE id = $1`, [logId]))).rejects.toThrow(/permission denied/);
    await expect(as({ system: true }, (q) => q(`UPDATE prescription_events SET event = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(as({ system: true }, (q) => q(`DELETE FROM prescription_events`))).rejects.toThrow(/permission denied/);
    // Adding to them is exactly what it is for.
    const added = await as({ system: true }, (q) => q(`INSERT INTO prescription_events (prescription_id, event) VALUES ($1, 'rls.test') RETURNING id`, [rxActive]));
    expect(added.rowCount).toBe(1);
  });
});

describe("with nobody established, the database shows and accepts nothing", () => {
  it("returns no rows from any protected table, and refuses writes", async () => {
    const tables = ["medications", "medication_logs", "medication_reminders", "symptom_reports", "documents", "pharmacy_orders", "follow_up_tasks", "appointments", "prescriptions", "sharing_grants", "pairing_requests", "messages", "care_circle_members", "notifications", "ai_messages", "data_requests", "user_devices", "password_reset_tokens", "email_verification_tokens", "user_mfa", "mfa_recovery_codes"];
    for (const t of tables) expect(await ids({}, t), t).toEqual([]);
    await expect(as({}, (q) => q(`INSERT INTO symptom_reports (patient_user_id, state, symptom_text, input_method) VALUES ($1, 'CA', 'x', 'typed')`, [A.id]))).rejects.toThrow(/row-level security/);
    expect((await as({}, (q) => q(`UPDATE medications SET name = 'hacked' WHERE id = $1`, [medA]))).rowCount).toBe(0);
    expect((await as({}, (q) => q(`DELETE FROM notifications WHERE id = $1`, [noteA]))).rowCount).toBe(0);
  });
});

describe("who can read which record", () => {
  // [description, table, id, who can see it]
  const matrix = (): [string, string, string, Record<string, boolean>][] => [
    ["a medicine", "medications", medA, { A: true, D1: true, C: true, B: false, D2: false, admin: false }],
    ["another patient's medicine", "medications", medB, { B: true, A: false, D1: false, C: false, D2: false, admin: false }],
    ["a symptom report sent to an accepted doctor", "symptom_reports", reportA, { A: true, D1: true, C: true, B: false, D2: false, admin: false }],
    ["a symptom report sent with a request not yet accepted", "symptom_reports", reportB, { B: true, D2: true, A: false, D1: false, admin: false }],
    ["an appointment", "appointments", apptA, { A: true, D1: true, C: true, B: false, D2: false, admin: false }],
    ["a prescription once authorized", "prescriptions", rxActive, { A: true, D1: true, C: true, B: false, D2: false, admin: false }],
    ["a prescription still a draft", "prescriptions", rxDraft, { D1: true, A: false, C: false, B: false, D2: false, admin: false }],
    ["a message between patient and doctor", "messages", msgA, { A: true, D1: true, C: false, B: false, D2: false, admin: false }],
    ["the connection itself", "pairing_requests", pairingAD1, { A: true, D1: true, C: false, B: false, D2: false, admin: false }],
    ["a sharing decision", "sharing_grants", grantA, { A: true, D1: true, C: false, B: false, D2: false, admin: false }],
    ["a care-circle membership", "care_circle_members", memberA, { A: true, C: true, B: false, D1: false, admin: false }],
    ["a document", "documents", docA, { A: true, D1: true, C: true, B: false, D2: false, admin: false }],
    ["a notice", "notifications", noteA, { A: true, B: false, D1: false, C: false, admin: false }],
    ["another person's notice", "notifications", noteB, { B: true, A: false, D1: false, admin: false }],
  ];
  it("follows the written matrix for every kind of person", async () => {
    const people: Record<string, Who> = {
      A: { userId: A.id }, B: { userId: B.id }, C: { userId: C.id }, D1: { userId: D1.id }, D2: { userId: D2.id }, admin: { userId: admin.id },
    };
    for (const [what, table, id, expected] of matrix()) {
      for (const [name, can] of Object.entries(expected)) {
        expect(await sees(people[name], table, id), `${name} ${can ? "should see" : "must not see"} ${what}`).toBe(can);
      }
      expect(await sees({ system: true }, table, id), `system sees ${what}`).toBe(true);
    }
  });

  it("shows each person only their own sessions, and nobody the single-use secrets", async () => {
    const mine = await as({ userId: A.id }, async (q) => (await q(`SELECT DISTINCT user_id FROM user_devices`)).rows.map((r) => r.user_id));
    expect(mine).toEqual([A.id]);
    await owner.query(`INSERT INTO password_reset_tokens (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [A.email, `hash-${Date.now()}`]);
    expect(await ids({ userId: A.id }, "password_reset_tokens")).toEqual([]);
    expect((await ids({ system: true }, "password_reset_tokens")).length).toBeGreaterThan(0);
  });

  it("keeps authenticator secrets and recovery codes from everyone, including their own owner", async () => {
    expect((await ids({ system: true }, "user_mfa", `user_id = '${D1.id}'`)).length).toBe(1); // D1 really is enrolled
    for (const who of [{ userId: D1.id }, { userId: admin.id }, { userId: A.id }, {}]) {
      expect(await ids(who, "user_mfa"), JSON.stringify(who)).toEqual([]);
      expect(await ids(who, "mfa_recovery_codes"), JSON.stringify(who)).toEqual([]);
    }
    await expect(as({ userId: D1.id }, (q) => q(`UPDATE user_mfa SET failed_attempts = 0 WHERE user_id = $1`, [D1.id]))).resolves.toMatchObject({ rowCount: 0 });
  });

  it("stops showing a patient to a doctor the moment the connection ends or the doctor is suspended", async () => {
    const d1 = { userId: D1.id };
    expect(await sees(d1, "medications", medA)).toBe(true);

    await owner.query(`UPDATE pairing_requests SET status = 'ended' WHERE id = $1`, [pairingAD1]);
    expect(await sees(d1, "medications", medA)).toBe(false);
    expect(await sees(d1, "symptom_reports", reportA)).toBe(false);
    expect(await sees(d1, "prescriptions", rxActive)).toBe(true); // their own authored record stays theirs
    await owner.query(`UPDATE pairing_requests SET status = 'accepted' WHERE id = $1`, [pairingAD1]);
    expect(await sees(d1, "medications", medA)).toBe(true);

    await owner.query(`UPDATE doctor_profiles SET active = false WHERE id = $1`, [D1.profileId]);
    expect(await sees(d1, "medications", medA)).toBe(false);
    expect(await sees(d1, "prescriptions", rxActive)).toBe(false);
    expect(await sees(d1, "pairing_requests", pairingAD1)).toBe(false);
    await owner.query(`UPDATE doctor_profiles SET active = true WHERE id = $1`, [D1.profileId]);
    expect(await sees(d1, "medications", medA)).toBe(true);
  });
});

describe("who can change which record", () => {
  it("lets nobody change or add to another person's records", async () => {
    // B tries to read-write A's medicine.
    expect((await as({ userId: B.id }, (q) => q(`UPDATE medications SET name = 'hacked' WHERE id = $1`, [medA]))).rowCount).toBe(0);
    expect((await as({ userId: B.id }, (q) => q(`DELETE FROM medications WHERE id = $1`, [medA]))).rowCount).toBe(0);
    const plant = `INSERT INTO symptom_reports (patient_user_id, state, symptom_text, input_method) VALUES ($1, 'CA', 'planted', 'typed')`;
    await expect(as({ userId: B.id }, (q) => q(plant, [A.id]))).rejects.toThrow(/row-level security/);
    // An unconnected doctor cannot write to, or for, a patient.
    await expect(as({ userId: D2.id }, (q) => q(plant, [A.id]))).rejects.toThrow(/row-level security/);
    await expect(
      as({ userId: D2.id }, (q) =>
        q(`INSERT INTO prescriptions (pairing_request_id, patient_user_id, doctor_profile_id, medication_name, dose, route, frequency_per_day, instructions, status)
           VALUES ($1, $2, $3, 'Planted', '1', 'oral', 1, 'x', 'draft')`, [pairingAD1, A.id, D2.profileId])),
    ).rejects.toThrow(/row-level security/);
    // …and cannot write a prescription in another doctor's name even for a patient they ARE connected to.
    await expect(
      as({ userId: D1.id }, (q) =>
        q(`INSERT INTO prescriptions (pairing_request_id, patient_user_id, doctor_profile_id, medication_name, dose, route, frequency_per_day, instructions, status)
           VALUES ($1, $2, $3, 'Impersonated', '1', 'oral', 1, 'x', 'draft')`, [pairingAD1, A.id, D2.profileId])),
    ).rejects.toThrow(/row-level security/);
    expect((await storage.getMedication(medA))!.name).not.toBe("hacked");
  });

  it("makes a caregiver read-only", async () => {
    const c = { userId: C.id };
    expect(await sees(c, "medications", medA)).toBe(true);
    expect((await as(c, (q) => q(`UPDATE medications SET name = 'edited' WHERE id = $1`, [medA]))).rowCount).toBe(0);
    await expect(as(c, (q) => q(`INSERT INTO symptom_reports (patient_user_id, state, symptom_text, input_method) VALUES ($1, 'CA', 'added', 'typed')`, [A.id]))).rejects.toThrow(/row-level security/);
    expect((await as(c, (q) => q(`DELETE FROM appointments WHERE id = $1`, [apptA]))).rowCount).toBe(0);
  });

  it("lets a person write their own, and leave a notice for someone they are connected to without being able to read it", async () => {
    const r = await as({ userId: A.id }, (q) => q(`INSERT INTO symptom_reports (patient_user_id, state, symptom_text, input_method) VALUES ($1, 'CA', 'mine', 'typed') RETURNING id`, [A.id]));
    expect(r.rowCount).toBe(1);
    // A leaves a notice for their doctor D1 (without RETURNING it back): allowed. Reading D1's notices: not.
    await as({ userId: A.id }, (q) => q(`INSERT INTO notifications (user_id, kind, params, link) VALUES ($1, 'x', '{}', '/')`, [D1.id]));
    expect(await ids({ userId: A.id }, "notifications", `user_id = '${D1.id}'`)).toEqual([]);
    expect((await ids({ userId: D1.id }, "notifications", `kind = 'x'`)).length).toBeGreaterThan(0);
    // …but not for a stranger: that is a way to put words in front of someone with no relationship to you (migration 0024).
    await expect(as({ userId: A.id }, (q) => q(`INSERT INTO notifications (user_id, kind, params, link) VALUES ($1, 'x', '{}', '/')`, [B.id]))).rejects.toThrow(/row-level security/);
    await expect(as({ userId: B.id }, (q) => q(`INSERT INTO notifications (user_id, kind, params, link) VALUES ($1, 'x', '{}', '/')`, [A.id]))).rejects.toThrow(/row-level security/);
  });

  it("blocks a patient from reading a draft prescription or editing someone else's", async () => {
    expect((await as({ userId: A.id }, (q) => q(`UPDATE prescriptions SET status = 'active' WHERE id = $1`, [rxDraft]))).rowCount).toBe(0);
    expect((await as({ userId: B.id }, (q) => q(`UPDATE prescriptions SET refills_used = refills_used WHERE id = $1`, [rxActive]))).rowCount).toBe(0);
  });
});

describe("free/busy is public to patients, whose visit it is is not", () => {
  it("returns only times for a doctor, to anyone, including nobody", async () => {
    const rows = await as({}, async (q) => (await q(`SELECT * FROM app_busy_intervals(ARRAY[$1]::text[], now()::timestamp, (now() + interval '30 days')::timestamp, NULL)`, [D1.profileId])).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(["doctor_profile_id", "duration_minutes", "scheduled_at"]);
    expect(await ids({}, "appointments")).toEqual([]); // while the visit records themselves stay closed
  });
});

describe.skipIf(!ENFORCED)("the running application, as the restricted role (npm run test:rls)", () => {
  it("shows a route that forgot its WHERE clause only the signed-in person's own rows", async () => {
    // select * from medications, with no filter: the bug this exists to contain.
    const asB = await runAsUser(B.id, () => db.select().from(medications));
    expect(asB.every((m) => m.patientUserId === B.id)).toBe(true);
    expect(asB.map((m) => m.id)).not.toContain(medA);
    const asA = await runAsUser(A.id, () => db.select().from(medications));
    expect(asA.map((m) => m.id)).toContain(medA);
    expect(asA.map((m) => m.id)).not.toContain(medB);
    const everyNotice = await runAsUser(A.id, () => db.select().from(notifications));
    expect(everyNotice.every((n) => n.userId === A.id)).toBe(true);
  });

  it("gives a code path that never said who it acts as nothing at all", async () => {
    expect(await runAsNobody(() => storage.getNotificationsForUser(A.id, 10))).toEqual([]);
    expect(await runAsNobody(() => storage.getMedicationsByPatient(A.id))).toEqual([]);
    expect((await runAsSystem(() => storage.getMedicationsByPatient(A.id))).length).toBeGreaterThan(0);
  });

  it("never lets one person's identity leak into another's queries on a shared connection", async () => {
    const results = await Promise.all(
      Array.from({ length: 80 }, (_, i) => {
        const me = i % 2 === 0 ? A : B;
        return runAsUser(me.id, async () => ({ me: me.id, owners: (await db.select().from(medications)).map((m) => m.patientUserId) }));
      }),
    );
    for (const r of results) expect(new Set(r.owners).size === 0 || (new Set(r.owners).size === 1 && r.owners[0] === r.me)).toBe(true);
  });

  it("serves every sign-in and recovery step with nothing established beforehand", async () => {
    await runAsNobody(async () => {
      const email = uniqueEmail("preauth");
      const signup = await request(app).post("/api/auth/signup").send({ name: "Pre Auth", email, password: PASSWORD, state: "CA" });
      expect(signup.status).toBe(201);
      expect((await request(app).post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
      expect((await request(app).post("/api/auth/forgot-password").send({ email })).status).toBe(200);
      const t = (await import("../server/services/tokenService")).generateSecureToken();
      await runAsSystem(() => storage.createPasswordResetToken(email, t.tokenHash, new Date(Date.now() + 3_600_000)));
      expect((await request(app).post("/api/auth/reset-password").send({ token: t.token, password: "a long and different passphrase" })).status).toBe(200);
      const relogin = await request(app).post("/api/auth/login").send({ email, password: "a long and different passphrase" });
      expect(relogin.status).toBe(200);
      expect((await request(app).post("/api/doctors/register").send({ name: "Dr Pre", email: uniqueEmail("predoc"), password: PASSWORD })).status).toBe(201);
      expect((await request(app).post("/api/auth/demo-login").send({ role: "patient" })).status).toBeLessThan(500);
      expect((await request(app).get("/api/doctors")).status).toBe(200);
      expect((await request(app).get("/api/config")).status).toBe(200);
      // A signed-in request starts from nothing too, and becomes that person at the authentication step.
      const me = await request(app).get("/api/auth/me").set(auth(relogin.body.token));
      expect(me.status).toBe(200);
      expect(me.body.email).toBe(email);
    });
  });

  it("refuses to run at all if enforcement is on but the role could bypass it", async () => {
    vi.resetModules();
    const saved = { app: process.env.APP_DATABASE_URL, flag: process.env.DB_ENFORCE_RLS };
    delete process.env.APP_DATABASE_URL; // fall back to the owner connection
    process.env.DB_ENFORCE_RLS = "on";
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { pool } = await import("../server/db");
      await expect(pool.query("SELECT 1")).rejects.toThrow(/bypass row-level security/);
      await pool.end().catch(() => {});
    } finally {
      quiet.mockRestore();
      if (saved.app) process.env.APP_DATABASE_URL = saved.app;
      process.env.DB_ENFORCE_RLS = saved.flag;
      vi.resetModules();
    }
  });
});

describe("operator scripts", () => {
  it("always load the owner connection, never the application's restricted role", async () => {
    const { readFileSync } = await import("node:fs");
    for (const name of ["create-admin", "seed", "retire-demo", "erase-user", "verify-production", "reset-mfa"]) {
      const src = readFileSync(`script/${name}.ts`, "utf8");
      const operator = src.indexOf('import "./asOperator"');
      const database = src.search(/from "\.\.\/server\/(db|storage)"/);
      const dotenv = src.indexOf('import "dotenv/config"');
      expect(operator, `${name} imports asOperator`).toBeGreaterThanOrEqual(0);
      expect(operator, `${name}: asOperator comes before the database module`).toBeLessThan(database);
      if (dotenv >= 0) expect(operator, `${name}: asOperator comes after dotenv, which may define APP_DATABASE_URL`).toBeGreaterThan(dotenv);
    }
  });
});
