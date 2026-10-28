/**
 * Does a shared connection pooler (Neon's PgBouncer in transaction mode) ever let one request be served under another's identity, and what do
 * the per-statement identity round trips cost? Run it against a COPY of production (a provider branch), never production itself:
 *
 *   APP_DATABASE_URL=<the branch's POOLED runtime url> DB_ENFORCE_RLS=on IDENTITY_KEY_ID=… IDENTITY_KEY=… npm run pooler:check
 *   (the key must be registered on that branch: migrations 0025+ applied and `identity:key -- register`)
 *
 * It uses the application's own pool and identity wrapper, so it measures what the application would do. It reads nothing but the database's own answer to
 * "who am I", writes nothing, creates no account, and prints counts, mismatches and timings only (never a key, an assertion or a connection string).
 * Exit code 1 if ANY request was served under an identity other than its own.
 */
import "dotenv/config";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { runAsNobody, runAsSystem, runAsUser } from "../server/dbContext";
import { SYSTEM_SCOPES } from "../server/identity";

type Who = { label: string; run: <T>(fn: () => Promise<T>) => Promise<T>; want: { u: string | null; s: string | null } };
const scopes = SYSTEM_SCOPES.filter((s) => s !== "server");
// After `identity:enforce -- server-scope off` the database refuses the unrestricted scope, so a request that asks for it is nobody. That is the
// correct answer in that configuration (and still must never be anybody else); say which configuration this database is in.
const SERVER_REFUSED = process.env.POOLER_CHECK_SERVER_SCOPE === "refused";
const person = (i: number): Who => ({ label: `user-${i}`, run: (fn) => runAsUser(`pooler-check-${i}`, fn), want: { u: `pooler-check-${i}`, s: null } });
const roster = (n: number): Who[] =>
  Array.from({ length: n }, (_, i): Who =>
    i % 7 === 0 ? { label: "nobody", run: runAsNobody, want: { u: null, s: null } }
    : i % 7 === 1 ? { label: "server", run: (fn) => runAsSystem(fn), want: { u: null, s: SERVER_REFUSED ? null : "server" } }
    : i % 7 === 2 ? { label: `scope:${scopes[i % scopes.length]}`, run: (fn) => runAsSystem(fn, scopes[i % scopes.length] as any), want: { u: null, s: scopes[i % scopes.length] } }
    : person(i));
const ask = () => pool.query("SELECT app_user_id() AS u, app_verified_scope() AS s").then((r) => ({ u: (r.rows[0].u as string | null) ?? null, s: (r.rows[0].s as string | null) ?? null }));
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

/**
 * Positive control. A check that passes is only worth something if it could have failed. This reproduces the flaw the signed identity replaces: a plain
 * session setting written in one statement and read in the next, on one held client. Through a direct connection it always reads back its own value;
 * through a transaction-mode pooler the two statements can run on different server connections, so it sometimes reads another client's value or nothing.
 * The setting name is harmless and nothing is written to the database. POOLER_CONTROL_REQUIRED=1 makes "the pooler did not behave like a pooler" a failure.
 */
async function positiveControl(): Promise<{ clients: number; own: number; foreign: number; none: number }> {
  const clients = Number(process.env.POOLER_CONTROL_CLIENTS ?? 120);
  const raw = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL, max: 10 });
  let own = 0;
  let foreign = 0;
  let none = 0;
  await Promise.all(
    Array.from({ length: clients }, async (_, i) => {
      const c = await raw.connect();
      try {
        await c.query("SELECT set_config('avela.pooler_control', $1, false)", [`c${i}`]);
        await new Promise((r) => setTimeout(r, Math.random() * 15));
        const got = (await c.query("SELECT current_setting('avela.pooler_control', true) AS v")).rows[0].v as string | null;
        if (got === `c${i}`) own++;
        else if (!got) none++;
        else foreign++;
      } finally {
        c.release();
      }
    }),
  );
  await raw.end();
  return { clients, own, foreign, none };
}

