# Before any real patient information is accepted

Avela today is a **demonstration with working software**, not a service that may hold real health information.
This checklist is the gate. Engineering can complete the items marked **[eng]**; the rest need a person with the
authority, licence or contract to complete them. **Nothing here is a claim of compliance or clinical safety.** Each
item needs evidence (a document, a signed agreement, a test report, a name) before it is ticked.

Run `npm run verify:production` on the real deployment. It checks the technical blockers below and exits non-zero while
any remain. Passing it is necessary, never sufficient.

## Status after Phase C (read this first)

**Recommendation: NO-GO for real patient information.** Phase C made the reminder job and the database layer much
stronger and moved the session out of script-readable storage; it did not, and could not by engineering alone, remove
the blockers below. Passing tests establishes behaviour of this code; it does not establish clinical safety, legal
compliance or operational readiness.

### Blockers, in order of severity

| # | Severity | Blocker | Evidence | Remediation |
| --- | --- | --- | --- | --- |
| 1 | **Critical** | No legal basis: jurisdiction, privacy/health-data law, vendor agreements (hosting, database, e-mail) are undecided; Privacy and Terms are drafts | The pages say so; no agreements exist | Counsel and contracts (section 1, 7). Not an engineering task |
| 2 | **Critical** | **No dependable reminder trigger is running.** GitHub's `schedule` has produced **no run** for this repository (see "Scheduler evidence"); the Vercel plan allows one cron per day; the external scheduler is built, tested and **not deployed** | `GET /api/health/scheduler` is `503 stale`; `/admin/activity` shows no calls; `job_run_history` has no scheduled rows | Deploy `ops/scheduler-worker` (needs the operator's Cloudflare login) or another external caller; then accumulate 7 days of evidence (`docs/SCHEDULER.md`, "Evidence") |
| 3 | **Critical** | Production still connects to the database as the **table owner**, so row-level security and the privilege limits are installed but **not enforced** | Production database: role `avela_app` exists, 19 tables have 43 policies, the connecting role is the owner; `verify:production` fails `rls-enforced` and `app-role` | The staged rollout in `docs/SECURITY.md` (create `avela_runtime`, set `APP_DATABASE_URL` + `DB_ENFORCE_RLS=on`, redeploy), rehearsed first on a copy |
| 4 | **Critical** | No multi-factor sign-in for doctors and administrators | Not built | Choose and build TOTP/passkeys; then re-run the role matrix |
| 5 | **Critical** | Doctor credentials are self-reported; an administrator reads what was typed | The product says so on every profile | Independent verification process per jurisdiction (section 2) |
| 6 | **Critical** | The deployment is a **public demonstration** in the same project and database that would hold real data: demo mode is on, the demo password is published in the repository | `GET /api/config` → `demoMode: true`; `verify:production` fails `demo-off`, `demo-accounts`, `admin` | A **separate** production project and database; do not "retire" the live demo into production. Retirement was rehearsed on a copy only (`docs/OPERATIONS.md`) |
| 7 | **Critical** | No incident response, backup restore rehearsal, support staffing, or independent penetration test | None exist | Section 6 and 4b |
| 8 | High | **No e-mail provider is configured**, so password-reset links and e-mail reminders are never sent in production | `verify:production` warns `email`; `RESEND_API_KEY` unset | Verified sending domain and provider agreement, then set the key; then confirm acceptance of one real reminder (acceptance only: Avela cannot see an inbox) |
| 9 | High | No alert sinks: nothing outside Avela is told if the scheduler stops | `SCHEDULER_HEARTBEAT_URL` and `OPS_ALERT_EMAIL` unset (both built and tested) | Create a dead-man's-switch monitor and an operator mailbox; set both; kill the caller once on purpose and confirm the alert arrives |
| 10 | High | Clinical content (prescription form, reminder wording, emergency guidance) and the Arabic text have had no clinician or fluent-reader review | Sections 3 and 4 | Clinical lead, pharmacist, Arabic-speaking reviewers |
| 11 | Medium | Database policies are coarser than the application's rules, and do not cover `users`, doctor tables, the audit log | `docs/SECURITY.md` "Limits" | Narrow by sharing grant and caregiver permission; column-level design for `users` |
| 12 | Medium | Erasure and retention are manual; no retention periods decided | `npm run erase:user` is an operator script | Section 5 |
| 13 | Medium | Specialist accessibility audit and testing with older adults and screen-reader users | Automated axe checks pass; they are not enough | Section 4b |
| 14 | Low | Four moderate advisories in `drizzle-kit`'s own `esbuild` copy (a development-server issue in a development-only CLI) | `npm audit` | Upstream release of `drizzle-kit` |

