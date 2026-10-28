import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, connect, issuePrescription, auth, uniqueEmail, operatorPool, type TestUser, type TestDoctor } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { ROUTER_MOUNTS } from "../server/routes";
import { assertionFor } from "./identityHelpers";

// Being allowed to see WHO a person is (a connected doctor, a caregiver, a colleague) is not being allowed to read their password hash,
// e-mail address, phone number, date of birth or emergency profile. Migration 0026 withdraws those columns from the application's database
// role and releases them only through functions that check who is asking. This attacks that at the database and through every API a
// counterpart can call.

const invites: { to: string; link: string }[] = [];
vi.mock("../server/services/emailService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/services/emailService")>();
  return { ...original, sendCareCircleInviteEmail: async (to: string, _n: string, _p: string, link: string) => { invites.push({ to: to.toLowerCase(), link }); } };
});

let app_: pg.Pool;
let app: Express;
type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;
type Who = { userId?: string; system?: boolean };
async function as<T>(who: Who, fn: (q: Q) => Promise<T>): Promise<T> {
  const c = await app_.connect();
  try {
    await c.query("SELECT set_config('app.assertion', $1, false)", [assertionFor(who)]);
    return await fn((t, p) => c.query(t, p));
  } finally {
    await c.query("SELECT set_config('app.assertion', '', false)").catch(() => {});
    c.release();
  }
}

const PRIVATE_COLUMNS = [
  "password_hash", "email", "state", "phone", "emergency_contact_name", "emergency_contact_phone", "allergies_text", "emergency_notes",
  "emergency_contact_relationship", "country", "date_of_birth", "preferred_name", "contact_method", "accessibility_notes", "care_preferences",
];
const PUBLIC_COLUMNS = ["id", "name", "role", "language", "read_receipts", "is_demo", "timezone", "created_at", "deactivated_at", "email_verified_at"];

// Values that exist nowhere else, so finding one in a response proves a private column leaked.
const MARK = { phone: "+15557771234", dob: "1971-02-03", contact: "Zed Zeldaworth", cphone: "+15558889999", allergy: "ZEBRA-ALLERGY", note: "ZEBRA-NOTE", rel: "ZEBRA-SISTER", pref: "ZEBRA-PREFERRED", access: "ZEBRA-ACCESS", clinic: "ZEBRA-CLINIC" };

let A: TestUser, B: TestUser, D1: TestDoctor, D2: TestDoctor, admin: TestUser, caregiver: TestUser;
let aEmail: string, aHash: string, pairingId: string;

beforeAll(async () => {
  app = await getApp();
  app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 4 });
  A = await signupPatient({ name: "Margaret Marked" });
  B = await signupPatient();
  D1 = await createDoctor();
  D2 = await createDoctor();
  admin = await createAdmin();
  ({ pairingId } = await connect(A, D1));
  await issuePrescription(D1, pairingId);
  const o = operatorPool();
  await o.query(
    `UPDATE users SET phone = $2, date_of_birth = $3, emergency_contact_name = $4, emergency_contact_phone = $5, allergies_text = $6, emergency_notes = $7,
            emergency_contact_relationship = $8, preferred_name = $9, accessibility_notes = $10, care_preferences = $11::jsonb, country = 'US', state = 'CA' WHERE id = $1`,
    [A.id, MARK.phone, MARK.dob, MARK.contact, MARK.cphone, MARK.allergy, MARK.note, MARK.rel, MARK.pref, MARK.access, JSON.stringify({ preferredClinic: MARK.clinic })],
  );
  const row = (await o.query("SELECT email, password_hash FROM users WHERE id = $1", [A.id])).rows[0];
  aEmail = row.email;
  aHash = row.password_hash;
  // A caregiver who really accepted (status 'active').
  const cg = (await o.query(`INSERT INTO users (name, email, password_hash, role) VALUES ('Care Giver', $1, 'x', 'caregiver') RETURNING id`, [uniqueEmail("cg")])).rows[0].id as string;
  await o.query(`INSERT INTO care_circle_members (patient_user_id, caregiver_user_id, name, invite_email, relationship_label, status) VALUES ($1, $2, 'Care Giver', $3, 'friend', 'active')`, [A.id, cg, uniqueEmail("cgi")]);
  caregiver = { id: cg, email: "", token: "" };
});
afterAll(async () => {
  await app_.end();
});

