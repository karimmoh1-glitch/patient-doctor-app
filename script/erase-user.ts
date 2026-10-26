/**
 * Carries out an account deletion request. Read server/services/erasure.ts first:
 * it explains what is removed and what is deliberately kept.
 *
 *   npm run erase:user -- <userId>            describes what would be done
 *   npm run erase:user -- <userId> --apply    does it, once, irreversibly
 *
 * List open requests with:  npm run erase:user -- --list
 */
import "dotenv/config";
import path from "path";
import { pool } from "../server/db";
import { eraseUser } from "../server/services/erasure";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    const rows = (await pool.query("SELECT id, user_id, kind, created_at FROM data_requests WHERE status = 'open' ORDER BY created_at")).rows;
    console.log(rows.length ? rows.map((r) => `${r.created_at.toISOString()}  ${r.kind}  user ${r.user_id}`).join("\n") : "No open requests.");
    return;
  }
  const userId = args.find((a) => !a.startsWith("--"));
  if (!userId) throw new Error("Give the user id, or --list.");
  if (!args.includes("--apply")) {
    const u = (await pool.query("SELECT role, deactivated_at FROM users WHERE id = $1", [userId])).rows[0];
    if (!u) throw new Error("No such user.");
    console.log(`Would erase the identity and patient-written text of user ${userId} (${u.role}). Nothing was changed. Re-run with --apply.`);
    return;
  }
  const report = await eraseUser(pool, userId, { uploadsDir: path.resolve(process.cwd(), "uploads", "documents") });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
