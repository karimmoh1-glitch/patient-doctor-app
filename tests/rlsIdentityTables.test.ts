import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { getApp, signupPatient, createDoctor, createAdmin, createCaregiverAccount, connect, issuePrescription, uniqueEmail, operatorPool, type TestUser, type TestDoctor } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { assertionFor } from "./identityHelpers";

// Migration 0024 put row-level security on the tables that held identity and account state, the access log, the directory
// and the server's own bookkeeping. This attacks each of them directly, as the restricted runtime role, saying who it is the
// way the application does and then running SQL the application never would. It runs against the same database in both
// modes: the role is always avela_app, whatever the application under test connects as.

let owner: pg.Pool;
let app_: pg.Pool;
type Who = { userId?: string; system?: boolean };
type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

async function as<T>(who: Who, fn: (q: Q) => Promise<T>): Promise<T> {
  const c = await app_.connect();
  try {
    await c.query("SELECT set_config('app.assertion', $1, false)", [assertionFor(who)]);
    return await fn((text, params) => c.query(text, params));
  } finally {
    await c.query("SELECT set_config('app.assertion', '', false), set_config('row_security', 'on', false)").catch(() => {});
    c.release();
  }
}
const ids = (who: Who, table: string, where = "true", key = "id") => as(who, async (q) => (await q(`SELECT ${key} AS id FROM ${table} WHERE ${where} ORDER BY 1`)).rows.map((r) => r.id as string));
const sees = async (who: Who, table: string, id: string, key = "id") => (await ids(who, table, `${key} = '${id}'`, key)).length === 1;

let A: TestUser, B: TestUser, C: TestUser, admin: TestUser, staff1: TestUser, staff2: TestUser, lonelyStaff: TestUser;
let D1: TestDoctor, D2: TestDoctor, hidden: TestDoctor;
let applicant: { userId: string; applicationId: string };
let pairingAD1: string, rxActive: string, rxDraft: string, reminderA: string, reminderB: string;

beforeAll(async () => {
  await getApp();
  owner = operatorPool();
  app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 4 });

  A = await signupPatient();
  B = await signupPatient();
  D1 = await createDoctor();
  D2 = await createDoctor();
  hidden = await createDoctor();
  C = await createCaregiverAccount();
  admin = await createAdmin();
  ({ pairingId: pairingAD1 } = await connect(A, D1));
  rxActive = (await issuePrescription(D1, pairingAD1)).id;
  rxDraft = (await owner.query(
    `INSERT INTO prescriptions (pairing_request_id, patient_user_id, doctor_profile_id, medication_name, dose, route, frequency_per_day, instructions, status)
     VALUES ($1, $2, $3, 'Draft Only', '1', 'oral', 1, 'x', 'draft') RETURNING id`, [pairingAD1, A.id, D1.profileId])).rows[0].id;
  await owner.query(`INSERT INTO prescription_events (prescription_id, actor_user_id, event) VALUES ($1, $2, 'drafted')`, [rxDraft, D1.id]);

  await owner.query(
    `INSERT INTO care_circle_members (patient_user_id, caregiver_user_id, name, invite_email, relationship_label, status) VALUES ($1, $2, 'Caregiver', $3, 'friend', 'active')`,
    [A.id, C.id, uniqueEmail("cg")]);

  // Two colleagues in one organization and a staff member who belongs to none.
  const mk = async (name: string) => (await owner.query(`INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', 'staff') RETURNING id`, [name, uniqueEmail("staff")])).rows[0].id as string;
  staff1 = { id: await mk("Colleague One"), email: "", token: "" };
  staff2 = { id: await mk("Colleague Two"), email: "", token: "" };
  lonelyStaff = { id: await mk("Elsewhere"), email: "", token: "" };
  const org = (await owner.query(`INSERT INTO organizations (name, kind, country, created_by_user_id) VALUES ('Test Clinic', 'clinic', 'US', $1) RETURNING id`, [staff1.id])).rows[0].id;
  for (const s of [staff1, staff2]) await owner.query(`INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, 'coordinator')`, [org, s.id]);

  // A doctor who applied and has not been decided on.
  const au = (await owner.query(`INSERT INTO users (name, email, password_hash, role) VALUES ('Applicant', $1, 'x', 'doctor') RETURNING id`, [uniqueEmail("applicant")])).rows[0].id as string;
  const ap = (await owner.query(`INSERT INTO doctor_applications (user_id, name, email, status, license_number) VALUES ($1, 'Applicant', $2, 'incomplete', 'LIC-123') RETURNING id`, [au, uniqueEmail("applicant")])).rows[0].id as string;
  applicant = { userId: au, applicationId: ap };

  // A reminder with one delivery for each patient.
  const mkReminder = async (p: TestUser) => {
    const rx = await owner.query(
      `INSERT INTO prescriptions (pairing_request_id, patient_user_id, doctor_profile_id, medication_name, dose, route, frequency_per_day, instructions, status)
       VALUES ($1, $2, $3, 'R', '1', 'oral', 1, 'x', 'draft') RETURNING id`, [pairingAD1, p.id, D1.profileId]);
    const med = await owner.query(`INSERT INTO medications (patient_user_id, prescription_id, name, instructions, schedule_times, start_date) VALUES ($1, $2, 'R', 'x', '["08:00"]', now()) RETURNING id`, [p.id, rx.rows[0].id]);
    const rem = await owner.query(`INSERT INTO medication_reminders (medication_id, patient_user_id, times, timezone, start_date) VALUES ($1, $2, '["08:00"]', 'UTC', '2026-01-01') RETURNING id`, [med.rows[0].id, p.id]);
    await owner.query(`INSERT INTO reminder_deliveries (reminder_id, due_at, channel) VALUES ($1, now(), 'email')`, [rem.rows[0].id]);
    return rem.rows[0].id as string;
  };
  reminderA = await mkReminder(A);
  reminderB = await mkReminder(B);
});

