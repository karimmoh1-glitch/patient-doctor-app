import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import path from "path";
import { execFile } from "child_process";
import pg from "pg";
import request from "supertest";
import { getApp, signupPatient, createDoctor, connect, auth, operatorPool, type TestUser } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { assertionFor } from "./identityHelpers";
import { ASSERTION_TTL_SECONDS, devIdentityKey, hmacPads, signAssertion } from "../server/identity";
import { assertionSql, pool, wrapClient } from "../server/db";
import { runAsNobody, runAsSystem, runAsUser } from "../server/dbContext";
import { setIdentityEnforcement } from "../script/lib/identityKeys";

// "Who is asking" is something the database VERIFIES (migration 0025), not something the application writes. These attack it as an
// attacker with arbitrary SQL under the real restricted role would: forging, tampering, replaying, borrowing a pooled connection,
// reading the key, calling the privileged functions. They connect as avela_app directly, whatever the application under test uses.

// The tests that go through the application's own pool need it to be the restricted pool (npm run test:rls); the others connect directly.
const ENFORCED = process.env.TEST_AS_APP_ROLE === "1";
let app_: pg.Pool;
const dev = devIdentityKey();
type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

/** Runs `fn` on one connection of the restricted role with these session settings (as an attacker could set them). */
async function withSettings<T>(settings: Record<string, string>, fn: (q: Q) => Promise<T>): Promise<T> {
  const c = await app_.connect();
  try {
    for (const [k, v] of Object.entries(settings)) await c.query("SELECT set_config($1, $2, false)", [k, v]);
    return await fn((t, p) => c.query(t, p));
  } finally {
    await c.query("RESET ALL").catch(() => {});
    c.release();
  }
}
/** What the database believes, given only these settings. */
const whoIs = (settings: Record<string, string>) =>
  withSettings(settings, async (q) => {
    const r = await q("SELECT app_user_id() AS u, app_is_system() AS s");
    return { user: r.rows[0].u as string | null, system: r.rows[0].s as boolean };
  });
const NOBODY = { user: null, system: false };
const A = "user-aaaa-1111";

beforeAll(async () => {
  await getApp();
  app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 4 });
});
afterAll(async () => {
  await app_.end();
});

describe("the signing scheme", () => {
  it("is plain HMAC-SHA256: the database's pad construction agrees with Node's implementation", () => {
    const { ipad, opad } = hmacPads(dev.key);
    const msg = Buffer.from("avela-identity-v1\ndev\nuser\nx\n1");
    const inner = crypto.createHash("sha256").update(ipad).update(msg).digest();
    const viaPads = crypto.createHash("sha256").update(opad).update(inner).digest("base64url");
    expect(viaPads).toBe(crypto.createHmac("sha256", dev.key).update(msg).digest("base64url"));
  });

  it("lives for about a minute, and refuses ids it cannot carry safely", () => {
    expect(ASSERTION_TTL_SECONDS).toBeLessThanOrEqual(60);
    for (const bad of ["a'b", "a b", "a.b", "a\nb", "x".repeat(65), "a;drop table users"]) expect(() => signAssertion({ userId: bad }, dev), bad).toThrow();
    expect(signAssertion(undefined, dev)).toBeNull();
    expect(() => assertionSql("abc'; DROP TABLE users; --")).toThrow(/malformed/);
    expect(assertionSql(null)).toContain("''");
  });
});

