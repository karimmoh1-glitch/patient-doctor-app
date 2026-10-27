# Review packets: what a qualified person is being asked to decide

Engineering cannot self-certify any of these. Each packet says what to read, what Avela claims and does not claim, the specific questions, and the evidence the
reviewer should expect back. None of them is a statement of compliance with any law or standard, and none has been done. Status lives in
`docs/PRODUCTION_READINESS.md` (gates G21-G25 and the approvals table).

## 1. Clinical review
**Reviewer:** a licensed clinician (preferably one who has run a telehealth service).
**Read:** the patient-facing text for reminders, prescriptions (as displayed), onboarding, "stop sharing" and the emergency screen (`client/src/locales/en/*.ts`); `docs/SAFETY_AND_COMPLIANCE.md`; `docs/CONNECTION_END.md`.
**Avela claims:** it gives no diagnosis, dosing, interaction or treatment advice; a reminder is a nudge, never a record of a dose; prescriptions are written and authorised by the clinician and are not sent to any pharmacy; it is not an emergency service.
**Questions:** (1) Is any wording a patient could read as advice? (2) Is "not confirmed" the right way to describe an unlogged dose to a caregiver? (3) Is the connection-end rule safe (a patient can end at once; a booked visit needs an explicit choice; the clinician keeps their own record)? Should a prescriber be told when a patient ends? (4) What must happen to an authorised prescription when the connection ends? (5) Is a three-hour late-reminder cut-off acceptable?
**Evidence back:** a signed review note naming the version reviewed (commit), with required changes listed.

## 2. Legal and privacy review (per jurisdiction: US states served, Egypt)
**Reviewer:** counsel with health-privacy and telehealth experience in each jurisdiction.
**Read:** `docs/SAFETY_AND_COMPLIANCE.md`, `docs/DATA_FLOW.md`, `docs/THREAT_MODEL.md`, `docs/DATABASE_ACCESS_AUDIT.md`, `docs/CONNECTION_END.md`, the in-product terms/privacy pages.
**Avela claims:** nothing about compliance. It documents what data goes where (database host, e-mail provider if configured), keeps an access log patients can read, lets a patient export their data and request deletion (an operator erases), and states plainly what it does not do.
**Questions:** consent and terms wording; retention periods (none are stated: visit records, prescriptions, audit logs, messages after a connection ends, erased-account remnants); breach-notification duties and who is responsible (no procedure exists); data-processing terms with the hosting provider, database provider and e-mail provider (none exists; the host plan is a consumer tier); cross-border transfer; whether storing a clinician's licence number is permitted as designed; whether the connection-end rule satisfies provider record-keeping duties.
**Evidence back:** written advice, a list of required text changes, the retention schedule, a breach procedure.

## 3. Fluent Arabic review
**Reviewer:** a fluent Arabic reader (and, for medical wording, a clinician who works in Arabic).
**Read:** `client/src/locales/ar/*.ts` (written by the engineering assistant; marked "awaiting review"), the right-to-left layouts (`e2e` and `e2e-live` already check direction).
**Questions:** correctness and tone; terms of art (medicine, prescription, reminder, "stop sharing"); numerals and dates; places where text is longer than the layout allows; any phrase that implies a guarantee.
**Evidence back:** a corrected `ar` locale set or a list of corrections.

## 4. Emergency-number verification
**Reviewer:** someone who can check official sources: for the US, FCC/911.gov; for **Egypt, an Egyptian resident** (only a US-government compilation was found; no Egyptian official source).
**Read:** `shared/emergency.ts` and the `EMERGENCY_DATA_VERSION` constant. In production the screens show **no number** until `EMERGENCY_DATA_REVIEWED_BY`, `EMERGENCY_DATA_REVIEWED_VERSION` and `EMERGENCY_DATA_REVIEWED_COUNTRIES` are set by a named person.
**Questions:** is each number, and each label, correct today? Is there a regional variation (tourist police, ambulance service) the screen must mention?
**Evidence back:** the reviewer's name, date, sources consulted, the version string.

## 5. Independent penetration test
**Reviewer:** a third-party security firm.
**Scope to offer:** the deployed application; the authentication, second-factor and recovery flows; every role boundary (`docs/DATABASE_ACCESS_AUDIT.md` §9 lists the claims to attack); the signed-identity boundary (`docs/IDENTITY_BOUNDARY.md`, especially §4-5: a public-route injection is the known weak point); organization-staff scoping (`server/services/orgs.ts`); the scheduler and webhook endpoints; the release and rollback procedure.
**Provide:** a staging deployment on a restored copy with synthetic accounts (needs the provider restore drill), the threat model, the audit, this list of known limits.
**Evidence back:** a report with severities and a retest.

## 6. E-mail provider terms and data-processing requirements
**Owner + counsel.** The provider receives each recipient address and message body (reminders carry no medicine name by default; invitations name the inviter). Need: account, verified sending domain (SPF/DKIM/DMARC), data-processing terms, the webhook, a real delivery event (`docs/OPERATIONS_RUNBOOK.md` §10). Until then the feature is explicitly unavailable and the product says so.

## 7-9. Evidence the owner collects (engineering supplies the procedure)
| Evidence | Procedure | Done? |
| --- | --- | --- |
| Backup and restore on the real provider | runbook §5 "Provider drill" (a Neon branch of production; `schema:fingerprint` diff, `audit:db`, runtime-role check, counts, preview deployment, recorded times) | No |
| Scheduler reliability | runbook §6 (Worker with its own secret; seven days of ≥ 90% of 288 daily calls from `cloudflare-worker`, shown on `/admin/integrations`) | No (Worker not deployed) |
| Monitoring and alert drill | runbook §11 (heartbeat + uptime monitor + a controlled failure in a preview; record the minute the alert arrives and where) | No |
