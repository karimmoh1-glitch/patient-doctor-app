/**
 * Switches demonstration data off without deleting anything.
 *
 *   npm run demo:retire            shows what would change (dry run)
 *   npm run demo:retire -- --apply does it
 *
 * Demo accounts are deactivated (and their sessions revoked) and seeded
 * demonstration doctors are hidden from the directory. Nothing is deleted, so
 * it is reversible and no audit history is lost. Real accounts are untouched.
 */
import "dotenv/config";
import { pool } from "../server/db";

async function main() {
  const apply = process.argv.includes("--apply");
  const users = (await pool.query("SELECT id, email FROM users WHERE is_demo AND deactivated_at IS NULL")).rows;
  const profiles = (await pool.query("SELECT id FROM doctor_profiles WHERE source = 'seed' AND active")).rows;
  console.log(`${users.length} demo account(s) and ${profiles.length} seeded demonstration doctor profile(s) are currently active.`);
  if (!apply) {
    console.log("Dry run: nothing changed. Re-run with --apply to deactivate them.");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE users SET deactivated_at = now() WHERE is_demo AND deactivated_at IS NULL");
    await client.query("UPDATE user_devices SET revoked_at = now() WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE is_demo)");
    await client.query("UPDATE doctor_profiles SET active = false WHERE source = 'seed' AND active");
    await client.query("COMMIT");
    console.log("Done. Demo accounts are deactivated and seeded doctors are hidden.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