describe("what the application's database role can read from an account row", () => {
  it("may read the ten columns that identify a person, for the people allowed to see the row", async () => {
    for (const who of [{ userId: A.id }, { userId: D1.id }, { userId: caregiver.id }, { system: true }]) {
      const r = await as(who, (q) => q(`SELECT ${PUBLIC_COLUMNS.join(", ")} FROM users WHERE id = $1`, [A.id]));
      expect(r.rows, JSON.stringify(who)).toHaveLength(1);
      expect(r.rows[0].name).toBe("Margaret Marked");
    }
  });

  it("cannot read any private column, of anyone, whoever is asking, including the person themself and the server", async () => {
    for (const who of [{ userId: A.id }, { userId: D1.id }, { userId: caregiver.id }, { userId: admin.id }, { system: true }, {}]) {
      for (const col of PRIVATE_COLUMNS) {
        await expect(as(who, (q) => q(`SELECT ${col} FROM users WHERE id = $1`, [A.id])), `${col} as ${JSON.stringify(who)}`).rejects.toThrow(/permission denied/);
      }
      await expect(as(who, (q) => q(`SELECT * FROM users`)), `SELECT * as ${JSON.stringify(who)}`).rejects.toThrow(/permission denied/);
      await expect(as(who, (q) => q(`SELECT id FROM users WHERE email = $1`, [aEmail])), "filtering by e-mail").rejects.toThrow(/permission denied/);
      await expect(as(who, (q) => q(`SELECT id FROM users WHERE password_hash LIKE '$2%'`)), "filtering by hash").rejects.toThrow(/permission denied/);
    }
  });

  it("cannot read them back from a write, a join, a view or a subquery either", async () => {
    await expect(as({ system: true }, (q) => q(`INSERT INTO users (name, email, password_hash, role) VALUES ('x', $1, 'x', 'patient') RETURNING email`, [uniqueEmail("ret")]))).rejects.toThrow(/permission denied/);
    await expect(as({ userId: A.id }, (q) => q(`UPDATE users SET name = name WHERE id = $1 RETURNING phone`, [A.id]))).rejects.toThrow(/permission denied/);
    await expect(as({ userId: D1.id }, (q) => q(`SELECT m.id, u.email FROM messages m JOIN users u ON u.id = m.sender_user_id`))).rejects.toThrow(/permission denied/);
    await expect(as({ userId: D1.id }, (q) => q(`SELECT (SELECT email FROM users WHERE id = $1)`, [A.id]))).rejects.toThrow(/permission denied/);
    await expect(as({ userId: D1.id }, (q) => q(`SELECT to_jsonb(u) FROM users u WHERE id = $1`, [A.id]))).rejects.toThrow(/permission denied/);
    await expect(as({ userId: D1.id }, (q) => q(`SELECT row_to_json(users) FROM users`))).rejects.toThrow(/permission denied/);
  });

  it("can still write a person's own private columns (their own row only)", async () => {
    expect((await as({ userId: B.id }, (q) => q(`UPDATE users SET phone = '+15550000000', preferred_name = 'Bee' WHERE id = $1`, [B.id]))).rowCount).toBe(1);
    expect((await as({ userId: D1.id }, (q) => q(`UPDATE users SET phone = '+15559999999' WHERE id = $1`, [A.id]))).rowCount).toBe(0); // a connected doctor changes nothing of theirs
    expect((await operatorPool().query("SELECT phone FROM users WHERE id = $1", [A.id])).rows[0].phone).toBe(MARK.phone);
  });
});