describe("what the database believes", () => {
  it("accepts a genuine assertion, for a person or for the server itself, and nothing more than what it says", async () => {
    expect(await whoIs({ "app.assertion": assertionFor({ userId: A }) })).toEqual({ user: A, system: false });
    expect(await whoIs({ "app.assertion": assertionFor({ system: true }) })).toEqual({ user: null, system: true });
    expect(await whoIs({})).toEqual(NOBODY);
  });

  it("ignores the plain settings the application used to write, whoever sets them", async () => {
    expect(await whoIs({ "app.user_id": A })).toEqual(NOBODY);
    expect(await whoIs({ "app.system": "on" })).toEqual(NOBODY);
    expect(await whoIs({ "app.user_id": A, "app.system": "on" })).toEqual(NOBODY);
    // …and a plain setting cannot ride along with someone else's assertion.
    expect(await whoIs({ "app.assertion": assertionFor({ userId: A }), "app.user_id": "someone-else", "app.system": "on" })).toEqual({ user: A, system: false });
  });

  it("refuses every tampered, malformed, expired, premature, wrongly keyed or retired assertion", async () => {
    const good = assertionFor({ userId: A });
    const [v, kid, mode, sub, exp, mac] = good.split(".");
    const flip = (m: string) => (m[0] === "A" ? "B" : "A") + m.slice(1);
    const forged: Record<string, string> = {
      "another person": [v, kid, mode, "user-bbbb-2222", exp, mac].join("."),
      "system instead of user": [v, kid, "system", "-", exp, mac].join("."),
      "user instead of system": [v, kid, "user", "-", exp, assertionFor({ system: true }).split(".")[5]].join("."),
      "later expiry": [v, kid, mode, sub, String(Number(exp) + 30), mac].join("."),
      "wrong mac": [v, kid, mode, sub, exp, flip(mac)].join("."),
      "truncated mac": [v, kid, mode, sub, exp, mac.slice(0, -1)].join("."),
      "empty mac": [v, kid, mode, sub, exp, ""].join("."),
      "unknown key id": [v, "nope", mode, sub, exp, mac].join("."),
      "other version": ["v2", kid, mode, sub, exp, mac].join("."),
      "extra segment": `${good}.x`,
      "missing segment": [v, kid, mode, sub, exp].join("."),
      "padded": ` ${good}`,
      "newline": `${good}\n`,
      "sql-ish": `${good}'; --`,
      "empty": "",
      "garbage": "not an assertion",
      "huge": "v1." + "A".repeat(100_000),
      "signed by another key": signAssertion({ userId: A }, { kid: dev.kid, key: crypto.randomBytes(32) })!,
      "expired a minute ago": signAssertion({ userId: A }, dev, Date.now() - 120_000, 60)!,
      "valid for an hour": signAssertion({ userId: A }, dev, Date.now(), 3600)!,
      "system, expired": signAssertion({ system: true }, dev, Date.now() - 120_000, 60)!,
    };
    for (const [what, token] of Object.entries(forged)) expect(await whoIs({ "app.assertion": token }), what).toEqual(NOBODY);
    expect(await whoIs({ "app.assertion": good })).toEqual({ user: A, system: false }); // the original still works
  });

  it("stops honouring a retired key at once, and a key that was never registered", async () => {
    const owner = operatorPool();
    const token = assertionFor({ userId: A });
    await owner.query("UPDATE app_identity_keys SET retired_at = now() WHERE kid = 'dev'");
    try {
      expect(await whoIs({ "app.assertion": token })).toEqual(NOBODY);
    } finally {
      await owner.query("UPDATE app_identity_keys SET retired_at = NULL WHERE kid = 'dev'");
    }
    expect(await whoIs({ "app.assertion": token })).toEqual({ user: A, system: false });
    expect(await whoIs({ "app.assertion": signAssertion({ userId: A }, { kid: "other", key: crypto.randomBytes(32) })! })).toEqual(NOBODY);
  });

  it("honours plain settings only in the roll-out state, never next to a present-but-invalid assertion, and never again once enforcement is on", async () => {
    const owner = operatorPool();
    await setIdentityEnforcement(owner, false);
    try {
      expect(await whoIs({ "app.user_id": A })).toEqual({ user: A, system: false }); // old releases keep working while the roll-out is under way
      expect(await whoIs({ "app.system": "on" })).toEqual({ user: null, system: true });
      expect(await whoIs({ "app.assertion": assertionFor({ userId: A }) })).toEqual({ user: A, system: false }); // new releases work in both states
      // a bad assertion never falls back to the plain settings beside it
      expect(await whoIs({ "app.assertion": "v1.dev.user.x.1.AAAA", "app.user_id": A, "app.system": "on" })).toEqual(NOBODY);
    } finally {
      await setIdentityEnforcement(owner, true);
    }
    expect(await whoIs({ "app.user_id": A, "app.system": "on" })).toEqual(NOBODY);
  });
});

