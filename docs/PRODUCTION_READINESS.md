# Production readiness: GO / NO-GO

**Decision today: NO-GO for real patients.** Nothing below that is marked "blocked" can be completed by engineering alone.
This page says what is true now, with the evidence, and what each remaining gate needs. It is updated with every release;
the commit it describes is in `docs/OVERNIGHT_EXECUTION.md` and `git log`. `npm run verify:production` automates the
checks that can be automated (it prints each blocker and exits non-zero while any remains) and is **necessary, not sufficient**.

A "GO" for a *limited, defined scope* (for example "ten invited clinicians and their patients, in-app messaging only")
is possible once the P1 gates below are closed. It is the owner's decision, with legal and clinical sign-off, and nobody
else's. Nothing in this repository is a compliance claim: no HIPAA, GDPR or Egyptian-law statement is made.

## Gates

| # | Gate | State | Evidence | What closes it |
| --- | --- | --- | --- | --- |
| 1 | No fabricated people in production | **Code done. Live database not yet cleaned.** | Fixtures refused at sign-in and session and hidden from the directory when `NODE_ENV=production` (`tests/productionGuards.test.ts`, `tests/retireDemo.test.ts`, production smoke run). The live deployment's database still contains the old demo rows (inactive to the app only once the new build runs). | Owner approves the cutover plan in `docs/OPERATIONS_RUNBOOK.md` §3 (new empty database, migrate, verify, switch). **Do not retire in place without a backup.** |
| 2 | Database role cannot bypass row-level security | **Enabled in production on 2026-10-26** (commit 704b7df) | `npm run test:rls` and `npm run test:e2e:rls` (the entire server and browser suites as the restricted role) pass in CI; the server refuses to serve if the role could bypass policies. | Done: role `avela_runtime` created (`verify:production` reports it exists and cannot bypass row-level security), `APP_DATABASE_URL` and `DB_ENFORCE_RLS=on` set, redeployed; the live app's connections were observed as `avela_runtime` in `pg_stat_activity`, `/api/doctors` answers 200 and the live browser suite passes apart from local-network drops. Back-out: remove those two variables, set `ALLOW_OWNER_DATABASE_ROLE=true`, redeploy. Still open: a recorded drill of an authenticated session as the restricted role (there is no real administrator yet, gate 16 below). |
| 3 | Second factor for clinicians, staff and administrators | **Done** | `tests/mfa.test.ts`, `tests/totp.test.ts`, `e2e/mfa.spec.ts`: encrypted secret, replay refusal, lock-out, single-use recovery codes, no session without it. | Production needs `MFA_ENCRYPTION_KEY` set (the server refuses to start without it). |
| 4 | Real e-mail (accounts, resets, invitations, reminders) | **Code done; provider not configured** | `tests/emailDeliveries.test.ts`: "accepted" recorded; "delivered/bounced" only from the provider's signed webhook. | `RESEND_API_KEY`, a verified sending domain, `RESEND_WEBHOOK_SECRET` and the webhook added at the provider; one real message accepted **and** a delivery event received (the integrations screen then reads "Verified"). A data-processing agreement covering health-related mail is the owner's to arrange. |
| 5 | Reminders run on a schedule, repeatedly, by themselves | **Not proven** | Scheduler code is tested (`tests/scheduler*.test.ts`, `tests/personalReminders.test.ts`). **No dependable caller is running:** GitHub's `schedule` never fired for this repository in over five hours of observation; the Cloudflare Worker (`ops/scheduler-worker/`) is built and unit-tested but not deployed. | Owner runs `wrangler login` and deploys the Worker (§6). Then seven days of calls recorded in `job_run_history` from a non-GitHub source; the integrations screen shows "Verified" only then. |
| 6 | Someone is told when it stops | **Not configured** | Heartbeat and operator e-mail code exist and are tested. | `SCHEDULER_HEARTBEAT_URL` at a dead-man's-switch monitor, `OPS_ALERT_EMAIL`, an uptime monitor on `/api/health/scheduler`, and one deliberate failure that produced a received alert. |
| 7 | Backups can be restored | **Not verified** | Documented only. | A restore of a recent backup into a scratch database, with the time it took recorded, on the real provider. |
| 8 | Clinician licences are checked by a person, with evidence | **Done in the product; the process is the owner's** | `tests/credentials.test.ts`: approval requires source, evidence, expiry; expired licence unlists the clinician. | Owner defines who reviews and against what source; there is no registry integration. |
| 9 | Emergency numbers for Egypt and the United States | **Researched; not reviewed by a person** | `shared/emergency.ts` with sources and dates. US: 911 (FCC, 911.gov). Egypt: 123/122/180 from a US-government compilation; **no Egyptian official source found**. In production a country's numbers are served only after a person sets `EMERGENCY_DATA_REVIEWED_BY`, `EMERGENCY_DATA_REVIEWED_VERSION` (must equal the data version, so editing a number un-reviews it) and `EMERGENCY_DATA_REVIEWED_COUNTRIES`; until then the screens say there is no reviewed information. | A person (preferably Egyptian-resident for Egypt) confirms each number against an official source, then sets those three variables. |
| 10 | Arabic text reviewed | **Not done** | Machine-assisted draft, marked "awaiting review" in the language list. | Fluent reviewer plus a clinician for medical wording. |
| 11 | Privacy policy, terms, consent wording reviewed legally | **Not done** | Plain-language drafts exist (`hp.consent.*`, legal pages). | Counsel for each launch jurisdiction. |
| 12 | Clinical safety review | **Not done** | Avela never gives dosing or diagnoses; reminders only nudge. | A clinician reviews prescription, reminder and onboarding wording. |
| 13 | Independent security test | **Not done** | Internal threat model (`docs/THREAT_MODEL.md`) and adversarial tests only. | Third-party penetration test. |
| 14 | Secrets rotated | **Not done** | A copy of the production environment was pulled to a developer machine during operations. | Rotate `JWT_SECRET`, `CRON_SECRET`, database credentials, provider keys; delete local copies. |
| 15 | Incident response and on-call | **Not defined** | `docs/OPERATIONS_RUNBOOK.md` §8 is a starting point. | Named people, contact paths, a breach-notification decision for each jurisdiction. |
| 16 | A real administrator exists | **Not done** | `npm run verify:production` (2026-10-26): no active non-demo administrator in the production database, so nobody can approve a clinician. | The owner runs `npm run admin:create` against production with their own e-mail and a password of their choosing, enrols the second factor, and keeps the recovery codes. |

