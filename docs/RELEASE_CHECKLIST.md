# Controlled production release: the checklist

One page that sequences everything. The detail of each step is in `docs/RELEASE_PROCEDURE.md` (§ numbers below), `docs/OWNER_ACTIONS.md` and `docs/OPERATIONS_RUNBOOK.md`.
A box is ticked only when its **evidence** exists. Nothing on this page has been run against production. Every line marked **[approval]** needs the owner's words in chat; the
assistant does nothing in production without them, and approval of one line is not approval of the next.

## 0. The candidate

| | Value | Evidence |
| --- | --- | --- |
| Branch / PR | `mission2/close-security-gaps`, PR #1 | `gh pr view 1` |
| Candidate SHA | **Fill from `git rev-parse HEAD` at release time.** Last SHA with a green CI run recorded in this checklist: `b224027` (CI run 40648430310: test, restricted-role incl. the no-server-scope browser run, release-rehearsal all green; it includes migration 0030). The test site runs exactly `b224027`. The release SHA must have **its own** green run | `gh run list --branch mission2/close-security-gaps` |
| Migrations, in order | 0024 → 0025 → 0026 → 0027 → 0028 → 0029 → 0030 | `ls migrations` |
| Structure fingerprint **before** | `5dc5a2698a1e` (24 migrations) | `npm run schema:fingerprint` on production (pre-release read) |
| Structure fingerprint **after** | `8065a842b3d2`, 1396 facts (migrations 0000-0030, fresh PostgreSQL 16.14; confirm the same value on Neon PostgreSQL 18.6 after the test site is redeployed). Through 0029 it was `ae523c8fa120`, identical on PostgreSQL 16.14 and on Neon 18.6 | `npm run schema:fingerprint` |
| Compatibility | old code (704b7df) on new schema: fails closed (no sign-in, empty directory, no leak); new code on old schema: refuses to serve; neither serves unsafely | `ops/release-rehearsal.sh`, CI job `release-rehearsal` |

## 1. Before the window (all must be ticked)

| ☐ | Item | Evidence to record | Who |
| --- | --- | --- | --- |
| ☐ | CI green on the release SHA, `npm audit --omit=dev` clean | run id | assistant |
| ☐ | Local suites on the SHA: `test:rls`, `npm test`, `test:e2e:rls`, `test:e2e`, `test:prod` | counts | assistant |
| ☐ | **Provider rehearsal passed** (`neon-rehearsal.yml` on a branch of production data): migration time, lock samples, `pooler:check` PASS with the control, rollback fingerprint = `5dc5a2698a1e` | the run's step summary | owner **[approval: "authorized: Neon rehearsal"]** |
| ☐ | Preconditions §1.1: counts of real data on production are what the procedure expects (4 deactivated fixtures, nothing else) | counts only | owner / assistant read-only **[approval for the read]** |
| ☐ | Backup: Neon branch `pre-release-<date>` created and opened; **restore drill** on the provider (runbook §5): fingerprint diff, `audit:db`, role check, counts, time taken | branch id, timestamp, duration | owner |
| ☐ | Secrets rotated in order (OWNER_ACTIONS checklist): `CRON_SECRET`, `CRON_SECRET_CLOUDFLARE`, `JWT_SECRET` (signs everyone out), `avela_runtime` password, **owner DB password**, `MFA_ENCRYPTION_KEY` (free while `user_mfa` is empty), new `IDENTITY_KEY` generated and placed on the host **not yet registered** | each verified with `rotation:verify`; no value ever printed | owner **[approval per secret]** |
| ☐ | Administrator created by the owner (`admin:create`), second factor enrolled, recovery codes stored offline, `admin:check` passes | `verify:production` `admin` check | owner |
| ☐ | Scheduler: Worker deployed (`wrangler login`), `CRON_SECRET_CLOUDFLARE` set on host, first attested call visible on `/admin/integrations`. *Only required if reminders will be offered; otherwise they stay disabled and labelled* | admin page | owner |
| ☐ | E-mail: provider account, verified sending domain (SPF/DKIM/DMARC), webhook, one accepted message and one signed delivery event. *Required for S2 (password reset); not for S1* | provider dashboard + `/admin/integrations` | owner |
| ☐ | Monitoring: external uptime monitor on `/api/health/ready` and `/api/health/scheduler`, heartbeat URL, alert address; **alert drill** received | minute the alert arrived | owner |
| ☐ | Incident owner and contact path named (runbook §8) | names | owner |
| ☐ | Deploy-only-from-green rule decided (G29): procedure or gated workflow | decision | owner |
| ☐ | Window chosen; nobody invited; test site (`avela-staging-chi`) untouched by the release | time | owner |

