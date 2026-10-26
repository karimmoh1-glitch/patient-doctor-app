# Production readiness: gates, evidence, risk register

**Decision: NO-GO for real patients.** Last audited 2026-10-26 against the live deployment and the database behind it.
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
| `main` is ahead of live (`28ef346`, `03f6d58`: test fix, readiness endpoint, no-store, honest scheduler check). **Not deployed.** | `git log`; deployment is by the owner's go-ahead after CI |
| All 24 migrations (0000–0023) applied; 0015–0023 at 15:45 UTC today by the build step | `schema_migrations` read from the production database |
| Application connects as `avela_runtime` (not superuser, no BYPASSRLS, no CREATEROLE/CREATEDB, no CREATE on the schema or database, member of `avela_app`) | `pg_roles`, `has_*_privilege`, and `pg_stat_activity` showing `avela_runtime` connections after requests to the live site |
| 4 users in production, all fabricated fixtures, all deactivated; 0 sessions active; 12 seeded doctors inactive; 3 appointments and 3 messages (fixture history) | database read, `audit_logs` entry `demo.retired` (13:24 UTC, backup file kept off-repo, mode 600) |
| 0 real users, 0 real administrators, 0 e-mails recorded | same read |

## Gates

| ID | Gate | Risk | Status | Level | Evidence | Closes it |
| --- | --- | --- | --- | --- | --- | --- |
| G01 | Live version and migration state are known and consistent | High | **PASS** | prod | see "What is live" | Re-run after every deploy (`test:live` checks the commit) |
| G02 | Runtime uses a least-privilege role and row-level security is enforced | Critical | **PASS** | prod | role flags and privileges above; the server refuses to serve if the role could bypass policies; `audit_logs` and `prescription_events` grant the role INSERT and SELECT only | Keep `verify:production` in the release routine |
| G03a | Patients, clinicians, caregivers, organizations cannot reach each other's data (adversarial tests, as owner and as the restricted role) | Critical | **PASS** | CI | `npm test` 515 passed / 5 skipped (skips are the restricted-role block, which `npm run test:rls` runs: 517 passed); `tests/rls.test.ts`, `orgs.test.ts`, `healthProfile.test.ts`, `pairingInvitations.test.ts`, `roleBoundaries.test.ts`, `routeInventory.test.ts` | — |
| G03b | The same denial verified against production with synthetic accounts | Critical | **NOT TESTED** | — | Production holds no real or synthetic non-fixture accounts; creating test accounts there would leave permanent records | Run `LIVE`-style isolation checks against a staging database that is a restored copy (needs G16) |
| G04 | Tables outside row-level security cannot leak | High | **FAIL** | prod | 12 public tables have no RLS: `users`, `doctor_profiles`, `doctor_applications`, `doctor_availability`, `pharmacies`, `audit_logs`, `prescription_events`, `job_runs`, `job_run_history`, `rate_limit_hits`, `reminder_deliveries`, `schema_migrations`. They are needed across identities (sign-in, directory, scheduler). A flaw in application code that reads `users` could expose every account's e-mail and password hash; the database would not stop it | Owner decision: accept, or add policies/column privileges for `users` and `doctor_profiles` (design in `THREAT_MODEL.md`), with tests |
| G05 | Append-only records cannot be altered by the runtime | High | **PASS** | prod, CI | 16 guard triggers present in production (`audit_logs`, `messages`, `health_entries`, `health_entry_events`, `credential_events`, `org_notes`, `prescription_events`, `prescriptions`); tests in `messaging`, `healthProfile`, `credentials`, `orgs`. A direct write by the table owner is out of scope (documented in `SECURITY.md`) | — |
| G06 | Demo and fixture data cannot sign in or be listed in production | Critical | **PASS** | prod, CI | Live: demo login returns 401, `/api/doctors` lists none, no demo banner (`test:live`); production code refuses fixtures (`tests/productionGuards.test.ts`, `retireDemo.test.ts`); database: every fixture row deactivated by `npm run demo:retire` with a backup. Nothing was deleted. | Optional: clean-database cutover (runbook §3), an owner decision |
| G07 | A real administrator exists | Critical | **FAIL** | prod | `verify:production`: no active non-demo administrator. Nobody can approve a clinician or reset a clinician's second factor | Owner: runbook §3a (`npm run admin:create`, then enrol the second factor) |
| G08 | Second factor required for clinicians, staff, administrators; secrets encrypted; replay and lock-out | Critical | **PASS** | CI | `tests/mfa.test.ts`, `totp.test.ts`, `e2e/mfa.spec.ts`; `MFA_ENCRYPTION_KEY` is set in production (the server refuses to start without it) | — |
| G09 | Second-factor enrolment, recovery and reset exercised on production | High | **NOT TESTED** | — | Needs the real administrator (G07) | After G07: enrol, sign out, sign in with a code, use one recovery code, run `mfa:reset` on a throwaway staff account in staging |
| G10 | Password reset and recovery cannot bypass the second factor | High | **PASS** | CI | `POST /api/auth/reset-password` issues no session, ends every existing session, and leaves the second factor in place; `tests/auth.test.ts`, `tests/mfa.test.ts` ("a wrong password never reaches the second factor") | — |
| G11 | Credential verification records source, evidence, reviewer, expiry; expiry and suspension remove access | High | **PASS** | CI | `tests/credentials.test.ts` | The review *process* is the owner's (no registry integration exists) |
| G12 | Reminders run on a dependable external caller, proven for seven consecutive days | Critical | **FAIL** | prod | `job_run_history` holds 5 calls in total: 2 from GitHub Actions' best-effort schedule, 1 from Vercel's daily cron, 2 manual. `GET /api/config` reports `reminderDelivery: "stale"`; `/api/health/scheduler` reports `stale`. The Cloudflare Worker is built and not deployed: `wrangler` is logged out (token expired) | **BLOCKED on the owner**: `wrangler login`, `wrangler secret put CRON_SECRET`, `wrangler deploy` (runbook §6), then seven days of ≥ 90% of 288 daily calls from that one source |
| G13 | Reminder semantics (calendar-correct recurrence, DST, month-end, idempotent, quiet hours, pause/cancel, e-mail only to confirmed addresses, daily cap) | High | **PASS** | CI | `tests/personalSchedule.test.ts`, `personalReminders.test.ts`, `scheduler*.test.ts`, `emailVerification.test.ts`, `e2e/reminders.spec.ts` | — |
| G14 | E-mail provider configured with a verified domain and a webhook | High | **BLOCKED** | — | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` unset; `/api/config` `features.email: false`. Without e-mail, password reset and e-mail confirmation cannot reach anyone | Owner: provider account, verified sending domain, webhook, one real accepted message **and** one signed delivery event |
| G15 | Webhook is verified (signature, timestamp, replay, idempotency); accepted ≠ delivered | High | **PASS** | CI, prod | `tests/emailDeliveries.test.ts` (wrong/stale/tampered/missing signature, redelivered event applied once, near-empty secret refused, unknown events ignored); live: webhook answers 503 until a secret exists, never open | Re-test with the provider's sandbox once G14 is done |
| G16 | A backup restores into an isolated database and the application works on it | Critical | **BLOCKED** | local only | `ops/restore-drill.sh` (2026-10-26, synthetic data): 24 migrations, same rows, 41 RLS tables, 16 triggers after restore; migrations are a no-op; restricted role sees 0 rows with no identity and the right rows with one. Restore of the synthetic database took under a second. **Not shown:** the provider's own backups, point-in-time recovery, how long a real restore takes, roles surviving a restore (they do not: recreate with `db:create-app-role`) | Owner: restore a Neon branch/PITR copy, run the drill's checks against it, record the time (runbook §5) |
| G17 | Health checks separate "process up" from "database ready"; an external monitor watches them | High | **BLOCKED** | CI | `/api/health` (liveness), `/api/health/ready` (database up/down, no detail), `/api/health/scheduler`; tests in `operationsHealth.test.ts`. `/ready` is on `main` but **not deployed**. No external monitor exists; `SCHEDULER_HEARTBEAT_URL` and `OPS_ALERT_EMAIL` unset | Owner: deploy, uptime monitor on `/api/health/ready` and `/api/health/scheduler`, heartbeat URL, alert address |
| G18 | An alert has been received during a controlled failure drill | High | **NOT TESTED** | — | Needs G17 | Drill in staging first, then production scheduler pause |
| G19 | Live checks pass against the intended release | High | **PASS** | prod | 2026-10-26 evening, commit `704b7df`, restricted role live: `npm run test:live` **18 passed, 0 retries, 0 flaky** (1.1 min). Earlier runs the same evening had failures that were all `ERR_NETWORK_CHANGED` or navigation timeouts on the test machine (see "Live suite") | Re-run on every release |
| G20 | Emergency information appears only when a person has reviewed it for that country | High | **PASS** | prod, CI | Live `/api/config`: both countries `reviewed: false`, no numbers served; `tests/emergencyInfo.test.ts` (reviewer, version and countries required; unset `NODE_ENV` counts as production) | — |
| G21 | The emergency numbers themselves are verified by a person against official sources | High | **BLOCKED** | — | US: FCC and 911.gov cited. Egypt: only a US-government compilation was found, **no Egyptian official source** | Owner or a reviewer (an Egyptian resident for Egypt) sets `EMERGENCY_DATA_REVIEWED_BY`, `_VERSION`, `_COUNTRIES` |
| G22 | Clinical safety review of reminder, prescription and onboarding wording | High | **BLOCKED** | — | Avela gives no dosing, diagnosis or interaction advice | A clinician |
| G23 | Legal and privacy review (consent, terms, privacy policy, retention, breach duties) per jurisdiction | High | **BLOCKED** | — | Plain-language drafts only | Counsel |
| G24 | Arabic text reviewed by a fluent speaker and a clinician | Medium | **BLOCKED** | — | Written by the engineering assistant, marked "awaiting review"; RTL layout is tested (`e2e`, `e2e-live`) | Fluent reviewer |
| G25 | Independent penetration test | High | **BLOCKED** | — | Internal adversarial review and tests only (`THREAT_MODEL.md`, `tests/reviewFindings.test.ts`); this is not a substitute | Third party |
| G26 | Secrets that left the platform have been rotated | High | **FAIL** | — | The production environment (including database URLs) was pulled to a developer machine several times during operations; generated runtime secrets are also kept in `~/.avela-secrets` | Owner: rotate `JWT_SECRET`, `CRON_SECRET`, `avela_runtime` password, database owner password; delete local copies; then keep one |
| G27 | Incident response, on-call and breach-notification decisions | High | **NOT TESTED** | doc | Runbook §8 is a starting point; no named people or contact paths | Owner |
| G28 | Dependencies and code scanned | Medium | **PASS** | CI, local | `npm audit --omit=dev`: 0 vulnerabilities; `tsc --noEmit` clean; no static-analysis tool beyond the type checker has been run | Add CodeQL or Semgrep if wanted |
| G29 | CI green on the release commit, and deploys happen only from a green commit | High | **FAIL** | CI | CI is green on code commits; docs commit `8863cca` failed an end-to-end spec that depended on the hour of day (a real defect, fixed in `28ef346`). **Deploys are made from a developer machine with the Vercel CLI; nothing enforces "CI first"** | Owner: a deploy workflow gated on CI (needs a Vercel token as a repository secret), or deploy only from a green commit by procedure |
| G30 | Hosting plan fit for health information | High | **NOT TESTED** | — | The project runs on Vercel's Hobby plan, which retains runtime logs for about 30 minutes (observed) and is intended for non-commercial use; no data-processing agreement exists with any host | Owner |

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
| R04 | `users` and `doctor_profiles` outside row-level security | High | G04 | Decide; policies or column privileges | extend `rls.test.ts` | Drop the policies | Owner + engineering |
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

## What Avela does not do (state it to every user)

It is not an emergency service and no one watches messages around the clock. It does not diagnose, prescribe on its own, check doses
or interactions, send prescriptions anywhere, verify licences against a register, or connect to a hospital information system. Video,
SMS, push, pharmacy, EHR, licence-registry and single-sign-on integrations are **not available** and the product says so. Hospital
operations modules beyond appointments, staff, follow-up tasks and an activity log are outside the current scope.

## Recommendation

**NO-GO.** The security core is in place and verified: restricted database role live, isolation tests in both roles, second factor,
fixtures retired, honest messaging states. Launch is blocked by operations and people, not by an unfinished feature: no administrator
(G07), no dependable scheduler (G12), no e-mail (G14), rotated secrets (G26), a restore rehearsed on the real provider (G16),
reviewed emergency numbers (G21) and the legal, clinical and Arabic reviews (G22–G24). Next action: the owner creates the
administrator (runbook §3a) and logs in to Cloudflare so the scheduler Worker can be deployed.
A "LIMITED GO" (for example, a handful of invited clinicians, in-app messaging only, no reminders) is conceivable only after G07, G14,
G16, G26 are closed and the owner and counsel approve that scope in writing.