afterAll(async () => {
  await app_.end();
});

describe("every table is behind row-level security, and the application role holds only the privileges it needs", () => {
  it("has row-level security on every table in the schema, and a policy on each (the migration record has the privilege withheld instead)", async () => {
    const { rows } = await owner.query(`
      SELECT c.relname AS t, c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1`);
    expect(rows.filter((r) => !r.rls).map((r) => r.t), "tables outside row-level security").toEqual([]);
    expect(rows.filter((r) => r.policies === 0).map((r) => r.t), "tables with no policy at all (nobody but the owner can use them)").toEqual(["app_identity_config", "app_identity_keys", "schema_migrations"]);
    // …and for those, the privilege itself is withheld: nobody but the owner can read the migration record or the identity keys.
    for (const t of ["schema_migrations", "app_identity_keys", "app_identity_config"]) {
      const can = await owner.query(`SELECT has_table_privilege('avela_app', $1, 'SELECT') AS can`, [t]);
      expect(can.rows[0].can, t).toBe(false);
    }
  });

  it("limits the application role's table privileges to what each table is for", async () => {
    const { rows } = await owner.query(`
      SELECT c.relname AS t, string_agg(p.priv, ',' ORDER BY p.priv) AS granted
        FROM pg_class c CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v') AND has_table_privilege('avela_app', c.oid, p.priv)
       GROUP BY c.relname`);
    const granted = Object.fromEntries(rows.map((r) => [r.t as string, r.granted as string]));
    const special: Record<string, string | undefined> = {
      audit_logs: "INSERT,SELECT", prescription_events: "INSERT,SELECT", // append-only
      pharmacies: "SELECT", doctor_directory: "SELECT", // reference data and a view
      users: "INSERT,SELECT,UPDATE", // people are not deleted by the application
      schema_migrations: undefined, app_identity_keys: undefined, app_identity_config: undefined,
    };
    for (const [t, g] of Object.entries(granted)) {
      expect(g, `privileges on ${t}`).toBe(t in special ? special[t] : "DELETE,INSERT,SELECT,UPDATE");
    }
    expect(granted.schema_migrations).toBeUndefined();
    expect(granted.app_identity_keys).toBeUndefined();
    expect(granted.app_identity_config).toBeUndefined();
  });

  it("lets nobody but the owner run the database's functions, except the policy helpers the application role needs", async () => {
    const { rows } = await owner.query(`
      SELECT p.proname AS f, has_function_privilege('avela_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`);
    expect(rows.filter((r) => r.public_exec).map((r) => r.f), "functions executable by PUBLIC").toEqual([]);
    expect(rows.filter((r) => r.app && !String(r.f).startsWith("app_")).map((r) => r.f), "non-policy functions the application role may call").toEqual([]);
    expect(rows.filter((r) => !r.app && String(r.f).startsWith("app_")).map((r) => r.f), "policy helpers the role cannot call (the policies would fail)").toEqual([]);
    // The ones that hold privilege.
    await expect(as({ system: true }, (q) => q("SELECT avela_apply_grants()"))).rejects.toThrow(/permission denied/);
    await expect(as({ system: true }, (q) => q("SELECT avela_users_guard()"))).rejects.toThrow(/permission denied/);
  });

  it("gives every SECURITY DEFINER function a fixed search_path, so a function of the same name in another schema cannot stand in", async () => {
    const { rows } = await owner.query(`
      SELECT p.proname AS f FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND NOT COALESCE(p.proconfig::text ~ 'search_path', false)`);
    expect(rows.map((r) => r.f)).toEqual([]);
  });

  it("cannot be talked into reading around the policies", async () => {
    // Turning row security off makes a query that would be filtered fail instead of showing everything.
    await expect(as({ userId: B.id }, async (q) => { await q("SET row_security = off"); return q("SELECT id FROM users"); })).rejects.toThrow();
    await expect(as({ userId: B.id }, (q) => q("SET ROLE neondb_owner"))).rejects.toThrow();
    await expect(as({ userId: B.id }, (q) => q("ALTER TABLE users DISABLE ROW LEVEL SECURITY"))).rejects.toThrow(/must be owner/);
    await expect(as({ userId: B.id }, (q) => q("CREATE POLICY sneaky ON users FOR SELECT USING (true)"))).rejects.toThrow(/must be owner/);
  });
});