## 2. The window (RELEASE_PROCEDURE §3; stop conditions §5)

| ☐ | Step | Expect | Stop → |
| --- | --- | --- | --- |
| ☐ | **[approval: "authorized: production release at <time>"]** | | |
| ☐ | Apply 0024-0030 (the Vercel build applies them: the test site's build applied all 30 files to an empty database in 2.4 s) | `Applied: …0029` | §6A |
| ☐ | Register the new key: `identity:key -- register --from=<file>` | `Registered key …` | §6A |
| ☐ | `audit:db` | 0 findings | §6B |
| ☐ | Deploy: `vercel deploy --prod --build-env BUILD_COMMIT=<SHA>` | ready; `/version.json` = SHA | §6B |
| ☐ | `release:verify`, `test:live` | all PASS | §6B |
| ☐ | `identity:enforce -- on`; repeat `release:verify`, `test:live` | Enforcement ON | `enforce off`, then §6B |
| ☐ | `pooler:check` from a trusted shell with `POOLER_CONTROL_REQUIRED=1 POOLER_CHECK_SERVER_SCOPE=allowed` (run **before** the next step) | PASS, control > 0 | roll back |
| ☐ | `identity:enforce -- server-scope off`; repeat checks; `pooler:check` again with `POOLER_CHECK_SERVER_SCOPE=refused` | refused; PASS | `server-scope on`, then §6B |
| ☐ | `schema:fingerprint` = `8065a842b3d2`; app connects as `avela_runtime` (`pg_stat_activity`) | recorded | investigate |
| ☐ | Synthetic checks on production **[approval to create each synthetic account]**: sign up, sign out; HTTP isolation (`ops/http-isolation.ts` refuses production because it carries no test notice: use the manual steps in §3.7 instead) | no 5xx | §6B |

**Stop conditions:** a migration error; an `audit:db` finding; the new release refusing to start; a failed `release:verify` or `test:live` check that is not a documented client-network flake;
any 5xx on a route a synthetic user used; **any response seen to be about another account** (take the site down by rolling back, preserve logs); the window exceeding thirty minutes.

## 3. Rollback (tested; RELEASE_PROCEDURE §6)

| What | Proof it works |
| --- | --- |
| Identity gate only: `identity:enforce -- off` (instant); unrestricted scope back: `server-scope on` | `identityBoundary` tests, local rehearsal |
| Application: `vercel rollback` to 704b7df, **then** database chain newest first: 0030 → 0029 → 0028 → 0027 → 0026 → 0025 → 0024 | `tests/migrationChain.test.ts` (fingerprint returns to `5dc5a2698a1e`), `ops/release-rehearsal.sh` (old code signs in again on the restored structure), CI job `release-rehearsal`; local timings 43-80 ms per rollback file; **provider timing: pending the Neon rehearsal** |
| Data concern: restore `pre-release-<date>` into a **new** branch, verify, repoint deliberately. Never restore over production | restore drill (box above) |
| Limits | Rows written in the window stay; `audit_logs` stays. The application never runs as the owner role |

## 4. After the window

`verify:production` (known blockers only), keep `pre-release-<date>` seven days, delete private key files only after they are in the password manager and a second deploy was verified,
first-hour log watch (`vercel logs --query 'level:error'`), update `docs/PRODUCTION_READINESS.md` with the evidence. **Do not invite anyone until Stage S2 conditions in
`docs/LAUNCH_GATES.md` are met.**

## 5. Explicit owner approvals still required (none given)

| # | Approval | Exact words to give |
| --- | --- | --- |
| 1 | Neon rehearsal on a branch of production data (may count against plan limits) | "authorized: Neon rehearsal" (also typed as the workflow's `authorization` input) |
| 2 | Read-only count of production data (precondition) | "authorized: read-only production counts" |
| 3 | Each secret rotation | "authorized: rotate <name>" |
| 4 | The release itself | "authorized: production release at <time>" |
| 5 | Each synthetic account created on production | "authorized: synthetic account <purpose>" |
| 6 | Real administrator creation (the owner runs it themself) | n/a: the owner's own action |
| 7 | Inviting anyone | not given and not available until S2; real patient data until S3 |
