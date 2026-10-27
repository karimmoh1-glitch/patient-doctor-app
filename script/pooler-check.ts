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
import { pool } from "../server/db";
import { runAsNobody, runAsSystem, runAsUser } from "../server/dbContext";
import { SYSTEM_SCOPES } from "../server/identity";

type Who = { label: string; run: <T>(fn: () => Promise<T>) => Promise<T>; want: { u: string | null; s: string | null } };
const scopes = SYSTEM_SCOPES.filter((s) => s !== "server");
const person = (i: number): Who => ({ label: `user-${i}`, run: (fn) => runAsUser(`pooler-check-${i}`, fn), want: { u: `pooler-check-${i}`, s: null } });
const roster = (n: number): Who[] =>
  Array.from({ length: n }, (_, i): Who =>
    i % 7 === 0 ? { label: "nobody", run: runAsNobody, want: { u: null, s: null } }
    : i % 7 === 1 ? { label: "server", run: (fn) => runAsSystem(fn), want: { u: null, s: "server" } }
    : i % 7 === 2 ? { label: `scope:${scopes[i % scopes.length]}`, run: (fn) => runAsSystem(fn, scopes[i % scopes.length] as any), want: { u: null, s: scopes[i % scopes.length] } }
    : person(i));
const ask = () => pool.query("SELECT app_user_id() AS u, app_verified_scope() AS s").then((r) => ({ u: (r.rows[0].u as string | null) ?? null, s: (r.rows[0].s as string | null) ?? null }));
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function main() {
  let wrong = 0;
  let served = 0;
  const check = (who: Who, got: { u: string | null; s: string | null }) => {
    served++;
    if (got.u !== who.want.u || got.s !== who.want.s) wrong++;
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
  await pool.end();
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
