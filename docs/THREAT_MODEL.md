# Threat model

Scope: the Avela web application, its API, its database and the services it depends on. Written against the code as it
exists (`docs/PRODUCT_ARCHITECTURE.md`). It is an engineering analysis, not an independent assessment; **no penetration
test has been performed**. "Control" means something that exists and is tested; "gap" means it does not.

## Assets, most sensitive first

1. Health information a patient or clinician enters: messages, symptom reports, prescriptions, appointments, medicines,
   documents, care-circle membership.
2. Identity and credentials: password hashes, session cookies, single-use reset and invitation tokens, MFA secrets and
   recovery codes (once MFA is built), clinician licence details.
3. The integrity of records that others rely on: authorized prescriptions, the audit log, who is a verified clinician.
4. Availability of time-critical functions: medication reminders, appointment notices.
5. Operator secrets: `JWT_SECRET`, `CRON_SECRET`, database credentials, provider API keys.

## Actors

Anonymous visitor · patient · caregiver · clinician (pending / approved / suspended) · clinic staff (planned) ·
administrator · operator with infrastructure access · another tenant (planned) · a compromised dependency or vendor ·
an automated attacker.

## Trust boundaries

Browser ↔ Vercel edge ↔ serverless function ↔ Neon Postgres; function ↔ external providers (none connected today);
scheduler caller ↔ `/api/cron/*`; operator machine ↔ database (owner credentials).

## Threats and controls

