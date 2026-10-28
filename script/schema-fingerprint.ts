/**
 * A canonical, secret-free description of a database's structure and protections, one line per fact, sorted: tables and
 * their columns, constraints, indexes, row-level-security state and policies, triggers, functions (by a hash of their
 * source), views, and what the application role may do. Read-only.
 *
 *   npm run schema:fingerprint > local.txt            (against DATABASE_URL, the owner connection)
 *   diff local.txt production.txt                     (an empty diff means the structures are identical)
 *
 * Why: "the migrations say X" and "the production database is X" are different claims. This is how the second one is checked
 * before a migration is applied, and after (docs/OPERATIONS_RUNBOOK.md, "Applying a migration"). It prints no row data.
 */
import "dotenv/config";
import "./asOperator";
import { pool } from "../server/db";
import { fingerprintLines, md5 } from "./lib/fingerprint";

const q = async (sql: string) => (await pool.query(sql)).rows as Record<string, any>[];

async function main() {
  const lines = await fingerprintLines(q);
  console.log(lines.join("\n"));
  console.error(`# ${(await q("SHOW server_version"))[0].server_version}, ${lines.length} facts, fingerprint ${md5(lines.join("\n"))}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