### What changed in Phase C

**Scheduler** (`docs/SCHEDULER.md`). One run at a time (database lease); a late call is told so (`202`) instead of
racing; a crashed run's lease expires; an outcome is recorded only by the run that holds the lease; a time budget under
the host's 30 s limit with deferral instead of loss; one bad reminder no longer stops the others; any failed step makes
the run a failure; every call is recorded (who, when, outcome) and shown to administrators with the longest silence;
`GET /api/health/scheduler` for monitors; optional heartbeat ping and failure e-mail; an email-send timeout; the GitHub
workflow now fails loudly when unconfigured; a Cloudflare Worker caller with retries. Reminder wording and delivery
semantics are unchanged: "sent" means the provider accepted it, never that it arrived.

**Security.** Session in an `HttpOnly`, `SameSite=Strict` cookie with forgery checks and a one-time migration of existing
browsers (no token in `localStorage`); a restricted database role and row-level security on 19 tables, proven by running
every server test and every browser test as that role; shared rate-limit counters in Postgres; production dependencies
at zero advisories (`zod` 4.6.7, `openai` 7, `drizzle-zod` 0.8) with a CI gate; operator scripts forced onto the owner
connection; production readiness now also checks the database role and the scheduler's call history.

**Tests.** Investigation of the intermittent slow test runs: reproduced under disk saturation, fixed for the test
database only (`docs/TESTING.md`).

### Scheduler evidence

See the "Evidence" checklist in `docs/SCHEDULER.md` and the numbers recorded in the release report: so far **no scheduled
GitHub run has ever fired for this repository** (zero across three scheduled workflows over several hours, with
Actions enabled and no GitHub incident). The only run on record is a manual dispatch, which proved the endpoint works.
Nothing here establishes that reminders are delivered on time.

### What was tested, and where

| Where | What | Result at the time of writing |
| --- | --- | --- |
| Locally (real Postgres) | server suite as owner and as the restricted role; browser suites as owner and as the restricted role; production-build smoke; stress runs for the stall investigation; role script and demo retirement on scratch databases | see the release report for counts |
| CI (GitHub Actions) | typecheck, production-advisory gate, both server suites, production-build smoke, both browser suites | green on the commit that was deployed |
| Production (read-only) | deployed commit equals the intended one; migrations 0012-0014 applied; role, policies and privileges present; owner connection still in use; shared rate limiter active; browser checks as a visitor and as the demo patient and doctor; refused anonymous access to the scheduler endpoint | see the release report |

### Claims that remain **unverified**

- That any caller will run the scheduler every five minutes for a week. (Only a manual run has ever been observed.)
- That the restricted role works on **Neon in production**: it is proven against local Postgres 16 and CI's Postgres 16;
  the production role exists but nothing has connected as it.
- That an e-mail provider will accept reminder or reset messages: none is configured.
- That the Arabic text, the prescription form and the reminder wording are clinically and linguistically appropriate.
- That doctors are who they say they are.
- That the application resists a determined attacker: there has been no independent penetration test.
- That backups restore, and that anyone would notice and respond to an incident.

## 1. Law and jurisdiction (needs counsel)
- [ ] Decide where the service operates and for whom. This sets the privacy and health-data law (for example HIPAA, GDPR, or others), telehealth and prescribing rules, and the emergency number. Avela currently supports US states only and a configurable emergency number.
- [ ] A lawyer reviews and replaces the draft Privacy and Terms pages (`client/src/locales/*/legal.ts`). They say plainly that they are drafts.
- [ ] Decide the lawful basis and consent wording for collecting health information, and who the "controller/covered entity" is.
- [ ] Decide retention periods (see 5) and record them.

## 2. Doctors (needs a clinical lead and a verification process)
- [ ] Choose how credentials are **independently** verified per jurisdiction (registry lookup, document check, re-verification schedule). Today an administrator reads what the applicant typed. The product says so on every profile; it must not say more until a real check exists.
- [ ] Name the people who review applications, how they are trained, and how long an application may wait.
- [ ] Decide what "suspended" means operationally (who decides, how the doctor appeals, what happens to their patients).