| # | Threat | Controls that exist | Gaps / residual |
| --- | --- | --- | --- |
| T1 | **Reading another patient's records (IDOR)** | Every query keyed by the session's user; ownership re-checked per record; role matrix test over all endpoints; database row-level security with a restricted role (tested in CI) | Production still connects as the table owner, so the database layer is **not enforced there yet**. Policies are coarser than app rules |
| T2 | Clinician reads a patient they are not connected to | Connection must be `accepted` and the clinician active, checked live; sharing grants; database policy requires the same | Same as T1 |
| T3 | **Cross-organization access** | Every organization query starts from the caller's own membership; another organization or a made-up id answers an identical "not found"; staff see only patients of their own organization's clinicians who allowed it, as name and times; no role has a clinical-record permission; tasks and notes are scoped by organization; `tests/orgs.test.ts` attacks it | Staff reads run with system database access after the permission check (no row policy can express them), so `server/services/orgs.ts` is a single point to get right; no penetration test |
| T4 | Privilege escalation via request fields | Role and status read from the database, never from the request or token; strict schemas; administrators only via an operator script | |
| T5 | **Credential stuffing / brute force** | Per-address and per-account login limits (shared across instances in production), bcrypt, generic failure, weak/common password refusal; second factor for clinicians, staff and administrators | Patients and caregivers have no second factor |
| T6 | Account enumeration | Identical responses and equalized work for login and reset | A small timing difference remains on reset (one extra write) |
| T7 | **Session theft by script injection** | `HttpOnly` `SameSite=Strict` cookie, strict CSP (`script-src 'self'`), no token in storage, server-side revocation | A script can still act inside the open page; no MFA step-up |
| T8 | CSRF | `SameSite=Strict`, required custom header, same-host `Origin` check on cookie-authenticated writes | |
| T9 | Stolen/forged token | Signed JWT, per-request device and user check, revocation, 24 h life | `JWT_SECRET` rotation signs everyone out (documented) |
| T10 | **Fake clinician** | Administrator review, status gating of all clinical routes | Credentials are self-reported and not checked against a registry; the interface must not claim verification (being corrected) |
| T11 | Altering the audit trail or an authorized prescription | Triggers (append-only, frozen after authorization) and withheld privileges for the runtime role | Owner/superuser can still alter; production runtime is not yet the restricted role |
| T12 | SQL injection | Parameterized queries throughout (Drizzle / bound parameters); no string-built SQL with user input | Row-level security does not defend against arbitrary SQL run as the runtime role |
| T13 | Abuse of messaging (spam, harassment) | Per-user message and request limits; report (with or without the text) and block; blocked pairs cannot reconnect | Review of reports is manual; nobody is promised round-the-clock moderation |
| T14 | Sensitive data in logs | Request logs carry method/path/status only; errors log a kind; scanned by a test | Third-party platform logs not reviewed |
| T15 | Sensitive data in external notifications | Reminder e-mails name no medicine unless the patient opts in; subjects generic | No e-mail provider is connected, so nothing external is sent today |
| T16 | Scheduler abuse or silence | Bearer secret, guess limiter, lease against overlap, history, monitor endpoint | **No dependable caller is running**; no external alert sink configured |
| T17 | Dependency compromise | Production dependencies audited (0 advisories), CI gate | Development-tool advisories accepted (four moderate, dev-only) |
| T18 | Secrets leakage | Secrets only in host environment; never in logs or reports | Secrets previously pulled to a developer machine for operations must be rotated before launch |
| T19 | Denial of service | Rate limits, body size cap, serverless scaling | No WAF/bot protection configured |
| T20 | Loss of data / bad migration | Idempotent transactional migrations | Backup and restore are **not rehearsed**; point-in-time recovery plan to be confirmed with the provider |
| T21 | Insider (operator) misuse | Owner credentials exist only on host and operator machines; administrator role cannot read patient data (policy) | No access-review process; no break-glass procedure |
| T22 | Fabricated content mistaken for real | No demo mode, simulated pharmacy or assistant remain; production refuses fixture accounts and hides fixture clinicians; every integration status is computed from evidence | The live database still contains old demonstration rows until the approved cutover |
| T23 | **Guessing or stealing a pairing code** | 256-bit single-use token in the URL fragment, an 8-character short code, 15-minute life, keyed hashes only, per-person limits per minute and day, identical answers for invalid/expired/used/revoked, one winner under concurrency, the patient must confirm | Someone who photographs a displayed code during its 15 minutes and confirms first can connect; the clinician sees who connected and can end it |
| T24 | A clinician reaches health information the patient did not intend | A connection alone opens none; a time-limited, revocable grant naming that clinician; withdrawing consent ends all grants; reads audited before returning; "not found" otherwise | A patient can still grant too widely; defaults are narrow |
| T25 | Silent change of a recorded allergy or medicine | Entries never edited in place (trigger); amendments supersede and keep history; a patient cannot silently remove what a clinician entered; "none known" is an explicit statement, never inferred | Free text can still be wrong |
| T26 | Staff invitation hijacked | Token bound to one e-mail address, single use, 7 days, hash stored, carried in the URL fragment; staff and clinician accounts are different kinds | Whoever controls the invited mailbox controls the invitation |
| T27 | Organization impersonation | Organizations start unverified and say so; "verified" needs a recorded source, evidence, reviewer and date (database constraint) | Verification is a person's check, not a registry |
| T28 | Forged provider webhook | Svix signature over the raw body, 5-minute tolerance, constant-time comparison, idempotent by event id, refused when no secret is set | Depends on the provider keeping the secret |
| T29 | Reminder content leaks externally | E-mail text generic unless the patient chose to include the title; no medicine name unless chosen; SMS and push do not exist | The patient's own mail provider sees the generic text |
| T30 | Wrong emergency number | Numbers only from `shared/emergency.ts` with sources; per country by the person's choice; production shows none until a person has reviewed them; unconfirmed numbers excluded | Egyptian numbers rest on a US-government compilation until reviewed |

## Abuse cases to keep testing

A patient requests another patient's appointment by id · a doctor reads messages of a connection that ended · a suspended
doctor keeps a cookie · a caregiver tries a write · an administrator calls a patient-data endpoint · a reused reset link ·
two simultaneous bookings for one slot · two schedulers at once · a request with no identity reaching the database.
Most of these have automated tests (see `docs/TESTING.md`); organization-boundary cases are added as organizations are built.