describe("users: an account row", () => {
  const sees_ = (who: Who, id: string) => sees(who, "users", id);

  it("shows nobody to nobody, and a person only themself plus the people their relationships connect them to", async () => {
    expect(await ids({}, "users")).toEqual([]);
    expect(await ids({ userId: B.id }, "users")).toEqual([B.id]);
    expect(await sees_({ userId: B.id }, A.id)).toBe(false);
    expect(await sees_({ userId: A.id }, B.id)).toBe(false);
    // A patient sees the doctor they asked; a doctor sees the patient who asked them and no other patient.
    expect(await sees_({ userId: A.id }, D1.id)).toBe(true);
    expect(await sees_({ userId: A.id }, D2.id)).toBe(false);
    expect(await sees_({ userId: D1.id }, A.id)).toBe(true);
    expect(await sees_({ userId: D1.id }, B.id)).toBe(false);
    expect(await sees_({ userId: D2.id }, A.id)).toBe(false);
    // A caregiver sees the patient they accepted and nobody else's; the patient sees the caregiver they invited.
    expect(await sees_({ userId: C.id }, A.id)).toBe(true);
    expect(await sees_({ userId: C.id }, B.id)).toBe(false);
    expect(await sees_({ userId: A.id }, C.id)).toBe(true);
    expect(await sees_({ userId: B.id }, C.id)).toBe(false);
    // Colleagues see each other; a stranger on the staff does not.
    expect(await sees_({ userId: staff1.id }, staff2.id)).toBe(true);
    expect(await sees_({ userId: lonelyStaff.id }, staff2.id)).toBe(false);
    expect(await sees_({ userId: staff1.id }, A.id)).toBe(false); // staff reach patients through the server's scoped paths, not the table
  });

  it("lets an administrator review clinicians and administrators, but not read a patient's account", async () => {
    expect(await sees_({ userId: admin.id }, D1.id)).toBe(true);
    expect(await sees_({ userId: admin.id }, applicant.userId)).toBe(true);
    expect(await sees_({ userId: admin.id }, A.id)).toBe(false);
    expect(await sees_({ userId: admin.id }, B.id)).toBe(false);
    // Only a live administrator: once deactivated the same identity is nobody special.
    await owner.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [admin.id]);
    try {
      expect(await sees_({ userId: admin.id }, D1.id)).toBe(false);
    } finally {
      await owner.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [admin.id]);
    }
    // An ordinary patient who merely says "I am an administrator" gets nothing.
    expect(await ids({ userId: A.id }, "users", `role = 'admin'`)).toEqual([]);
  });

  it("stops a person changing anyone else, deleting anyone, or creating an account", async () => {
    expect((await as({ userId: B.id }, (q) => q(`UPDATE users SET name = 'hacked' WHERE id = $1`, [A.id]))).rowCount).toBe(0);
    expect((await as({ userId: D1.id }, (q) => q(`UPDATE users SET name = 'hacked' WHERE id = $1`, [A.id]))).rowCount).toBe(0);
    expect((await as({}, (q) => q(`UPDATE users SET name = 'hacked' WHERE id = $1`, [A.id]))).rowCount).toBe(0);
    await expect(as({ userId: B.id }, (q) => q(`DELETE FROM users WHERE id = $1`, [B.id]))).rejects.toThrow(/permission denied/);
    await expect(as({ system: true }, (q) => q(`DELETE FROM users WHERE id = $1`, [B.id]))).rejects.toThrow(/permission denied/);
    await expect(as({ userId: B.id }, (q) => q(`INSERT INTO users (name, email, password_hash, role) VALUES ('x', $1, 'x', 'patient')`, [uniqueEmail("new")]))).rejects.toThrow(/row-level security/);
    await expect(as({}, (q) => q(`INSERT INTO users (name, email, password_hash, role) VALUES ('x', $1, 'x', 'patient')`, [uniqueEmail("new")]))).rejects.toThrow(/row-level security/);
    expect((await owner.query(`SELECT name FROM users WHERE id = $1`, [A.id])).rows[0].name).not.toBe("hacked");
  });

  it("never lets the application make or become an administrator, or change a role, an address or a fixture flag, even as itself", async () => {
    // Creating one, even with full system access (the first administrator is made by the operator: npm run admin:create).
    await expect(as({ system: true }, (q) => q(`INSERT INTO users (name, email, password_hash, role) VALUES ('Sneaky', $1, 'x', 'admin')`, [uniqueEmail("sneaky")]))).rejects.toThrow(/cannot be created by the application/);
    // Promoting oneself.
    await expect(as({ userId: A.id }, (q) => q(`UPDATE users SET role = 'admin' WHERE id = $1`, [A.id]))).rejects.toThrow(/role cannot be changed/);
    await expect(as({ system: true }, (q) => q(`UPDATE users SET role = 'admin' WHERE id = $1`, [A.id]))).rejects.toThrow(/role cannot be changed/);
    expect((await as({ userId: admin.id }, (q) => q(`UPDATE users SET role = 'admin' WHERE id = $1`, [B.id]))).rowCount, "an administrator edits nobody's account row").toBe(0);
    // Taking over an account by pointing it at another address, or hiding behind the fixture flag.
    await expect(as({ userId: A.id }, (q) => q(`UPDATE users SET email = $2 WHERE id = $1`, [A.id, uniqueEmail("takeover")]))).rejects.toThrow(/email cannot be changed/);
    await expect(as({ userId: A.id }, (q) => q(`UPDATE users SET is_demo = true WHERE id = $1`, [A.id]))).rejects.toThrow(/is_demo cannot be changed/);
    // Declaring one's own address verified.
    await expect(as({ userId: A.id }, (q) => q(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [A.id]))).rejects.toThrow(/verification is recorded by the server/);
    expect((await owner.query(`SELECT role FROM users WHERE id = $1`, [A.id])).rows[0].role).toBe("patient");
    // What a person may change about themself still works.
    expect((await as({ userId: A.id }, (q) => q(`UPDATE users SET preferred_name = 'Ay' WHERE id = $1`, [A.id]))).rowCount).toBe(1);
    expect((await as({ system: true }, (q) => q(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [B.id]))).rowCount).toBe(1);
  });

  it("is operable by the owner: the guards bind the application role, not the operator who maintains the data", async () => {
    const r = await owner.query(`INSERT INTO users (name, email, password_hash, role) VALUES ('Operator Made', $1, 'x', 'admin') RETURNING id`, [uniqueEmail("op")]);
    expect(r.rowCount).toBe(1);
  });
});

