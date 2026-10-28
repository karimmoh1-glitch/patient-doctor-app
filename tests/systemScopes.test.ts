import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "crypto";
import pg from "pg";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, connect, issuePrescription, auth, uniqueEmail, operatorPool, PASSWORD, type TestUser } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { assertionFor } from "./identityHelpers";
import * as identity from "../server/identity";
import { SYSTEM_SCOPES, devIdentityKey, type SystemScope } from "../server/identity";
import { pool } from "../server/db";
import { runAsSystem, runAsUser } from "../server/dbContext";
import { ROUTER_MOUNTS, RAW_BODY_MOUNTS } from "../server/routes";

// "System" used to be one identity that every policy accepted: a flaw in any public entry point (sign-in, password reset, invitations, the webhook, the
// scheduler) would have run with the power to read every patient's records. Migration 0028 gives each entry point a SCOPE and lets each scope touch only
// the tables its job needs. This attacks that: the declared permissions, what each scope can really see, what the application really asks for on each
// route, and that a helper called from a narrow scope cannot widen it.

const provider = vi.hoisted(() => ({ accepted: [] as unknown[] }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (m: unknown) => { provider.accepted.push(m); return { data: { id: `msg_${Math.random().toString(36).slice(2)}` }, error: null }; } };
  },
}));

const ENFORCED = process.env.TEST_AS_APP_ROLE === "1";
type Scope = Exclude<SystemScope, "server">;

/** The intended permissions, written down a second time here on purpose: the migration is checked against THIS, not against itself. */
const ALLOWED: Record<Scope, string[]> = {
  auth: ["audit_logs", "doctor_applications", "email_deliveries", "email_verification_tokens", "password_reset_tokens", "user_devices", "users"], // second-factor tables left in 0030: only the mfa scope, with a verified actor
  invite: ["audit_logs", "care_circle_members", "org_invitations", "org_memberships", "organizations", "user_devices", "users"],
  session: ["user_devices", "users"],
  scheduler: ["appointments", "email_deliveries", "job_run_history", "job_runs", "medication_reminders", "medications", "notifications", "personal_reminder_deliveries", "personal_reminders", "prescriptions", "reminder_deliveries", "users"],
  webhook: ["email_deliveries", "email_webhook_events"],
  ratelimit: ["rate_limit_hits"],
};

