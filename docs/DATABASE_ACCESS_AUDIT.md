# Database access audit

Status: written 2026-10-26 against production commit `704b7df` (schema 0000–0023) and the candidate that adds migration
`0024_close_rls_gaps.sql`. Every statement below is backed by a command or a test named beside it. This file is the answer to
"who can reach what, in the database, and how do we know".

## 1. What was verified, and how

| Claim | Evidence |
| --- | --- |
| Production's structure is exactly what migrations 0000–0023 produce | `npm run schema:fingerprint` run against production (owner connection, read-only) and against a fresh database built from migrations 0000–0023: **identical fingerprint `5dc5a2698a1e`**, 1,100 facts (columns, constraints, indexes, policies, triggers, function bodies, privileges); migration history identical (24 rows). The fingerprint ignores the owner's name and NOT NULL constraint rows (PostgreSQL 18 lists them, 16 does not). |
| Production has 24 migrations applied, `0023_organizations.sql` last | `schema_migrations` read in the same run |
| The runtime role cannot bypass or administer | `pg_roles`: `avela_runtime` (LOGIN) → member of `avela_app` (NOLOGIN); neither is superuser, `CREATEROLE`, `CREATEDB` or `BYPASSRLS`; `avela_app` owns nothing; has no `CREATE` on the schema; no `TRUNCATE`/`REFERENCES`/`TRIGGER`; nothing at all on `schema_migrations`; only `SELECT`/`INSERT` on `audit_logs` and `prescription_events` |
| Twelve tables were outside row-level security in production | `pg_class.relrowsecurity` read from production: `audit_logs`, `doctor_applications`, `doctor_availability`, `doctor_profiles`, `job_run_history`, `job_runs`, `pharmacies`, `prescription_events`, `rate_limit_hits`, `reminder_deliveries`, `schema_migrations`, `users` |
| The candidate closes all of them, and nothing new is outside | migration 0024; `tests/rlsIdentityTables.test.ts` ("has row-level security on every table in the schema"); `npm run audit:db` (0 findings); `verify:production` check `rls-complete` |

## 2. Roles

| Role | Can log in | Super | Bypass RLS | Create role/db | Purpose |
| --- | --- | --- | --- | --- | --- |
| `neondb_owner` | yes | no | **yes** | yes | Owns every object. Used only by migrations and operator scripts (`npm run db:migrate`, `admin:create`, `demo:retire`, …); **not** configured as the runtime connection |
| `avela_runtime` | yes | no | no | no | The running application (`APP_DATABASE_URL`), member of `avela_app` |
| `avela_app` | no | no | no | no | Group role carrying the application's privileges |
| `neon_superuser`, `cloud_admin`, `neon_service`, `neon_auth`, `token_roles` | provider-managed | provider | provider | provider | The hosting provider's own; not ours to change |

The server refuses to serve a request if the connection could bypass row-level security (`server/db.ts`), and refuses to start in
production on an owner connection unless `ALLOW_OWNER_DATABASE_ROLE=true`.

## 3. The model, in one paragraph

Before each transaction the application presents a **signed, 60-second identity assertion** (`server/identity.ts`) which the database verifies with a key the
application role cannot read (migration 0025; `docs/IDENTITY_BOUNDARY.md`). Policies read the verified identity through `app_user_id()` and
`app_is_system()`. With no valid assertion every policy is false: nothing is visible and nothing can be written. **System** identity is declared route by
route (`systemAccess`: sign-in, sign-up, password reset, e-mail confirmation, invitations, the scheduler, the e-mail webhook) and in named service methods
(organization staff after the permission matrix, administrators acting on another account, background jobs). Every other request runs as the signed-in person,
set by `requireAuth` after a system-identity lookup of the session. Row policies decide which rows; **column privileges** (migration 0026) decide which
columns: of an account row the application role can read only the ten that identify a person.

**What this does not protect against.** The application process holds the signing key: code execution inside it can sign any identity. SQL injection inside
a *public* route runs as `system`. Both are discussed with the full threat table in `docs/IDENTITY_BOUNDARY.md` §4–5 and are why `tests/sqlHygiene.test.ts` forbids
interpolated SQL, why the key is custody-managed and rotatable, and why a scoped replacement for `system` is recommended (D-03b).