describe("doctor_applications: a clinician's licence details while under review", () => {
  it("shows an application to its applicant, to an administrator and to the server, and to nobody else", async () => {
    expect(await sees({ userId: applicant.userId }, "doctor_applications", applicant.applicationId)).toBe(true);
    expect(await sees({ userId: admin.id }, "doctor_applications", applicant.applicationId)).toBe(true);
    expect(await sees({ system: true }, "doctor_applications", applicant.applicationId)).toBe(true);
    for (const who of [{}, { userId: A.id }, { userId: D1.id }, { userId: C.id }, { userId: staff1.id }]) {
      expect(await sees(who, "doctor_applications", applicant.applicationId), JSON.stringify(who)).toBe(false);
    }
  });

  it("lets the applicant write their details and submit, but not decide their own application", async () => {
    const me = { userId: applicant.userId };
    expect((await as(me, (q) => q(`UPDATE doctor_applications SET bio = 'about me' WHERE id = $1`, [applicant.applicationId]))).rowCount).toBe(1);
    await expect(as(me, (q) => q(`UPDATE doctor_applications SET status = 'approved' WHERE id = $1`, [applicant.applicationId]))).rejects.toThrow(/can only submit/);
    await expect(as(me, (q) => q(`UPDATE doctor_applications SET reviewer_notes = 'fine by me', reviewed_at = now() WHERE id = $1`, [applicant.applicationId]))).rejects.toThrow(/belong to the reviewer/);
    await expect(as(me, (q) => q(`UPDATE doctor_applications SET user_id = $2 WHERE id = $1`, [applicant.applicationId, A.id]))).rejects.toThrow(/belong to the reviewer/);
    expect((await as(me, (q) => q(`UPDATE doctor_applications SET status = 'pending', submitted_at = now() WHERE id = $1`, [applicant.applicationId]))).rowCount).toBe(1);
    // Once submitted it is out of the applicant's hands.
    await expect(as(me, (q) => q(`UPDATE doctor_applications SET status = 'approved' WHERE id = $1`, [applicant.applicationId]))).rejects.toThrow(/can only submit/);
  });

  it("stops anyone else editing or removing it, and lets an administrator decide", async () => {
    expect((await as({ userId: D1.id }, (q) => q(`UPDATE doctor_applications SET status = 'approved' WHERE id = $1`, [applicant.applicationId]))).rowCount).toBe(0);
    expect((await as({ userId: A.id }, (q) => q(`DELETE FROM doctor_applications WHERE id = $1`, [applicant.applicationId]))).rowCount).toBe(0);
    expect((await as({ userId: applicant.userId }, (q) => q(`DELETE FROM doctor_applications WHERE id = $1`, [applicant.applicationId]))).rowCount).toBe(0);
    await expect(as({ userId: A.id }, (q) => q(`INSERT INTO doctor_applications (user_id, name, email) VALUES ($1, 'x', 'x@test.example')`, [D2.id]))).rejects.toThrow(/row-level security/);
    expect((await as({ userId: admin.id }, (q) => q(`UPDATE doctor_applications SET status = 'needs_info', info_request = 'licence page?', reviewed_by_user_id = $2, reviewed_at = now() WHERE id = $1`, [applicant.applicationId, admin.id]))).rowCount).toBe(1);
    // Answering the request is the applicant's, and only that.
    expect((await as({ userId: applicant.userId }, (q) => q(`UPDATE doctor_applications SET status = 'pending', info_request = NULL WHERE id = $1`, [applicant.applicationId]))).rowCount).toBe(1);
  });
});