## 3. Clinical content (needs a clinician and a pharmacist)
- [ ] Review the prescription form: routes, the 1-4 times a day limit, warnings, and the rule that controlled substances are refused. Decide whether Avela may record prescriptions at all in the target jurisdiction. It does **not** transmit them anywhere, and says so.
- [ ] Review reminders: wording, the rule that a reminder never changes a dose and never marks a dose missed, and the default of not naming the medicine.
- [ ] Review the emergency guidance and the symptom-matching keyword list (`shared/specialties.ts`).
- [ ] Decide whether any dose or interaction checking is required before real use. None exists.

## 4. Language (needs fluent human review)
- [ ] Arabic translations (`client/src/locales/ar/`) are first drafts. Have them reviewed by Arabic-speaking clinicians and patients, especially emergency, prescription, consent and privacy wording.
- [ ] Confirm the choice of Western digits (0-9) with Arabic-speaking users and pharmacists.

## 4b. Privacy and security review (needs an independent reviewer)
- [ ] Independent penetration test and a review of `docs/SECURITY.md`.
- [ ] Decide on multi-factor sign-in for doctors and administrators (**not built; strongly recommended before real data**).
- [ ] Accessibility audit by a specialist and testing with older adults and screen-reader users (automated checks pass; they are not enough).

## 5. Patient rights (partly built)
- [x] [eng] Patients can download a copy of their information (`Settings → Download my information`).
- [x] [eng] Patients can close their account (signs out everywhere, blocks sign-in, records a request).
- [x] [eng] An operator can erase identity and patient-written text (`npm run erase:user`), keeping what doctors authored without the patient's name.
- [ ] Decide what must be kept for medical-record law and for how long, then confirm the erasure script's "retained" list is right.
- [ ] Name who processes deletion requests and the deadline you promise. There is no automatic expiry today.
- [ ] Doctors' and administrators' own data requests are not built.

## 6. Operations
- [ ] **Incident response**: who is on call, how a breach is assessed and reported, how patients are told. No runbook exists beyond `docs/OPERATIONS.md`.
- [ ] **Backups and recovery**: managed point-in-time recovery on the database, a written restore objective, and a rehearsed restore. Uploaded files are not in the database (document uploads are off on Vercel).
- [ ] **Support ownership**: a staffed support phone or email, published through `SUPPORT_*`. Without it the Help page says nobody can be reached.
- [ ] **Monitoring**: someone watches the reminder health view (`/admin/activity`) and error logs, with an escalation path.
- [ ] A real **scheduler** for reminders: five-minute calls to `/api/cron/reminders`, with seven days of evidence (`docs/SCHEDULER.md`). GitHub's schedule has not fired for this repository; a Cloudflare Worker caller is built but not deployed.
- [ ] Production email provider with a verified sending domain (reset links and email reminders need it).

## 7. Vendors and agreements (needs contracts)
- [ ] Hosting and database provider agreements covering health information (for example a BAA where required).
- [ ] Email provider agreement; confirm what message content is permitted.
- [ ] If an AI provider is ever enabled: a signed agreement, then `AI_PHI_PROCESSING_CONFIRMED=true`. Off by default.
- [ ] If speech-to-text is ever enabled: same.

## 8. Technical blockers (verified by `npm run verify:production`)
- [ ] `DEMO_MODE` is off and `DEMO_MODE_ACKNOWLEDGED` is unset.
- [ ] No demo account is active (`npm run demo:retire -- --apply` after reviewing the dry run). Seeded demonstration doctors are hidden.
- [ ] A real administrator exists (`npm run admin:create`), created from a trusted shell.
- [ ] `JWT_SECRET` is long and random; `CRON_SECRET` is set; `APP_URL` is https; the emergency number is set for the country.
- [ ] The reminder job has succeeded within the last 30 minutes.
- [ ] A **separate production database**, never the one a demonstration has used.
- [ ] `APP_DATABASE_URL` + `DB_ENFORCE_RLS=on`: the application connects as the restricted role (`docs/SECURITY.md`).
- [ ] `SCHEDULER_HEARTBEAT_URL` and `OPS_ALERT_EMAIL` are set and an alert was received at least once.
- [ ] Object storage with encryption for uploaded documents before enabling uploads.

## What still prevents real use today
1. No legal review, no jurisdiction decision, no agreements with vendors.
2. Doctor credentials are not independently verified.
3. No multi-factor sign-in. (Session tokens no longer live in script-readable storage.)
4. Reminders are not reliably delivered by a monitored scheduler; email and SMS/push are unproven in production.
5. Arabic wording unreviewed; no clinical sign-off on prescriptions or reminders.
6. No incident response, backup rehearsal, support staffing, retention policy, or penetration test.
7. Database row-level security is implemented and tested but **not yet enforced in production** (see `docs/SECURITY.md`).
