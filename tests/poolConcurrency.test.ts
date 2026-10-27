import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { getApp } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { devIdentityKey, SYSTEM_SCOPES } from "../server/identity";
import { pool, db, wrapClient } from "../server/db";
import { runAsNobody, runAsSystem, runAsUser } from "../server/dbContext";
import { sql } from "drizzle-orm";

// The production pooler hands the same few physical connections to everybody. These push identities (people, scoped system roles, the server,
// nobody) through a small pool in every way a request can end (success, exception, rollback, timeout, retry) and check that nobody ever
// answers as somebody else. Meaningful only through the restricted pool (npm run test:rls).

const ENFORCED = process.env.TEST_AS_APP_ROLE === "1";
type Who = { kind: "user"; id: string } | { kind: "scope"; scope: string } | { kind: "server" } | { kind: "nobody" };
const ask = () => pool.query("SELECT app_user_id() AS u, app_verified_scope() AS s, pg_sleep(0.003)").then((r) => ({ u: (r.rows[0].u as string | null) ?? null, s: (r.rows[0].s as string | null) ?? null }));
const as = <T>(w: Who, fn: () => Promise<T>) =>
  w.kind === "user" ? runAsUser(w.id, fn) : w.kind === "scope" ? runAsSystem(fn, w.scope as any) : w.kind === "server" ? runAsSystem(fn) : runAsNobody(fn);
const expected = (w: Who) => (w.kind === "user" ? { u: w.id, s: null } : w.kind === "scope" ? { u: null, s: w.scope } : w.kind === "server" ? { u: null, s: "server" } : { u: null, s: null });
const everyone = (n: number): Who[] => {
  const scopes = SYSTEM_SCOPES.filter((s) => s !== "server");
  return Array.from({ length: n }, (_, i): Who => (i % 5 === 0 ? { kind: "nobody" } : i % 5 === 1 ? { kind: "server" } : i % 5 === 2 ? { kind: "scope", scope: scopes[i % scopes.length] } : { kind: "user", id: `p-${i}` }));
};
/** Touches every physical connection of the pool at once and returns what each one says about who it is. */
const sweep = () => Promise.all(Array.from({ length: 12 }, () => runAsNobody(ask)));

beforeAll(async () => {
  await getApp();
});

describe.skipIf(!ENFORCED)("identities through a small shared pool", () => {
  it("keeps three hundred interleaved requests of every kind apart", async () => {
    const people = everyone(300);
    const seen = await Promise.all(people.map((w) => as(w, ask)));
    seen.forEach((got, i) => expect(got, `request ${i} (${JSON.stringify(people[i])})`).toEqual(expected(people[i])));
  });

  it("leaves no identity behind after a request throws inside a transaction, so the next request on that connection is nobody", async () => {
    for (let round = 0; round < 5; round++) {
      const failures = await Promise.allSettled(
        everyone(40).map((w) =>
          as(w, () =>
            db.transaction(async (tx) => {
              await tx.execute(sql`SELECT app_user_id() AS id`);
              throw new Error("boom");
            }),
          ),
        ),
      );
      expect(failures.every((f) => f.status === "rejected")).toBe(true);
      for (const s of await sweep()) expect(s).toEqual({ u: null, s: null });
    }
  });

  it("leaves none after an explicit rollback, a failed statement, a statement that times out, or a cancelled one", async () => {
    const endings: [string, (w: Who) => Promise<unknown>][] = [
      ["rollback", (w) => as(w, () => db.transaction(async (tx) => { await tx.execute(sql`SELECT 1`); tx.rollback(); })).catch(() => {})],
      ["bad statement", (w) => as(w, () => pool.query("SELECT * FROM there_is_no_such_table")).catch(() => {})],
      ["timeout", (w) => as(w, () => db.transaction(async (tx) => { await tx.execute(sql`SET LOCAL statement_timeout = 20`); await tx.execute(sql`SELECT pg_sleep(1)`); })).catch(() => {})],
      ["constraint", (w) => as(w, () => pool.query("INSERT INTO users (id) VALUES (NULL)")).catch(() => {})],
    ];
    for (const [name, end] of endings) {
      await Promise.all(everyone(30).map(end));
      for (const s of await sweep()) expect(s, name).toEqual({ u: null, s: null });
    }
  });

  it("gives a retried request its own identity again, not whatever the failed attempt held", async () => {
    const attempts = everyone(60).map(async (w) => {
      let tries = 0;
      const once = () => as(w, async () => {
        tries++;
        const got = await ask();
        if (tries === 1) throw new Error("transient");
        return got;
      });
      return once().catch(() => once());
    });
    const seen = await Promise.all(attempts);
    seen.forEach((got, i) => expect(got).toEqual(expected(everyone(60)[i])));
    for (const s of await sweep()) expect(s).toEqual({ u: null, s: null });
  });

  it("keeps a held connection clean through many different identities in a row", async () => {
    const raw = new pg.Client({ connectionString: appRoleUrl(process.env.DATABASE_URL!) });
    await raw.connect();
    const client = wrapClient(raw as any, devIdentityKey()) as unknown as pg.Client;
    const residue = async () => ((await (pg.Client.prototype.query as any).call(raw, "SELECT current_setting('app.assertion', true) AS a")).rows[0].a ?? "") as string;
    try {
      for (const w of everyone(50)) {
        const got = await as(w, () => client.query("SELECT app_user_id() AS u, app_verified_scope() AS s").then((r) => ({ u: r.rows[0].u ?? null, s: r.rows[0].s ?? null })));
        expect(got).toEqual(expected(w));
        expect(await residue()).toBe("");
      }
    } finally {
      await raw.end();
    }
  });
});