describe("doctor_profiles and doctor_availability: the directory", () => {
  it("keeps the profile table private: the phone number and licence are for the clinician, an administrator and the doctor's own connections", async () => {
    expect(await sees({ userId: D1.id }, "doctor_profiles", D1.profileId)).toBe(true); // their own
    expect(await sees({ userId: admin.id }, "doctor_profiles", D1.profileId)).toBe(true);
    expect(await sees({ userId: A.id }, "doctor_profiles", D1.profileId)).toBe(true); // connected
    expect(await sees({ userId: C.id }, "doctor_profiles", D1.profileId)).toBe(true); // caregiver of a connected patient
    for (const who of [{}, { userId: B.id }, { userId: D2.id }, { userId: staff1.id }]) {
      expect(await sees(who, "doctor_profiles", D1.profileId), JSON.stringify(who)).toBe(false);
    }
  });

  it("offers the public a directory view that has no phone number, licence or registry number in it", async () => {
    const cols = (await owner.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'doctor_directory'`)).rows.map((r) => r.column_name as string);
    for (const secret of ["phone", "license_number", "npi_number", "verified_by_user_id"]) expect(cols, secret).not.toContain(secret);
    // Anyone, signed in or not, can search it; it lists a listed doctor.
    for (const who of [{}, { userId: B.id }]) expect(await sees(who, "doctor_directory", D2.profileId), JSON.stringify(who)).toBe(true);
    // …and cannot be made to show a doctor who is not listed.
    await owner.query(`UPDATE doctor_profiles SET active = false WHERE id = $1`, [hidden.profileId]);
    try {
      expect(await sees({}, "doctor_directory", hidden.profileId)).toBe(false);
      expect(await sees({ userId: B.id }, "doctor_directory", hidden.profileId)).toBe(false);
    } finally {
      await owner.query(`UPDATE doctor_profiles SET active = true WHERE id = $1`, [hidden.profileId]);
    }
  });

  it("lets a clinician edit how they are described, never whether they are active, verified or licensed", async () => {
    const me = { userId: D2.id };
    expect((await as(me, (q) => q(`UPDATE doctor_profiles SET bio = 'Updated' WHERE id = $1`, [D2.profileId]))).rowCount).toBe(1);
    for (const sql of [
      `UPDATE doctor_profiles SET active = false WHERE id = $1`,
      `UPDATE doctor_profiles SET verified_at = now() WHERE id = $1`,
      `UPDATE doctor_profiles SET license_number = 'FORGED' WHERE id = $1`,
      `UPDATE doctor_profiles SET credential_expires_at = now() + interval '10 years' WHERE id = $1`,
      `UPDATE doctor_profiles SET user_id = '${A.id}' WHERE id = $1`,
      `UPDATE doctor_profiles SET specialty = 'Surgery' WHERE id = $1`,
    ]) {
      await expect(as(me, (q) => q(sql, [D2.profileId])), sql).rejects.toThrow(/may be edited by the clinician/);
    }
    // A clinician who has been suspended cannot switch themself back on.
    await owner.query(`UPDATE doctor_profiles SET active = false WHERE id = $1`, [D2.profileId]);
    try {
      await expect(as(me, (q) => q(`UPDATE doctor_profiles SET active = true WHERE id = $1`, [D2.profileId]))).rejects.toThrow(/may be edited by the clinician/);
      expect((await owner.query(`SELECT active FROM doctor_profiles WHERE id = $1`, [D2.profileId])).rows[0].active, "a suspended clinician stays suspended").toBe(false);
    } finally {
      await owner.query(`UPDATE doctor_profiles SET active = true WHERE id = $1`, [D2.profileId]);
    }
  });

  it("lets nobody but the server create or remove a profile, and nobody edit another clinician's", async () => {
    await expect(as({ userId: D2.id }, (q) => q(`INSERT INTO doctor_profiles (user_id, name, specialty, state, phone) VALUES ($1, 'Clone', 'x', 'CA', '1')`, [D2.id]))).rejects.toThrow(/row-level security/);
    await expect(as({ userId: A.id }, (q) => q(`INSERT INTO doctor_profiles (user_id, name, specialty, state, phone) VALUES ($1, 'Fake', 'x', 'CA', '1')`, [A.id]))).rejects.toThrow(/row-level security/);
    expect((await as({ userId: D2.id }, (q) => q(`DELETE FROM doctor_profiles WHERE id = $1`, [D2.profileId]))).rowCount).toBe(0);
    expect((await as({ userId: D2.id }, (q) => q(`UPDATE doctor_profiles SET bio = 'mine now' WHERE id = $1`, [D1.profileId]))).rowCount).toBe(0);
    expect((await as({ userId: A.id }, (q) => q(`UPDATE doctor_profiles SET bio = 'patient edit' WHERE id = $1`, [D1.profileId]))).rowCount).toBe(0);
  });

  it("publishes a listed doctor's weekly windows to everyone and lets only that doctor change them", async () => {
    const w = await as({ userId: D1.id }, (q) => q(`INSERT INTO doctor_availability (doctor_profile_id, weekday, start_minute, end_minute) VALUES ($1, 2, 540, 720) RETURNING id`, [D1.profileId]));
    const id = w.rows[0].id as string;
    for (const who of [{}, { userId: B.id }, { userId: D2.id }]) expect(await sees(who, "doctor_availability", id), JSON.stringify(who)).toBe(true);
    expect((await as({ userId: D2.id }, (q) => q(`UPDATE doctor_availability SET end_minute = 1000 WHERE id = $1`, [id]))).rowCount).toBe(0);
    expect((await as({ userId: A.id }, (q) => q(`DELETE FROM doctor_availability WHERE id = $1`, [id]))).rowCount).toBe(0);
    await expect(as({ userId: A.id }, (q) => q(`INSERT INTO doctor_availability (doctor_profile_id, weekday, start_minute, end_minute) VALUES ($1, 3, 0, 60)`, [D1.profileId]))).rejects.toThrow(/row-level security/);
    // A doctor who is not listed publishes nothing to the public.
    await owner.query(`UPDATE doctor_profiles SET active = false WHERE id = $1`, [D1.profileId]);
    try {
      expect(await sees({}, "doctor_availability", id)).toBe(false);
      expect(await sees({ userId: B.id }, "doctor_availability", id)).toBe(false);
    } finally {
      await owner.query(`UPDATE doctor_profiles SET active = true WHERE id = $1`, [D1.profileId]);
    }
    expect((await as({ userId: D1.id }, (q) => q(`DELETE FROM doctor_availability WHERE id = $1`, [id]))).rowCount).toBe(1);
  });
});

describe("audit_logs and prescription_events: append-only records", () => {
  let logAboutA: string;
  beforeAll(async () => {
    logAboutA = (await owner.query(`INSERT INTO audit_logs (actor_user_id, subject_user_id, action) VALUES ($1, $2, 'rls.identity.test') RETURNING id`, [D1.id, A.id])).rows[0].id;
  });

  it("shows a person what was done to their records and what they did, an administrator the whole log, and nobody else anything", async () => {
    expect(await sees({ userId: A.id }, "audit_logs", logAboutA)).toBe(true); // the subject
    expect(await sees({ userId: D1.id }, "audit_logs", logAboutA)).toBe(true); // the actor
    expect(await sees({ userId: admin.id }, "audit_logs", logAboutA)).toBe(true);
    for (const who of [{}, { userId: B.id }, { userId: D2.id }, { userId: C.id }, { userId: staff1.id }]) {
      expect(await sees(who, "audit_logs", logAboutA), JSON.stringify(who)).toBe(false);
    }
  });

  it("lets a person add an entry only in their own name, and nobody edit or remove one", async () => {
    await expect(as({ userId: B.id }, (q) => q(`INSERT INTO audit_logs (actor_user_id, subject_user_id, action) VALUES ($1, $2, 'forged')`, [A.id, B.id]))).rejects.toThrow(/row-level security/);
    await expect(as({}, (q) => q(`INSERT INTO audit_logs (action) VALUES ('anonymous')`))).rejects.toThrow(/row-level security/);
    expect((await as({ userId: B.id }, (q) => q(`INSERT INTO audit_logs (actor_user_id, subject_user_id, action) VALUES ($1, $1, 'own') RETURNING id`, [B.id]))).rowCount).toBe(1);
    for (const who of [{ userId: A.id }, { userId: admin.id }, { system: true }]) {
      await expect(as(who, (q) => q(`UPDATE audit_logs SET action = 'edited' WHERE id = $1`, [logAboutA]))).rejects.toThrow(/permission denied/);
      await expect(as(who, (q) => q(`DELETE FROM audit_logs WHERE id = $1`, [logAboutA]))).rejects.toThrow(/permission denied/);
    }
  });

  it("shows a prescription's history exactly to the people who may see the prescription", async () => {
    const ev = async (rx: string) => (await owner.query(`SELECT id FROM prescription_events WHERE prescription_id = $1 LIMIT 1`, [rx])).rows[0].id as string;
    const issued = await ev(rxActive);
    const draft = await ev(rxDraft);
    expect(await sees({ userId: D1.id }, "prescription_events", issued)).toBe(true);
    expect(await sees({ userId: A.id }, "prescription_events", issued)).toBe(true);
    expect(await sees({ userId: C.id }, "prescription_events", issued)).toBe(true);
    expect(await sees({ userId: D1.id }, "prescription_events", draft)).toBe(true);
    expect(await sees({ userId: A.id }, "prescription_events", draft), "a draft is invisible to the patient, and so is its history").toBe(false);
    for (const who of [{}, { userId: B.id }, { userId: D2.id }, { userId: admin.id }, { userId: staff1.id }]) {
      expect(await sees(who, "prescription_events", issued), JSON.stringify(who)).toBe(false);
    }
    await expect(as({ userId: B.id }, (q) => q(`INSERT INTO prescription_events (prescription_id, actor_user_id, event) VALUES ($1, $2, 'cancelled')`, [rxActive, B.id]))).rejects.toThrow(/row-level security/);
    await expect(as({ userId: D2.id }, (q) => q(`INSERT INTO prescription_events (prescription_id, actor_user_id, event) VALUES ($1, $2, 'cancelled')`, [rxActive, D2.id]))).rejects.toThrow(/row-level security/);
    await expect(as({ userId: D1.id }, (q) => q(`UPDATE prescription_events SET event = 'edited' WHERE id = $1`, [issued]))).rejects.toThrow(/permission denied/);
  });
});

describe("pharmacies, the scheduler's bookkeeping and the rate-limit counters", () => {
  it("lets a signed-in person read the pharmacy list and nobody, signed in or not, change it", async () => {
    const p = (await owner.query(`INSERT INTO pharmacies (name, address, city, state, zip, phone) VALUES ('Corner Pharmacy', '1 Main', 'Town', 'CA', '90000', '555') RETURNING id`)).rows[0].id as string;
    expect(await sees({}, "pharmacies", p)).toBe(false);
    expect(await sees({ userId: B.id }, "pharmacies", p)).toBe(true);
    for (const who of [{ userId: B.id }, { userId: admin.id }, { system: true }]) {
      await expect(as(who, (q) => q(`UPDATE pharmacies SET name = 'x' WHERE id = $1`, [p])), JSON.stringify(who)).rejects.toThrow(/permission denied/);
      await expect(as(who, (q) => q(`INSERT INTO pharmacies (name, address, city, state, zip, phone) VALUES ('x','x','x','x','x','x')`)), JSON.stringify(who)).rejects.toThrow(/permission denied/);
      await expect(as(who, (q) => q(`DELETE FROM pharmacies WHERE id = $1`, [p])), JSON.stringify(who)).rejects.toThrow(/permission denied/);
    }
  });

  it("keeps job_runs, job_run_history and rate_limit_hits to the server alone", async () => {
    await owner.query(`INSERT INTO job_runs (job, last_run_at) VALUES ('rls.identity.test', now()) ON CONFLICT (job) DO NOTHING`);
    await owner.query(`INSERT INTO job_run_history (job, run_id, source, started_at) VALUES ('rls.identity.test', 'r1', 'test', now())`);
    await owner.query(`INSERT INTO rate_limit_hits (key, hits, reset_at) VALUES ('abababababababababababababababababababababababababababababababab', 1, now() + interval '1 minute') ON CONFLICT (key) DO NOTHING`);
    for (const [table, key] of [["job_runs", "job"], ["job_run_history", "job"], ["rate_limit_hits", "key"]] as const) {
      for (const who of [{}, { userId: A.id }, { userId: D1.id }, { userId: admin.id }]) {
        expect(await ids(who, table, "true", key), `${table} as ${JSON.stringify(who)}`).toEqual([]);
        expect((await as(who, (q) => q(`DELETE FROM ${table}`))).rowCount, `delete ${table}`).toBe(0);
      }
      expect((await ids({ system: true }, table, "true", key)).length, `${table} as the server`).toBeGreaterThan(0);
    }
    await expect(as({ userId: A.id }, (q) => q(`INSERT INTO rate_limit_hits (key, hits, reset_at) VALUES ('mine', 1, now())`))).rejects.toThrow(/row-level security/);
    await expect(as({ userId: admin.id }, (q) => q(`UPDATE job_runs SET consecutive_failures = 0`))).resolves.toMatchObject({ rowCount: 0 });
    await expect(as({ userId: admin.id }, (q) => q(`INSERT INTO job_run_history (job, run_id, started_at) VALUES ('forged', 'x', now())`))).rejects.toThrow(/row-level security/);
    // Leave the shared tables as found: other suites read them.
    await owner.query(`DELETE FROM job_run_history WHERE job = 'rls.identity.test'`);
    await owner.query(`DELETE FROM job_runs WHERE job = 'rls.identity.test'`);
    await owner.query(`DELETE FROM rate_limit_hits WHERE key = '${"ab".repeat(32)}'`);
  });

  it("shows a reminder's delivery history only to whoever may see the reminder, and lets only the server write it", async () => {
    const d = async (rem: string) => (await owner.query(`SELECT id FROM reminder_deliveries WHERE reminder_id = $1`, [rem])).rows[0].id as string;
    const dA = await d(reminderA);
    const dB = await d(reminderB);
    expect(await sees({ userId: A.id }, "reminder_deliveries", dA)).toBe(true);
    expect(await sees({ userId: A.id }, "reminder_deliveries", dB)).toBe(false);
    expect(await sees({ userId: B.id }, "reminder_deliveries", dA)).toBe(false);
    expect(await sees({ userId: D2.id }, "reminder_deliveries", dA)).toBe(false);
    expect(await sees({}, "reminder_deliveries", dA)).toBe(false);
    await expect(as({ userId: A.id }, (q) => q(`INSERT INTO reminder_deliveries (reminder_id, due_at, channel) VALUES ($1, now() + interval '1 day', 'email')`, [reminderA]))).rejects.toThrow(/row-level security/);
    expect((await as({ userId: A.id }, (q) => q(`UPDATE reminder_deliveries SET status = 'sent' WHERE id = $1`, [dA]))).rowCount).toBe(0);
  });
});

describe("the parties to a connection, a visit or a follow-up cannot be re-pointed", () => {
  it("refuses to move a connection, appointment or follow-up to another patient or doctor, even by its own clinician", async () => {
    const appt = (await owner.query(
      `INSERT INTO appointments (pairing_request_id, patient_user_id, doctor_profile_id, type, reason, scheduled_at, status)
       VALUES ($1, $2, $3, 'Video Visit', 'r', now() + interval '3 days', 'confirmed') RETURNING id`, [pairingAD1, A.id, D1.profileId])).rows[0].id as string;
    const task = (await owner.query(
      `INSERT INTO follow_up_tasks (patient_user_id, doctor_profile_id, title) VALUES ($1, $2, 'check in') RETURNING id`, [A.id, D1.profileId])).rows[0].id as string;
    const d1 = { userId: D1.id };
    await expect(as(d1, (q) => q(`UPDATE pairing_requests SET patient_user_id = $2 WHERE id = $1`, [pairingAD1, B.id]))).rejects.toThrow(/cannot be changed/);
    await expect(as(d1, (q) => q(`UPDATE pairing_requests SET doctor_profile_id = $2 WHERE id = $1`, [pairingAD1, D2.profileId]))).rejects.toThrow(/cannot be changed/);
    await expect(as({ userId: A.id }, (q) => q(`UPDATE pairing_requests SET doctor_profile_id = $2 WHERE id = $1`, [pairingAD1, D2.profileId]))).rejects.toThrow(/cannot be changed/);
    await expect(as(d1, (q) => q(`UPDATE appointments SET patient_user_id = $2 WHERE id = $1`, [appt, B.id]))).rejects.toThrow(/cannot be changed/);
    await expect(as(d1, (q) => q(`UPDATE follow_up_tasks SET patient_user_id = $2 WHERE id = $1`, [task, B.id]))).rejects.toThrow(/cannot be changed/);
    // …so B never gains access to A's connection, and D1 never gains a patient they were not given.
    expect(await sees({ userId: B.id }, "pairing_requests", pairingAD1)).toBe(false);
    // What a party may change still works.
    expect((await as(d1, (q) => q(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [appt]))).rowCount).toBe(1);
  });
});
