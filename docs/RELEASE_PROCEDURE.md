# Release procedure: moving production from 704b7df to the Mission 3 candidate

Status: **prepared, not executed.** Nothing below has been run against production. Every step marked **[owner]** needs the owner's authorization or credentials.
This release changes the database in four ways at once (migrations 0024-0027) and the application with it; the live release (704b7df) is **not compatible**
with the migrated database, and the new release will not serve without its identity key. The procedure therefore uses a short **maintenance window**, justified only
because production holds no real users (verified below, not assumed).

## 0. What is being released

| | |
| --- | --- |
| Candidate | the tip of branch `mission2/close-security-gaps` (PR #1). Record the exact SHA: `git rev-parse HEAD` |
| CI | must be green **on that SHA** (`gh run list --branch mission2/close-security-gaps`); an older green run does not count |
| Migrations | 0024 close RLS gaps · 0025 verified identity · 0026 private account columns · 0027 connection-end semantics (each idempotent; each has `ops/rollback/*.down.sql`; as a chain they restore production's exact current structure: `tests/migrationChain.test.ts`) |
| Environment variables, by name | **new, required**: `IDENTITY_KEY_ID`, `IDENTITY_KEY` · **new, optional**: `CRON_SECRET_CLOUDFLARE`, `MFA_ENCRYPTION_KEY_PREVIOUS` · **existing**: `DATABASE_URL` (owner), `APP_DATABASE_URL`, `DB_ENFORCE_RLS=on`, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `APP_URL`, `CRON_SECRET`, `EMERGENCY_DATA_REVIEWED_*` (absent on purpose) · **absent**: `DEMO_MODE`, `DEMO_MODE_ACKNOWLEDGED`, `ALLOW_OWNER_DATABASE_ROLE` |
| Why a window | 0026 withdraws columns the old code reads (it would fail on sign-in); 0024 empties the old code's directory; the new code refuses to start until the database recognises its key. |

## 1. Preconditions: verify, do not assume **[owner for the first three]**

1. **No real data.** On the owner connection, read counts only: `users`, `appointments`, `messages`, `prescriptions`, `documents`, `audit_logs`. Expected today: 4 users (all fixtures,
   all deactivated), 3 appointments and 3 messages (fixture history), 0 real administrators. Any other number **stops the release** and goes to the owner (the plan below assumes nothing
   precious would be affected by a few minutes of the old code failing; if that is false, redesign as expand/contract).
2. **A recoverable backup.** Create a Neon branch of production named `pre-release-<date>` (point-in-time). Note its id and timestamp. Confirm it opens (connect, `SELECT count(*) FROM schema_migrations` = 24). This is the recovery point for §6 option C.
3. **Dry run on the provider's own PostgreSQL major version**, on a *different* branch (`dry-run-<date>`) of production: `OWNER_DATABASE_URL=<branch owner url> npm run migration:dry-run` (all four, in order, one transaction, rolled back; it must print PASS and the fingerprint `5dc5a2698a1e`). Delete the branch.
4. `DATABASE_URL=<production owner url> npm run schema:fingerprint` prints fingerprint **`5dc5a2698a1e`** and 24 migrations (production still equals migrations 0000-0023). Any difference **stops the release**.
5. CI green on the candidate SHA; `npm audit --omit=dev` clean; `npm run build` clean (CI does all three).
6. Local evidence on the SHA: `npm run test:rls`, `npm test`, `npm run test:e2e:rls`, `npm run test:e2e`, `npm run test:prod` pass.
7. Review packets sent (docs/REVIEW_PACKETS.md); the release does not depend on their outcome, **launch does**.

## 2. Prepare (changes nothing the live release can notice) **[owner]**

```bash
# a fresh signing key, written to a private file, NOT registered yet (the database has no table for it until the migrations run)
npm run identity:key -- generate --no-register --out=$HOME/.avela-secrets/identity-release
# put the two values on the host, as sensitive variables, without printing them (the live release ignores them)
for NAME in IDENTITY_KEY_ID IDENTITY_KEY; do
  grep "^$NAME=" $HOME/.avela-secrets/identity-release | cut -d= -f2- | npx vercel env add $NAME production --sensitive --scope karims-projects-54b12a26
done
```

(Optional here, recommended before the window: the other secret rotations in docs/OPERATIONS_RUNBOOK.md §9, each verified on its own.)

## 3. The window **[owner]**

Start a clock; the goal is under ten minutes. Everything between "migrate" and "enforce" is the mixed state.

| # | Step | Expect | Stop condition → go to |
| --- | --- | --- | --- |
| 3.1 | `DATABASE_URL=<owner url> npm run db:migrate` (from a network that reaches Neon over TCP, or through the WebSocket driver pattern, runbook §11) | `Applied: 0024…, 0025…, 0026…, 0027…` | any error → §6A |
| 3.2 | `DATABASE_URL=<owner url> npm run identity:key -- register --from=$HOME/.avela-secrets/identity-release` | `Registered key …` | error → §6A |
| 3.3 | `DATABASE_URL=<owner url> npm run audit:db` | `0 finding(s)` | any finding → §6B |
| 3.4 | `npx vercel deploy --prod --yes --scope karims-projects-54b12a26 --build-env BUILD_COMMIT=$(git rev-parse HEAD)` | build ok (the build's `db:migrate` is a no-op), deployment ready | build or start failure → §6B |
| 3.5 | `LIVE_URL=https://avela-taupe.vercel.app EXPECTED_COMMIT=$(git rev-parse HEAD) OWNER_DATABASE_URL=<owner url> npm run release:verify` | all PASS; `Enforcement: OFF` is expected at this point | any FAIL → §6B |
| 3.6 | `LIVE_URL=… EXPECTED_COMMIT=… npm run test:live` | all pass | failure that is not `client-network` per the evidence file → §6B |
| 3.7 | In a browser, as a synthetic patient created for the purpose **[owner approves creating it]**: sign up, request the first listed doctor if any, open settings; check the Vercel runtime log for errors (`npx vercel logs --query 'level:error'`) | works; no 5xx | errors → §6B |
| 3.8 | `DATABASE_URL=<owner url> npm run identity:enforce -- on`, then repeat 3.5 and 3.6 | `Enforcement: ON`, all PASS | any FAIL → `npm run identity:enforce -- off` first (instant), then §6B |
| 3.9 | `DATABASE_URL=<owner url> npm run schema:fingerprint` and record it as the new baseline; confirm the live app connects as `avela_runtime` (`SELECT usename FROM pg_stat_activity` shows it after a request) | recorded | mismatch with the rehearsal's post-state → investigate before opening the window's end |

The window ends after 3.8. Record: SHA, CI run id, the pre-release branch id, the fingerprints, and the time taken for each step.

## 4. After the window

* `npm run verify:production` (blockers that remain are the known ones: administrator, scheduler, e-mail; nothing new).
* Delete the dry-run branch; keep `pre-release-<date>` for seven days.
* Delete `$HOME/.avela-secrets/identity-release` **only after** both values are in the owner's password manager and a second deployment has been verified using the host's copy.
* The Vercel logs, the first hour: watch for 5xx and for `identity` rejections (a request that arrives with no valid assertion sees nothing, which looks like empty pages, not errors).

## 5. Stop conditions (any one ends the roll-out)

An error from a migration · `audit:db` finding · the new release refusing to start (`database does not recognise this server's identity key`) · a failed `release:verify` or
`test:live` check that is not a documented client-network flake · any 5xx in the first hour on a route a synthetic user used · a request seen to return another account's data
(**immediately** `identity:enforce -- off` is *not* the fix for that: take the site down by rolling back, §6C, and preserve the logs) · the elapsed window exceeding thirty minutes.

## 6. Recovery (choose by what failed; never switch the application to the owner role)

* **A. A migration failed.** Each file runs in its own transaction, so the failing file left nothing and earlier files stay. Read the error; fix forward with a new migration, or, to return to the starting structure,
  run the rollback scripts for the files that did apply, **newest first**: `psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/0027_connection_end_semantics.down.sql` … then 0026, 0025, 0024. Verify `schema:fingerprint` = `5dc5a2698a1e`. The live release (704b7df) works against that structure again.
* **B. The new release misbehaves (does not start, refuses requests, fails checks).** Fastest: `npm run identity:enforce -- off` if it is only the identity gate; otherwise fix forward (register the key, correct a variable, redeploy). If it cannot be fixed within the window: `npx vercel rollback` to 704b7df **and** run the rollback chain of option A (the old code needs the old structure). Order: roll the application back first, then the database, so the old code is never left on the new structure for long.
* **C. Data concern or an unexplained failure.** Roll back application and database as in B; if the database is in doubt, restore from `pre-release-<date>` into a **new** branch, verify with `schema:fingerprint`/`audit:db`, and repoint the application (`DATABASE_URL`/`APP_DATABASE_URL`) deliberately. Never restore over production in place.
* **Limits of the rollback.** The rollback scripts restore *structure* exactly (proven) and read or change no row. Rows written by the new release in the window (a synthetic patient) stay, and the old code can read them. `audit_logs` is append-only and keeps its entries. Identity keys are removed with 0025's rollback; the host's `IDENTITY_KEY*` variables become inert.

## 7. What this procedure does not do

It does not create the administrator, deploy the scheduler Worker, set up e-mail or monitoring, rotate secrets, or run the provider restore drill; those are separate gates (docs/PRODUCTION_READINESS.md) with their own steps in docs/OPERATIONS_RUNBOOK.md. A successful release is a prerequisite for them, not a launch.
