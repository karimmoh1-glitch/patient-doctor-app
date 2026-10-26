# Overnight execution queue

The working checklist for the production transformation. A row is marked **Done** only when its acceptance criteria are met
and the evidence column names a test or a recorded observation. "Evidence" cites tests in this repository; counts are
whatever the latest recorded run printed, not estimates. Updated as work proceeds; the newest state is the last commit.

Legend — **Indep.**: can be finished without anyone else. **Ext.**: needs an external credential, vendor, legal or clinical
decision, or the owner's authorization to a production change.

## P0 — critical

| # | Task | State | Acceptance | Evidence | Indep. | Ext. |
|---|------|-------|-----------|----------|--------|------|
| P0-1 | No demo login, public credentials or fixture accounts in production | **Done** (code). Production data retirement **not executed** | Production refuses demo config; fixtures refused at login/session and hidden from the directory | `tests/productionGuards.test.ts`, `tests/retireDemo.test.ts`, `e2e-prod` (22 passed at the time) | yes | Retiring data in the live DB needs owner approval |
| P0-2 | Cross-patient access impossible at the database | **Done in code and tests; not enforced in production** | Restricted role + RLS, missing identity denies | `npm run test:rls`, `npm run test:e2e:rls` | yes | Switching the live runtime role needs owner approval |
| P0-3 | Clinicians/administrators need a real second factor | **Done** | TOTP, recovery codes, lockout, replay refusal, encrypted secret | `tests/mfa.test.ts`, `tests/totp.test.ts`, `e2e/mfa.spec.ts` | yes | Production needs `MFA_ENCRYPTION_KEY` set before deploying |
| P0-4 | No feature claims something that is not connected | **Done** for messaging, e-mail, video, integrations | "Delivered"/"read" only from evidence; integrations show real status | `tests/messaging.test.ts`, `tests/emailDeliveries.test.ts`, `tests/integrations.test.ts` | yes | — |

## P1 — launch blockers

| # | Task | State | Acceptance | Evidence | Indep. | Ext. |
|---|------|-------|-----------|----------|--------|------|
| P1-1 | Production DB runtime role + RLS enforced | Prepared, **not enabled** | Operator runbook, create-role script, readiness check, rollback | `docs/OPERATIONS_RUNBOOK.md` (to write), `npm run db:create-app-role` | partly | **Owner must review and approve the cutover** |
| P1-2 | Reliable scheduler with proof of repeated scheduled runs | Code done; **no dependable caller yet** | ≥7 days of dependable calls recorded | `tests/scheduler*.test.ts`; registry shows "not yet proven" | partly | `wrangler login` to deploy the Cloudflare Worker |
| P1-3 | E-mail with delivery evidence | Code done; provider **not configured** | Accepted vs delivered/bounced from signed webhook | `tests/emailDeliveries.test.ts` | partly | `RESEND_API_KEY`, sending domain, `RESEND_WEBHOOK_SECRET` |
| P1-4 | Clinician credential verification workflow | In progress | submitted/pending/verified/rejected/suspended/expired with source, evidence, reviewer, expiry; listing honours expiry | — | yes | A real verification source/process decided by the owner |
| P1-5 | Backups and restore verified | Documented, **not verified** | A restore performed and recorded | — | no | Neon backup/branch access and an approved restore drill |
| P1-6 | Monitoring and alerts | Code done; **not configured** | Alert received from a deliberate failure | `docs/SCHEDULER.md` | partly | Heartbeat monitor URL, `OPS_ALERT_EMAIL` |
| P1-7 | Country-aware emergency information (Egypt, United States) | Queued | Sourced numbers with URL, date, reviewer; independent country and language; launch blocked if unreviewed | — | partly | A human reviewer must confirm each number before launch |

## P2 — core product

| # | Task | State | Acceptance | Evidence | Indep. | Ext. |
|---|------|-------|-----------|----------|--------|------|
| P2-1 | Reliable messaging | **Done** | Idempotent send, honest states, inbox, search, report/block | `tests/messaging.test.ts`, `e2e/messaging.spec.ts` | yes | — |
| P2-2 | Appointments: concurrency, history | **Done** | One winner under races; history for participants | `tests/scheduling.test.ts` | yes | — |
| P2-3 | Patient onboarding: allergies, medications, history, emergency contact, consent with provenance and states | Queued | Section-by-section save/resume; explicit "no known allergies"; provenance per entry | — | yes | Consent wording needs legal review |
| P2-4 | Clinician-assisted onboarding | Queued (after P2-3) | Needs patient authorisation; per-field author and source; amendments audited; revocable | — | yes | — |
| P2-5 | QR pairing | Queued | Single-use, hashed, short-lived token; manual code; patient confirms; replay/expiry/revocation/concurrency tests | — | yes | — |
| P2-6 | Patients without a doctor; subscription and bill reminders; general reminders | Queued | Reminders work with no clinician; subscription schedules handle month ends and leap years | — | yes | — |
| P2-7 | Provider search with "why this matches" | Queued | Real filters; reason shown | — | yes | — |
| P2-8 | Organizations, staff roles, permission matrix, tenant isolation, care coordination, dashboard | Queued | Org A cannot read org B; matrix enforced and tested; real counts only | — | yes | — |

## P3 — quality

| # | Task | State | Evidence |
|---|------|-------|----------|
| P3-1 | Accessibility checks in English and Arabic on every new screen | Ongoing | `e2e/messaging.spec.ts`, `e2e/integrations.spec.ts` |
| P3-2 | Older-adult usability review of the new onboarding | Queued | — |
| P3-3 | Documentation: readiness, runbook, integrations | Ongoing | `docs/` |

## Items that cannot be completed by engineering alone
Legal and clinical review of consent text and emergency numbers, a credential-verification source, a decision to switch the
production database role and move to a separate production database, provider accounts (e-mail, scheduler caller,
monitor), a backup/restore drill on the real database, and a penetration test.
