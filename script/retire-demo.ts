/**
 * Retires fabricated (demo / fixture) accounts and providers from a database, without deleting anything.
 *
 *   npm run demo:retire                                       inventory only: what exists, what would change
 *   npm run demo:retire -- --apply --backup-dir=<dir>         back up, then retire (a backup directory is REQUIRED)
 *   npm run demo:retire -- --verify                           exit 1 unless nothing fabricated is still active
 *
 * What it changes, in one transaction, only for rows marked as fabricated (users.is_demo, doctor_profiles.source = 'seed'):
 *   1. users.deactivated_at = now()            they cannot sign in
 *   2. user_devices.revoked_at = now()         their open sessions end on the next request
 *   3. doctor_profiles.active = false          the seeded providers leave the directory
 *   4. one audit_logs row, action 'demo.retired', with counts only
 * Nothing is deleted. Real accounts are untouched. Undo with the SQL in docs/OPERATIONS_RUNBOOK.md.
 *
 * Before changing anything it writes the affected rows (and ONLY those) to <dir>/demo-retirement-<timestamp>.json, mode 0600.
 * Runs with the OWNER connection (DATABASE_URL / OWNER_DATABASE_URL), never the restricted application role.
 */
import "dotenv/config";
import "./asOperator";
import fs from "fs";
import path from "path";
import { pool } from "../server/db";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name: string) => process.argv.includes(`--${name}`);

/** Tables holding rows that belong to a fabricated person, and the condition that selects exactly those rows. */
const DEMO_USERS = "(SELECT id FROM users WHERE is_demo)";
const SEED_PROFILES = "(SELECT id FROM doctor_profiles WHERE source = 'seed')";
const AFFECTED: [string, string][] = [
  ["users", "is_demo"],
  ["doctor_profiles", "source = 'seed'"],
  ["user_devices", `user_id IN ${DEMO_USERS}`],
  ["pairing_requests", `patient_user_id IN ${DEMO_USERS} OR doctor_profile_id IN ${SEED_PROFILES}`],
  ["messages", `sender_user_id IN ${DEMO_USERS}`],
  ["appointments", `patient_user_id IN ${DEMO_USERS} OR doctor_profile_id IN ${SEED_PROFILES}`],
  ["prescriptions", `patient_user_id IN ${DEMO_USERS} OR doctor_profile_id IN ${SEED_PROFILES}`],
  ["medications", `patient_user_id IN ${DEMO_USERS}`],
  ["medication_reminders", `patient_user_id IN ${DEMO_USERS}`],
  ["symptom_reports", `patient_user_id IN ${DEMO_USERS}`],
  ["documents", `patient_user_id IN ${DEMO_USERS}`],
  ["follow_up_tasks", `patient_user_id IN ${DEMO_USERS}`],
  ["care_circle_members", `patient_user_id IN ${DEMO_USERS} OR caregiver_user_id IN ${DEMO_USERS}`],
  ["pharmacy_orders", `patient_user_id IN ${DEMO_USERS}`],
  ["notifications", `user_id IN ${DEMO_USERS}`],
  ["doctor_applications", `user_id IN ${DEMO_USERS}`],
];

async function inventory() {
  const counts: Record<string, number> = {};
  for (const [table, where] of AFFECTED) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`).catch(() => ({ rows: [{ n: -1 }] }));
    counts[table] = r.rows[0].n;
  }
  const active = (await pool.query("SELECT count(*)::int AS n FROM users WHERE is_demo AND deactivated_at IS NULL")).rows[0].n;
  const profiles = (await pool.query("SELECT count(*)::int AS n FROM doctor_profiles WHERE source = 'seed' AND active")).rows[0].n;
  const sessions = (await pool.query(`SELECT count(*)::int AS n FROM user_devices WHERE revoked_at IS NULL AND user_id IN ${DEMO_USERS}`)).rows[0].n;
  const real = (await pool.query("SELECT count(*)::int AS n FROM users WHERE NOT is_demo")).rows[0].n;
  return { counts, active, profiles, sessions, real };
}

async function main() {
  const inv = await inventory();
  console.log(`Fabricated accounts still active: ${inv.active}. Seeded provider profiles still listed: ${inv.profiles}. Open sessions of fabricated accounts: ${inv.sessions}.`);
  console.log(`Accounts that are NOT fabricated (left untouched): ${inv.real}.`);
  console.log("Rows tied to fabricated people:", Object.entries(inv.counts).filter(([, n]) => n !== 0).map(([t, n]) => `${t}=${n}`).join(", ") || "none");

  if (has("verify")) {
    const clean = inv.active === 0 && inv.profiles === 0 && inv.sessions === 0;
    console.log(clean ? "PASS  nothing fabricated is active." : "FAIL  something fabricated is still active.");
    process.exitCode = clean ? 0 : 1;
    return;
  }
  if (!has("apply")) {
    console.log("\nInventory only: nothing changed. To retire them: --apply --backup-dir=<dir>");
    return;
  }
  const dir = arg("backup-dir");
  if (!dir) throw new Error("--apply needs --backup-dir=<directory>: the rows are written there before anything is changed.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `demo-retirement-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const dump: Record<string, unknown[]> = {};
  for (const [table, where] of AFFECTED) {
    if (inv.counts[table] === 0) continue;
    // Password hashes and token hashes of fabricated accounts are not needed to restore access; leave them out of the file.
    const cols = table === "users" ? "id, name, email, role, state, is_demo, created_at, deactivated_at" : "*";
    dump[table] = (await pool.query(`SELECT ${cols} FROM ${table} WHERE ${where}`)).rows;
  }
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), counts: inv.counts, rows: dump }, null, 1), { mode: 0o600 });
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Object.keys(written.rows).length !== Object.keys(dump).length) throw new Error("The backup file could not be read back; nothing was changed.");
  console.log(`Backed up ${Object.values(dump).reduce((n, r) => n + r.length, 0)} row(s) to ${file}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE users SET deactivated_at = now() WHERE is_demo AND deactivated_at IS NULL");
    await client.query(`UPDATE user_devices SET revoked_at = now() WHERE revoked_at IS NULL AND user_id IN ${DEMO_USERS}`);
    await client.query("UPDATE doctor_profiles SET active = false WHERE source = 'seed' AND active");
    await client.query(
      "INSERT INTO audit_logs (action, target_type, metadata) VALUES ('demo.retired', 'system', $1)",
      [JSON.stringify({ accounts: inv.active, providers: inv.profiles, sessions: inv.sessions, backup: path.basename(file) })],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  const after = await inventory();
  console.log(`Done. Active fabricated accounts: ${after.active}; listed seeded providers: ${after.profiles}; open sessions: ${after.sessions}. Nothing was deleted.`);
  process.exitCode = after.active === 0 && after.profiles === 0 && after.sessions === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