## 4. Table inventory (generated: `npm run audit:db -- --markdown`)

Data: PII identity/contact · AUTH credentials, tokens, sessions · CLIN health or clinical · TENANT organization · OPS operational
metadata · REF reference data. App role: S select, I insert, U update, D delete.

| Table | Data | Whose / what | RLS | Policies | App role (S/I/U/D) | Reached by | Boundary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ai_messages` | CLIN, PII | assistant conversation | on | 1 | D,I,S,U | user, system | the person themself |
| `allergy_statements` | CLIN | allergies as stated, with who stated them | on | 1 | D,I,S,U | user, system | the patient and people allowed to see the patient's profile |
| `app_identity_config` | OPS | whether signed identities are enforced, and the longest assertion lifetime accepted | on | 0 | (none) | definer | owner only; read solely by avela_identity_check() |
| `app_identity_keys` | AUTH | the keys the database verifies identity assertions with (HMAC pad blocks, never the key itself) | on | 0 | (none) | definer | owner only: no privilege for the application role; read solely by avela_identity_check() (a SECURITY DEFINER function). Whoever can read this table can mint any identity |
| `appointments` | CLIN, PII | visits (time, reason, status) | on | 4 | D,I,S,U | user, system, definer | the patient, a connected doctor, a caregiver (read), the provider of the visit (who keeps the record after a connection ends and may change it only while open); parties immutable; others see only free/busy through app_busy_intervals |
| `assist_grants` | CLIN | a patient letting a clinician help fill in their profile | on | 2 | D,I,S,U | user, system | the patient; the named clinician reads |
| `audit_logs` | OPS, PII | who read or did what to whose records (append-only) | on | 2 | I,S | user, system | the subject and the actor read their own entries; an administrator reads all; anyone may add an entry only in their own name; no UPDATE or DELETE privilege, trigger-enforced |
| `care_circle_members` | PII | caregivers a patient invited, and what they may see | on | 2 | D,I,S,U | user, system | the patient writes; the caregiver reads their own membership |
| `credential_events` | OPS | append-only history of a credential's review | on | 1 | D,I,S,U | system | server only; trigger-enforced append-only |
| `data_requests` | PII | export and deletion requests | on | 1 | D,I,S,U | user, system | the person themself |
| `doctor_applications` | PII | a clinician's licence and registry details while under review | on | 4 | D,I,S,U | user, system | the applicant, an administrator, the server; an applicant can submit but not decide, and cannot touch review fields |
| `doctor_availability` | OPS | a clinician's published weekly windows | on | 2 | D,I,S,U | user, system | public while the clinician is listed; written by that clinician only |
| `doctor_credentials` | PII | licence evidence and its review | on | 2 | D,I,S,U | system, user | the clinician reads their own; the server writes |
| `doctor_directory` (view) | REF | VIEW: listed clinicians' public details | n/a (owner's rights) | 0 | S | definer | open to every session by design (a public page); excludes phone, licence and registry numbers; read-only for the application role |
| `doctor_profiles` | PII | a clinician's directory entry (phone, licence and registry numbers are private) | on | 4 | D,I,S,U | user, system, definer | the clinician, an administrator, and anyone with a connection to that doctor; the public sees the doctor_directory view; a clinician edits description and contact details only; only the server creates or removes |
| `documents` | CLIN | a patient's saved papers | on | 2 | D,I,S,U | user, system | the patient, a connected active doctor, an invited caregiver (read only); written by the patient or a connected doctor |
| `email_deliveries` | PII, OPS | what was e-mailed to whom and its delivery state | on | 1 | D,I,S,U | system | server only |
| `email_verification_tokens` | AUTH | single-use confirmation links (hashed) | on | 1 | D,I,S,U | system | server only |
| `email_webhook_events` | OPS | provider delivery reports (deduplicated) | on | 1 | D,I,S,U | system | server only |
| `follow_up_tasks` | CLIN | a patient's follow-up items | on | 4 | D,I,S,U | user, system | the patient and a LIVE connection's clinician (the clinician sees and changes tasks only while connected); parties immutable |
| `health_entries` | CLIN | conditions and history | on | 1 | D,I,S,U | user, system | the patient and people allowed to see the patient's profile; edits recorded; trigger-guarded |
| `health_entry_events` | CLIN, OPS | append-only history of profile entries | on | 2 | D,I,S,U | user, system | through the entry; trigger-enforced append-only |
| `job_run_history` | OPS | one row per scheduler call (evidence of scheduling) | on | 1 | D,I,S,U | system | server only |
| `job_runs` | OPS | scheduler state and leases | on | 1 | D,I,S,U | system | server only |
| `medication_logs` | CLIN | doses taken or skipped | on | 2 | D,I,S,U | user, system | the patient, a connected active doctor, an invited caregiver (read only); written by the patient or a connected doctor |
| `medication_reminders` | CLIN | reminder settings | on | 2 | D,I,S,U | user, system | the patient, a connected active doctor, an invited caregiver (read only); written by the patient or a connected doctor |
| `medications` | CLIN | a patient's tracked medicines | on | 2 | D,I,S,U | user, system | the patient, a connected active doctor, an invited caregiver (read only); written by the patient or a connected doctor |
| `message_reports` | CLIN, OPS | a person reporting a message | on | 3 | D,I,S,U | user, system | the reporter reads; an administrator resolves |
| `messages` | CLIN, PII | doctor-patient messages | on | 3 | D,I,S,U | user, system | the patient always; the clinician only while the connection is live; writing only while live; sender and body immutable (trigger); the recipient may only mark delivered/read |
| `mfa_recovery_codes` | AUTH | second-factor recovery (hashed codes) | on | 1 | D,I,S,U | system | server only |
| `notifications` | PII | in-app notices | on | 4 | D,I,S,U | user, system | the recipient reads and clears; a notice may be left only for yourself or someone you are connected to |
| `onboarding_sections` | CLIN | which profile sections a patient completed | on | 1 | D,I,S,U | user, system | the person themself |
| `org_invitations` | TENANT, AUTH | staff invitations (hashed tokens) | on | 1 | D,I,S,U | system | server only |
| `org_memberships` | TENANT, PII | who works where, in what role | on | 2 | D,I,S,U | user, system | yourself and colleagues in the same organization; the server writes |
| `org_notes` | TENANT, CLIN | internal staff notes (append-only) | on | 2 | D,I,S,U | system, user | members read; the server writes; never shown to patients |
| `org_tasks` | TENANT, CLIN | staff tasks about patients | on | 2 | D,I,S,U | system, user | members of the organization read; the server writes; staff reach patients only through server-side scoping |
| `organizations` | TENANT | clinics and hospitals | on | 2 | D,I,S,U | user, system | members read their own organization; the server writes after the permission matrix |
| `pairing_invitations` | AUTH, PII | a clinician's invitation codes (hashed) | on | 2 | D,I,S,U | user, system | the inviting clinician; the server redeems |
| `pairing_requests` | CLIN, PII | a patient-doctor connection and its state | on | 4 | D,I,S,U | user, system | the two parties; parties immutable; only the server deletes |
| `password_reset_tokens` | AUTH, PII | single-use reset links (hashed) | on | 1 | D,I,S,U | system | server only |
| `patient_consents` | CLIN | recorded consents | on | 2 | D,I,S,U | user, system | the patient; a clinician with an assist grant reads |
| `personal_reminder_deliveries` | OPS | delivery ledger of personal reminders | on | 1 | D,I,S,U | user, system | through the person's own reminder |
| `personal_reminders` | CLIN | a person's own reminders | on | 1 | D,I,S,U | user, system | the person themself |
| `pharmacies` | REF | pharmacy list (demonstration data, no personal information) | on | 1 | S | user | any signed-in person reads; nobody writes through the application role |
| `pharmacy_orders` | CLIN | demonstration fulfilment records | on | 2 | D,I,S,U | user, system | the patient, a connected active doctor, an invited caregiver (read only); written by the patient or a connected doctor |
| `prescription_events` | CLIN, OPS | append-only history of a prescription | on | 2 | I,S | user, system | visible exactly when the prescription is; add only in your own name; no UPDATE or DELETE privilege |
| `prescriptions` | CLIN | prescriptions (drafts hidden from the patient) | on | 4 | D,I,S,U | user, system | the doctor of record and connected doctors; the patient and caregivers once authorized; a doctor creates only in their own name for a connected patient; frozen after authorization by trigger |
| `rate_limit_hits` | OPS | shared rate-limit counters keyed by a one-way hash | on | 1 | D,I,S,U | system | server only |
| `reminder_deliveries` | OPS, CLIN | which reminder was sent when, and whether it worked | on | 2 | D,I,S,U | system, user | read only through a reminder you may read; written by the server |
| `schema_migrations` | OPS | which migrations have run | on | 0 | (none) | none | no privilege at all for the application role; row-level security on with no policy |
| `sharing_grants` | CLIN | what a patient lets a doctor see | on | 2 | D,I,S,U | user, system | the patient; the named doctor can see that the grant exists |
| `symptom_reports` | CLIN | what a patient wrote when asking for help | on | 2 | D,I,S,U | user, system | the patient, a connected active doctor, an invited caregiver (read only); written by the patient or a connected doctor; a doctor also sees the report attached to a request addressed to them |
| `user_blocks` | PII | who a person blocked | on | 1 | D,I,S,U | user, system | the blocker |
| `user_devices` | AUTH | each signed-in browser or device | on | 1 | D,I,S,U | user, system | the person themself |
| `user_mfa` | AUTH | clinicians, staff, administrators (encrypted authenticator secret, lock-out state) | on | 1 | D,I,S,U | system | server only: nobody, including the owner of the secret, can read it through the application role |
| `users` | PII, AUTH, CLIN | every account. The application role may READ only ten identifying columns (id, name, role, language, time zone, read receipts, fixture flag, created/deactivated/confirmed dates); the password hash, e-mail, phone, state, date of birth, emergency profile and preferences are released only by app_user_private / app_user_credentials* / app_user_contacts to the person, the server or the sign-in steps | on | 3 | I,U | user, system, definer | row: self; the other side of a doctor connection (live) or of a visit the doctor provides; care-circle parties; colleagues; an administrator sees clinicians, administrators, organization staff and message reporters. Column: public ten only. Insert: server only, never an administrator. Update: self or server, role/e-mail/fixture flag immutable, e-mail verification server only. No DELETE privilege. |

## 5. Functions

All functions are executable only by their owner and, for the application role, only the policy helpers (`app_*`). `PUBLIC` holds no
`EXECUTE` (it did before 0024: every function, including the trigger functions and `avela_apply_grants()`, was executable by every role).

- SECURITY DEFINER functions: app_admin_may_see_user, app_busy_intervals, app_can_see_user, app_doctor_has_report, app_has_assist_grant, app_has_pairing_with_profile, app_in_pairing, app_is_admin, app_is_caregiver_of, app_is_connected_doctor, app_is_listed_doctor, app_is_org_member, app_may_read_conversation, app_may_write_conversation, app_my_doctor_profiles, app_user_contacts, app_user_credentials, app_user_credentials_by_id, app_user_private, app_verified_system, app_verified_user, avela_identity_check
- Policy helpers the application role may execute: app_admin_may_see_user, app_busy_intervals, app_can_read_patient, app_can_see_profile, app_can_see_user, app_can_write_patient, app_doctor_has_report, app_has_assist_grant, app_has_pairing_with_profile, app_in_pairing, app_is_admin, app_is_caregiver_of, app_is_connected_doctor, app_is_listed_doctor, app_is_org_member, app_is_system, app_may_read_conversation, app_may_write_conversation, app_my_doctor_profiles, app_owns, app_restricted_session, app_user_contacts, app_user_credentials, app_user_credentials_by_id, app_user_id, app_user_private, app_verified_system, app_verified_user
- Functions it may not execute: avela_append_only, avela_apply_grants, avela_credential_event_guard, avela_doctor_applications_guard, avela_doctor_profiles_guard, avela_health_entry_guard, avela_health_events_guard, avela_identity_check, avela_message_guard, avela_org_notes_guard, avela_parties_immutable, avela_prescription_guard, avela_users_guard, zz_fail_invitation

Every SECURITY DEFINER function fixes `search_path = public, pg_temp` (test: "gives every SECURITY DEFINER function a fixed search_path").
`zz_fail_invitation` exists only in test databases.

## 6. Privileged execution paths (where identity is "system")

| Family | Where | What bounds it |
| --- | --- | --- |
| Pre-sign-in public endpoints | `systemAccess` on `POST /api/auth/{signup,login,forgot-password,reset-password,email/verify,mfa/setup,mfa/enable,mfa/verify}`, `POST /api/doctors/register`, `GET/POST /api/care-circle/invitations/*`, `POST /api/orgs/invitations/{preview,accept-new}`, `POST /api/webhooks/resend`, `GET/POST /api/cron/reminders` | `tests/routeInventory.test.ts` enumerates every endpoint and fails on one that is not classified; rate limits; single-use hashed tokens; webhook signature and cron secret checks |
| Session lookup | `server/middleware/auth.ts`: device and user are read as system, then `enterUser(id)` | session needs a live, unrevoked device row; suspension revokes in the same transaction |
| Organization staff | `server/services/orgs.ts` (29 `runAsSystem` sites) | staff have no relationship row a policy could test; every function checks the permission matrix and scopes to the organization's own clinicians' accepted, staff-visible patients first. **Security-critical file**; attacked from outside by `tests/orgs.test.ts` and `tests/reviewFindings.test.ts` |
| Administrator workflows | `approve/suspend/reinstate` doctor, message-report resolution, credential review (`storage.ts`, `credentialService.ts`) | `adminOnly` (role read live + second factor); every decision audited |
| Background work | reminders, personal reminders, e-mail delivery ledger, integrations check (`services/*`) | called only from the cron endpoint or the server itself |
| Rate limiter | `server/middleware/pgRateLimitStore.ts` | writes only hashed counters |
| Operator scripts | `script/*` on the owner connection | run from a trusted shell; `script/asOperator.ts` makes them ignore the restricted URL |

## 7. Findings and what was done

| ID | Finding | Severity | Fix | Regression test |
| --- | --- | --- | --- | --- |
| F1 | Twelve tables outside row-level security, including `users` (password hashes, contact details, date of birth, emergency profile), the access log, `doctor_profiles` (phone, licence numbers) | High | Migration 0024: policies per table by data class (section 4) | `rlsIdentityTables.test.ts` (25 tests, every table, allowed and denied) |
| F2 | `PUBLIC` could execute every function, including the privileged `avela_apply_grants()` and all trigger functions; the application role could execute them too | Medium | `avela_apply_grants()` revokes from `PUBLIC` and grants the application role only `app_*` helpers; default privileges changed | "lets nobody but the owner run the database's functions…" |
| F3 | Nothing in the database stopped the application role creating an `admin`, changing a role, rewriting an e-mail address, setting its own `email_verified_at`, or clearing a suspension (`doctor_profiles.active`) — only route code did | High (defence in depth) | Guard triggers `users_guard`, `doctor_profiles_guard`, `doctor_applications_guard` bound to the restricted role | "never lets the application make or become an administrator…", "lets a clinician edit how they are described, never whether they are active…" |
| F4 | Either party to a connection, visit or follow-up could re-point the row at a stranger (the clinician's update check "still my profile" stays true), making it visible to and attributed to someone with no relationship | Medium | `avela_parties_immutable` triggers on `pairing_requests`, `appointments`, `follow_up_tasks` | "refuses to move a connection, appointment or follow-up to another patient or doctor…" |
| F5 | Any signed-in person could leave a notification for any account (a way to put words in front of a stranger) | Low | Insert policy narrowed to yourself and people you are connected to | `rls.test.ts` "…leave a notice for someone they are connected to…" |
| F6 | A simple view is writable *with its owner's rights, skipping row-level security*. The directory view would have been writable by the application role (the grant function granted `INSERT/UPDATE/DELETE` on all relations) | High, caught before release by the grants test | The grant function revokes writes on the view | "limits the application role's table privileges to what each table is for" |
| F7 | `checkReadiness` counted users and scheduler calls through whatever identity was ambient; through the restricted role with nobody established every count would be zero and "no demo account is active" would pass for the wrong reason | Medium | Runs as system | `productionGuards.test.ts` (readiness) |
| F8 | After a patient ends a connection, the doctor keeps the visit record, including the patient's name and stated reason, for visits they delivered *or are booked to deliver* | Decision | **Not changed** — product/clinical/legal call (D-02). Pinned by a test so a change is deliberate | "a documented exception…" in `accessEndsEverywhere.test.ts` |
| F9 | `password_hash` is readable by the user's own session and by the server; column-level privileges would break `SELECT *` queries throughout the application | Accepted | Row policy limits it to the account itself (and the server); passwords are bcrypt hashes | — |
| F11 | **Real caregivers were invisible to row-level security.** Migration 0014's `app_is_caregiver_of` looked for membership status `'accepted'`; the application's value is `'active'` (invited \| active \| revoked). Under the restricted role (live in production since 2026-10-26) a caregiver therefore saw an empty overview. The 0014 tests inserted `'accepted'` by hand and agreed with the bug; it surfaced when the browser suite ran against the restricted role after `users` got a policy | High (fails closed, but breaks a feature, and shows how a policy can disagree with the application) | `app_is_caregiver_of` corrected in 0024; fixtures now use the real status | "shows a real caregiver the patient's name, today's medicines and upcoming visits" (goes through the real invitation and checks content; fails against the old helper), `e2e/roles.spec.ts` under `test:e2e:rls` |
| F12 | No bounce or complaint suppression: invitations and reminders kept being sent to addresses that bounced permanently or complained | Medium | `isSuppressed` before every non-essential send | `emailDeliveries.test.ts` "suppression after a bounce or a complaint" |
| F13 | Scheduler source was a self-chosen label: anyone holding the shared cron secret (a GitHub workflow) could appear as the dedicated scheduler | Medium | The server attests a caller by which secret it presents (`CRON_SECRET_CLOUDFLARE`); a claim is recorded as `claimed:…` | `scheduler.test.ts` "who called: attested by secret, not by label" |
| F14 | **Identity was connection-scoped behind a transaction-mode connection pooler.** Production reaches Postgres through Neon's PgBouncer; session-wide settings written by the application were read back by other clients (26 of 200 reads) or not at all (own value 3 of 200) | **Critical** (cross-user data exposure under concurrency; hidden today by zero users and serial traffic) | Identity is transaction-local and signed (0025) | `identityBoundary.test.ts` ("a pooled connection never carries an identity…") with a mutation check |
| F15 | The identity itself was forgeable by anyone who could run SQL as the application role (two plain settings) | High | Signed assertion verified in the database; key unreadable by the role | `identityBoundary.test.ts` (forged, tampered, expired, wrongly keyed, retired, plain settings, key access) |
| F16 | A connected clinician (and a caregiver, a colleague, anyone who may see an account row) could read the whole row: password hash, e-mail, phone, date of birth, emergency profile, preferences | High | Column privileges: the role reads ten identifying columns only; private columns come through `app_user_*` functions that check who is asking (0026) | `privateAccountColumns.test.ts` (15 private columns × 6 identities, joins/subqueries/RETURNING, the functions, and a 400-request API crawl for hash, address and marker values) |
| F17 | The database allowed a clinician to keep reading an ended conversation and a patient's follow-up tasks, and to rewrite a finished visit | Medium | Policies tightened (0027); visits stay the provider's record, changeable only while open | `connectionEnd.test.ts` (database level) |
| F18 | Ending a connection settled upcoming visits implicitly (they just stayed) | Medium (product/privacy) | The patient must choose cancel or keep (409 until they do) | `connectionEnd.test.ts` |
| F10 | `doctor_applications.password_hash` is a legacy column ("new registrations keep the password only on the user row"); 0 rows in production | Low | Left (empty); candidate for a later drop | — |

## 8. Unresolved exceptions (read these)

1. **The application process holds the signing key** (`IDENTITY_BOUNDARY.md` §4): code execution there can sign any identity.
2. **`system` is one broad capability**, used by 16 public routes and many services; an injection in a public route would have it (§5 there; D-03b).
3. **System identity in `orgs.ts`** (29 sites) is correct by the permission matrix, not by row policies. Treat as security-critical.
4. **Historical visits stay with the provider** after a connection ends (F8, now an explicit rule in `docs/CONNECTION_END.md`; retention periods are a legal question).
5. **The test database is PostgreSQL 16 locally** (18 in CI and production).
6. Coarse policies by design (docs/SECURITY.md): they do not check which sections a patient shared or individual caregiver permissions; the application narrows further.
7. Plain-text e-mail addresses remain in `doctor_applications` and the per-feature tables that hold an address of their own (care-circle invitations, organization invitations, password-reset tokens) — each behind its own policy, none readable by counterparts.

## 9. Where each required adversarial scenario is tested

Each runs under the restricted role (`npm run test:rls`, and the browser suite with `test:e2e:rls`) as well as the owner connection; the direct-SQL ones connect as `avela_app`
whatever the application under test uses.

| Scenario | Direct (SQL as the restricted role) | Through the API |
| --- | --- | --- |
| One patient cannot read another's profile or records | `rls.test.ts` "follows the written matrix for every kind of person"; `rlsIdentityTables.test.ts` users | `authorization.test.ts`, `dataRights.test.ts`, per-feature suites |
| A clinician cannot reach an unrelated patient | same matrix (D2 vs A); users, doctor_profiles | `accessEndsEverywhere.test.ts` (six doctor endpoints before/after), `roleBoundaries.test.ts` |
| One organization cannot reach another's records | org tables in `rls.test.ts` | `orgs.test.ts`, `reviewFindings.test.ts` |
| A caregiver is limited to their active grant | "makes a caregiver read-only"; users/profile visibility | `careCircle.test.ts`; `accessEndsEverywhere.test.ts` (content, revocation, other patients) |
| A revoked grant stops at once, everywhere | "stops showing a patient to a doctor the moment the connection ends or the doctor is suspended" | `accessEndsEverywhere.test.ts` (connection ended, sharing withdrawn, caregiver revoked, doctor deactivated), `authorization.test.ts` |
| Suspended or unverified clinicians lose privileges | suspension in the matrix; a suspended clinician cannot re-activate themself | `suspendedDoctor.test.ts`, `doctorOnboarding.test.ts`, `credentials.test.ts` |
| Ordinary users cannot create or become administrators | `rlsIdentityTables.test.ts` "never lets the application make or become an administrator…" (even with system access) | `accessEndsEverywhere.test.ts` "nobody can become an administrator…", `auth.test.ts`, `doctorOnboarding.test.ts` |
| Authentication tables and user records only through intended paths | sessions, single-use tokens, authenticator secrets, recovery codes, `users` | `routeInventory.test.ts`, `mfa.test.ts`, `auth.test.ts` |
| Privileged functions cannot be invoked by unauthorised roles | "lets nobody but the owner run the database's functions…" | — |
| Runtime connections cannot bypass or administer | `rls.test.ts` "the restricted role really is restricted"; `rlsIdentityTables.test.ts` "cannot be talked into reading around the policies" | `productionGuards.test.ts`, the server's own refusal (`rls.test.ts`) |
| Nothing broke: login, MFA, recovery, pairing, admin operations | — | the whole suite under the restricted role (574 tests) and `test:e2e:rls` |
| Every table is behind RLS and classified | `rlsIdentityTables.test.ts`, `dbClassification.test.ts`, `npm run audit:db` | — |