describe("the functions that release private columns", () => {
  const privateOf = (who: Who, target: string) => as(who, async (q) => (await q(`SELECT * FROM app_user_private($1)`, [target])).rows);

  it("give a person their own account, without the password hash, and nobody else's", async () => {
    const own = await privateOf({ userId: A.id }, A.id);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ email: aEmail, phone: MARK.phone, date_of_birth: MARK.dob, allergies_text: MARK.allergy, emergency_contact_name: MARK.contact });
    expect(Object.keys(own[0])).not.toContain("password_hash");
    expect(JSON.stringify(own[0])).not.toContain(aHash);
    expect(await privateOf({ userId: B.id }, A.id)).toEqual([]);
  });

  it("give a connected doctor, a caregiver, an unrelated doctor, an administrator and an anonymous caller nothing at all", async () => {
    for (const who of [{ userId: D1.id }, { userId: D2.id }, { userId: caregiver.id }, { userId: admin.id }, {}]) {
      expect(await privateOf(who, A.id), JSON.stringify(who)).toEqual([]);
    }
  });

  it("do not even let a clinician the patient asked to help with their health profile read the private account columns", async () => {
    await operatorPool().query(`INSERT INTO assist_grants (patient_user_id, doctor_profile_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [A.id, D1.profileId]);
    try {
      expect(await privateOf({ userId: D1.id }, A.id)).toEqual([]);
    } finally {
      await operatorPool().query(`DELETE FROM assist_grants WHERE patient_user_id = $1`, [A.id]);
    }
  });

  it("give the password hash to the server's sign-in steps and to the person for their own password change, and to no one else", async () => {
    const byEmail = (who: Who) => as(who, async (q) => (await q(`SELECT * FROM app_user_credentials($1)`, [aEmail])).rows);
    const byId = (who: Who, id: string) => as(who, async (q) => (await q(`SELECT * FROM app_user_credentials_by_id($1)`, [id])).rows);
    expect((await byEmail({ system: true }))[0].password_hash).toBe(aHash);
    expect((await byEmail({ system: true })).length).toBe(1);
    for (const who of [{ userId: A.id }, { userId: D1.id }, { userId: admin.id }, {}]) expect(await byEmail(who), `by e-mail as ${JSON.stringify(who)}`).toEqual([]);
    expect((await byId({ userId: A.id }, A.id))[0].password_hash).toBe(aHash);
    expect((await byId({ system: true }, A.id))[0].password_hash).toBe(aHash);
    for (const who of [{ userId: B.id }, { userId: D1.id }, { userId: caregiver.id }, { userId: admin.id }, {}]) expect(await byId(who, A.id), `by id as ${JSON.stringify(who)}`).toEqual([]);
  });

  it("give e-mail addresses to the server alone, only for the people asked for", async () => {
    const contacts = (who: Who, ids: string[]) => as(who, async (q) => (await q(`SELECT * FROM app_user_contacts($1::text[])`, [ids])).rows);
    const got = await contacts({ system: true }, [A.id, B.id]);
    expect(got.map((r) => r.id).sort()).toEqual([A.id, B.id].sort());
    expect(got.find((r) => r.id === A.id).email).toBe(aEmail);
    for (const who of [{ userId: A.id }, { userId: D1.id }, { userId: admin.id }, {}]) expect(await contacts(who, [A.id]), JSON.stringify(who)).toEqual([]);
  });

  it("stay closed when nobody is established (a NULL comparison must not read as 'allowed')", async () => {
    expect(await privateOf({}, A.id)).toEqual([]);
    expect(await as({}, async (q) => (await q(`SELECT * FROM app_user_credentials_by_id($1)`, [A.id])).rows)).toEqual([]);
    // …and an assertion for somebody else's id, or a made-up one, opens nothing.
    expect(await privateOf({ userId: "no-such-person" }, A.id)).toEqual([]);
  });
});

describe("through the API: nobody who is not the person gets the private values", () => {
  const MARKERS = [MARK.phone, MARK.dob, MARK.contact, MARK.cphone, MARK.allergy, MARK.note, MARK.rel, MARK.pref, MARK.access, MARK.clinic];
  const sweep = async (who: string, token: string, paths: string[]) => {
    for (const p of paths) {
      const res = await request(app).get(p).set(auth(token));
      const text = JSON.stringify(res.body) + JSON.stringify(res.headers);
      expect(text, `${who} GET ${p}`).not.toMatch(/\$2[aby]\$\d\d\$/); // a bcrypt hash
      expect(text, `${who} GET ${p}`).not.toContain(aHash);
      for (const m of MARKERS) expect(text, `${who} GET ${p} leaked ${m}`).not.toContain(m);
      expect(text, `${who} GET ${p} leaked the patient's address`).not.toContain(aEmail);
    }
  };

  /** Every GET endpoint the server has, with each path parameter filled with something real (the connection, the patient). */
  const endpoints = (): string[] => {
    const out: string[] = [];
    for (const [prefix, router] of ROUTER_MOUNTS) for (const layer of (router as any).stack) if (layer.route?.methods.get) out.push(prefix + (layer.route.path === "/" ? "" : layer.route.path));
    return out;
  };
  const filled = (pattern: string, values: string[]): string[] => (/:[A-Za-z]+/.test(pattern) ? values.map((v) => pattern.replace(/:[A-Za-z]+/g, v)) : [pattern]);

  it("never shows anyone but the patient the patient's private values, on ANY read endpoint, with the real ids filled in", async () => {
    // A caregiver who really accepted the patient's invitation, through the real flow.
    const cgEmail = uniqueEmail("sweepcg");
    expect((await request(app).post("/api/care-circle").set(auth(A.token)).send({ name: "Sweep", inviteEmail: cgEmail, relationshipLabel: "friend" })).status).toBe(201);
    await vi.waitFor(() => expect(invites.some((i) => i.to === cgEmail.toLowerCase())).toBe(true));
    const inviteToken = new URL(invites.filter((i) => i.to === cgEmail.toLowerCase()).pop()!.link).searchParams.get("token")!;
    const accepted = await request(app).post("/api/care-circle/invitations/accept").send({ token: inviteToken, password: "CorrectHorse-9" });
    expect(accepted.status).toBe(200);
    const people: Record<string, string> = { "connected doctor": D1.token, "unconnected doctor": D2.token, administrator: admin.token, "other patient": B.token, "connected caregiver": accepted.body.token };
    const apptId = (await operatorPool().query(`INSERT INTO appointments (pairing_request_id, patient_user_id, doctor_profile_id, type, reason, scheduled_at, status)
      VALUES ($1, $2, $3, 'Video Visit', 'r', now() + interval '3 days', 'confirmed') RETURNING id`, [pairingId, A.id, D1.profileId])).rows[0].id as string;
    let calls = 0;
    for (const [who, token] of Object.entries(people)) {
      for (const pattern of endpoints()) {
        for (const path of filled(pattern, [pairingId, A.id, apptId])) {
          const res = await request(app).get(path).set(auth(token));
          calls++;
          const text = JSON.stringify(res.body) + (res.text ?? "");
          expect(text, `${who} GET ${path}`).not.toMatch(/\$2[aby]\$\d\d\$/);
          expect(text, `${who} GET ${path} leaked the hash`).not.toContain(aHash);
          expect(text, `${who} GET ${path} leaked the patient's address`).not.toContain(aEmail);
          for (const m of MARKERS) expect(text, `${who} GET ${path} leaked ${m}`).not.toContain(m);
        }
      }
    }
    expect(calls).toBeGreaterThan(400); // a crawl, not a spot check
  }, 120_000);

  it("shows the patient their own private values, and only them, on their own screens", async () => {
    const mine = await request(app).get("/api/health-profile/basic").set(auth(A.token));
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ phone: MARK.phone, dateOfBirth: MARK.dob, preferredName: MARK.pref });
    expect(JSON.stringify(mine.body)).not.toContain(aHash);
    const emergency = await request(app).get("/api/emergency-profile").set(auth(A.token));
    expect(emergency.body).toMatchObject({ emergencyContactName: MARK.contact, emergencyNotes: MARK.note });
    const theirs = await request(app).get("/api/health-profile/basic").set(auth(B.token));
    expect(JSON.stringify(theirs.body)).not.toContain(MARK.phone);
    const exported = await request(app).get("/api/me/export").set(auth(A.token));
    expect(exported.status).toBe(200);
    expect(exported.body.account).toMatchObject({ email: aEmail, phone: MARK.phone });
    expect(JSON.stringify(exported.body)).not.toContain(aHash);
  });

  it("keeps the directory free of private fields", async () => {
    const res = await request(app).get("/api/doctors");
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/\$2[aby]\$/);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("licenseNumber");
    expect(text).not.toContain("npiNumber");
  });
});
