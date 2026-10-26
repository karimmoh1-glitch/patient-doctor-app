/**
 * Re-encrypts every stored authenticator secret under the CURRENT MFA_ENCRYPTION_KEY, after the key was rotated. See the key
 * rotation steps in docs/OPERATIONS_RUNBOOK.md. Run with the OWNER connection, with the new key in MFA_ENCRYPTION_KEY and the old
 * one in MFA_ENCRYPTION_KEY_PREVIOUS:
 *
 *   npm run mfa:rekey -- --status      counts by key (changes nothing)
 *   npm run mfa:rekey                  re-encrypts what is not yet under the current key
 *
 * Each secret is replaced only if it still holds the ciphertext that was read (so a person enrolling meanwhile is never overwritten).
 * It prints counts only. Recovery codes cannot be re-hashed (they are one-way): they keep working under the previous key until it is
 * removed, so keep the previous key until every person has used up or regenerated their codes.
 */
import "dotenv/config";
import "./asOperator";
import { pool } from "../server/db";
import { decryptSecret, encryptSecret, secretKeyAge } from "../server/services/mfaService";

async function main() {
  const statusOnly = process.argv.includes("--status");
  if (!process.env.MFA_ENCRYPTION_KEY) throw new Error("Set MFA_ENCRYPTION_KEY (the new key) and MFA_ENCRYPTION_KEY_PREVIOUS (the old one).");
  const { rows } = await pool.query("SELECT user_id, secret_ciphertext FROM user_mfa");
  const tally = { current: 0, previous: 0, unreadable: 0, rekeyed: 0, skipped: 0 };
  for (const r of rows as { user_id: string; secret_ciphertext: string }[]) {
    const age = secretKeyAge(r.secret_ciphertext);
    if (age === "current" && r.secret_ciphertext.startsWith("v2.")) { tally.current++; continue; }
    // "previous", or a legacy v1 value whose key is not recorded: read it with whichever key opens it.
    let plain: string;
    try {
      plain = decryptSecret(r.user_id, r.secret_ciphertext);
    } catch {
      tally.unreadable++;
      continue;
    }
    if (age === "previous") tally.previous++; else tally.current++;
    if (statusOnly) continue;
    const res = await pool.query("UPDATE user_mfa SET secret_ciphertext = $3, updated_at = now() WHERE user_id = $1 AND secret_ciphertext = $2", [r.user_id, r.secret_ciphertext, encryptSecret(r.user_id, plain)]);
    if (res.rowCount) tally.rekeyed++; else tally.skipped++;
  }
  if (!statusOnly) {
    await pool.query("INSERT INTO audit_logs (action, target_type, metadata) VALUES ('mfa.rekeyed', 'system', $1)", [JSON.stringify({ ...tally, operator: process.env.USER ?? "unknown" })]);
  }
  console.log(`${statusOnly ? "Status" : "Done"}: ${rows.length} stored secret(s); ${JSON.stringify(tally)}`);
  if (tally.unreadable) {
    console.error(`${tally.unreadable} secret(s) cannot be read with either key. Those people need \`npm run mfa:reset\`.`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
