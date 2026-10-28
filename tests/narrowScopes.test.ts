import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "crypto";
import pg from "pg";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, createStaff, connect, auth, uniqueEmail, operatorPool, completeSecondFactor, PASSWORD, APPROVAL, type TestUser, type TestDoctor } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { assertionFor } from "./identityHelpers";
import { devIdentityKey, SYSTEM_SCOPES, type SystemScope } from "../server/identity";
import { ROUTER_MOUNTS } from "../server/routes";
import { ENTRY_MAY_USE } from "../server/dbContext";

// Migration 0029 gives every code path that used the unrestricted "server" scope a scope of its own, command by command. These attack that:
// the declared permissions against the database, every operation a scope was NOT given, a scope edited or replayed as another, people
// calling things that belong to scopes, signed-in roles calling things that belong to other roles, and concurrent changes to the accounts involved.

const ENFORCED = process.env.TEST_AS_APP_ROLE === "1";
const resetLinks: { to: string; link: string }[] = [];
vi.mock("../server/services/emailService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/services/emailService")>();
  return { ...original, sendPasswordResetEmail: async (to: string, _n: string, link: string) => { resetLinks.push({ to, link }); } };
});

type Cmds = string; // S select, I insert, U update, D delete
/** The second, independent statement of the intended permissions for the scopes added by 0029. */
const NEW_SCOPES: Record<string, Record<string, Cmds>> = {
  staff: { appointments: "S", audit_logs: "SI", doctor_profiles: "S", notifications: "SI", org_invitations: "SIU", org_memberships: "SIU", org_notes: "SI", org_tasks: "SIU", organizations: "SIU", pairing_requests: "SU", users: "S" },
  review: { audit_logs: "SI", credential_events: "SI", doctor_applications: "SU", doctor_credentials: "SIU", doctor_profiles: "SIU", message_reports: "SU", organizations: "SU", user_devices: "SU", users: "SU" },
  mfa: { mfa_recovery_codes: "SIUD", user_devices: "SU", user_mfa: "SIUD" },
  notify: { notifications: "SI" },
  contact: {},
  audit: { audit_logs: "S" },
  blocks: { user_blocks: "S" },
  ops: { doctor_profiles: "S", email_deliveries: "S", email_webhook_events: "S", job_run_history: "S", job_runs: "S", medication_reminders: "S", personal_reminder_deliveries: "S", personal_reminders: "S", users: "S" },
  mail: { email_deliveries: "SIU" },
  pairing: { doctor_profiles: "S", pairing_invitations: "SU", pairing_requests: "SIU", users: "S" },
  verify: { email_verification_tokens: "SI" },
};

const OLD: Record<string, string[]> = {
    auth: ["audit_logs", "doctor_applications", "email_deliveries", "email_verification_tokens", "mfa_recovery_codes", "password_reset_tokens", "user_devices", "user_mfa", "users"],
    invite: ["audit_logs", "care_circle_members", "org_invitations", "org_memberships", "organizations", "user_devices", "users"],
    session: ["user_devices", "users"],
    scheduler: ["appointments", "email_deliveries", "job_run_history", "job_runs", "medication_reminders", "medications", "notifications", "personal_reminder_deliveries", "personal_reminders", "prescriptions", "reminder_deliveries", "users"],
    webhook: ["email_deliveries", "email_webhook_events"],
    ratelimit: ["rate_limit_hits"],
  };

/** Rows a scope can see only because a policy asks a question of a table the scope DOES have (a prescription event is visible when its prescription is). Not grants of their own; listed so a new one is noticed. */
const TRANSITIVE: Record<string, string> = {
  "scheduler:prescription_events": "visible exactly when the prescription is; the scheduler may read prescriptions",
  "ops:reminder_deliveries": "visible through a reminder you may read; ops may read medication_reminders",
};

let app: Express, app_: pg.Pool;
let A: TestUser, B: TestUser, D1: TestDoctor, D2: TestDoctor, admin: TestUser, staff: TestUser;
let pairingId: string;

