# Data-flow inventory

Where health-related information goes. "PHI" means anything about a person's health or care. Keep this current whenever an
integration is added; a reviewer should be able to answer "who else can see this?"

| Data | Collected in | Stored | Leaves our servers to | Controls |
| --- | --- | --- | --- | --- |
| Account (name, e-mail, state, country, time zone, password hash) | Sign-up, profile | `users` (bcrypt hash) | The e-mail provider (address and name, for sign-in, reset, invitation and notice mail) | Generic subjects; links single-use and expiring |
| Health information the patient enters (allergies, medicines, history, needs) | Health information screens | `health_entries` (+ `allergy_statements`, `health_entry_events`, `onboarding_sections`) | Nobody | Consent by version required; owner-only by row-level policy; a clinician only under the patient's time-limited grant; every read by a clinician audited; entries never edited in place; erased on closure unless a clinician wrote them |
| Date of birth, preferred name, contact method, accessibility needs, emergency contact and relationship, care preferences | Health information screens | `users` columns | Nobody | Owner-only; erased on closure |
| Symptom description (typed) | Symptom entry | `symptom_reports` | Nobody; matching is local | A doctor reads only while a request is open or a connection accepted; reads audited fail-closed |
| Messages patient to doctor | Chat | `messages` | Nobody | Only the two parties of an accepted connection; never edited or deleted; bodies never logged; patient text erased on closure |
| Message reports | Report dialog | `message_reports` | Nobody | The reporter chooses whether the message text is attached; administrators see only what was attached |
| Appointments | Booking | `appointments` | The e-mail provider only in generic notices | Ownership guards; the database prevents double booking |
| Appointment names and times seen by organization staff | Derived | Not copied | Organization staff, if the patient has not hidden themselves | Per-connection patient switch (`pairing_requests.org_staff_visible`); never the reason; scoped to the organization's own clinicians |
| Prescription records | Doctor | `prescriptions`, `prescription_events` | Nobody; never sent to a pharmacy | Drafts visible only to the author; frozen after authorization |
| Clinician medication reminders | Patient | `medication_reminders`, `reminder_deliveries` | The e-mail provider if the patient chose e-mail; no medicine name unless chosen | Owner-only |
| Personal reminders (medicine, appointment, task, bill, subscription; amounts are notes) | Patient | `personal_reminders`, `personal_reminder_deliveries` | The e-mail provider if chosen; text is generic unless the patient chose to include the title | Owner-only; quiet hours hold e-mail back for good |
| Care-circle membership and sharing grants | Patient | `care_circle_members`, `sharing_grants` | Nobody | Revocable; read access logged |
| Documents | Documents screen | Local disk + metadata (disabled on Vercel) | Nobody | Type allowlist, magic-byte check, never served statically |
| Pairing codes | Clinician | `pairing_invitations` (keyed hashes only) | Nobody | 15 minutes, single use, revocable; the QR holds a token only, in the URL fragment |
| Clinician licence details and the checks made | Application, reviewer | `doctor_applications`, `doctor_credentials`, `credential_events` | Reviewers; a clinician sees their own check status | Self-reported until a reviewer records the check; evidence notes never shown to patients |
| Organization staff, tasks, internal notes | Organization screens | `organizations`, `org_memberships`, `org_invitations`, `org_tasks`, `org_notes` | Nobody | Permission matrix; tenant scoping; notes append-only, never shown to patients; reads of notes audited |
| E-mail delivery evidence | Provider webhook | `email_deliveries`, `email_webhook_events` | Nobody | Provider message id, purpose and a keyed hash of the address only: no address, no content |
| Second-factor secrets and recovery codes | Enrolment | `user_mfa` (AES-256-GCM, bound to the user), `mfa_recovery_codes` (hashes) | Nobody | System-only tables |
| Audit events | Every sensitive action | `audit_logs` | Nobody | Actor, subject, action, target; no record contents |
| Server logs | Every request | Host log stream | The host's log service | Method, path pattern, status, duration only |
| Browser storage | Client | Text size, language, chosen country for emergency numbers, a pending code or invitation for this tab only | n/a | Session lives in an `HttpOnly` cookie, not in storage |

## Not collected

Analytics, advertising identifiers, device fingerprints beyond a revocable session label, location (the SOS "share location"
control is explicit and only sent if the patient then sends an alert).

## Third parties (none is required to run; none is connected in production today)

The e-mail provider (Resend). Video, SMS, push, pharmacy, registry and single-sign-on providers do not exist in the code.
Each provider needs a data-processing agreement appropriate to the launch jurisdiction **before** real patient data touches it.