describe("the key cannot be read, written or minted from SQL", () => {
  it("is unreadable and unwritable by the application role, as are the switch and its limits", async () => {
    for (const sql of [
      "SELECT * FROM app_identity_keys", "SELECT kid FROM app_identity_keys", "SELECT * FROM app_identity_config",
      "INSERT INTO app_identity_keys (kid, ipad, opad) VALUES ('evil', '\\x00', '\\x00')",
      "UPDATE app_identity_config SET enforce = false", "UPDATE app_identity_keys SET retired_at = now()", "DELETE FROM app_identity_keys",
      "TRUNCATE app_identity_keys", "ALTER TABLE app_identity_keys DISABLE ROW LEVEL SECURITY",
    ]) {
      await expect(withSettings({ "app.assertion": assertionFor({ system: true }) }, (q) => q(sql)), sql).rejects.toThrow(/permission denied|must be owner/);
    }
  });

  it("is not in any function's source, and the verifier itself cannot be called or replaced", async () => {
    const ipad = hmacPads(dev.key).ipad.toString("hex");
    const { rows } = await operatorPool().query("SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace");
    for (const r of rows) expect(String(r.prosrc).toLowerCase(), r.proname).not.toContain(ipad);
    await expect(withSettings({}, (q) => q("SELECT avela_identity_check()"))).rejects.toThrow(/permission denied/);
    await expect(withSettings({}, (q) => q("CREATE OR REPLACE FUNCTION app_user_id() RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$"))).rejects.toThrow(/permission denied|must be owner/);
    await expect(withSettings({}, (q) => q("CREATE FUNCTION public.sha256(bytea) RETURNS bytea LANGUAGE sql AS $$ SELECT $1 $$"))).rejects.toThrow(/permission denied/);
    await expect(withSettings({}, (q) => q("CREATE SCHEMA evil"))).rejects.toThrow(/permission denied/);
  });

  it("offers no function that signs, mints or reveals anything the application role could use to become somebody", async () => {
    const { rows } = await operatorPool().query(`
      SELECT p.proname, pg_get_function_result(p.oid) AS result FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('avela_app', p.oid, 'EXECUTE') AND p.prokind = 'f' ORDER BY 1`);
    const names = rows.map((r) => r.proname as string);
    expect(names.filter((n) => !n.startsWith("app_")), "only policy helpers").toEqual([]);
    expect(names.filter((n) => /sign|mint|token|assert|key|hmac/i.test(n) && !/^app_verified_(user|system|scope)$/.test(n))).toEqual([]);
    // The two verifiers only ever answer who the settings in front of them say, in the form the policies need.
    expect(rows.filter((r) => /^app_verified_/.test(r.proname)).map((r) => r.result).sort()).toEqual(["boolean", "text", "text"]);
    // A person cannot use them to learn another's identity: they report the caller's own verified identity or nothing.
    expect(await whoIs({ "app.assertion": assertionFor({ userId: A }) })).toEqual({ user: A, system: false });
  });
});

describe("a pooled connection never carries an identity from one use to the next", () => {
  const idOf = (fn: () => Promise<pg.QueryResult>) => fn().then((r) => (r.rows[0].id as string | null) ?? null);
  const whoAmI = () => pool.query("SELECT app_user_id() AS id");

  it.skipIf(!ENFORCED)("applies an identity to one transaction only, however many statements follow on the same connection", async () => {
    for (let i = 0; i < 20; i++) {
      expect(await runAsUser(`user-${i}`, () => idOf(whoAmI))).toBe(`user-${i}`);
      expect(await runAsNobody(() => idOf(whoAmI))).toBeNull();
      expect(await runAsSystem(() => pool.query("SELECT app_is_system() AS s")).then((r) => r.rows[0].s)).toBe(true);
      expect(await runAsNobody(() => pool.query("SELECT app_is_system() AS s")).then((r) => r.rows[0].s)).toBe(false);
    }
  });

  it("leaves nothing on the connection once a statement, a transaction, a failed statement or a rollback is over", async () => {
    // Looks at the physical connection with the driver's own query function, bypassing the wrapper, as the next client of a shared connection would.
    const raw = new pg.Client({ connectionString: appRoleUrl(process.env.DATABASE_URL!) });
    await raw.connect();
    const client = wrapClient(raw as any, dev) as unknown as pg.Client;
    const residue = async () => ((await (pg.Client.prototype.query as any).call(raw, "SELECT current_setting('app.assertion', true) AS a")).rows[0].a ?? "") as string;
    try {
      expect(await residue()).toBe("");
      await runAsUser("someone", () => client.query("SELECT app_user_id()"));
      expect(await residue(), "after a single statement").toBe("");
      await runAsSystem(async () => { await client.query("BEGIN"); await client.query("SELECT 1"); await client.query("COMMIT"); });
      expect(await residue(), "after a committed transaction").toBe("");
      await runAsUser("someone", async () => { await client.query("BEGIN"); await client.query("SELECT 1"); await client.query("ROLLBACK"); });
      expect(await residue(), "after a rolled-back transaction").toBe("");
      await runAsUser("someone", () => client.query("SELECT * FROM no_such_table")).catch(() => {});
      expect(await residue(), "after a failed statement").toBe("");
    } finally {
      await raw.end();
    }
  });

  it.skipIf(!ENFORCED)("keeps sixty concurrent requests for sixty different people apart on a small pool, as a transaction-mode pooler would share connections", async () => {
    const people = Array.from({ length: 60 }, (_, i) => `person-${i}`);
    const seen = await Promise.all(
      people.map((p) => runAsUser(p, async () => pool.query("SELECT app_user_id() AS id, pg_sleep(0.005)").then((r) => r.rows[0].id as string))),
    );
    expect(seen).toEqual(people);
  });

  it.skipIf(!ENFORCED)("does not let a setting an attacker leaves behind decide who a later request is", async () => {
    // Inside a request for person X, SQL the application never wrote sets a session-wide assertion for the server itself.
    const stolen = assertionFor({ system: true });
    await runAsUser("victim-1", () => pool.query("SELECT set_config('app.assertion', $1, false)", [stolen]));
    // Later requests on whatever connection that was: nobody stays nobody, and others stay themselves.
    for (let i = 0; i < 30; i++) {
      expect(await runAsNobody(() => pool.query("SELECT app_is_system() AS s")).then((r) => r.rows[0].s), `anonymous #${i}`).toBe(false);
      expect(await runAsUser("victim-2", () => idOf(whoAmI)), `user #${i}`).toBe("victim-2");
    }
  });

  it.skipIf(!ENFORCED)("holds inside an explicit transaction too, and follows an identity change made part way through", async () => {
    const { db } = await import("../server/db");
    const { sql } = await import("drizzle-orm");
    const out = await runAsUser("tx-user", () =>
      db.transaction(async (tx) => {
        const first = (await tx.execute(sql`SELECT app_user_id() AS id`)).rows[0].id;
        const asSystem = await runAsSystem(async () => (await tx.execute(sql`SELECT app_is_system() AS s, app_user_id() AS id`)).rows[0]);
        const again = (await tx.execute(sql`SELECT app_user_id() AS id`)).rows[0].id;
        return { first, asSystem, again };
      }),
    );
    expect(out.first).toBe("tx-user");
    expect(out.asSystem).toEqual({ s: true, id: null });
    expect(out.again).toBe("tx-user");
    expect(await runAsNobody(() => idOf(whoAmI))).toBeNull();
  });
});