beforeAll(async () => {
  app = await getApp();
  app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 3 });
  A = await signupPatient(); B = await signupPatient(); D1 = await createDoctor(); D2 = await createDoctor(); admin = await createAdmin(); staff = await createStaff();
  ({ pairingId } = await connect(A, D1));
});
afterAll(async () => { await app_.end(); });

/** Runs `fn` on one connection of the restricted role as this scope, inside a transaction that is always rolled back. */
async function asNobody<T>(fn: (q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
  const c = await app_.connect();
  try { await c.query("BEGIN"); return await fn((t, p) => c.query(t, p)); } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
}
async function asScope<T>(scope: SystemScope, fn: (q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
  const c = await app_.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.assertion', $1, true)", [assertionFor({ scope })]);
    return await fn((t, p) => c.query(t, p));
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}
const denied = (e: any) => e?.code === "42501";

describe("the declared permissions of the scopes added in 0029 are exactly what the database has", () => {
  it("has one policy per table, scope and command, for exactly the declared commands", async () => {
    const { rows } = await operatorPool().query(`SELECT tablename AS t, policyname AS p, cmd, coalesce(qual, '') || coalesce(with_check, '') AS expr FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'avela\\_scope\\_%' AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%app_verified_scope()%'`);
    const got: Record<string, Record<string, string>> = {};
    for (const r of rows) {
      const scope = /app_verified_scope\(\) = '([a-z]+)'/.exec(r.expr)![1];
      const letter = { SELECT: "S", INSERT: "I", UPDATE: "U", DELETE: "D" }[r.cmd as string]!;
      ((got[scope] ??= {})[r.t] ??= "");
      got[scope][r.t] += letter;
    }
    const norm = (o: Record<string, Record<string, string>>) => Object.fromEntries(Object.entries(o).filter(([, v]) => Object.keys(v).length).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([t, c]) => [t, [...c].sort().join("")]).sort())]));
    const want = Object.fromEntries(Object.entries(NEW_SCOPES).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([t, c]) => [t, [...c].sort().join("")]))]));
    expect(norm(got)).toEqual(norm(want));
  });
});

describe("a request that began on a public or background entry scope can only be narrowed by a helper", () => {
  it("lets a helper scope be used inside an entry scope only if everything it may do the entry scope may already do", () => {
    for (const [entry, helpers] of Object.entries(ENTRY_MAY_USE)) {
      for (const helper of helpers) {
        for (const [table, cmds] of Object.entries(NEW_SCOPES[helper] ?? {})) {
          expect(OLD[entry]?.includes(table), `${helper} reaches ${table}, which ${entry} does not`).toBe(true);
          expect(cmds.length).toBeGreaterThan(0);
        }
      }
    }
    expect(Object.keys(ENTRY_MAY_USE).sort()).toEqual(["auth", "invite", "ratelimit", "scheduler", "session", "webhook"]);
  });
});