## What is verifiably in place (so a reader can trust the rest)

Counts below are from the latest local run recorded in `docs/OVERNIGHT_EXECUTION.md`; CI runs the same commands.

- Server tests as the table owner and again as the restricted role (`npm test`, `npm run test:rls`); browser tests with
  accessibility checks in English and Arabic as both (`npm run test:e2e`, `npm run test:e2e:rls`); a production-build
  smoke test (`npm run test:prod`); a read-only check of the live deployment (`npm run test:live`).
- Production refuses to start with a demo setting, a short secret, a non-https `APP_URL`, no `MFA_ENCRYPTION_KEY`, an owner
  database role (unless explicitly excepted) or a half-configured restricted role (`server/config.ts`).
- Messages say "delivered" and "read" only on evidence; e-mail says "accepted" until the provider's signed event says more;
  the integrations screen computes every status from recorded evidence.
- No feature claims a capability that is not connected: video, SMS, push, pharmacy, EHR, licence registry and single sign-on
  are shown as **not available**.

## What Avela does not do (state it to every user)

It is not an emergency service and no one watches messages around the clock. It does not diagnose, prescribe on its own,
check doses or interactions, send prescriptions anywhere, verify licences against a register, charge or cancel anything for
a reminder, or connect to a hospital information system. Hospital operations modules beyond appointments, staff, follow-up
tasks and an activity log (admissions, beds, laboratory, radiology, billing, pharmacy stock, EHR) are **outside the current scope**.
