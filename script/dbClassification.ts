/**
 * What every table holds and who may reach it. This is the human half of the database access audit: the catalog says what the
 * database enforces (npm run audit:db prints both side by side); this says what it is FOR, so a reviewer can tell whether the
 * enforcement is the right one. A table added without an entry here fails tests/dbClassification.test.ts.
 *
 * data:  PII = identity / contact · AUTH = credentials, tokens, sessions, secrets · CLIN = health or clinical · TENANT = organization data
 *        OPS = operational metadata · REF = reference data with no personal information
 * path:  user = queried under the signed-in person's identity (row policies decide) · system = the server's own identity
 *        (sign-in, scheduler, webhooks, admin workflows, organization staff after the permission matrix) · definer = through a
 *        SECURITY DEFINER function or view
 */
export interface TableFacts {
  data: ("PII" | "AUTH" | "CLIN" | "TENANT" | "OPS" | "REF")[];
  whose: string;
  path: ("user" | "system" | "definer")[];
  boundary: string;
}

const own = "the person themself";
const patientRecord = "the patient, a connected active doctor, an invited caregiver (read only); written by the patient or a connected doctor";

export const CLASSIFICATION: Record<string, TableFacts> = {
  users: { data: ["PII", "AUTH", "CLIN"], whose: "every account (password hash, contact details, date of birth, emergency profile)", path: ["user", "system"], boundary: "self; the other side of a doctor connection or care-circle invitation; colleagues in the same organization; an administrator sees clinicians, administrators, organization staff and message reporters, never other patients. Insert: server only, never an administrator. Update: self or server, role/e-mail/fixture flag immutable, e-mail verification server only. No DELETE privilege." },
  user_devices: { data: ["AUTH"], whose: "each signed-in browser or device", path: ["user", "system"], boundary: own },
  user_mfa: { data: ["AUTH"], whose: "clinicians, staff, administrators (encrypted authenticator secret, lock-out state)", path: ["system"], boundary: "server only: nobody, including the owner of the secret, can read it through the application role" },
  mfa_recovery_codes: { data: ["AUTH"], whose: "second-factor recovery (hashed codes)", path: ["system"], boundary: "server only" },
  password_reset_tokens: { data: ["AUTH", "PII"], whose: "single-use reset links (hashed)", path: ["system"], boundary: "server only" },
  email_verification_tokens: { data: ["AUTH"], whose: "single-use confirmation links (hashed)", path: ["system"], boundary: "server only" },
  audit_logs: { data: ["OPS", "PII"], whose: "who read or did what to whose records (append-only)", path: ["user", "system"], boundary: "the subject and the actor read their own entries; an administrator reads all; anyone may add an entry only in their own name; no UPDATE or DELETE privilege, trigger-enforced" },
  doctor_applications: { data: ["PII"], whose: "a clinician's licence and registry details while under review", path: ["user", "system"], boundary: "the applicant, an administrator, the server; an applicant can submit but not decide, and cannot touch review fields" },
  doctor_profiles: { data: ["PII"], whose: "a clinician's directory entry (phone, licence and registry numbers are private)", path: ["user", "system", "definer"], boundary: "the clinician, an administrator, and anyone with a connection to that doctor; the public sees the doctor_directory view; a clinician edits description and contact details only; only the server creates or removes" },
  doctor_directory: { data: ["REF"], whose: "VIEW: listed clinicians' public details", path: ["definer"], boundary: "open to every session by design (a public page); excludes phone, licence and registry numbers; read-only for the application role" },
  doctor_availability: { data: ["OPS"], whose: "a clinician's published weekly windows", path: ["user", "system"], boundary: "public while the clinician is listed; written by that clinician only" },
  doctor_credentials: { data: ["PII"], whose: "licence evidence and its review", path: ["system", "user"], boundary: "the clinician reads their own; the server writes" },
  credential_events: { data: ["OPS"], whose: "append-only history of a credential's review", path: ["system"], boundary: "server only; trigger-enforced append-only" },
  pairing_requests: { data: ["CLIN", "PII"], whose: "a patient-doctor connection and its state", path: ["user", "system"], boundary: "the two parties; parties immutable; only the server deletes" },
  pairing_invitations: { data: ["AUTH", "PII"], whose: "a clinician's invitation codes (hashed)", path: ["user", "system"], boundary: "the inviting clinician; the server redeems" },
  symptom_reports: { data: ["CLIN"], whose: "what a patient wrote when asking for help", path: ["user", "system"], boundary: `${patientRecord}; a doctor also sees the report attached to a request addressed to them` },
  appointments: { data: ["CLIN", "PII"], whose: "visits (time, reason, status)", path: ["user", "system", "definer"], boundary: "the patient, a connected doctor, a caregiver (read), the provider of the visit; parties immutable; others see only free/busy through app_busy_intervals" },
  follow_up_tasks: { data: ["CLIN"], whose: "a patient's follow-up items", path: ["user", "system"], boundary: "as appointments; parties immutable" },
  prescriptions: { data: ["CLIN"], whose: "prescriptions (drafts hidden from the patient)", path: ["user", "system"], boundary: "the doctor of record and connected doctors; the patient and caregivers once authorized; a doctor creates only in their own name for a connected patient; frozen after authorization by trigger" },
  prescription_events: { data: ["CLIN", "OPS"], whose: "append-only history of a prescription", path: ["user", "system"], boundary: "visible exactly when the prescription is; add only in your own name; no UPDATE or DELETE privilege" },
  medications: { data: ["CLIN"], whose: "a patient's tracked medicines", path: ["user", "system"], boundary: patientRecord },
  medication_logs: { data: ["CLIN"], whose: "doses taken or skipped", path: ["user", "system"], boundary: patientRecord },
  medication_reminders: { data: ["CLIN"], whose: "reminder settings", path: ["user", "system"], boundary: patientRecord },
  reminder_deliveries: { data: ["OPS", "CLIN"], whose: "which reminder was sent when, and whether it worked", path: ["system", "user"], boundary: "read only through a reminder you may read; written by the server" },
  personal_reminders: { data: ["CLIN"], whose: "a person's own reminders", path: ["user", "system"], boundary: own },
  personal_reminder_deliveries: { data: ["OPS"], whose: "delivery ledger of personal reminders", path: ["user", "system"], boundary: "through the person's own reminder" },
  documents: { data: ["CLIN"], whose: "a patient's saved papers", path: ["user", "system"], boundary: patientRecord },
  pharmacy_orders: { data: ["CLIN"], whose: "demonstration fulfilment records", path: ["user", "system"], boundary: patientRecord },
  pharmacies: { data: ["REF"], whose: "pharmacy list (demonstration data, no personal information)", path: ["user"], boundary: "any signed-in person reads; nobody writes through the application role" },
  sharing_grants: { data: ["CLIN"], whose: "what a patient lets a doctor see", path: ["user", "system"], boundary: "the patient; the named doctor can see that the grant exists" },
  care_circle_members: { data: ["PII"], whose: "caregivers a patient invited, and what they may see", path: ["user", "system"], boundary: "the patient writes; the caregiver reads their own membership" },
  assist_grants: { data: ["CLIN"], whose: "a patient letting a clinician help fill in their profile", path: ["user", "system"], boundary: "the patient; the named clinician reads" },
  patient_consents: { data: ["CLIN"], whose: "recorded consents", path: ["user", "system"], boundary: "the patient; a clinician with an assist grant reads" },
  allergy_statements: { data: ["CLIN"], whose: "allergies as stated, with who stated them", path: ["user", "system"], boundary: "the patient and people allowed to see the patient's profile" },
  health_entries: { data: ["CLIN"], whose: "conditions and history", path: ["user", "system"], boundary: "the patient and people allowed to see the patient's profile; edits recorded; trigger-guarded" },
  health_entry_events: { data: ["CLIN", "OPS"], whose: "append-only history of profile entries", path: ["user", "system"], boundary: "through the entry; trigger-enforced append-only" },
  onboarding_sections: { data: ["CLIN"], whose: "which profile sections a patient completed", path: ["user", "system"], boundary: own },
  messages: { data: ["CLIN", "PII"], whose: "doctor-patient messages", path: ["user", "system"], boundary: "the two parties; sender and body immutable (trigger); the recipient may only mark delivered/read" },
  message_reports: { data: ["CLIN", "OPS"], whose: "a person reporting a message", path: ["user", "system"], boundary: "the reporter reads; an administrator resolves" },
  user_blocks: { data: ["PII"], whose: "who a person blocked", path: ["user", "system"], boundary: "the blocker" },
  notifications: { data: ["PII"], whose: "in-app notices", path: ["user", "system"], boundary: "the recipient reads and clears; a notice may be left only for yourself or someone you are connected to" },
  ai_messages: { data: ["CLIN", "PII"], whose: "assistant conversation", path: ["user", "system"], boundary: own },
  data_requests: { data: ["PII"], whose: "export and deletion requests", path: ["user", "system"], boundary: own },
  email_deliveries: { data: ["PII", "OPS"], whose: "what was e-mailed to whom and its delivery state", path: ["system"], boundary: "server only" },
  email_webhook_events: { data: ["OPS"], whose: "provider delivery reports (deduplicated)", path: ["system"], boundary: "server only" },
  organizations: { data: ["TENANT"], whose: "clinics and hospitals", path: ["user", "system"], boundary: "members read their own organization; the server writes after the permission matrix" },
  org_memberships: { data: ["TENANT", "PII"], whose: "who works where, in what role", path: ["user", "system"], boundary: "yourself and colleagues in the same organization; the server writes" },
  org_invitations: { data: ["TENANT", "AUTH"], whose: "staff invitations (hashed tokens)", path: ["system"], boundary: "server only" },
  org_tasks: { data: ["TENANT", "CLIN"], whose: "staff tasks about patients", path: ["system", "user"], boundary: "members of the organization read; the server writes; staff reach patients only through server-side scoping" },
  org_notes: { data: ["TENANT", "CLIN"], whose: "internal staff notes (append-only)", path: ["system", "user"], boundary: "members read; the server writes; never shown to patients" },
  job_runs: { data: ["OPS"], whose: "scheduler state and leases", path: ["system"], boundary: "server only" },
  job_run_history: { data: ["OPS"], whose: "one row per scheduler call (evidence of scheduling)", path: ["system"], boundary: "server only" },
  rate_limit_hits: { data: ["OPS"], whose: "shared rate-limit counters keyed by a one-way hash", path: ["system"], boundary: "server only" },
  schema_migrations: { data: ["OPS"], whose: "which migrations have run", path: [], boundary: "no privilege at all for the application role; row-level security on with no policy" },
};