describe.skipIf(!ENFORCED)("every operation a scope was not given is refused by the database", () => {
  const granted = (scope: string, table: string): string => (NEW_SCOPES[scope] ? NEW_SCOPES[scope][table] ?? "" : OLD[scope]?.includes(table) ? "SIUD" : "");

  it("refuses select, insert, update and delete on every table outside a scope's grant (and the commands outside it on the tables inside)", async () => {
    const { rows: tabs } = await operatorPool().query(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'app_identity_keys', 'app_identity_config') ORDER BY 1`);
    const seen = (await operatorPool().query(`SELECT count(*)::int AS n FROM users`)).rows[0].n;
    expect(seen).toBeGreaterThan(5);
    let refused = 0;
    let readable = 0;
    for (const scope of SYSTEM_SCOPES.filter((s) => s !== "server")) {
      for (const { t } of tabs as { t: string }[]) {
        const g = granted(scope, t);
        // A table anybody may read by design (the public directory's availability, the pharmacy list) is not a grant to a scope.
        const open = (await asNobody((q) => q(`SELECT 1 FROM "${t}" LIMIT 1`).then((r) => r.rowCount, () => 0))) > 0;
        await asScope(scope, async (q) => {
          if (!g.includes("S") && !open) {
            try { const r = await q(`SELECT 1 FROM "${t}" LIMIT 1`); if (r.rowCount) { if (process.env.NARROW_REPORT) console.log(`TRANSITIVE ${scope} ${t}`); expect(TRANSITIVE[`${scope}:${t}`], `${scope} reads ${t}`).toBeTruthy(); } refused++; } catch (e: any) { expect(denied(e), `${scope} select ${t}: ${e.message}`).toBe(true); refused++; }
          } else readable++;
        });
        if (!g.includes("I")) {
          await asScope(scope, async (q) => {
            // The row-level check comes before the table's own constraints: a denied insert is 42501, an allowed one fails later on a missing value.
            const e: any = await q(`INSERT INTO "${t}" DEFAULT VALUES`).then(() => null, (x) => x);
            expect(e && denied(e) ? true : `${scope} insert ${t}: ${e?.code ?? "no error"} ${e?.message ?? ""}`).toBe(true);
            refused++;
          });
        }
        if (!g.includes("U")) {
          await asScope(scope, async (q) => {
            const col = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position LIMIT 1`, [t])).rows[0]?.column_name;
            if (!col) return;
            const e: any = await q(`UPDATE "${t}" SET "${col}" = "${col}"`).then((r) => (r.rowCount ? new Error(`updated ${r.rowCount}`) : null), (x) => x);
            expect(e === null || denied(e) || /append-only|cannot be|not allowed|immutable/i.test(e.message) ? true : `${scope} update ${t}: ${e.message}`).toBe(true);
            refused++;
          });
        }
        if (!g.includes("D")) {
          await asScope(scope, async (q) => {
            const e: any = await q(`DELETE FROM "${t}"`).then((r) => (r.rowCount ? new Error(`deleted ${r.rowCount}`) : null), (x) => x);
            expect(e === null || denied(e) ? true : `${scope} delete ${t}: ${e.message}`).toBe(true);
            refused++;
          });
        }
      }
    }
    expect(refused).toBeGreaterThan(2500);
    expect(readable).toBeGreaterThan(60);
  }, 300_000);

  it("hands the sensitive clinical tables to none of the scopes added in 0029 except where declared", async () => {
    const SENSITIVE = ["medications", "medication_logs", "symptom_reports", "documents", "pharmacy_orders", "follow_up_tasks", "prescriptions", "sharing_grants", "messages", "ai_messages", "assist_grants", "health_entries", "allergy_statements", "patient_consents"];
    for (const [scope, tables] of Object.entries(NEW_SCOPES)) for (const t of SENSITIVE) expect(tables[t], `${scope} was given ${t}`).toBeUndefined();
  });
});