describe("the server will not serve on an identity the database does not recognise", () => {
  const run = (env: Record<string, string>) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const script = `import("./server/db.ts").then(async ({ pool }) => { try { const r = await pool.query("SELECT 1 AS ok"); console.log("SERVED " + r.rows[0].ok); } catch (e) { console.log("REFUSED " + e.message); } finally { process.exit(0); } })`;
      const c = execFile(path.resolve("node_modules/.bin/tsx"), ["-e", script], {
        cwd: path.resolve("."), timeout: 60_000,
        env: { ...process.env, NODE_ENV: "development", DB_ENFORCE_RLS: "on", APP_DATABASE_URL: appRoleUrl(process.env.DATABASE_URL!), ...env },
      }, (err, so, se) => resolve({ code: err ? 1 : 0, out: `${so}${se}` }));
      c.stdin?.end();
    });

  it("serves with the registered key and refuses with any other", async () => {
    const good = await run({ IDENTITY_KEY_ID: dev.kid, IDENTITY_KEY: dev.key.toString("base64") });
    expect(good.out).toContain("SERVED 1");
    const wrong = await run({ IDENTITY_KEY_ID: dev.kid, IDENTITY_KEY: crypto.randomBytes(32).toString("base64") });
    expect(wrong.out).toContain("REFUSED");
    expect(wrong.out).toMatch(/does not recognise/);
    const unregistered = await run({ IDENTITY_KEY_ID: "unregistered", IDENTITY_KEY: crypto.randomBytes(32).toString("base64") });
    expect(unregistered.out).toContain("REFUSED");
  });
});

describe("through the application: identity comes from the session, never from the request", () => {
  let a: TestUser, b: TestUser;
  beforeAll(async () => {
    a = await signupPatient();
    b = await signupPatient();
  });

  it("serves each person only their own records whatever identity-looking things they send", async () => {
    const app = await getApp();
    const doctor = await createDoctor();
    await connect(a, doctor);
    const lie = { "X-User-Id": b.id, "X-Avela-User": b.id, "X-System": "on", "X-Avela-System": "on", Cookie: "app.user_id=" + b.id };
    const mine = await request(app).get("/api/pairings").set(auth(a.token)).set(lie);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    const theirs = await request(app).get("/api/pairings").set(auth(b.token)).set(lie);
    expect(theirs.body).toHaveLength(0);
    for (const q of [`?userId=${b.id}`, `?patientUserId=${b.id}`, `?system=on`]) {
      const r = await request(app).get(`/api/pairings${q}`).set(auth(a.token));
      expect(JSON.stringify(r.body), q).not.toContain(b.id);
    }
  });

  it("gives the scheduler's system access to nobody who cannot present its secret", async () => {
    const app = await getApp();
    const before = (await operatorPool().query("SELECT count(*)::int AS n FROM job_run_history")).rows[0].n;
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { "X-Avela-Scheduler": "cloudflare-worker" }, { Authorization: `Bearer ${assertionFor({ system: true })}` }]) {
      expect([401, 503], JSON.stringify(headers)).toContain((await request(app).get("/api/cron/reminders").set(headers)).status);
    }
    expect((await operatorPool().query("SELECT count(*)::int AS n FROM job_run_history")).rows[0].n).toBe(before);
  });
});