let app_: pg.Pool;
let app: Express;
beforeAll(async () => {
  app = await getApp();
  app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 4 });
});
afterAll(async () => {
  await app_.end();
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
  vi.restoreAllMocks();
});
const scoped = async <T>(scope: SystemScope, fn: (q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> => {
  const c = await app_.connect();
  try {
    await c.query("SELECT set_config('app.assertion', $1, false)", [assertionFor({ scope })]);
    return await fn((t, p) => c.query(t, p));
  } finally {
    await c.query("SELECT set_config('app.assertion', '', false)").catch(() => {});
    c.release();
  }
};

describe("what each scope is allowed, as the database stands", () => {
  it("opens exactly the declared tables to each narrow scope, and no other table to any of them", async () => {
    const { rows } = await operatorPool().query(`SELECT tablename AS t, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expr FROM pg_policies WHERE schemaname = 'public'`);
    const granted: Record<string, Set<string>> = {};
    for (const r of rows) {
      for (const m of String(r.expr).matchAll(/app_system_in\(([^)]*)\)/g)) {
        for (const s of m[1].matchAll(/'([a-z]+)'/g)) (granted[s[1]] ??= new Set()).add(r.t);
      }
    }
    for (const scope of Object.keys(ALLOWED) as Scope[]) expect([...(granted[scope] ?? [])].sort(), scope).toEqual([...ALLOWED[scope]].sort());
    expect(Object.keys(granted).sort()).toEqual(Object.keys(ALLOWED).sort()); // no scope the test does not know about
  });

  it("makes `app_is_system()` mean the unrestricted server scope only, and refuses unknown or forged scopes", async () => {
    const who = (token: string) => app_.connect().then(async (c) => {
      try {
        await c.query("SELECT set_config('app.assertion', $1, false)", [token]);
        const r = await c.query("SELECT app_is_system() AS s, app_verified_scope() AS scope");
        return r.rows[0] as { s: boolean; scope: string | null };
      } finally {
        await c.query("RESET ALL").catch(() => {});
        c.release();
      }
    });
    expect(await who(assertionFor({ scope: "server" }))).toEqual({ s: true, scope: "server" });
    expect(await who(assertionFor({ system: true }))).toEqual({ s: true, scope: "server" });
    for (const scope of Object.keys(ALLOWED)) expect(await who(assertionFor({ scope: scope as SystemScope })), scope).toEqual({ s: false, scope });
    // Properly signed, but for a scope that does not exist, and the old unscoped "-" form: both are nobody.
    const dev = devIdentityKey();
    const forge = (sub: string) => {
      const exp = Math.floor(Date.now() / 1000) + 60;
      const mac = crypto.createHmac("sha256", dev.key).update(`avela-identity-v1\n${dev.kid}\nsystem\n${sub}\n${exp}`).digest("base64url");
      return ["v1", dev.kid, "system", sub, exp, mac].join(".");
    };
    for (const sub of ["admin", "superuser", "-", "Server", "auth;", "root"]) expect(await who(forge(sub)), sub).toEqual({ s: false, scope: null });
    // A signed auth assertion cannot be turned into server by editing the scope.
    const auth_ = assertionFor({ scope: "auth" }).split(".");
    auth_[3] = "server";
    expect(await who(auth_.join("."))).toEqual({ s: false, scope: null });
    expect(() => identity.signAssertion({ system: true, scope: "everything" as any }, dev)).toThrow();
  });

  it("lets only the scopes that need them call the functions that release private columns", async () => {
    const callable = async (scope: SystemScope, sql: string, params: unknown[]) => (await scoped(scope, (q) => q(sql, params))).rowCount! > 0;
    const person = (await operatorPool().query(`INSERT INTO users (name, email, password_hash, role) VALUES ('Scope Person', $1, 'x', 'patient') RETURNING id, email`, [uniqueEmail("sp")])).rows[0];
    const matrix: [string, string, unknown[], SystemScope[]][] = [
      ["credentials by e-mail", "SELECT * FROM app_user_credentials($1)", [person.email], ["auth", "invite", "server"]],
      ["credentials by id", "SELECT * FROM app_user_credentials_by_id($1)", [person.id], ["auth", "server"]],
      ["private profile", "SELECT * FROM app_user_private($1)", [person.id], ["auth", "invite", "scheduler", "contact", "server"]],
      ["contacts", "SELECT * FROM app_user_contacts($1::text[])", [[person.id]], ["scheduler", "invite", "contact", "staff", "server"]],
    ];
    for (const [what, sql, params, allowed] of matrix) {
      for (const scope of SYSTEM_SCOPES) expect(await callable(scope, sql, params), `${what} as ${scope}`).toBe(allowed.includes(scope));
    }
  });
});

describe("what a narrow scope can really reach (rows that exist)", () => {
  const SENSITIVE = ["medications", "medication_logs", "symptom_reports", "documents", "pharmacy_orders", "follow_up_tasks", "prescriptions", "sharing_grants", "pairing_requests", "messages", "care_circle_members", "notifications", "appointments", "health_entries", "ai_messages", "assist_grants"];
  let A: TestUser;
  beforeAll(async () => {
    A = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(A, doctor);
    const rx = await issuePrescription(doctor, pairingId);
    await request(app).post(`/api/prescriptions/${rx.id}/track`).set(auth(A.token));
    const o = operatorPool();
    await o.query(`INSERT INTO appointments (pairing_request_id, patient_user_id, doctor_profile_id, type, reason, scheduled_at, status) VALUES ($1, $2, $3, 'Phone Call', 'r', now() + interval '2 days', 'confirmed')`, [pairingId, A.id, doctor.profileId]);
    await o.query(`INSERT INTO messages (pairing_request_id, sender_user_id, body) VALUES ($1, $2, 'private words')`, [pairingId, A.id]);
    await o.query(`INSERT INTO follow_up_tasks (patient_user_id, doctor_profile_id, title) VALUES ($1, $2, 'task')`, [A.id, doctor.profileId]);
    await o.query(`INSERT INTO symptom_reports (patient_user_id, state, symptom_text, input_method) VALUES ($1, 'CA', 'private symptoms', 'typed')`, [A.id]);
    await o.query(`INSERT INTO documents (patient_user_id, uploaded_by_user_id, title) VALUES ($1, $1, 'private paper')`, [A.id]);
    await o.query(`INSERT INTO ai_messages (user_id, role, content) VALUES ($1, 'user', 'private chat')`, [A.id]).catch(() => {});
    await o.query(`INSERT INTO care_circle_members (patient_user_id, name, invite_email, relationship_label) VALUES ($1, 'cg', $2, 'friend')`, [A.id, uniqueEmail("cgx")]);
    await o.query(`INSERT INTO sharing_grants (patient_user_id, shared_with_doctor_profile_id) VALUES ($1, $2)`, [A.id, doctor.profileId]);
    await o.query(`INSERT INTO notifications (user_id, kind, params, link) VALUES ($1, 'x', '{}', '/')`, [A.id]);
  });

  it("shows the unrestricted server scope everything, so the checks below are about the scope and not about empty tables", async () => {
    let total = 0;
    for (const t of SENSITIVE) total += (await scoped("server", (q) => q(`SELECT 1 FROM ${t} LIMIT 1`))).rowCount!;
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it("shows the sign-in scopes (auth, invite, session) none of a patient's clinical, messaging or visit records, and lets them write none", async () => {
    for (const scope of ["auth", "invite", "session", "webhook", "ratelimit"] as Scope[]) {
      for (const t of SENSITIVE.filter((t) => !ALLOWED[scope].includes(t))) {
        expect((await scoped(scope, (q) => q(`SELECT 1 FROM ${t}`))).rowCount, `${scope} reading ${t}`).toBe(0);
      }
      await expect(scoped(scope, (q) => q(`INSERT INTO symptom_reports (patient_user_id, state, symptom_text, input_method) VALUES ($1, 'CA', 'planted', 'typed')`, [A.id])), `${scope} writing`).rejects.toThrow(/row-level security/);
      expect((await scoped(scope, (q) => q(`DELETE FROM messages`))).rowCount, `${scope} deleting messages`).toBe(0);
      expect((await scoped(scope, (q) => q(`UPDATE medications SET name = 'hacked'`))).rowCount, `${scope} editing medicines`).toBe(0);
    }
  });

  it("lets the scheduler see the reminder-related records it needs but not messages, documents, symptom reports or sharing decisions", async () => {
    for (const t of ["messages", "documents", "symptom_reports", "sharing_grants", "care_circle_members", "follow_up_tasks", "pairing_requests", "ai_messages", "assist_grants"]) {
      expect((await scoped("scheduler", (q) => q(`SELECT 1 FROM ${t}`))).rowCount, `scheduler reading ${t}`).toBe(0);
    }
    for (const t of ["medications", "appointments", "notifications", "prescriptions"]) expect((await scoped("scheduler", (q) => q(`SELECT 1 FROM ${t} LIMIT 1`))).rowCount, `scheduler reading ${t}`).toBe(1);
  });

  it("keeps the webhook to its two tables and the rate limiter to its one", async () => {
    for (const t of ["users", "user_devices", "audit_logs", "email_deliveries"]) {
      if (t !== "email_deliveries") expect((await scoped("webhook", (q) => q(`SELECT 1 FROM ${t}`).catch(() => ({ rowCount: 0 })))).rowCount, `webhook reading ${t}`).toBe(0);
    }
    for (const t of ["email_deliveries", "email_webhook_events", "job_runs", "user_devices"]) expect((await scoped("ratelimit", (q) => q(`SELECT 1 FROM ${t}`))).rowCount, `ratelimit reading ${t}`).toBe(0);
  });

  it.skipIf(!ENFORCED)("gives the application the same answers when the narrow scope is asked through its own pool (what an injected statement in a public route would get)", async () => {
    const read = (scope: SystemScope, table: string) => runAsSystem(() => pool.query(`SELECT 1 FROM ${table}`), scope).then((r) => r.rowCount);
    for (const t of ["medications", "messages", "prescriptions", "appointments", "documents", "symptom_reports"]) expect(await read("auth", t), `auth ${t}`).toBe(0);
    expect(await read("server", "medications")).toBeGreaterThan(0);
    // Nesting inside a narrow scope keeps it; a bare helper cannot widen it.
    const inner = await runAsSystem(() => runAsSystem(() => pool.query(`SELECT 1 FROM medications`)), "auth");
    expect(inner.rowCount).toBe(0);
    const whoami = await runAsSystem(() => runAsSystem(() => pool.query(`SELECT app_verified_scope() AS s`)), "invite");
    expect(whoami.rows[0].s).toBe("invite");
    // Code in a narrow scope cannot ask for the server scope, directly or from a helper.
    expect(() => runAsSystem(() => runAsSystem(() => pool.query("SELECT 1"), "server"), "auth")).toThrow(/cannot widen/);
    expect(() => runAsSystem(() => runAsSystem(() => pool.query("SELECT 1"), "server"), "scheduler")).toThrow(/cannot widen/);
    // A person's request that asks for the server scope explicitly still gets it (that is the reviewed code path), and a user identity stays a user.
    expect((await runAsSystem(() => pool.query(`SELECT app_verified_scope() AS s`))).rows[0].s).toBe("server");
    expect((await runAsUser(A.id, () => pool.query(`SELECT app_verified_scope() AS s`))).rows[0].s).toBeNull();
  });
});

describe("what the application asks for on each route", () => {
  it("names a narrow scope on every route that works before sign-in, and none names the unrestricted one", () => {
    const found: { route: string; scope: string }[] = [];
    for (const [prefix, router] of [...ROUTER_MOUNTS, ...RAW_BODY_MOUNTS]) {
      for (const layer of (router as any).stack) {
        if (!layer.route) continue;
        for (const l of layer.route.stack) if (l.handle?.systemScope) found.push({ route: `${Object.keys(layer.route.methods)[0].toUpperCase()} ${prefix}${layer.route.path}`, scope: l.handle.systemScope });
      }
    }
    expect(found.length).toBeGreaterThanOrEqual(15);
    expect(found.filter((f) => f.scope === "server" || !(SYSTEM_SCOPES as readonly string[]).includes(f.scope))).toEqual([]);
    expect(Object.fromEntries(found.map((f) => [f.route, f.scope]))).toMatchObject({
      "POST /api/auth/login": "auth", "POST /api/auth/signup": "auth", "POST /api/auth/forgot-password": "auth", "POST /api/auth/reset-password": "auth",
      "POST /api/doctors/register": "auth", "POST /api/care-circle/invitations/accept": "invite", "POST /api/orgs/invitations/accept-new": "invite",
      "POST /api/webhooks/resend": "webhook", "GET /api/cron/reminders": "scheduler", "POST /api/cron/reminders": "scheduler",
    });
  });

  it.skipIf(!ENFORCED)("never mints the unrestricted system identity while serving a public request", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const minted: string[] = [];
    const real = identity.signAssertion;
    vi.spyOn(identity, "signAssertion").mockImplementation((id, k, ...rest) => {
      if (id?.system) minted.push(id.scope ?? "server");
      return real(id, k, ...rest);
    });
    const email = uniqueEmail("flow");
    const signup = await request(app).post("/api/auth/signup").send({ name: "Flow Person", email, password: PASSWORD, state: "CA" });
    expect(signup.status).toBe(201);
    expect((await request(app).post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ email, password: "wrong-password-1" })).status).toBe(401);
    expect((await request(app).post("/api/auth/forgot-password").send({ email })).status).toBe(200);
    expect((await request(app).post("/api/auth/forgot-password").send({ email: uniqueEmail("nobody") })).status).toBe(200);
    expect((await request(app).post("/api/auth/reset-password").send({ token: "x".repeat(40), password: "Another-Passphrase-77" })).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post("/api/auth/email/verify").send({ token: "y".repeat(40) })).status).toBeGreaterThanOrEqual(400);
    const docEmail = uniqueEmail("regdoc");
    expect((await request(app).post("/api/doctors/register").send({ name: "Reg Doctor", email: docEmail, password: PASSWORD })).status).toBe(201);
    expect((await request(app).get("/api/auth/me").set(auth(signup.body.token))).status).toBe(200); // the session lookup
    expect((await request(app).post("/api/webhooks/resend").set("content-type", "application/json").send("{}")).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).get("/api/cron/reminders").set({ Authorization: "Bearer wrong" })).status).toBeGreaterThanOrEqual(400);
    expect(minted.length).toBeGreaterThan(0);
    expect(minted.filter((s) => s === "server"), `scopes minted: ${[...new Set(minted)].join(", ")}`).toEqual([]);
    expect(new Set(minted)).toContain("auth");
    expect(new Set(minted)).toContain("session");
  });
});