describe.skipIf(!ENFORCED)("a scope is only what the signature says", () => {
  const dev = devIdentityKey();
  const whoIs = async (token: string) => {
    const c = await app_.connect();
    try {
      await c.query("SELECT set_config('app.assertion', $1, false)", [token]);
      return (await c.query("SELECT app_verified_scope() AS scope, app_user_id() AS u")).rows[0] as { scope: string | null; u: string | null };
    } finally { await c.query("RESET ALL").catch(() => {}); c.release(); }
  };
  it("is nobody if one scope's assertion is edited to name another, or a person's is edited to name a scope", async () => {
    const scopes = SYSTEM_SCOPES.filter((s) => s !== "server");
    for (const from of scopes) {
      const good = assertionFor({ scope: from });
      expect(await whoIs(good)).toEqual({ scope: from, u: null });
      for (const to of ["staff", "review", "server", "ops"]) {
        if (to === from) continue;
        const p = good.split("."); p[3] = to;
        expect(await whoIs(p.join(".")), `${from} -> ${to}`).toEqual({ scope: null, u: null });
      }
    }
    const person = assertionFor({ userId: A.id }).split("."); person[2] = "system"; person[3] = "staff";
    expect(await whoIs(person.join("."))).toEqual({ scope: null, u: null });
    const sys = assertionFor({ scope: "staff" }).split("."); sys[2] = "user"; sys[3] = A.id;
    expect(await whoIs(sys.join("."))).toEqual({ scope: null, u: null });
  });
  it("refuses a correctly signed assertion for a scope that does not exist, and one with the old unscoped form", async () => {
    const forge = (sub: string) => { const exp = Math.floor(Date.now() / 1000) + 60; const mac = crypto.createHmac("sha256", dev.key).update(`avela-identity-v1\n${dev.kid}\nsystem\n${sub}\n${exp}`).digest("base64url"); return ["v1", dev.kid, "system", sub, exp, mac].join("."); };
    for (const sub of ["admin", "superuser", "Staff", "staff2", "-", "root", "all"]) expect(await whoIs(forge(sub)), sub).toEqual({ scope: null, u: null });
  });
  it("gives a person none of the functions that belong to scopes", async () => {
    const c = await app_.connect();
    try {
      await c.query("SELECT set_config('app.assertion', $1, false)", [assertionFor({ userId: A.id })]);
      expect((await c.query("SELECT * FROM app_user_contacts($1::text[])", [[B.id]])).rowCount).toBe(0);
      expect((await c.query("SELECT * FROM app_user_credentials($1)", [B.email])).rowCount).toBe(0);
      expect((await c.query("SELECT * FROM app_user_private($1)", [B.id])).rowCount).toBe(0);
      expect((await c.query("SELECT app_account_id_by_email($1) AS id", [B.email])).rows[0].id).toBeNull();
    } finally { await c.query("RESET ALL").catch(() => {}); c.release(); }
  });
  it("lets only staff and invite learn whether an address has an account, and shows them an id, never a hash", async () => {
    for (const scope of SYSTEM_SCOPES) {
      const r = await asScope(scope, async (q) => (await q("SELECT app_account_id_by_email($1) AS id", [B.email])).rows[0].id as string | null);
      expect(r !== null, scope).toBe(["staff", "invite", "server"].includes(scope));
      if (r) expect(r).toBe(B.id);
    }
  });
});

describe("people calling what belongs to other roles", () => {
  const filled = (p: string, v: string[]) => (/:[A-Za-z]+/.test(p) ? v.map((x) => p.replace(/:[A-Za-z]+/g, x)) : [p]);
  it("shows a patient, a clinician who is not an administrator, and an unrelated staff account nothing under /api/admin, and no organization they do not belong to", async () => {
    const made = await request(app).post("/api/orgs").set(auth(D1.token)).send({ name: "Scope Clinic", kind: "clinic", country: "US", contactEmail: "a@example.org", contactPhone: "+1 555 010 2000" });
    expect(made.status).toBe(201);
    const orgId = made.body.id as string;
    const gets: string[] = [];
    for (const [prefix, router] of ROUTER_MOUNTS) for (const layer of (router as any).stack) if (layer.route?.methods.get && (prefix === "/api/admin" || prefix === "/api/orgs")) gets.push(prefix + (layer.route.path === "/" ? "" : layer.route.path));
    expect(gets.length).toBeGreaterThan(10);
    const bad: string[] = [];
    for (const [who, tok] of [["patient", A.token], ["other clinician", D2.token], ["unrelated staff", staff.token]] as const) {
      for (const g of gets) for (const path of filled(g, [orgId, A.id, pairingId])) {
        const res = await request(app).get(path).set(auth(tok));
        if (res.status === 200 && (g.startsWith("/api/admin") || g.startsWith("/api/orgs/:"))) bad.push(`${who} ${path}`);
      }
    }
    expect(bad).toEqual([]);
    // …and the same for what they could change.
    for (const [who, tok] of [["patient", A.token], ["other clinician", D2.token], ["unrelated staff", staff.token]] as const) {
      for (const path of [`/api/orgs/${orgId}/staff/invitations`, `/api/orgs/${orgId}/tasks`, `/api/orgs/${orgId}/notes`]) {
        const res = await request(app).post(path).set(auth(tok)).send({ email: uniqueEmail("x"), role: "coordinator" });
        expect(res.status, `${who} POST ${path}`).toBeGreaterThanOrEqual(400);
      }
      expect((await request(app).post("/api/admin/doctor-applications/none/approve").set(auth(tok)).send(APPROVAL)).status, who).toBeGreaterThanOrEqual(401);
    }
  });
});

