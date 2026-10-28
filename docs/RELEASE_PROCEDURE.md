# Release procedure: moving production from 704b7df to the Mission 5 candidate

Status: **prepared, not executed.** Nothing below has been run against production. Every step marked **[owner]** needs the owner's authorization or credentials.
This release changes the database in six ways at once (migrations 0024-0029) and the application with it; the live release (704b7df) is **not compatible**
with the migrated database, and the new release will not serve without its identity key. The procedure therefore uses a short **maintenance window**, justified only
because production holds no real users (verified below, not assumed).

## 0. What is being released

| | |
| --- | --- |
| Candidate | the tip of branch `mission2/close-security-gaps` (PR #1). Record the exact SHA: `git rev-parse HEAD` |
| CI | must be green **on that SHA** (`gh run list --branch mission2/close-security-gaps`); an older green run does not count |
| Migrations | 0024 close RLS gaps · 0025 verified identity · 0026 private account columns · 0027 connection-end semantics · 0028 scoped system identities · 0029 narrow server scope (eleven more scopes, the switch that makes the database refuse the unrestricted one) (each idempotent; each has `ops/rollback/*.down.sql`; as a chain they restore production's exact current structure: `tests/migrationChain.test.ts`; 0028 alone: `npm run migration:rehearse -- 0028_scoped_system_identity.sql`, exact rollback proven) |
| Environment variables, by name | **new, required**: `IDENTITY_KEY_ID`, `IDENTITY_KEY` · **new, optional**: `CRON_SECRET_CLOUDFLARE`, `MFA_ENCRYPTION_KEY_PREVIOUS` · **existing**: `DATABASE_URL` (owner), `APP_DATABASE_URL`, `DB_ENFORCE_RLS=on`, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `APP_URL`, `CRON_SECRET`, `EMERGENCY_DATA_REVIEWED_*` (absent on purpose) · **absent**: `DEMO_MODE`, `DEMO_MODE_ACKNOWLEDGED`, `ALLOW_OWNER_DATABASE_ROLE` |
| Why a window | 0026 withdraws columns the old code reads (it would fail on sign-in); 0024 empties the old code's directory; the new code refuses to start until the database recognises its key; 0028 makes `app_is_system()` mean only the unrestricted `server` scope, so an application release that signs unscoped system assertions (anything before the Mission 4 candidate) sees no clinical data after it. The Mission 3 candidate (e90ff77) is therefore **not** compatible with 0028 either: deploy the Mission 4 candidate. |

## 1. Preconditions: verify, do not assume **[owner for the first three]**

1. **No real data.** On the owner connection, read counts only: `users`, `appointments`, `messages`, `prescriptions`, `documents`, `audit_logs`. Expected today: 4 users (all fixtures,
   all deactivated), 3 appointments and 3 messages (fixture history), 0 real administrators. Any other number **stops the release** and goes to the owner (the plan below assumes nothing
   precious would be affected by a few minutes of the old code failing; if that is false, redesign as expand/contract).
2. **A recoverable backup.** Create a Neon branch of production named `pre-release-<date>` (point-in-time). Note its id and timestamp. Confirm it opens (connect, `SELECT count(*) FROM schema_migrations` = 24). This is the recovery point for §6 option C.
3. **Dry run on the provider's own PostgreSQL major version**, on a *different* branch (`dry-run-<date>`) of production: `OWNER_DATABASE_URL=<branch owner url> npm run migration:dry-run` (all five, in order, one transaction, rolled back; it must print PASS and the fingerprint `5dc5a2698a1e`; note the wall-clock time and, from another session, `SELECT pid, mode, relation::regclass FROM pg_locks WHERE NOT granted` while it runs: expected none, the migrations only take brief catalog locks). Delete the branch.
4. `DATABASE_URL=<production owner url> npm run schema:fingerprint` prints fingerprint **`5dc5a2698a1e`** and 24 migrations (production still equals migrations 0000-0023). Any difference **stops the release**.
5. CI green on the candidate SHA; `npm audit --omit=dev` clean; `npm run build` clean (CI does all three).
6. Local evidence on the SHA: `npm run test:rls`, `npm test`, `npm run test:e2e:rls`, `npm run test:e2e`, `npm run test:prod` pass.
7. Review packets sent (docs/REVIEW_PACKETS.md); the release does not depend on their outcome, **launch does**.

### 1.3 The safe-branch rehearsal on the provider (what Mission 4 could not do) **[owner: `npx neonctl auth` first]**

Nothing below touches production's data or settings; it works on a Neon branch of production that is deleted afterwards. Record the output of each step in the release notes (counts, times, verdicts; no URLs, keys or rows).

```bash
npx neonctl auth && npx neonctl me                                  # logs the CLI in with your browser; nothing is typed here
npx neonctl branches create --name rehearse-$(date +%Y%m%d) --project-id <id>   # a copy-on-write branch of production: costs nothing until it diverges
export OWNER_DATABASE_URL="$(npx neonctl connection-string rehearse-$(date +%Y%m%d) --project-id <id>)"   # held in this shell only
npm run schema:fingerprint                                          # expect 5dc5a2698a1e and 24 migrations (the branch is production as it is today)
npm run migration:dry-run                                           # 0024-0028 in one transaction, rolled back; note the seconds
DATABASE_URL="$OWNER_DATABASE_URL" npm run db:migrate && npm run audit:db   # for real, on the branch; expect "0 finding(s)"; note the seconds
npm run identity:key -- generate --kid=rehearsal                    # registers a key on the BRANCH and writes it to a mode-600 file
# the pooled runtime URL of the branch (Neon console: branch > Connection details > Pooled connection, role avela_runtime) goes into APP_DATABASE_URL for this shell
DATABASE_URL="$OWNER_DATABASE_URL" DB_ENFORCE_RLS=on npm run pooler:check   # (APP_DATABASE_URL = the pooled runtime url) PASS and 0 crossings; latency numbers are the cost to record
npm run identity:enforce -- on && npm run identity:enforce -- server-scope off && npm run audit:db
npm run migration:rehearse -- 0028_scoped_system_identity.sql       # (uses a local scratch database; repeat the chain test there with the provider's server version if a scratch Neon database is available)
# rollback rehearsal, newest first, then compare:
for f in 0029_narrow_server_scope 0028_scoped_system_identity 0027_connection_end_semantics 0026_private_account_columns 0025_verified_identity 0024_close_rls_gaps; do psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/$f.down.sql; done
npm run schema:fingerprint                                          # must be 5dc5a2698a1e again
npx neonctl branches delete rehearse-$(date +%Y%m%d) --project-id <id>
```

What this answers that the local rehearsal cannot: that the SQL runs on the provider's PostgreSQL major version; that the pooler does not cross identities with the real application pool; the migration's wall-clock time and locks; and the price of the two extra round trips per statement against a remote database.

### 1.3b What Mission 6 already measured on the real provider (test site; not a substitute for §1.3 on production data)

On an isolated Neon database (PostgreSQL 18.6, pooled endpoint, restricted role, enforcement on, unrestricted scope refused), with synthetic data: the Vercel build applied 0000-0029 in 2.4 s; fingerprint `ae523c8fa120`;
`pooler:check` (with its positive control, `POOLER_CONTROL_REQUIRED=1 POOLER_CHECK_SERVER_SCOPE=refused`) 2,644 requests, 0 under the wrong identity, the control read another client's value 113/120; the deployed application under
1,503 interleaved requests from 12 users: 0 crossings, 0 server errors. `ops/staging-journeys.ts` 37/37. Practical notes learned there: (a) a **new** Vercel project can refuse a deploy with "the commit author doesn't have permission"
when the CLI attaches git metadata from a worktree; deploying an exported tree (`git archive <sha> | tar -x -C <dir>`) avoids it; (b) Vercel validates `functions` before building, and `api/index.js` is a gitignored build output, so an exported tree needs
a placeholder file at that path (the build overwrites it); (c) the auth rate limiter (about 10 attempts per network per window) throttles scripts: do not probe it in a loop; (d) after `server-scope off`, a request that asks for the
unrestricted scope is *nobody*, which is the correct and expected answer.

### 1.4 What the local rehearsal already shows (`ops/release-rehearsal.sh`, scratch database, synthetic data, real servers)

Run it again on any machine with PostgreSQL: `bash ops/release-rehearsal.sh`. It starts the **new** code on production's **old** schema (it refuses to serve: sign-in 500, no token, the log says the database does not recognise
the key), the **old** code (704b7df) on the **new** schema with enforcement on and off (sign-in does not succeed, no token or private value in any answer, the public directory is empty: it fails closed, it does not
leak), the new code on the new schema with the key registered, enforcement on and the unrestricted scope refused (serves), the six migrations timed one by one, and the rollback chain newest first followed by the old code
on the restored structure (signs in again). The unsafe-looking intermediate state is therefore *unavailable*, not dangerous: between the migration and the deploy the live site cannot sign anyone in, which is why §3 is a window.
**Measured locally** (PostgreSQL 16, a nearly empty database, the file `docs/evidence/release-rehearsal-local.txt`): the six migrations took 0024 329 ms, 0025 339 ms, 0026 343 ms, 0027 348 ms, 0028 313 ms, 0029 316 ms (total 1988 ms; each figure includes starting the TypeScript runner, which dominates, so the SQL itself took less); the six rollbacks 0029 54 ms, 0028 71 ms, 0027 58 ms, 0026 60 ms, 0025 80 ms, 0024 43 ms (total 366 ms). These are the cost of the SQL on an empty database, not of a production-sized one or a remote one; locks were not observed locally (the migrations only touch catalog objects and brief table locks). `npm run pooler:check` locally: 2,080 requests, 0 under the wrong identity, `SELECT 1` p50 0.1 ms with or without an identity (a local socket: the two extra round trips per statement cost nothing there and will cost real milliseconds over the network). **Not measured**: anything on the provider (migration time and locks on a production-sized database, the pooler, the latency of the two extra round trips). That run is BLOCKED (`docs/OWNER_ACTIONS.md` step 2).
This is PostgreSQL 16 on a laptop; the provider run in §1.3 repeats it on PostgreSQL 18 through the pooler.

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
| 3.1 | `DATABASE_URL=<owner url> npm run db:migrate` (from a network that reaches Neon over TCP, or through the WebSocket driver pattern, runbook §11) | `Applied: 0024…, 0025…, 0026…, 0027…, 0028…, 0029…` | any error → §6A |
| 3.2 | `DATABASE_URL=<owner url> npm run identity:key -- register --from=$HOME/.avela-secrets/identity-release` | `Registered key …` | error → §6A |
| 3.3 | `DATABASE_URL=<owner url> npm run audit:db` | `0 finding(s)` | any finding → §6B |
| 3.4 | `npx vercel deploy --prod --yes --scope karims-projects-54b12a26 --build-env BUILD_COMMIT=$(git rev-parse HEAD)` | build ok (the build's `db:migrate` is a no-op), deployment ready | build or start failure → §6B |
| 3.5 | `LIVE_URL=https://avela-taupe.vercel.app EXPECTED_COMMIT=$(git rev-parse HEAD) OWNER_DATABASE_URL=<owner url> npm run release:verify` | all PASS; `Enforcement: OFF` is expected at this point | any FAIL → §6B |
| 3.6 | `LIVE_URL=… EXPECTED_COMMIT=… npm run test:live` | all pass | failure that is not `client-network` per the evidence file → §6B |
| 3.7 | In a browser, as a synthetic patient created for the purpose **[owner approves creating it]**: sign up, request the first listed doctor if any, open settings; check the Vercel runtime log for errors (`npx vercel logs --query 'level:error'`) | works; no 5xx | errors → §6B |
| 3.8 | `DATABASE_URL=<owner url> npm run identity:enforce -- on`, then repeat 3.5 and 3.6 | `Enforcement: ON`, all PASS | any FAIL → `npm run identity:enforce -- off` first (instant), then §6B |
| 3.8b | `APP_DATABASE_URL=<the POOLED runtime url> DB_ENFORCE_RLS=on IDENTITY_KEY_ID=… IDENTITY_KEY=… npm run pooler:check` (from a trusted shell, key from the file, never typed) | `PASS`, `0 under the wrong identity`, latency printed | any wrong identity → `identity:enforce -- off` is NOT a fix; roll back (§6B) |
| 3.8c | `DATABASE_URL=<owner url> npm run identity:enforce -- server-scope off`, then repeat 3.5 and 3.6 | `The unrestricted server scope is now refused by the database`, all PASS (`release:verify` now checks it) | any FAIL → `identity:enforce -- server-scope on` first (instant), then §6B |
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
  run the rollback scripts for the files that did apply, **newest first**: `psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/0029_narrow_server_scope.down.sql`, then 0028, 0027, 0026, 0025, 0024. Verify `schema:fingerprint` = `5dc5a2698a1e`. The live release (704b7df) works against that structure again.
* **B. The new release misbehaves (does not start, refuses requests, fails checks).** Fastest: `npm run identity:enforce -- off` if it is only the identity gate; otherwise fix forward (register the key, correct a variable, redeploy). If it cannot be fixed within the window: `npx vercel rollback` to 704b7df **and** run the rollback chain of option A (the old code needs the old structure). Order: roll the application back first, then the database, so the old code is never left on the new structure for long.
* **C. Data concern or an unexplained failure.** Roll back application and database as in B; if the database is in doubt, restore from `pre-release-<date>` into a **new** branch, verify with `schema:fingerprint`/`audit:db`, and repoint the application (`DATABASE_URL`/`APP_DATABASE_URL`) deliberately. Never restore over production in place.
* **Limits of the rollback.** The rollback scripts restore *structure* exactly (proven) and read or change no row. Rows written by the new release in the window (a synthetic patient) stay, and the old code can read them. `audit_logs` is append-only and keeps its entries. Identity keys are removed with 0025's rollback; the host's `IDENTITY_KEY*` variables become inert.

## 7. What this procedure does not do

It does not create the administrator, deploy the scheduler Worker, set up e-mail or monitoring, rotate secrets, or run the provider restore drill; those are separate gates (docs/PRODUCTION_READINESS.md) with their own steps in docs/OPERATIONS_RUNBOOK.md. A successful release is a prerequisite for them, not a launch.
