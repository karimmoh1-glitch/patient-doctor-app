import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import { getApp, createDoctor, createAdmin, createStaff, signupPatient, operatorPool, type TestUser, type TestDoctor } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { devIdentityKey, signAssertion } from "../server/identity";
import { assertionSql, pool } from "../server/db";
import { runAsNobody, runAsUser, withScope } from "../server/dbContext";
import { storage } from "../server/storage";
import * as orgs from "../server/services/orgs";

// D-03c. The signed identity names the PERSON a scope acts for, and the database checks that person against the rows. These tests do not exercise the
// application's own permission checks (tests/orgs.test.ts does): they show what the DATABASE still refuses when the code is wrong, forged or compromised.
// Meaningful only through the restricted pool (npm run test:rls).

const ENFORCED = process.env.TEST_AS_APP_ROLE === "1";
const owner = () => operatorPool();
const q = async (sql: string, params: unknown[] = []) => (await owner().query(sql, params)).rows;

interface World {
  o1: string; o2: string;
  A: TestDoctor;            // owner of O1, an approved clinician
  S: TestUser;              // administrator-role member of O1 (not a clinician)
  D2: TestDoctor;           // a second clinician of O1
  C: TestDoctor;            // owner of O2
  R: TestUser;              // a REVOKED member of O1
  outsider: TestUser;       // a patient, member of nothing
  P1: TestUser; P2: TestUser; P3: TestUser; P4: TestUser;
  taskO1: string; taskO2: string; noteO1: string; noteO2: string;
  membershipC: string;
}
let w: World;

async function org(name: string, creator: string) {
  return (await q("INSERT INTO organizations (name, kind, country, created_by_user_id) VALUES ($1, 'clinic', 'US', $2) RETURNING id", [name, creator]))[0].id as string;
}
const member = async (o: string, u: string, role: string, status = "active") =>
  (await q("INSERT INTO org_memberships (org_id, user_id, role, status) VALUES ($1, $2, $3, $4) RETURNING id", [o, u, role, status]))[0].id as string;
const pairing = async (patient: string, profile: string, visible: boolean) =>
  q("INSERT INTO pairing_requests (patient_user_id, doctor_profile_id, status, org_staff_visible) VALUES ($1, $2, 'accepted', $3)", [patient, profile, visible]);

beforeAll(async () => {
  await getApp();
  const A = await createDoctor({ name: "Dr. Alder" });
  const D2 = await createDoctor({ name: "Dr. Birch" });
  const C = await createDoctor({ name: "Dr. Cedar" });
  const S = await createStaff("Admin Sam");
  const R = await createStaff("Revoked Rae");
  const outsider = await signupPatient();
  const [P1, P2, P3, P4] = [await signupPatient(), await signupPatient(), await signupPatient(), await signupPatient()];
  const o1 = await org("Orchard Clinic", A.id);
  const o2 = await org("Cove Clinic", C.id);
  await member(o1, A.id, "owner");
  await member(o1, S.id, "admin");
  await member(o1, D2.id, "clinician");
  await member(o1, R.id, "admin", "revoked");
  const membershipC = await member(o2, C.id, "owner");
  await pairing(P1.id, A.profileId, true);   // visible to staff
  await pairing(P2.id, A.profileId, false);  // the patient did NOT let staff see this connection
  await pairing(P3.id, C.profileId, true);   // the other organization's patient
  await pairing(P4.id, D2.profileId, false); // the second clinician's own patient, hidden from staff by the patient
  const taskO1 = (await q("INSERT INTO org_tasks (org_id, patient_user_id, title, created_by_user_id) VALUES ($1, $2, 'call back', $3) RETURNING id", [o1, P1.id, A.id]))[0].id;
  const taskO2 = (await q("INSERT INTO org_tasks (org_id, patient_user_id, title, created_by_user_id) VALUES ($1, $2, 'other clinic task', $3) RETURNING id", [o2, P3.id, C.id]))[0].id;
  const noteO1 = (await q("INSERT INTO org_notes (org_id, patient_user_id, body, author_user_id) VALUES ($1, $2, 'note in O1', $3) RETURNING id", [o1, P1.id, A.id]))[0].id;
  const noteO2 = (await q("INSERT INTO org_notes (org_id, patient_user_id, body, author_user_id) VALUES ($1, $2, 'note in O2', $3) RETURNING id", [o2, P3.id, C.id]))[0].id;
  await q("INSERT INTO audit_logs (action, actor_user_id, metadata) VALUES ('org.test_event', $1, $2)", [A.id, JSON.stringify({ orgId: o1 })]);
  await q("INSERT INTO audit_logs (action, actor_user_id, metadata) VALUES ('org.test_event', $1, $2)", [C.id, JSON.stringify({ orgId: o2 })]);
  w = { o1, o2, A, S, D2, C, R, outsider, P1, P2, P3, P4, taskO1, taskO2, noteO1, noteO2, membershipC };
});