/** A clinician made the way a real one is: register, second factor, application, an administrator's approval. */
async function approvedClinician() {
  const email = uniqueEmail("flowdoc");
  const reg = await request(app).post("/api/doctors/register").send({ name: "Flow Doctor", email, password: PASSWORD });
  const session = await completeSecondFactor(reg.body, email);
  const COMPLETE = { displayName: "Dr. Flow", professionalRole: "physician", specialty: "Cardiology", state: "TX", licenseNumber: `TX-${Date.now()}`, licensingBody: "Texas Medical Board", languages: ["en"], modalities: ["phone", "messaging"], phone: "+1 555 000 4444", qualifications: "MD", yearsExperience: 5, clinic: "Clinic", bio: "Cardiology." };
  await request(app).put("/api/doctors/me/application").set(auth(session.token)).send(COMPLETE);
  const sub = await request(app).post("/api/doctors/me/application/submit").set(auth(session.token));
  const approve = await request(app).post(`/api/admin/doctor-applications/${sub.body.id}/approve`).set(auth(admin.token)).send(APPROVAL);
  expect(approve.status).toBe(200);
  const profile = (await operatorPool().query("SELECT id FROM doctor_profiles WHERE user_id = $1", [session.user.id])).rows[0];
  return { id: session.user.id as string, token: session.token as string, applicationId: sub.body.id as string, profileId: profile.id as string } as TestDoctor & { applicationId: string };
}

