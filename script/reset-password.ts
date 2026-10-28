/**
 * Sets a new password for an account and ends all its sessions. The way back in for an ADMINISTRATOR who has forgotten their
 * password while e-mail recovery is not available (or is the account that would receive the link), and an emergency tool for anyone.
 *
 *   npm run password:reset -- --email=someone@example.org --reason="forgot password; identity confirmed by <how>"
 *
 * Runs with the OWNER connection, from a trusted machine, by a named operator. The new password is asked for at the terminal
 * (twice, not echoed) or, for an automated run, NEW_PASSWORD in the environment. It writes an audit entry (who, why; no password).
 * The person's second factor is not touched: a lost authenticator is `npm run mfa:reset`.
 */
import "dotenv/config";
import "./asOperator";
import bcrypt from "bcryptjs";
import { pool } from "../server/db";
import { weakPasswordReason } from "../server/lib/password";
import { promptNewSecret } from "./prompt";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const reason = arg("reason")?.trim();
  if (!email) throw new Error("--email=<address> is required");
  if (!reason || reason.length < 10) throw new Error('--reason="..." is required (say how the person\'s identity was confirmed)');
  const { rows } = await pool.query("SELECT id, name, role FROM users WHERE lower(email) = $1", [email]);
  if (!rows.length) throw new Error("No such user.");
  const { id, name, role } = rows[0] as { id: string; name: string; role: string };
  const password = process.env.NEW_PASSWORD ?? (await promptNewSecret("New password (12+ characters)"));
  if (password.length < 12) throw new Error("The password must be at least 12 characters.");
  const weak = weakPasswordReason(password, { email, name });
  if (weak) throw new Error(weak);

  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, hash]);
    await client.query("UPDATE user_devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
    await client.query("UPDATE password_reset_tokens SET used = true WHERE email = $1 AND NOT used", [email]);
    await client.query(
      "INSERT INTO audit_logs (action, target_type, target_id, subject_user_id, metadata) VALUES ('password.reset_by_operator', 'user', $1, $1, $2)",
      [id, JSON.stringify({ role, reason, operator: process.env.USER ?? "unknown", host: process.env.HOSTNAME ?? "unknown" })],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  console.log("Done. The password was changed and every session of that account was ended.");
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
