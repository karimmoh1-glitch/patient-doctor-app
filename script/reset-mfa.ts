/**
 * Removes a person's second factor and ends all their sessions, so they enrol again at their next sign-in. The way back in
 * for an ADMINISTRATOR who has lost their device and recovery codes (another administrator cannot do this for them in the
 * application by design), and an emergency tool for anyone else.
 *
 *   npm run mfa:reset -- --email=someone@example.org --reason="lost phone, identity confirmed by <how>"
 *
 * Runs with the OWNER connection, from a trusted machine, by a named operator. Writes an audit entry (who/why, no codes).
 */
import "dotenv/config";
import "./asOperator";
import { pool } from "../server/db";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const reason = arg("reason")?.trim();
  if (!email) throw new Error("--email=<address> is required");
  if (!reason || reason.length < 10) throw new Error('--reason="..." is required (say how the person\'s identity was confirmed)');
  const { rows } = await pool.query("SELECT id, role FROM users WHERE lower(email) = $1", [email]);
  if (!rows.length) throw new Error("No such user.");
  const { id, role } = rows[0] as { id: string; role: string };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [id]);
    await client.query("DELETE FROM user_mfa WHERE user_id = $1", [id]);
    await client.query("UPDATE user_devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
    await client.query(
      "INSERT INTO audit_logs (action, target_type, target_id, subject_user_id, metadata) VALUES ('mfa.reset_by_operator', 'user', $1, $1, $2)",
      [id, JSON.stringify({ role, reason })],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  console.log("Done. Their sign-in codes were removed and their sessions ended. They set up an authenticator at the next sign-in.");
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