/** Runs SQL as this signed-in person inside the actor-bound scope, exactly as an organization function would. */
const asMember = <T>(who: { id: string }, scope: "orgmember" | "mfa" | "review", fn: () => Promise<T>) => runAsUser(who.id, () => withScope(scope, fn));
const rows = (sql: string, params: unknown[] = []) => () => pool.query(sql, params).then((r) => r.rows);

describe.skipIf(!ENFORCED)("organization members: the database confines them to their own organization", () => {
  it("shows each member only their own organization's rows, in every table the scope opens", async () => {
    for (const [who, mine, theirs] of [[w.A, w.o1, w.o2], [w.C, w.o2, w.o1]] as const) {
      const t = await asMember(who, "orgmember", rows("SELECT org_id FROM org_tasks"));
      expect(t.length, "own tasks visible").toBeGreaterThan(0);
      expect(t.every((r) => r.org_id === mine)).toBe(true);
      expect((await asMember(who, "orgmember", rows("SELECT org_id FROM org_notes"))).every((r) => r.org_id === mine)).toBe(true);
      expect((await asMember(who, "orgmember", rows("SELECT id FROM organizations"))).map((r) => r.id)).toEqual([mine]);
      expect((await asMember(who, "orgmember", rows("SELECT org_id FROM org_memberships"))).every((r) => r.org_id === mine)).toBe(true);
      const audit = await asMember(who, "orgmember", rows("SELECT metadata->>'orgId' AS o FROM audit_logs"));
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.every((r) => r.o === mine && r.o !== theirs)).toBe(true);
    }
  });

  it("limits the patients an organization sees to those who let staff see them, and a clinician to their own", async () => {
    const patients = (who: { id: string }) => asMember(who, "orgmember", rows("SELECT id FROM users WHERE id = ANY ($1)", [[w.P1.id, w.P2.id, w.P3.id, w.P4.id]])).then((r) => r.map((x) => x.id).sort());
    // Every role but the clinician role (here the administrator role, and the owner) sees the organization's patients who let staff see them: P1 only. P2 and P4 are hidden
    // by their patients (even from the owner who is also P2's own clinician: the rule follows the ROLE, as server/services/orgs.ts scopeFor does), and P3 is another organization's.
    expect(await patients(w.S)).toEqual([w.P1.id]);
    expect(await patients(w.A)).toEqual([w.P1.id]);
    // A member with the CLINICIAN role sees only their own connections, whatever the patient chose about staff.
    expect(await patients(w.D2)).toEqual([w.P4.id]);
    // And the other organization's owner sees only theirs.
    expect(await patients(w.C)).toEqual([w.P3.id]);
    const visits = await asMember(w.S, "orgmember", rows("SELECT patient_user_id FROM pairing_requests"));
    expect(visits.map((v) => v.patient_user_id)).toEqual([w.P1.id]);
  });

  it("refuses everything to someone who is not an active member: a patient, a revoked member, a request with no actor", async () => {
    for (const who of [w.outsider, w.R, w.P1]) {
      for (const t of ["org_tasks", "org_notes", "organizations", "org_invitations"]) {
        expect(await asMember(who, "orgmember", rows(`SELECT 1 FROM ${t}`)), `${who.id} on ${t}`).toEqual([]);
      }
      // a person may see their OWN membership row (even a revoked one: it is how "you are no longer a member" is answered), nobody else's
      expect((await asMember(who, "orgmember", rows("SELECT user_id FROM org_memberships"))).every((r) => r.user_id === who.id)).toBe(true);
      expect(await asMember(who, "orgmember", rows("SELECT 1 FROM audit_logs WHERE metadata->>'orgId' IS NOT NULL"))).toEqual([]);
    }
    // No actor at all (nobody authenticated entered the scope): the scope guards nothing it could be asked for.
    const nobody = await runAsNobody(() => withScope("orgmember", rows("SELECT 1 FROM org_tasks UNION ALL SELECT 1 FROM organizations")));
    expect(nobody).toEqual([]);
  });

  it("refuses writes into another organization, and writes about a patient the actor may not see, while the same writes in their own organization work", async () => {
    // positive control: A may create a task for P1 in O1
    await asMember(w.A, "orgmember", () => pool.query("INSERT INTO org_tasks (org_id, patient_user_id, title, created_by_user_id) VALUES ($1, $2, 'mine', $3)", [w.o1, w.P1.id, w.A.id]));
    const refused = async (sql: string, params: unknown[]) => expect(asMember(w.A, "orgmember", () => pool.query(sql, params))).rejects.toMatchObject({ code: "42501" });
    await refused("INSERT INTO org_tasks (org_id, patient_user_id, title, created_by_user_id) VALUES ($1, $2, 'x', $3)", [w.o2, w.P3.id, w.A.id]);
    await refused("INSERT INTO org_notes (org_id, patient_user_id, body, author_user_id) VALUES ($1, $2, 'x', $3)", [w.o2, w.P3.id, w.A.id]);
    await refused("INSERT INTO org_notes (org_id, patient_user_id, body, author_user_id) VALUES ($1, $2, 'about someone else''s patient', $3)", [w.o1, w.P4.id, w.A.id]); // O1 but D2's patient: A is a clinician and sees only their own
    await refused("INSERT INTO org_invitations (org_id, email, role, token_hash, expires_at, invited_by_user_id) VALUES ($1, 'x@example.org', 'staff', 'h', now() + interval '1 day', $2)", [w.o2, w.A.id]);
    await refused("INSERT INTO audit_logs (action, actor_user_id, metadata) VALUES ('org.forged', $1, '{}')", [w.C.id]); // an entry in someone else's name
    for (const sql of ["UPDATE org_memberships SET role = 'auditor' WHERE org_id = $1", "UPDATE org_tasks SET status = 'done' WHERE org_id = $1", "UPDATE organizations SET name = 'taken over' WHERE id = $1"]) {
      const r = await asMember(w.A, "orgmember", () => pool.query(sql, [w.o2]));
      expect(r.rowCount, sql).toBe(0);
    }
    expect((await q("SELECT role FROM org_memberships WHERE id = $1", [w.membershipC]))[0].role).toBe("owner");
    expect((await q("SELECT name FROM organizations WHERE id = $1", [w.o2]))[0].name).toBe("Cove Clinic");
  });
});

