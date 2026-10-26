/**
 * Runs one pending migration inside a transaction on the database in OWNER_DATABASE_URL / DATABASE_URL, looks at the result, and
 * ROLLS BACK. Nothing is committed and the migration is not recorded. Use it on a copy of production (a provider branch or a
 * restored backup) to learn that the SQL runs on the provider's exact server version before it is applied for real:
 *
 *   OWNER_DATABASE_URL=<a COPY's owner url> npm run migration:dry-run -- 0024_close_rls_gaps.sql
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

const file = process.argv.slice(2).find((a) => a.endsWith(".sql"));

async function main() {
  if (!file) throw new Error("Name the migration file, for example 0024_close_rls_gaps.sql");
  const sql = fs.readFileSync(path.resolve("migrations", file), "utf8");
  const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
  if (done.rowCount) throw new Error(`${file} is already applied here; a dry run needs a database that has not applied it.`);
  const client = await pool.connect();
  try {
    const q = async (text: string) => (await client.query(text)).rows as Record<string, any>[];
    const version = (await q("SHOW server_version"))[0].server_version;
    const before = await fingerprintLines(q);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      const after = await fingerprintLines(q);
      console.log(`PASS  ${file} runs on PostgreSQL ${version}: ${before.length} structural facts before, ${after.length} inside the transaction.`);
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