async function main() {
  let wrong = 0;
  let served = 0;
  const byPhase = new Map<string, { served: number; wrong: number; sample: string }>();
  const phaseOf = (label: string) => (label.startsWith("sweep") ? label : label.replace(/-\d+$/, "").replace(/^scope:.*/, "scope"));
  const check = (who: Who, got: { u: string | null; s: string | null }) => {
    served++;
    const entry = byPhase.get(phaseOf(who.label)) ?? { served: 0, wrong: 0, sample: "" };
    entry.served++;
    if (got.u !== who.want.u || got.s !== who.want.s) {
      wrong++;
      entry.wrong++;
      entry.sample ||= `wanted ${who.want.u ? "a person" : who.want.s ?? "nobody"}, got ${got.u ? "a person" : got.s ?? "nobody"}`;
    }
    byPhase.set(phaseOf(who.label), entry);
  };
  const rounds = Number(process.env.POOLER_CHECK_ROUNDS ?? 20);
  const width = Number(process.env.POOLER_CHECK_WIDTH ?? 80);
  console.log(`Probing ${rounds} rounds of ${width} interleaved identities (people, narrow scopes, the server, nobody)…`);
  for (let r = 0; r < rounds; r++) {
    const who = roster(width);
    const got = await Promise.all(who.map((w) => w.run(ask)));
    got.forEach((g, i) => check(who[i], g));
    // Statements that end badly, then a sweep of the pool: no connection may keep an identity.
    await Promise.all(who.slice(0, 20).map((w) => w.run(() => pool.query("SELECT * FROM there_is_no_such_table")).catch(() => {})));
    const sweep = await Promise.all(Array.from({ length: 24 }, () => runAsNobody(ask)));
    sweep.forEach((g) => check({ label: "sweep", run: runAsNobody, want: { u: null, s: null } }, g));
  }

  // Every other way a request can end (a throw inside a transaction, an explicit rollback, a statement timeout, a constraint failure), then a
  // sweep of the pool; and a retried request, which must get its own identity again rather than whatever the failed attempt held.
  const endings: [string, (w: Who) => Promise<unknown>][] = [
    ["throw in a transaction", (w) => w.run(() => db.transaction(async (tx) => { await tx.execute(sql`SELECT app_user_id() AS id`); throw new Error("boom"); })).catch(() => {})],
    ["rollback", (w) => w.run(() => db.transaction(async (tx) => { await tx.execute(sql`SELECT 1`); tx.rollback(); })).catch(() => {})],
    ["statement timeout", (w) => w.run(() => db.transaction(async (tx) => { await tx.execute(sql`SET LOCAL statement_timeout = 20`); await tx.execute(sql`SELECT pg_sleep(1)`); })).catch(() => {})],
    ["constraint", (w) => w.run(() => pool.query("INSERT INTO users (id) VALUES (NULL)")).catch(() => {})],
  ];
  for (const [name, end] of endings) {
    for (let r = 0; r < Math.max(2, Math.floor(rounds / 4)); r++) {
      await Promise.all(roster(30).map(end));
      const sweep = await Promise.all(Array.from({ length: 24 }, () => runAsNobody(ask)));
      sweep.forEach((g) => check({ label: `sweep after ${name}`, run: runAsNobody, want: { u: null, s: null } }, g));
    }
  }
  {
    const who = roster(60);
    const seen = await Promise.all(
      who.map((w) => {
        let tries = 0;
        const once = () => w.run(async () => { tries++; const got = await ask(); if (tries === 1) throw new Error("transient"); return got; });
        return once().catch(() => once());
      }),
    );
    seen.forEach((g, i) => check(who[i], g));
    (await Promise.all(Array.from({ length: 24 }, () => runAsNobody(ask)))).forEach((g) => check({ label: "sweep after retry", run: runAsNobody, want: { u: null, s: null } }, g));
  }

  // The cost of the per-statement identity: a trivial statement as nobody (one assertion round trip pair) against the same through one raw pooled call.
  const timed = async (fn: () => Promise<unknown>, n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = process.hrtime.bigint();
      await fn();
      out.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    return out;
  };
  const asPerson = await timed(() => runAsUser("pooler-check-latency", () => pool.query("SELECT 1")), 200);
  const asNobody = await timed(() => runAsNobody(() => pool.query("SELECT 1")), 200);
  const ms = (x: number) => x.toFixed(1);
  console.log(`Latency of one SELECT 1 (ms), 200 sequential: as a person p50 ${ms(pct(asPerson, 50))} p95 ${ms(pct(asPerson, 95))}; as nobody p50 ${ms(pct(asNobody, 50))} p95 ${ms(pct(asNobody, 95))}`);
  console.log(`${served} requests served, ${wrong} under the wrong identity.`);
  if (wrong) for (const [phase, e] of byPhase) if (e.wrong) console.log(`  ${phase}: ${e.wrong} of ${e.served} wrong (${e.sample})`);
  const host = (() => {
    try { return new URL(process.env.APP_DATABASE_URL ?? "").hostname; } catch { return ""; }
  })();
  const control = await positiveControl();
  const differs = control.foreign + control.none;
  console.log(`Control (a plain session setting, written then read on one held client, ${control.clients} clients): own ${control.own}, another client's ${control.foreign}, nothing ${control.none}. Endpoint host ${host.includes("-pooler") ? "is" : "is NOT"} a provider pooler host.`);
  const controlOk = differs > 0;
  if (!controlOk) console.log("NOTE  the control never differed: this endpoint behaved like a direct connection, so this run does not show how a transaction pooler behaves.");
  await pool.end();
  if (process.env.POOLER_CONTROL_REQUIRED === "1" && !controlOk) {
    console.log("FAIL  POOLER_CONTROL_REQUIRED is set and the endpoint did not behave like a transaction pooler.");
    process.exit(1);
  }
  if (wrong) {
    console.log("FAIL  an identity crossed between requests: do not use this pooler configuration.");
    process.exit(1);
  }
  console.log("PASS  no request was served under another's identity.");
}
main().catch((e) => {
  console.error(`pooler:check failed: ${String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://…")}`);
  process.exit(1);
});
