# Production readiness: gates, evidence, risk register

**Decision: NO-GO for real patients.** Last audited 2026-10-26 (night) against the live deployment, the database behind it, and the Mission 2 release candidate (draft PR #1, not deployed).
Where this page and the code disagree, the code and the evidence win; correct this page.

Statuses (the only four used):

- **PASS**: verified with the evidence named in the row.
- **FAIL**: known to be unsafe or broken today.
- **BLOCKED**: engineering has done what it can; the next step needs an account, an owner decision or an outside reviewer.
- **NOT TESTED**: no evidence has been obtained.

A row never says PASS because code exists, a test was written or a deploy succeeded. "Level" says how far the evidence reaches:
**prod** = observed on the live deployment or its database, **CI** = automated tests against a real PostgreSQL (as owner and as the
restricted role), **local** = rehearsed on a developer machine with synthetic data, **doc** = written down only.

`npm run verify:production` automates the checks that can be automated and is necessary, not sufficient. Nothing here is a
compliance claim (no HIPAA, GDPR or Egyptian-law statement). Human reviews are listed as BLOCKED and are not self-approved.

## What is live (2026-10-26 evening)

| Fact | Evidence |
| --- | --- |
| Live commit `704b7df34919ed330a82b85ac209707b42e6dcef` (built 18:04 UTC) | `GET /api/health`, `GET /version.json` |
| `main` (`f4131a3`) is ahead of live by `28ef346`, `03f6d58`, `e1dfd5d` (test fix, readiness endpoint, no-store on the API, honest scheduler check, audited admin bootstrap; CI green, run 40391855768). The Mission 2 candidate (branch `mission2/close-security-gaps`, draft PR #1) is ahead of `main` by migration 0024 and the work below. **Neither is deployed**: awaiting the owner's go-ahead | `git log`, `gh pr view 1` |
| Production's structure is exactly what migrations 0000–0023 produce (no drift) | `npm run schema:fingerprint` on production and on a fresh database built from the migrations: identical (`5dc5a2698a1e`, 1,100 facts); migration history identical. Production is PostgreSQL 18.6 |
| Candidate CI: see "Release candidate" below | |
| All 24 migrations (0000–0023) applied; 0015–0023 at 15:45 UTC today by the build step | `schema_migrations` read from the production database |
| Application connects as `avela_runtime` (not superuser, no BYPASSRLS, no CREATEROLE/CREATEDB, no CREATE on the schema or database, member of `avela_app`) | `pg_roles`, `has_*_privilege`, and `pg_stat_activity` showing `avela_runtime` connections after requests to the live site |
| 4 users in production, all fabricated fixtures, all deactivated; 0 sessions active; 12 seeded doctors inactive; 3 appointments and 3 messages (fixture history) | database read, `audit_logs` entry `demo.retired` (13:24 UTC, backup file kept off-repo, mode 600) |
| 0 real users, 0 real administrators, 0 e-mails recorded | same read |

## Gates

| ID | Gate | Risk | Status | Level | Evidence | Closes it |
| --- | --- | --- | --- | --- | --- | --- |
| G01 | Live version and migration state are known and consistent | High | **PASS** | prod | see "What is live" | Re-run after every deploy (`test:live` checks the commit) |
| G02 | Runtime uses a least-privilege role and row-level security is enforced | Critical | **PASS** | prod | role flags and privileges above; the server refuses to serve if the role could bypass policies; `audit_logs` and `prescription_events` grant the role INSERT and SELECT only | Keep `verify:production` in the release routine |
| G03a | Patients, clinicians, caregivers, organizations cannot reach each other's data (adversarial tests, as owner and as the restricted role) | Critical | **PASS** | CI | production code: `npm test` 515 passed / 5 skipped, `npm run test:rls` 517 passed; the candidate adds `rlsIdentityTables`, `accessEndsEverywhere`, `operatorScripts`, `mfaKeyRotation`, `sqlHygiene`, `dbClassification` tests (`test:rls` 574 passed); `tests/rls.test.ts`, `orgs.test.ts`, `healthProfile.test.ts`, `pairingInvitations.test.ts`, `roleBoundaries.test.ts`, `routeInventory.test.ts` | — |
| G03b | The same denial verified against production with synthetic accounts | Critical | **NOT TESTED** | — | Production holds no real or synthetic non-fixture accounts; creating test accounts there would leave permanent records | Run `LIVE`-style isolation checks against a staging database that is a restored copy (needs G16) |
| G04 | Tables outside row-level security cannot leak | High | **FAIL** | prod | **In production, today:** 12 public tables have no RLS (`users`, `doctor_profiles`, `doctor_applications`, `doctor_availability`, `pharmacies`, `audit_logs`, `prescription_events`, `job_runs`, `job_run_history`, `rate_limit_hits`, `reminder_deliveries`, `schema_migrations`). **In the candidate:** all 53 relations are behind RLS with per-table policies (`docs/DATABASE_ACCESS_AUDIT.md`), proven by `tests/rlsIdentityTables.test.ts` (27 adversarial tests as `avela_app`), `npm run audit:db` (0 findings), the full suite under the restricted role and `test:e2e:rls`. It also found and fixed F6 (a writable view), F11 (a caregiver policy that never matched real caregivers) and others | Deploy the candidate (runbook §4a: rehearsed, rollback exact, but **not compatible with the live code during the build window**), then re-run `audit:db` and `verify:production` (`rls-complete`) against production |
| G05 | Append-only records cannot be altered by the runtime | High | **PASS** | prod, CI | 8 guard triggers present in production (the candidate adds 6 more guards, see G04) (`audit_logs`, `messages`, `health_entries`, `health_entry_events`, `credential_events`, `org_notes`, `prescription_events`, `prescriptions`); tests in `messaging`, `healthProfile`, `credentials`, `orgs`. A direct write by the table owner is out of scope (documented in `SECURITY.md`) | — |
| G06 | Demo and fixture data cannot sign in or be listed in production | Critical | **PASS** | prod, CI | Live: demo login returns 401, `/api/doctors` lists none, no demo banner (`test:live`); production code refuses fixtures (`tests/productionGuards.test.ts`, `retireDemo.test.ts`); database: every fixture row deactivated by `npm run demo:retire` with a backup. Nothing was deleted. | Optional: clean-database cutover (runbook §3), an owner decision |
| G07 | A real administrator exists | Critical | **FAIL** | prod | `verify:production`: no active non-demo administrator. Nobody can approve a clinician or reset a clinician's second factor | Owner: runbook §3a (`npm run admin:create` now asks for the password at the terminal; `password:reset` and `mfa:reset` are the audited recoveries; all three tested in `tests/operatorScripts.test.ts`). Nothing was created: it needs the owner's own name, address and password |
| G08 | Second factor required for clinicians, staff, administrators; secrets encrypted; replay and lock-out | Critical | **PASS** | CI | `tests/mfa.test.ts`, `totp.test.ts`, `e2e/mfa.spec.ts`; `MFA_ENCRYPTION_KEY` is set in production (the server refuses to start without it) | — |
| G09 | Second-factor enrolment, recovery and reset exercised on production | High | **NOT TESTED** | — | Needs the real administrator (G07) | After G07: enrol, sign out, sign in with a code, use one recovery code, run `mfa:reset` on a throwaway staff account in staging |
| G10 | Password reset and recovery cannot bypass the second factor | High | **PASS** | CI | `POST /api/auth/reset-password` issues no session, ends every existing session, and leaves the second factor in place; `tests/auth.test.ts`, `tests/mfa.test.ts` ("a wrong password never reaches the second factor") | — |
| G11 | Credential verification records source, evidence, reviewer, expiry; expiry and suspension remove access | High | **PASS** | CI | `tests/credentials.test.ts` | The review *process* is the owner's (no registry integration exists) |
| G12 | Reminders run on a dependable external caller, proven for seven consecutive days | Critical | **FAIL** | prod | `job_run_history` holds 5 calls in total: 2 from GitHub Actions' best-effort schedule, 1 from Vercel's daily cron, 2 manual. `GET /api/config` reports `reminderDelivery: "stale"`. The Cloudflare Worker is built and not deployed: `wrangler` is logged out. **Prepared in the candidate:** the server now *attests* the Worker by its own secret (`CRON_SECRET_CLOUDFLARE`); a header label is recorded as `claimed:` and counts for nothing; the Worker refuses non-https; the dependable-caller check is now a hard `fail`. Seven-day observation has **not started** | **BLOCKED on the owner**: runbook §6 checklist (`wrangler login`, secrets, deploy), then seven days of ≥ 90% of 288 daily calls from `cloudflare-worker` |
| G13 | Reminder semantics (calendar-correct recurrence, DST, month-end, idempotent, quiet hours, pause/cancel, e-mail only to confirmed addresses, daily cap) | High | **PASS** | CI | `tests/personalSchedule.test.ts`, `personalReminders.test.ts`, `scheduler*.test.ts`, `emailVerification.test.ts`, `e2e/reminders.spec.ts` | — |
| G14 | E-mail provider configured with a verified domain and a webhook | High | **BLOCKED** | — | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` unset; `/api/config` `features.email: false`. Without e-mail, password reset and e-mail confirmation cannot reach anyone | Owner: provider account, verified sending domain, webhook, one real accepted message **and** one signed delivery event (runbook §10). The candidate adds suppression: after a permanent bounce or complaint, invitations and reminders to that address stop (`tests/emailDeliveries.test.ts`) |
| G15 | Webhook is verified (signature, timestamp, replay, idempotency); accepted ≠ delivered | High | **PASS** | CI, prod | `tests/emailDeliveries.test.ts` (wrong/stale/tampered/missing signature, redelivered event applied once, near-empty secret refused, unknown events ignored); live: webhook answers 503 until a secret exists, never open | Re-test with the provider's sandbox once G14 is done |
| G16 | A backup restores into an isolated database and the application works on it | Critical | **BLOCKED** | local only | `ops/restore-drill.sh` (2026-10-26, synthetic data): 24 migrations, same rows, 41 RLS tables, 16 triggers after restore; migrations are a no-op; restricted role sees 0 rows with no identity and the right rows with one. Restore of the synthetic database took under a second. **Not shown:** the provider's own backups, point-in-time recovery, how long a real restore takes, roles surviving a restore (they do not: recreate with `db:create-app-role`) | Owner: restore a Neon branch/PITR copy and run the provider drill (runbook §5: fingerprint diff, `audit:db`, role check, counts, preview deployment), record the time. The tooling to check a restored database (`schema:fingerprint`, `audit:db`) exists and works against Neon over WebSocket (used read-only on production today) |
| G17 | Health checks separate "process up" from "database ready"; an external monitor watches them | High | **BLOCKED** | CI | `/api/health` (liveness), `/api/health/ready` (database up/down, no detail), `/api/health/scheduler`; tests in `operationsHealth.test.ts`. `/ready` is on `main` but **not deployed**. No external monitor exists; `SCHEDULER_HEARTBEAT_URL` and `OPS_ALERT_EMAIL` unset | Owner: deploy, uptime monitor on `/api/health/ready` and `/api/health/scheduler`, heartbeat URL, alert address |
| G18 | An alert has been received during a controlled failure drill | High | **NOT TESTED** | — | Needs G17 | Drill in staging first, then production scheduler pause |
| G19 | Live checks pass against the intended release | High | **PASS** | prod | 2026-10-26 evening, commit `704b7df`, restricted role live: `npm run test:live` **18 passed, 0 retries, 0 flaky** (1.1 min). Earlier runs the same evening had failures that were all `ERR_NETWORK_CHANGED` or navigation timeouts on the test machine (see "Live suite") | Re-run on every release |
| G20 | Emergency information appears only when a person has reviewed it for that country | High | **PASS** | prod, CI | Live `/api/config`: both countries `reviewed: false`, no numbers served; `tests/emergencyInfo.test.ts` (reviewer, version and countries required; unset `NODE_ENV` counts as production) | — |
| G21 | The emergency numbers themselves are verified by a person against official sources | High | **BLOCKED** | — | US: FCC and 911.gov cited. Egypt: only a US-government compilation was found, **no Egyptian official source** | Owner or a reviewer (an Egyptian resident for Egypt) sets `EMERGENCY_DATA_REVIEWED_BY`, `_VERSION`, `_COUNTRIES` |
| G22 | Clinical safety review of reminder, prescription and onboarding wording | High | **BLOCKED** | — | Avela gives no dosing, diagnosis or interaction advice | A clinician |
| G23 | Legal and privacy review (consent, terms, privacy policy, retention, breach duties) per jurisdiction | High | **BLOCKED** | — | Plain-language drafts only | Counsel |
| G24 | Arabic text reviewed by a fluent speaker and a clinician | Medium | **BLOCKED** | — | Written by the engineering assistant, marked "awaiting review"; RTL layout is tested (`e2e`, `e2e-live`) | Fluent reviewer |
| G25 | Independent penetration test | High | **BLOCKED** | — | Internal adversarial review and tests only (`THREAT_MODEL.md`, `tests/reviewFindings.test.ts`); this is not a substitute | Third party |
| G26 | Secrets that left the platform have been rotated | High | **FAIL** | — | Exposed categories and order of rotation: runbook §9. Facts: the owner database credential was written to the laptop by `vercel env pull` (again during this audit); the generated runtime password, runtime URL and `MFA_ENCRYPTION_KEY` sit in `~/.avela-secrets`; none of those values appears in any of the ten session transcripts (searched by value; nothing printed). **Prepared:** `ops/generate-rotation-secrets.sh` (new values to private files, never printed), `MFA_ENCRYPTION_KEY_PREVIOUS` + `npm run mfa:rekey` so the MFA key can be rotated without locking anyone out (`tests/mfaKeyRotation.test.ts`), proof-of-revocation steps. Production has **0** enrolled second factors, so the MFA key can be replaced for free *now* | Owner performs the rotation (runbook §9) and deletes local copies. Nothing was rotated by the assistant |
| G27 | Incident response, on-call and breach-notification decisions | High | **NOT TESTED** | doc | Runbook §8 is a starting point; no named people or contact paths | Owner |
| G28 | Dependencies and code scanned | Medium | **PASS** | CI, local | `npm audit --omit=dev`: 0 vulnerabilities; `tsc --noEmit` clean; no static-analysis tool beyond the type checker has been run | Add CodeQL or Semgrep if wanted |
| G29 | CI green on the release commit, and deploys happen only from a green commit | High | **FAIL** | CI | CI is green on code commits; docs commit `8863cca` failed an end-to-end spec that depended on the hour of day (a real defect, fixed in `28ef346`). **Deploys are made from a developer machine with the Vercel CLI; nothing enforces "CI first"** | Owner: a deploy workflow gated on CI (needs a Vercel token as a repository secret), or deploy only from a green commit by procedure |
| G30 | Hosting plan fit for health information | High | **NOT TESTED** | — | The project runs on Vercel's Hobby plan, which retains runtime logs for about 30 minutes (observed) and is intended for non-commercial use; no data-processing agreement exists with any host | Owner |
| G31 | Every migration is rehearsed on a database built to production's state, is idempotent, touches no row, and rolls back exactly | High | **PASS** | local, CI | `npm run migration:rehearse` for 0024: applies, 2nd application changes nothing, no row changed, rollback restores the identical structure, re-apply reproduces it; runs in CI on PostgreSQL 18. `npm run migration:dry-run` runs the SQL in a transaction on any copy and rolls back | Before applying to production: dry-run on a Neon branch (runbook §4a step 4) |
| G32 | The administrator bootstrap and recoveries cannot be used by the public, expose no secret, are audited and cannot escalate an existing account | High | **PASS** | CI | `tests/operatorScripts.test.ts` (runs the scripts as child processes against the test database): password asked at a terminal or supplied by the environment, never printed or logged; audit entries without secrets; an existing account is never changed; the application's own role is refused the `admin` role by a database trigger (`rlsIdentityTables.test.ts`); no route creates one | — (G07 remains: nobody has run it) |
| G33 | A deployment cannot be mistaken for a working scheduler, an existing admin or a protected database | High | **PASS** | CI | `verify:production` checks: `rls-complete`, `scheduler-caller` (attested, hard fail), `admin`, `demo-accounts`; counts run as system so they cannot read zero through the restricted role (F7) | — |

## Live suite (`npm run test:live`, read-only, no accounts)

Runs against the deployed site as a visitor: commit identity, landing/registration/sign-in survive reload, Arabic turns right-to-left
and stays so, anonymous visitors are kept out of private screens, no demo login, banner or published credential, the directory lists
no one who cannot answer, no removed or unconnected capability is advertised, reminder status is honest and consistent, every private
API refuses anonymous callers. 2026-10-26 after the role switch the first three runs had failures (16 passed + 2 failed; 13 passed + 3 flaky + 1 failed; 6 passed + 2 flaky + 1
failed on the phone project), every one an `ERR_NETWORK_CHANGED` or a navigation timeout in the test machine's browser; during those
runs 36 of 36 plain requests answered 200 (median 0.4 s) and the platform's error log held only Node deprecation warnings, no 5xx. That
was a judgement, not proof, so failure evidence was added (`e2e-live/diagnostics.ts`: method, path, status, milliseconds, the host's
request id, and a `client-network` / `server` / `unclassified` verdict for every failure). The next full run, with no change to the
deployment, passed 18 of 18 with no retries.

## Risk register

| ID | Risk | Severity | Evidence | Remediation | Test | Rollback | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R01 | Nobody can administer production (no clinician can be approved; no second factor can be reset) | Critical | G07 | `npm run admin:create` | `verify:production` `admin` PASS; sign in with a code | Deactivate the account | Owner |
| R02 | Reminders silently do not run | Critical | G12 | Deploy the Worker; heartbeat; alert | seven-day history; alert drill | None needed (caller only) | Owner |
| R03 | No e-mail: nobody can reset a password or confirm an address | High | G14 | Provider and domain | one accepted + one delivered event | Remove the key (e-mail falls back to "not sent", surfaced honestly) | Owner |
| R04 | `users` and `doctor_profiles` outside row-level security | High | G04 | **Done in the candidate** (migration 0024); open in production until deployed | `rlsIdentityTables.test.ts`, `audit:db` | `ops/rollback/0024_close_rls_gaps.down.sql` | Owner approves deploy |
| R05 | Secrets copied to a developer machine | High | G26 | Rotate | `verify:production` and live suite after rotation | Restore previous secret from the host's history | Owner |
| R06 | Unreviewed emergency numbers | High | G21 | Review | production `/api/config` shows `reviewed: true` only after the three variables | Unset the variables | Reviewer |
| R07 | Restore never done on the real provider | High | G16 | Drill | restore drill checks | — | Owner |
| R08 | Log retention about 30 minutes | High | G30; `vercel logs` refuses older ranges | Longer retention or a log drain | Query a 24-hour-old request | — | Owner |
| R09 | Deploys not gated on CI | Medium | G29 | Gated workflow | a red commit cannot deploy | — | Owner + engineering |
| R10 | Default "organization staff can see a patient's record, with a switch and notices" | Medium | `SAFETY_AND_COMPLIANCE.md` | Owner and counsel decide the default | `tests/orgs.test.ts` | — | Owner + counsel |
| R11 | Pairing codes have about 40 bits of entropy | Low | accepted: 15-minute life, 40 failures per person per day, single use | — | `pairingInvitations.test.ts` | — | — |
| R12 | A direct database write by the owner could change a status column | Low | documented in `SECURITY.md` | Owner credentials kept off the application | — | — | — |
| R13 | A time-of-day-dependent browser spec went undetected until a late commit | Fixed | `28ef346` | Spec picks a later, always-complete day | `e2e/patient-journey.spec.ts` | — | — |
| R14 | A readiness check counted a manual call and a daily cron as a "dedicated scheduler" (false PASS) | Fixed | `03f6d58` | One named source must make 90% of expected calls; manual checks not counted | `tests/productionGuards.test.ts` | — | — |
| R15 | API responses carried the host's default `Cache-Control: public, max-age=0, must-revalidate` | Fixed in `main`, not deployed | live headers | `no-store` on `/api`. The first attempt broke 10+ browser specs in CI (an API response whose body nobody reads stays "in flight" under no-store, so `networkidle` waits never ended); caught by CI, fixed by draining unread bodies in `apiRequest`; full local browser suite 145 passed | `tests/operationsHealth.test.ts`, `e2e/*` | — | — |
| R16 | Production's database policy for caregivers never matched real caregivers (`'accepted'` vs the real `'active'`): under the restricted role a caregiver sees an empty overview | High (fails closed; no caregivers exist yet) | F11 | Corrected in 0024 | `accessEndsEverywhere.test.ts` (content, not status code) | down script restores the old helper | Owner approves deploy |
| R17 | Migration 0024 is applied by the build **before** the new code serves, and the live code (`704b7df`) is not compatible with it (public doctor directory empty, counterpart names missing until the new release is up) | Medium pre-launch (no real users), High after | runbook §4a | Deploy while there are no real users, keep the build short, dry-run on a Neon branch first | `test:live` after | previous release **and** down script, or restore the pre-migration branch | Owner |
| R18 | Row-level security trusts the identity the application asserts; arbitrary SQL as `avela_runtime` (injection, stolen credential) defeats it | High if either occurs | `DATABASE_ACCESS_AUDIT.md` §3 | Parameterisation enforced by `tests/sqlHygiene.test.ts`; rotate the credential (G26); option D-03 (signed identity) | `sqlHygiene.test.ts` | — | Owner decision |
| R19 | After a patient ends a connection the doctor keeps the visit record (name, stated reason) for visits delivered or booked | Medium | F8 / D-02 | Owner + counsel decide; pinned by a test | `accessEndsEverywhere.test.ts` | — | Owner + counsel |
| R20 | Test database is PostgreSQL 16 locally, 18 in CI and production | Low | fingerprints equal; CI now 18 | Install 18 locally | CI | — | Engineering |

## Release candidate

| | |
| --- | --- |
| Branch / PR | `mission2/close-security-gaps`, draft PR #1 (base `main` at `f4131a3`; production is `704b7df`) |
| Candidate commit | code tip `38205ed` (any later commit on the branch changes documentation only: check `git diff 38205ed..HEAD --stat`) |
| CI for that exact commit | **green**: run 40414813189, jobs `test` and `restricted-role` both success, on PostgreSQL 18; the restricted-role job includes `npm run audit:db` (0 findings) and `npm run migration:rehearse` (apply, idempotent, no row touched, exact rollback). The previous code commit `99f85f9` was also green (run 40414069153); `2b8248c` failed on a real defect in my migration (default function privileges were revoked per-schema, which cannot remove the global default) caught by the new audit step and fixed in `99f85f9` |
| Diff reviewed | `git diff 704b7df..HEAD`: ~55 files; new migration `0024_close_rls_gaps.sql`; no secret-shaped string (scan: the only matches are CI-only throwaway credentials in the workflow and a placeholder in a comment); `npm audit --omit=dev`: 0 vulnerabilities (4 moderate in dev tooling, accepted); production build and `test:prod` (22) pass |
| Local runs on the candidate | `npm run test:rls` 574 passed; `npm test` 569 passed + 5 skipped (the restricted-role block, which `test:rls` runs); typecheck clean |
| Production environment requirements | Unchanged except (all optional): `CRON_SECRET_CLOUDFLARE`, `MFA_ENCRYPTION_KEY_PREVIOUS` (runbook §1) |
| Health and readiness | `/api/health` (liveness), `/api/health/ready` (database), `/api/health/scheduler`; `verify:production` gains `rls-complete` and a hard `scheduler-caller` |
| Cache headers | `no-store` on `/api` without breaking navigation (browser suite green; fixed in `e1dfd5d`) |
| Demo fixtures cannot be exposed | `productionGuards.test.ts`; the directory view computes `is_fixture` in the database |
| Rollback | runbook §4a: previous release **and** `ops/rollback/0024_close_rls_gaps.down.sql`, or restore the pre-migration branch |
| Deployed? | **No.** Nothing in this mission was deployed, migrated in production, or written to production. Production was read (schema, roles, counts) and nothing else |

## Human approvals and reviews (engineering does not self-certify these)

| Review | Status | What exists | Who |
| --- | --- | --- | --- |
| Clinical review of reminder, prescription and onboarding wording | **BLOCKED** | wording drafts; no dosing/diagnosis advice in code | A clinician |
| Legal and privacy review (consent, terms, retention, breach duties; per jurisdiction) | **BLOCKED** | plain-language drafts; no claim of HIPAA/GDPR/Egyptian-law compliance anywhere | Counsel |
| Fluent Arabic review | **BLOCKED** | first draft marked "awaiting review"; RTL tested | A fluent reader + a clinician |
| Emergency-number source verification | **BLOCKED** | US cites FCC/911.gov; Egypt has no official source found; numbers are withheld in production until a named person sets `EMERGENCY_DATA_REVIEWED_*` | A reviewer (an Egyptian resident for Egypt) |
| External penetration test | **BLOCKED** | internal adversarial tests and review only | A third party |
| E-mail provider and data-processing terms | **BLOCKED** | integration and tests; no provider account; provider receives addresses and bodies | Owner + counsel |
| Scheduler reliability observation (seven days) | **BLOCKED** | attestation and checks built; Worker not deployed; not started | Owner |
| Real-provider restore rehearsal | **BLOCKED** | procedure and tooling; local synthetic rehearsal only | Owner |
| Monitoring and alert drill | **BLOCKED** | code and local stand-in test; no monitor or alert address | Owner |

## Decisions that are the owner's (nothing below was decided for you)

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D-01 | Deploy the candidate (migration 0024 included), and when | now (no real users: simplest), or after the dry-run on a Neon branch | Dry-run on a branch, then deploy while there are no real users |
| D-02 | Should ending a connection also cancel future visits with that doctor, or hide the reason? | keep (records of care), cancel upcoming, hide reason | Counsel and a clinician decide; the test pins today's behaviour |
| D-03 | Make the database verify who is asking (a signed identity) instead of trusting the application | not now (accept R18), or build it (per-request HMAC the role cannot forge; cost: a function call per policy check and a key to rotate) | Accept for launch of a small invited group; revisit before scale |
| D-04 | Narrow `users` by column (hide `password_hash` and the emergency profile from counterparts) | accept, or split the table (a larger refactor) | Accept now; plan the split |
| D-05 | Rotate `MFA_ENCRYPTION_KEY` now, while nobody has enrolled | rotate (free today), or keep | Rotate now |
| D-06 | Plan and log retention for a service holding health information | stay on Hobby, or move | Move before real patients |

## What Avela does not do (state it to every user)

It is not an emergency service and no one watches messages around the clock. It does not diagnose, prescribe on its own, check doses
or interactions, send prescriptions anywhere, verify licences against a register, or connect to a hospital information system. Video,
SMS, push, pharmacy, EHR, licence-registry and single-sign-on integrations are **not available** and the product says so. Hospital
operations modules beyond appointments, staff, follow-up tasks and an activity log are outside the current scope.

## Recommendation

**NO-GO for real patient information.** Engineering gaps closed in the candidate: every table is behind row-level security with adversarial tests, function privileges
are narrowed, the application role cannot make an administrator or reactivate a suspension, the scheduler's identity is attested, e-mail is suppressed after bounces, the MFA
key can be rotated safely, and the migration is rehearsed with an exact rollback. **None of it is deployed.** What still blocks launch is not code: no administrator
exists (G07), no dependable scheduler (G12; Cloudflare login), no e-mail (G14), secrets copied to a laptop are not rotated (G26), no restore has been rehearsed on the real
provider (G16), no external monitor or alert drill (G17, G18), emergency numbers are unreviewed (G21), and the clinical, legal, Arabic and penetration-test reviews have not
happened (G22–G25). A "LIMITED GO" (a few invited clinicians, in-app messaging only, no reminders, no real patient records) becomes conceivable only after the candidate is
deployed and verified, G07, G14, G16 and G26 are closed, and the owner and counsel approve that scope in writing.

Next actions for the owner, in order: (1) review and approve deploying PR #1 (D-01), ideally after a dry-run on a Neon branch; (2) run `npm run admin:create` yourself; (3) `wrangler login`
so the Worker can be deployed and the seven-day clock can start; (4) rotate secrets (runbook §9, D-05); (5) create the e-mail provider account; (6) schedule the reviews above.