describe.skipIf(!ENFORCED)("a defective code path: a capability forged for another organization gets nothing", () => {
  it("returns nothing and changes nothing for every organization function, even though the code believes the actor is the other organization's owner", async () => {
    const [orgRow] = await q("SELECT * FROM organizations WHERE id = $1", [w.o2]);
    const [memRow] = await q("SELECT * FROM org_memberships WHERE id = $1", [w.membershipC]);
    // What a bug (a missing check, a wrong id, a cast) would produce: an OrgAccess for O2, held by someone who is only a member of O1.
    const camel = (r: any) => ({ ...r, orgId: r.org_id, userId: r.user_id, createdAt: r.created_at });
    const forged = { org: { ...orgRow, createdByUserId: orgRow.created_by_user_id }, membership: camel(memRow), role: "owner" } as unknown as orgs.OrgAccess;
    const before = {
      members: await q("SELECT id, role, status FROM org_memberships WHERE org_id = $1 ORDER BY id", [w.o2]),
      tasks: await q("SELECT id, status FROM org_tasks WHERE org_id = $1 ORDER BY id", [w.o2]),
      notes: await q("SELECT count(*)::int n FROM org_notes WHERE org_id = $1", [w.o2]),
      invites: await q("SELECT count(*)::int n FROM org_invitations WHERE org_id = $1", [w.o2]),
    };
    const attempt = async <T,>(f: () => Promise<T>) => runAsUser(w.A.id, f).catch((e) => ({ refused: String(e?.message ?? e) }));
    const staff = await attempt(() => orgs.listStaff(forged));
    expect(Array.isArray(staff) ? staff : []).toEqual([]);
    expect(await attempt(() => orgs.listPatients(forged))).toEqual([]);
    expect(await attempt(() => orgs.listTasks(forged, "all"))).toEqual([]);
    expect(await attempt(() => orgs.listAppointments(forged))).toEqual([]);
    const audit = await attempt(() => orgs.searchAudit(forged, {}));
    expect(Array.isArray(audit) ? audit : []).toEqual([]);
    // writes: each either throws or does nothing
    await attempt(() => orgs.createTask(forged, { patientUserId: w.P3.id, title: "forged task" }));
    await attempt(() => orgs.addNote(forged, w.P3.id, "forged note"));
    await attempt(() => orgs.invite(forged, "victim@example.org", "staff"));
    await attempt(() => orgs.changeRole(forged, w.membershipC, "auditor"));
    await attempt(() => orgs.revokeMember(forged, w.membershipC));
    await attempt(() => orgs.updateTask(forged, w.taskO2, { status: "done" }));
    const after = {
      members: await q("SELECT id, role, status FROM org_memberships WHERE org_id = $1 ORDER BY id", [w.o2]),
      tasks: await q("SELECT id, status FROM org_tasks WHERE org_id = $1 ORDER BY id", [w.o2]),
      notes: await q("SELECT count(*)::int n FROM org_notes WHERE org_id = $1", [w.o2]),
      invites: await q("SELECT count(*)::int n FROM org_invitations WHERE org_id = $1", [w.o2]),
    };
    expect(after).toEqual(before);
    expect(await q("SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'org.%' AND metadata->>'orgId' = $1 AND actor_user_id = $2", [w.o2, w.A.id])).toEqual([{ n: 0 }]);
  });

  it("does not let the code choose its own actor: access() answers for the signed-in person only", async () => {
    // A signed-in member of O1 asks for O2 (and for C's membership): not found, as if it did not exist.
    await expect(runAsUser(w.A.id, () => orgs.access(w.A.id, w.o2, "org.view"))).rejects.toMatchObject({ status: 404 });
    // Asking on behalf of another person gains nothing: the database answers for the verified actor, so the owner of O2 is not "found" for A's request.
    await expect(runAsUser(w.A.id, () => orgs.access(w.C.id, w.o2, "org.view"))).rejects.toMatchObject({ status: 404 });
    // The legitimate path works.
    expect((await runAsUser(w.A.id, () => orgs.access(w.A.id, w.o1, "org.view"))).org.id).toBe(w.o1);
  });
});

