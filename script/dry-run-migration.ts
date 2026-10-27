/**
 * Runs the pending migration(s) (or the named ones) inside ONE transaction, in order, on the database in OWNER_DATABASE_URL / DATABASE_URL, looks at the result, and
 * ROLLS BACK. Nothing is committed and the migration is not recorded. Use it on a copy of production (a provider branch or a
 * restored backup) to learn that the SQL runs on the provider's exact server version before it is applied for real:
 *
 *   OWNER_DATABASE_URL=<a COPY's owner url> npm run migration:dry-run             (all pending, in order)
 *   OWNER_DATABASE_URL=<a COPY's owner url> npm run migration:dry-run -- 0024_close_rls_gaps.sql 0025_verified_identity.sql
 *
 * It takes the locks the migration takes, for as long as the transaction lasts (a moment). Do not point it at production
 * unless the owner has decided that is acceptable: use a branch. Prints structure counts only, never row data.
 */
import "dotenv/config";
import "./asOperator";
import fs from "fs";
import path from "path";
import { pool } from "../server/db";
import { fingerprintLines, md5 } from "./lib/fingerprint";

const named = process.argv.slice(2).filter((a) => a.endsWith(".sql"));

async function main() {
  const dir = path.resolve("migrations");
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client0 = await pool.connect();
  let applied: Set<string>;
  try {
    applied = new Set((await client0.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
  } finally {
    client0.release();
  }
  const files = named.length ? named : all.filter((f) => !applied.has(f));
  if (files.length === 0) throw new Error("Nothing pending: every migration is already applied here.");
  for (const f of files) if (applied.has(f)) throw new Error(`${f} is already applied here; a dry run needs a database that has not applied it.`);
  const client = await pool.connect();
  try {
    const q = async (text: string) => (await client.query(text)).rows as Record<string, any>[];
    const version = (await q("SHOW server_version"))[0].server_version;
    const before = await fingerprintLines(q);
    await client.query("BEGIN");
    try {
      for (const f of files) {
        await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
        console.log(`PASS  ${f} runs on PostgreSQL ${version}`);
      }
      const after = await fingerprintLines(q);
      console.log(`PASS  all ${files.length} file(s), in order, in one transaction: ${before.length} structural facts before, ${after.length} inside it.`);
    } finally {
      await client.query("ROLLBACK");
    }
    const restored = await fingerprintLines(q);
    const same = md5(restored.join("\n")) === md5(before.join("\n"));
    console.log(`${same ? "PASS" : "FAIL"}  rolled back: the structure is exactly as it was (${md5(before.join("\n"))}).`);
    if (!same) process.exitCode = 1;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
