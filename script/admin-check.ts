/**
 * After the owner has created the first administrator (docs/OPERATIONS_RUNBOOK.md §3a), checks what can be checked from the database. Read-only; prints
 * no address, hash or secret.
 *
 *   ADMIN_EMAIL=you@example.org DATABASE_URL=<owner url> npm run admin:check
 *
 * It reports: the account exists with role `admin` and is active; who bootstrapped it (the audit entry, without any secret); the second-factor state
 * (`none` until the administrator signs in once and enrols; `enabled` afterwards); that the application role cannot create or promote administrators
 * (the guard trigger is present and enabled; the role has no way around it); and how many administrators exist in total.
 */
import "dotenv/config";
import "./asOperator";
import { pool } from "../server/db";

const ok = (good: boolean, what: string, detail = "") => {
  console.log(`${good ? "PASS" : "FAIL"}  ${what}${detail ? ` (${detail})` : ""}`);
  if (!good) process.exitCode = 1;
};

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("Set ADMIN_EMAIL to the address the administrator was created with.");
  const u = (await pool.query("SELECT id, role, is_demo, deactivated_at FROM users WHERE lower(email) = $1", [email])).rows[0];
  ok(!!u, "the account exists");
  if (!u) return;
  ok(u.role === "admin" && !u.is_demo && !u.deactivated_at, "it is a live, non-fixture administrator");
  const audit = (await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'admin.bootstrapped' AND target_id = $1", [u.id])).rows[0].n;
  ok(audit === 1, "the bootstrap is recorded exactly once in the audit log", `${audit} entr${audit === 1 ? "y" : "ies"}`);
  const mfa = (await pool.query("SELECT pending, enabled_at FROM user_mfa WHERE user_id = $1", [u.id])).rows[0];
  const state = !mfa ? "none (they enrol at their first sign-in)" : mfa.pending ? "started, not finished" : "enabled";
  console.log(`INFO  second factor: ${state}. An administrator has no working session until it is enabled.`);
  const total = (await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT is_demo AND deactivated_at IS NULL")).rows[0].n;
  console.log(`INFO  active administrators in total: ${total}`);
  const trig = (await pool.query("SELECT tgenabled FROM pg_trigger WHERE tgname = 'users_guard' AND tgrelid = 'public.users'::regclass")).rows[0];
  ok(trig?.tgenabled === "O", "the database guard against creating or promoting administrators through the application is present and enabled");
  const priv = (await pool.query(`SELECT has_table_privilege('avela_app', 'public.users', 'DELETE') AS del, has_database_privilege('avela_app', current_database(), 'CREATE') AS cr`)).rows[0];
  ok(!priv.del && !priv.cr, "the application role can neither delete accounts nor create anything");
  const sessions = (await pool.query("SELECT count(*)::int AS n FROM user_devices WHERE user_id = $1 AND revoked_at IS NULL", [u.id])).rows[0].n;
  console.log(`INFO  open sessions for this account: ${sessions}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
