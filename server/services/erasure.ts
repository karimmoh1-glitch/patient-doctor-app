import fs from "fs";
import path from "path";
import type { Pool } from "pg";
import crypto from "crypto";

export interface ErasureReport {
  userId: string;
  erased: Record<string, number>;
  retained: string[];
  filesRemoved: number;
}

/**
 * Removes a person's identity and the free text they wrote, in ONE transaction.
 *
 * What it does NOT do, on purpose, because it is a legal and clinical decision
 * that Avela cannot make for an operator:
 *  - it keeps what a DOCTOR authored about the person (visit notes, authorized
 *    prescriptions and their history, doctors' messages). Medical-record
 *    retention law in many places requires it; these records no longer carry a
 *    name, an email or any contact detail, only an anonymous identifier;
 *  - it keeps the append-only access log (it holds identifiers, not content).
 * An operator who is legally required to erase those as well must do it
 * deliberately, with that law in front of them.
 *
 * The account is left unusable: deactivated, a random password, a placeholder
 * name and an address that cannot receive mail.
 */
export async function eraseUser(pool: Pool, userId: string, opts: { uploadsDir?: string } = {}): Promise<ErasureReport> {
  const erased: Record<string, number> = {};
  const files: string[] = [];
  const client = await pool.connect();
  const run = async (key: string, sql: string, params: unknown[] = [userId]) => {
    const r = await client.query(sql, params);
    erased[key] = (erased[key] ?? 0) + (r.rowCount ?? 0);
    return r;
  };
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!exists.rowCount) throw new Error("No such user");

    const docs = await client.query("SELECT file_path FROM documents WHERE patient_user_id = $1 AND file_path IS NOT NULL", [userId]);
    files.push(...docs.rows.map((d) => d.file_path as string));

    await run("symptomReports", "UPDATE symptom_reports SET symptom_text = '[erased]', transcription_provider = NULL WHERE patient_user_id = $1");
    await run("patientMessages", "UPDATE messages SET body = '[erased]' WHERE sender_user_id = $1");
    await run("appointmentText", "UPDATE appointments SET reason = '[erased]', questions_for_doctor = '[]'::jsonb WHERE patient_user_id = $1");
    await run("documents", "UPDATE documents SET title = '[erased]', notes = NULL, file_name = NULL, file_path = NULL WHERE patient_user_id = $1");
    await run("assistantMessages", "DELETE FROM ai_messages WHERE user_id = $1");
    await run("notifications", "DELETE FROM notifications WHERE user_id = $1");
    await run("reminders", "DELETE FROM medication_reminders WHERE patient_user_id = $1");
    await run("personalReminders", "DELETE FROM personal_reminders WHERE patient_user_id = $1");
    await run("sharingGrants", "UPDATE sharing_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE patient_user_id = $1");
    await run("careCircle", "UPDATE care_circle_members SET name = 'Deleted', invite_email = 'deleted@invalid', token_hash = NULL, status = 'revoked' WHERE patient_user_id = $1");
    await run("resetTokens", "DELETE FROM password_reset_tokens WHERE email = (SELECT email FROM users WHERE id = $1)");
    await run("sessions", "UPDATE user_devices SET revoked_at = COALESCE(revoked_at, now()), name = NULL WHERE user_id = $1");
    // What the patient wrote about their own health is erased (the entry keeps its kind, author and time, with a tombstone).
    // What a clinician entered is kept, like other clinician-authored records (see above).
    await run("healthEntries", `UPDATE health_entries SET data = '{"erased": true}'::jsonb, dispute_note = NULL WHERE patient_user_id = $1 AND source = 'patient_reported'`);
    await run("healthEntryEvents", `UPDATE health_entry_events SET data = NULL, note = '[erased]' WHERE entry_id IN (SELECT id FROM health_entries WHERE patient_user_id = $1 AND source = 'patient_reported')`);
    await run("allergyStatements", "DELETE FROM allergy_statements WHERE patient_user_id = $1");
    await run("onboardingSections", "DELETE FROM onboarding_sections WHERE patient_user_id = $1");
    await run("assistGrants", "UPDATE assist_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE patient_user_id = $1");
    await run("account", `UPDATE users SET name = 'Deleted user', email = $2, password_hash = $3, phone = NULL, state = NULL,
        emergency_contact_name = NULL, emergency_contact_phone = NULL, allergies_text = NULL, emergency_notes = NULL,
        date_of_birth = NULL, preferred_name = NULL, accessibility_notes = NULL, country = NULL, contact_method = NULL,
        emergency_contact_relationship = NULL, care_preferences = '{}'::jsonb,
        deactivated_at = COALESCE(deactivated_at, now()) WHERE id = $1`,
      [userId, `deleted-${userId}@invalid.example`, crypto.randomBytes(32).toString("hex")]);
    await run("dataRequests", "UPDATE data_requests SET status = 'done', completed_at = now() WHERE user_id = $1 AND kind = 'deletion' AND status = 'open'");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Files are removed only after the database change is safely committed.
  let filesRemoved = 0;
  if (opts.uploadsDir) {
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(opts.uploadsDir, path.basename(f)));
        filesRemoved++;
      } catch {
        // Already gone, or on a disk this process cannot reach: the operator must check the storage.
      }
    }
  }
  return {
    userId,
    erased,
    filesRemoved,
    retained: [
      "visit notes, follow-up instructions and doctors' messages written by doctors",
      "authorized prescriptions and their history (now linked to an anonymous account)",
      "the append-only access log (identifiers only)",
    ],
  };
}
