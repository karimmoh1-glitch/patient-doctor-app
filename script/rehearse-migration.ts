/**
 * Rehearses one migration on a scratch database before it goes anywhere near production:
 *
 *   REHEARSAL_ADMIN_URL=postgresql://user:pw@host:5432/postgres npm run migration:rehearse -- 0024_close_rls_gaps.sql
 *
 * It creates a scratch database, builds it from every migration BEFORE the one named (the state production is in), puts a few
 * synthetic rows in it, fingerprints its structure (script/lib/fingerprint.ts), applies the migration, and checks:
 *
 *   1. the migration applies cleanly, and applying it again changes nothing (idempotent);
 *   2. no existing row was touched (row counts of every table before and after);
 *   3. if ops/rollback/<name>.down.sql exists: running it restores the exact pre-migration structure, and applying the
 *      migration again after that reproduces the identical post-migration structure.
 *
 * The scratch database is dropped at the end. Nothing here reads a real database; to compare against production, run
 * `npm run schema:fingerprint` there (owner connection) and diff it with the "before" fingerprint this prints with --dump=<dir>.
 */
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import pg from "pg";
import { runMigrations } from "./migrate";
import { fingerprintLines, md5 } from "./lib/fingerprint";

const root = path.resolve(process.cwd());
const target = process.argv.slice(2).find((a) => a.endsWith(".sql")) ?? fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort().pop()!;
const dump = process.argv.find((a) => a.startsWith("--dump="))?.slice(7);
const adminUrl = process.env.REHEARSAL_ADMIN_URL || process.env.TEST_DATABASE_URL?.replace(/\/[^/]+$/, "/postgres");
if (!adminUrl) throw new Error("Set REHEARSAL_ADMIN_URL to a connection that may CREATE DATABASE (for example the server's postgres database).");

const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

let failed = false;
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failed = true;
};

// Row counts of the tables that exist now (or, when `only` is given, of those). A migration may add tables and seed its own rows; what
// matters is that no row of anything that was already there changed.
async function counts(pool: pg.Pool, only?: string[]): Promise<string> {
  const all = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1")).rows;
  const rows = only ? all.filter((r) => only.includes(r.tablename)) : all;
  const out: string[] = [];
  for (const r of rows) out.push(`${r.tablename}=${(await pool.query(`SELECT count(*)::int AS n FROM "${r.tablename}"`)).rows[0].n}`);
  return out.join(",");
}

async function main() {
  const name = `avela_rehearsal_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = withDb(adminUrl!, name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avela-mig-"));
  const scratch = new pg.Pool({ connectionString: url, max: 2 });
  const q = async (sql: string) => (await scratch.query(sql)).rows as Record<string, any>[];
  const fp = async () => (await fingerprintLines(q)).filter((l) => !l.startsWith("migration\t"));
  try {
    const all = fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
    if (!all.includes(target)) throw new Error(`No such migration: ${target}`);
    for (const f of all.filter((f) => f < target)) fs.copyFileSync(path.join(root, "migrations", f), path.join(tmp, f));
    const before = await runMigrations(url, tmp);
    console.log(`Built the pre-migration state from ${before.length} migrations (everything before ${target}).`);

    // A few synthetic rows, in whichever of these tables exist, to prove the migration does not touch data.
    await scratch.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ('s1', 'Synthetic Patient', 's1@synthetic.invalid', 'x', 'patient'), ('s2', 'Synthetic Doctor', 's2@synthetic.invalid', 'x', 'doctor')`);
    await scratch.query(`INSERT INTO doctor_profiles (id, user_id, name, specialty, state, phone, source) VALUES ('p1', 's2', 'Dr Synthetic', 'Family Medicine', 'CA', '+10000000000', 'application')`).catch(() => {});
    await scratch.query(`INSERT INTO audit_logs (action) VALUES ('rehearsal')`).catch(() => {});
    const tablesBefore = (await scratch.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")).rows.map((r) => r.tablename as string);
    const rowsBefore = await counts(scratch);
    const fpBefore = await fp();

    fs.copyFileSync(path.join(root, "migrations", target), path.join(tmp, target));
    const applied = await runMigrations(url, tmp);
    check(applied.length === 1 && applied[0] === target, `${target} applies cleanly to the pre-migration state`);
    const fpAfter = await fp();
    check(md5(fpAfter.join("\n")) !== md5(fpBefore.join("\n")), `it changes the structure (${fpAfter.length} facts after, ${fpBefore.length} before)`);
    check((await counts(scratch, tablesBefore)) === rowsBefore, "no existing row was added, changed or removed");

    // Idempotent: run the file's SQL again by hand (the runner would skip it as already recorded).
    await scratch.query(fs.readFileSync(path.join(root, "migrations", target), "utf8"));
    check(md5((await fp()).join("\n")) === md5(fpAfter.join("\n")), "applying it a second time changes nothing");

    const down = path.join(root, "ops", "rollback", target.replace(/\.sql$/, ".down.sql"));
    if (fs.existsSync(down)) {
      await scratch.query(fs.readFileSync(down, "utf8"));
      const fpDown = await fp();
      const diff = fpBefore.filter((l) => !fpDown.includes(l)).concat(fpDown.filter((l) => !fpBefore.includes(l)));
      check(diff.length === 0, `the rollback restores the exact pre-migration structure${diff.length ? ` (${diff.length} differences, first: ${diff[0].slice(0, 100)})` : ""}`);
      check((await counts(scratch, tablesBefore)) === rowsBefore, "the rollback touched no row");
      await runMigrations(url, tmp);
      check(md5((await fp()).join("\n")) === md5(fpAfter.join("\n")), "re-applying after the rollback reproduces the identical post-migration structure");
    } else {
      console.log(`NOTE  no rollback file at ${path.relative(root, down)}; recovery is restore-from-backup only`);
    }
    if (dump) {
      fs.mkdirSync(dump, { recursive: true });
      fs.writeFileSync(path.join(dump, "before.txt"), fpBefore.join("\n") + "\n");
      fs.writeFileSync(path.join(dump, "after.txt"), fpAfter.join("\n") + "\n");
      console.log(`Wrote before.txt and after.txt to ${dump}`);
    }
  } finally {
    await scratch.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