// ---- the signed assertion itself
const key = devIdentityKey();
const mac = (mode: string, sub: string, exp: number, kid = key.kid) =>
  crypto.createHmac("sha256", key.key).update(`avela-identity-v1\n${kid}\n${mode}\n${sub}\n${exp}`).digest("base64url");
const forge = (mode: string, sub: string, ttl = 60) => { const exp = Math.floor(Date.now() / 1000) + ttl; return ["v1", key.kid, mode, sub, exp, mac(mode, sub, exp)].join("."); };

async function asToken<T>(token: string | null, sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: appRoleUrl(process.env.DATABASE_URL!) });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(assertionSql(token));
    const r = await c.query(sql);
    await c.query("ROLLBACK");
    return r.rows as T[];
  } finally {
    await c.end();
  }
}
const whoAmI = "SELECT app_verified_scope() AS scope, app_actor() AS actor, app_user_id() AS person";

describe.skipIf(!ENFORCED)("the assertion: an actor cannot be added, changed, moved or replayed without the key", () => {
  it("accepts a correctly signed actor on the three scopes that take one (positive control)", async () => {
    for (const scope of ["orgmember", "review", "mfa"] as const) {
      const t = signAssertion({ system: true, scope, actor: w.A.id }, key)!;
      expect(await asToken(t, whoAmI)).toEqual([{ scope, actor: w.A.id, person: null }]);
    }
    expect((await asToken(signAssertion({ system: true, scope: "orgmember", actor: w.A.id }, key), "SELECT count(*)::int n FROM org_tasks"))[0]).toMatchObject({ n: expect.any(Number) });
  });

  it("treats a changed actor, a moved scope or a tampered signature as nobody", async () => {
    const good = signAssertion({ system: true, scope: "orgmember", actor: w.A.id }, key)!;
    const parts = good.split(".");
    const withSub = (sub: string) => [...parts.slice(0, 3), sub, ...parts.slice(4)].join(".");
    const swapped = withSub(`orgmember~${w.C.id}`);        // C's id, A's signature
    const moved = withSub(`review~${w.A.id}`);             // another scope, the same signature
    const stripped = withSub("orgmember");                 // actor removed
    const flipped = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
    for (const t of [swapped, moved, stripped, flipped]) expect(await asToken(t, whoAmI), t.slice(0, 40)).toEqual([{ scope: null, actor: null, person: null }]);
  });

  it("refuses an actor on a scope that takes none, and on a person, even when validly signed", async () => {
    for (const scope of ["scheduler", "auth", "staff", "server", "notify"]) {
      expect(await asToken(forge("system", `${scope}~${w.A.id}`), whoAmI), scope).toEqual([{ scope: null, actor: null, person: null }]);
    }
    expect(await asToken(forge("user", `${w.A.id}~${w.C.id}`), whoAmI)).toEqual([{ scope: null, actor: null, person: null }]);
    expect(await asToken(forge("system", "orgmember~"), whoAmI)).toEqual([{ scope: null, actor: null, person: null }]);
  });

  it("gives an actor-bound scope with no actor nothing to see, and an expired actor nothing", async () => {
    const noActor = forge("system", "orgmember");
    expect(await asToken(noActor, whoAmI)).toEqual([{ scope: "orgmember", actor: null, person: null }]);
    for (const t of ["org_tasks", "org_notes", "organizations", "org_memberships", "user_mfa", "mfa_recovery_codes"]) {
      expect(await asToken(noActor, `SELECT 1 FROM ${t}`), t).toEqual([]);
      expect(await asToken(forge("system", t.startsWith("user_mfa") || t.startsWith("mfa") ? "mfa" : "review"), `SELECT 1 FROM ${t}`), `${t} without actor`).toEqual([]);
    }
    expect(await asToken(forge("system", `orgmember~${w.A.id}`, -5), whoAmI)).toEqual([{ scope: null, actor: null, person: null }]);
  });

  it("does not leak an actor between requests that share a connection pool", async () => {
    const people = [w.A, w.C, w.S, w.D2, w.R, w.outsider, w.P1, w.P2];
    const ask = () => pool.query("SELECT app_verified_scope() AS s, app_actor() AS a, pg_sleep(0.003)").then((r) => ({ s: r.rows[0].s, a: r.rows[0].a }));
    const jobs = Array.from({ length: 240 }, (_, i) => {
      const p = people[i % people.length];
      return i % 4 === 3 ? runAsNobody(() => withScope("orgmember", ask)).then((got) => ({ got, want: { s: "orgmember", a: null } }))
                         : runAsUser(p.id, () => withScope(i % 4 === 0 ? "orgmember" : i % 4 === 1 ? "review" : "mfa", ask)).then((got) => ({ got, want: { s: ["orgmember", "review", "mfa"][i % 4 === 0 ? 0 : i % 4 === 1 ? 1 : 2], a: p.id } }));
    });
    for (const { got, want } of await Promise.all(jobs)) expect(got).toEqual(want);
    // and nothing is left on a connection afterwards
    const sweep = await Promise.all(Array.from({ length: 12 }, () => runAsNobody(() => pool.query("SELECT app_actor() AS a, app_verified_scope() AS s").then((r) => r.rows[0]))));
    for (const s of sweep) expect(s).toEqual({ a: null, s: null });
  });
});