describe("concurrent changes to the accounts involved", () => {
  it("never answers a suspended clinician once the suspension has returned, however many requests were in flight", async () => {
    const doc = await approvedClinician();
    const patient = await signupPatient();
    const { pairingId: pid } = await connect(patient, doc);
    const statuses: { at: "before" | "after"; s: number }[] = [];
    let done = false;
    const reader = (async () => {
      while (!done) { const r = await request(app).get(`/api/pairings/${pid}/messages`).set(auth(doc.token)); statuses.push({ at: "before", s: r.status }); }
    })();
    const sus = await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/suspend`).set(auth(admin.token)).send({ reason: "concurrency test" });
    done = true;
    await reader;
    expect(sus.status).toBeLessThan(300);
    const after = await Promise.all(Array.from({ length: 12 }, () => request(app).get(`/api/pairings/${pid}/messages`).set(auth(doc.token))));
    expect(after.map((r) => r.status).filter((s) => s === 200)).toEqual([]);
  });

  it("stops a revoked staff member at once, and lets two simultaneous revocations of one member finish once", async () => {
    const owner = await createDoctor();
    const made = await request(app).post("/api/orgs").set(auth(owner.token)).send({ name: "Race Clinic", kind: "clinic", country: "US", contactEmail: "r@example.org", contactPhone: "+1 555 010 2000" });
    const orgId = made.body.id as string;
    const email = uniqueEmail("race-staff");
    const inv = await request(app).post(`/api/orgs/${orgId}/staff/invitations`).set(auth(owner.token)).send({ email, role: "coordinator" });
    const token = String(inv.body.link).split("#")[1];
    const acc = await request(app).post("/api/orgs/invitations/accept-new").send({ token, name: "Race Staff", password: PASSWORD });
    expect(acc.status).toBeLessThan(300);
    const login = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    const session = login.body.token ? login.body : await (await import("./helpers")).completeSecondFactor(login.body, email);
    const members = (await request(app).get(`/api/orgs/${orgId}/staff`).set(auth(owner.token))).body.members as any[];
    const member = members.find((m) => m.email === email || m.name === "Race Staff");
    expect(member).toBeTruthy();
    expect((await request(app).get(`/api/orgs/${orgId}/patients`).set(auth(session.token))).status).toBe(200);
    const [r1, r2] = await Promise.all([
      request(app).delete(`/api/orgs/${orgId}/staff/${member.id}`).set(auth(owner.token)),
      request(app).delete(`/api/orgs/${orgId}/staff/${member.id}`).set(auth(owner.token)),
    ]);
    expect([r1.status, r2.status].filter((s) => s < 300)).toHaveLength(1);
    expect((await operatorPool().query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'org.member_revoked' AND target_id = $1", [member.id])).rows[0].n).toBe(1);
    const after = await Promise.all(Array.from({ length: 8 }, () => request(app).get(`/api/orgs/${orgId}/patients`).set(auth(session.token))));
    expect(after.map((r) => r.status).filter((s) => s === 200)).toEqual([]);
  });

  it("lets a password-reset link be used by exactly one of many simultaneous requests, and signs the old password out", async () => {
    const user = await signupPatient();
    resetLinks.length = 0;
    await request(app).post("/api/auth/forgot-password").send({ email: user.email });
    await vi.waitFor(() => expect(resetLinks.length).toBe(1));
    const token = new URL(resetLinks[0].link).searchParams.get("token")!;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => request(app).post("/api/auth/reset-password").send({ token, password: `Concurrent-Passphrase-${i}-xyz` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set(auth(user.token))).status).toBe(401);
  });

  it("lets a care-circle invitation be redeemed once, however many simultaneous attempts carry the link", async () => {
    const patient = await signupPatient();
    const cg = uniqueEmail("race-cg");
    const sent: string[] = [];
    const made = await request(app).post("/api/care-circle").set(auth(patient.token)).send({ name: "Race Caregiver", inviteEmail: cg, relationshipLabel: "friend" });
    expect(made.status).toBe(201);
    const row = (await operatorPool().query("SELECT id FROM care_circle_members WHERE invite_email = $1", [cg.toLowerCase()])).rows[0];
    // The link is only e-mailed: set a token whose hash we know, the way the invitation flow stores it.
    const { hashToken } = await import("../server/services/tokenService");
    expect(sent).toEqual([]);
    expect(row.id).toBeTruthy();
    if (!hashToken) return;
    const token = crypto.randomBytes(32).toString("base64url");
    await operatorPool().query("UPDATE care_circle_members SET token_hash = $2 WHERE id = $1", [row.id, hashToken(token)]);
    const results = await Promise.all(Array.from({ length: 6 }, () => request(app).post(`/api/care-circle/invitations/accept/${token}`).send({ password: "CorrectHorse-9-battery" })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    expect((await operatorPool().query("SELECT status FROM care_circle_members WHERE id = $1", [row.id])).rows[0].status).toBe("active");
  });

  it("does not let one account's reset link, or confirmation link, act on another account", async () => {
    const u1 = await signupPatient(); const u2 = await signupPatient();
    resetLinks.length = 0;
    await request(app).post("/api/auth/forgot-password").send({ email: u1.email });
    await vi.waitFor(() => expect(resetLinks.length).toBe(1));
    const token = new URL(resetLinks[0].link).searchParams.get("token")!;
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect((await request(app).post("/api/auth/reset-password").send({ token: tampered, password: "Tampered-Passphrase-77" })).status).toBe(400);
    expect((await request(app).post("/api/auth/reset-password").send({ token, password: "Right-Passphrase-77-x", email: u2.email, userId: u2.id })).status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ email: u2.email, password: PASSWORD })).status).toBe(200); // u2 untouched
    expect((await request(app).post("/api/auth/login").send({ email: u1.email, password: "Right-Passphrase-77-x" })).status).toBe(200);
  });
});