describe.skipIf(!ENFORCED)("second factor: only the account holder; an administrator may only reset", () => {
  let holder: TestDoctor, other: TestDoctor, admin: TestUser;
  beforeAll(async () => {
    holder = await createDoctor({ name: "Dr. Holder" });
    other = await createDoctor({ name: "Dr. Other" });
    admin = await createAdmin();
    // The helpers sign clinicians in, which enrols their second factor; confirm both rows exist (written through the actor-bound scope, so that path is exercised too).
    for (const u of [holder, other]) expect((await q("SELECT count(*)::int n FROM user_mfa WHERE user_id = $1", [u.id]))[0].n).toBe(1);
  });

  it("lets a person read and change only their own second-factor rows", async () => {
    const own = (await q("SELECT secret_ciphertext FROM user_mfa WHERE user_id = $1", [holder.id]))[0].secret_ciphertext;
    expect((await runAsUser(holder.id, () => storage.getMfa(holder.id)))?.secretCiphertext).toBe(own);
    // the code asks for someone else's row (a defect, an injection): the database shows the holder nothing of it
    expect(await runAsUser(holder.id, () => storage.getMfa(other.id))).toBeUndefined();
    expect((await asMember(holder, "mfa", () => pool.query("UPDATE user_mfa SET failed_attempts = 9 WHERE user_id = $1", [other.id]))).rowCount).toBe(0);
    expect((await asMember(holder, "mfa", () => pool.query("DELETE FROM user_mfa WHERE user_id = $1", [other.id]))).rowCount).toBe(0);
    expect((await asMember(holder, "mfa", () => pool.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [other.id]))).rowCount).toBe(0);
    await expect(asMember(holder, "mfa", () => pool.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, 'x')", [other.id]))).rejects.toMatchObject({ code: "42501" });
    expect((await q("SELECT failed_attempts FROM user_mfa WHERE user_id = $1", [other.id]))[0].failed_attempts).toBe(0);
  });

  it("gives an administrator no way to READ a secret, and a reset only through the checked function", async () => {
    // an administrator reads no one's secret through this scope: all they can see is their own row, like anyone
    expect((await asMember(admin, "mfa", rows("SELECT user_id FROM user_mfa"))).every((r) => r.user_id === admin.id)).toBe(true);
    expect(await asMember(admin, "mfa", rows("SELECT 1 FROM user_mfa WHERE user_id = ANY ($1)", [[holder.id, other.id]]))).toEqual([]);
    await expect(runAsUser(holder.id, () => storage.resetMfa(other.id))).rejects.toMatchObject({ cause: { code: "42501" } });     // a non-administrator (Drizzle wraps the database error)
    await expect(asMember(other, "mfa", rows("SELECT app_reset_mfa($1)", [holder.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(runAsNobody(() => withScope("mfa", rows("SELECT app_reset_mfa($1)", [holder.id])))).rejects.toMatchObject({ code: "42501" });
    expect((await q("SELECT count(*)::int n FROM user_mfa WHERE user_id = ANY ($1)", [[holder.id, other.id]]))[0].n).toBe(2);
    // a deactivated administrator is not an administrator
    const gone = await createAdmin();
    await q("UPDATE users SET deactivated_at = now() WHERE id = $1", [gone.id]);
    await expect(runAsUser(gone.id, () => storage.resetMfa(other.id))).rejects.toMatchObject({ cause: { code: "42501" } });
    // the real administrator can
    await runAsUser(admin.id, () => storage.resetMfa(other.id));
    expect((await q("SELECT count(*)::int n FROM user_mfa WHERE user_id = $1", [other.id]))[0].n).toBe(0);
    expect((await q("SELECT count(*)::int n FROM user_mfa WHERE user_id = $1", [holder.id]))[0].n).toBe(1);
  });
});

describe.skipIf(!ENFORCED)("administrators' decisions: only an active administrator, whatever the code asks", () => {
  it("shows and changes nothing to a person who is not an administrator", async () => {
    const reporter = w.P1;
    for (const who of [w.A, reporter, w.outsider]) {
      for (const t of ["message_reports", "doctor_applications", "credential_events"]) expect(await asMember(who, "review", rows(`SELECT 1 FROM ${t}`)), `${who.id} ${t}`).toEqual([]);
      expect((await asMember(who, "review", () => pool.query("UPDATE users SET deactivated_at = now() WHERE id = $1", [w.C.id]))).rowCount).toBe(0);
      expect((await asMember(who, "review", () => pool.query("UPDATE organizations SET status = 'verified' WHERE id = $1", [w.o2]))).rowCount).toBe(0);
      await expect(asMember(who, "review", () => pool.query("INSERT INTO credential_events (credential_id, to_status, actor_user_id) VALUES ('x', 'verified', $1)", [who.id]))).rejects.toBeDefined();
    }
    expect((await q("SELECT status FROM organizations WHERE id = $1", [w.o2]))[0].status).toBe("unverified");
    expect((await q("SELECT deactivated_at FROM users WHERE id = $1", [w.C.id]))[0].deactivated_at).toBeNull();
    // through the application's own functions, with the same ambient person
    expect(await runAsUser(w.A.id, () => storage.listMessageReports("open"))).toEqual([]);
    await expect(runAsUser(w.A.id, () => orgs.setOrgStatus(w.A.id, w.o2, "verified", { source: "x", note: "y" } as any))).rejects.toBeDefined();
    expect((await q("SELECT status FROM organizations WHERE id = $1", [w.o2]))[0].status).toBe("unverified");
  });

  it("lets an active administrator do it (positive control), and not a deactivated one", async () => {
    const admin = await createAdmin();
    expect((await asMember(admin, "review", () => pool.query("UPDATE organizations SET verification_note = 'seen' WHERE id = $1", [w.o2]))).rowCount).toBe(1);
    await q("UPDATE users SET deactivated_at = now() WHERE id = $1", [admin.id]);
    expect((await asMember(admin, "review", () => pool.query("UPDATE organizations SET verification_note = 'again' WHERE id = $1", [w.o2]))).rowCount).toBe(0);
  });
});

describe.skipIf(!ENFORCED)("a membership revoked while requests are in flight", () => {
  it("stops being honoured at the next statement: no request after the revocation sees the organization", async () => {
    const m = await createStaff("Mid-flight Mo");
    const o = await org("Revocable Clinic", w.A.id);
    await member(o, w.A.id, "owner");
    const mid = await member(o, m.id, "admin");
    await q("INSERT INTO org_tasks (org_id, patient_user_id, title, created_by_user_id) VALUES ($1, $2, 't', $3)", [o, w.P1.id, w.A.id]);
    const count = () => asMember(m, "orgmember", rows("SELECT count(*)::int n FROM org_tasks WHERE org_id = $1", [o])).then((r) => r[0].n as number);
    expect(await count()).toBe(1);
    // 60 reads race a revocation. Each statement sees either the whole organization or nothing (never a partial view)...
    const racing = Array.from({ length: 60 }, async (_, i) => { if (i === 30) await q("UPDATE org_memberships SET status = 'revoked' WHERE id = $1", [mid]); return count(); });
    for (const n of await Promise.all(racing)) expect([0, 1]).toContain(n);
    // ...and once the revocation has committed, every later request sees nothing, on any pooled connection.
    const after = await Promise.all(Array.from({ length: 40 }, () => count()));
    expect(after.every((n) => n === 0)).toBe(true);
    await expect(runAsUser(m.id, () => orgs.access(m.id, o, "org.view"))).rejects.toMatchObject({ status: 404 });
  });
});
