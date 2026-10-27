# Operations runbook

Everything an operator needs to deploy, switch the database role, cut over to a clean database, recover, and respond.
Commands that change production are marked **[owner]**: they are prepared here and have **not** been run.
Never print, paste or commit a secret. Use the host's secret store.

## 1. Environment

Required in production (the server refuses to start otherwise; `server/config.ts` lists every problem at once):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` (or `OWNER_DATABASE_URL`) | Owner connection: migrations and operator scripts only |
| `IDENTITY_KEY_ID`, `IDENTITY_KEY` | The key the server signs per-transaction identity assertions with and the database verifies (docs/IDENTITY_BOUNDARY.md). 32 random bytes, base64; generated and registered with `npm run identity:key`. Required with the restricted role; the server refuses to start without it, or with the development key, and refuses to serve if the database does not recognise it |
| `APP_DATABASE_URL`, `DB_ENFORCE_RLS=on` | The restricted runtime role (see §2). Until set, `ALLOW_OWNER_DATABASE_ROLE=true` is needed (a deliberate, visible exception) |
| `JWT_SECRET` | 32+ random characters |
| `MFA_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Losing it locks every clinician and administrator out of their second factor. Rotating it is safe only with the steps in §9 (`MFA_ENCRYPTION_KEY_PREVIOUS`, `npm run mfa:rekey`) |
| `APP_URL` | `https://…`, no trailing slash |
| `CRON_SECRET` | Bearer secret for the general scheduler endpoint callers (GitHub's schedule, a person testing) |
| `CRON_SECRET_CLOUDFLARE` | The Cloudflare Worker's own bearer secret (≠ `CRON_SECRET`, 32+ characters). The server records a call as `cloudflare-worker` **only** if it presents this secret; a header label proves nothing. Without it no caller can ever count as a dependable scheduler (§6) |
| `EMERGENCY_DATA_REVIEWED_BY`, `EMERGENCY_DATA_REVIEWED_VERSION`, `EMERGENCY_DATA_REVIEWED_COUNTRIES` | Set only by a person who has compared `shared/emergency.ts` with its sources: their name, the data version they reviewed (the value of `EMERGENCY_DATA_VERSION`), and the countries (`US,EG`). Anything else and the screens show no number |

Optional but needed for the features they name: `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`,
`SCHEDULER_HEARTBEAT_URL`, `OPS_ALERT_EMAIL`, `SUPPORT_PHONE`/`SUPPORT_EMAIL`/`SUPPORT_HOURS`, `ADMIN_NOTIFICATION_EMAILS`.
`DEMO_MODE` and `DEMO_MODE_ACKNOWLEDGED` must be **absent**: production refuses them.

## 2. Switching the application to the restricted database role **[owner]**

Why: row-level security protects every patient table only when the application is not the table owner.
Nothing happens until step 4. Rehearse on a copy of production data first.

1. Take a backup (§5) and note its identifier.
2. Deploy a build containing the migrations (they are applied by the build step and change nothing for an owner connection).
3. As the owner: `DATABASE_URL=<owner> AVELA_RUNTIME_PASSWORD=<new 32+ chars> npm run db:create-app-role`. It prints `PASS` or lists what is wrong. Build `APP_DATABASE_URL` (same host and database, user `avela_runtime`).
4. Set `APP_DATABASE_URL` and `DB_ENFORCE_RLS=on`; keep the owner URL as `OWNER_DATABASE_URL`/`DATABASE_URL`; remove `ALLOW_OWNER_DATABASE_ROLE`. Redeploy. If the role could bypass row-level security the server serves nothing.
5. Verify: `npm run verify:production` (`rls-enforced`, `app-role` PASS) → `LIVE_URL=… EXPECTED_COMMIT=$(git rev-parse HEAD) npm run test:live` → sign in as each role → watch the error rate for an hour.
6. **Rollback:** remove `APP_DATABASE_URL` and `DB_ENFORCE_RLS`, set `ALLOW_OWNER_DATABASE_ROLE=true`, redeploy. No data or schema changes are involved.

## 3. Cutover to a clean production database **[owner]**

Today the live site's database was created for a demonstration and holds fabricated records. Do not retire them in place.

1. Create a **new** Neon database (or project). Do not touch the old one.
2. `DATABASE_URL=<new owner url> npm run db:migrate` (all migrations; idempotent).
3. Create the restricted role there (§2 steps 3–4 apply to the new database).
4. Create the first administrator from a trusted shell: `ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD='…' npm run admin:create`; sign in and set up the second factor.
5. Point a **preview** deployment at the new database; run `npm run verify:production` and `npm run test:live` against it. Required: no `FAIL`.
6. Switch production's environment to the new database; redeploy with `--build-env BUILD_COMMIT=$(git rev-parse HEAD)`; confirm the commit with `GET /version.json`.
7. Keep the old database read-only for a defined period, then delete it deliberately. `REVOKE CONNECT ON DATABASE <old> FROM PUBLIC` first, so nothing can write to it by mistake.
8. Rollback before step 7: point the environment back at the old database and redeploy.

What `npm run demo:retire` does, if an old database must be neutralised instead (it deletes nothing and is a dry run without `--apply`):
deactivates accounts marked as fixtures, revokes their sessions, hides seeded doctors. Run it with the owner connection only.

## 4. Deploying

`npm run build` → `npm run db:migrate` (the start script runs it too) → `npm start`; on Vercel:
`npx vercel deploy --prod --yes --scope <team> --build-env BUILD_COMMIT=$(git rev-parse HEAD)`. Deploy only a commit whose CI is green.
Never run `drizzle-kit push` against a real database; add a numbered, idempotent SQL file to `migrations/` instead.
A new required variable (for example `MFA_ENCRYPTION_KEY`) must be set **before** deploying the release that requires it.

## 4a. Applying a migration to production **[owner]**

On Vercel the build command is `npm run build && npm run db:migrate`: **the migration is applied during the build, before the new deployment takes traffic.**
So for the length of a build (a few minutes) the previous deployment runs against the new schema. Check "compatible with the deployed code" for every migration.

For each pending migration, in this order:

1. **Say what it does** (the file's header) and whether it is reversible (`ops/rollback/<name>.down.sql`).
2. **Rehearse on a scratch database built to production's state:** `REHEARSAL_ADMIN_URL=postgresql://…/postgres npm run migration:rehearse -- <file>`. It builds the
   database from the migrations before this one, applies it, checks it is idempotent and touches no row, runs the rollback and checks the structure is restored exactly.
3. **Prove the scratch state is production's state:** `npm run schema:fingerprint` against production's owner connection and against a fresh database built from the
   applied migrations must print the same fingerprint (`# … fingerprint abc123`); `diff` the outputs for detail. 2026-10-26: both `5dc5a2698a1e`, migration history identical.
4. **Dry-run on the provider's own server version, on a copy:** create a Neon branch of production, then
   `OWNER_DATABASE_URL=<branch owner url> npm run migration:dry-run -- <file>` (runs inside a transaction and rolls back). The scratch database may be a different
   PostgreSQL version from production (production is 18.x); this step removes that doubt. Delete the branch.
5. **Back up:** a Neon branch/restore point immediately before (§5). Note its identifier.
6. **Check compatibility with the code that is live while the build runs**, and decide: acceptable window, or deploy in two steps (an additive migration first).
7. Apply (deploy). Then `npm run schema:fingerprint` on production again and `npm run audit:db`, `npm run verify:production`, `npm run test:live`.
8. **Recover:** restore the pre-migration branch (preferred), or `psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/<name>.down.sql` **together with** redeploying the previous release.

**Migration 0024 (`0024_close_rls_gaps.sql`), assessed 2026-10-26:**

| | |
| --- | --- |
| Schema change | Row-level security on 12 tables and ~25 policies; 6 guard triggers; 1 view (`doctor_directory`); 11 functions; function privileges narrowed (`PUBLIC` loses `EXECUTE`); `app_is_caregiver_of` corrected to the status caregivers really have. **No column, table, index or row changes.** |
| Locks / data | `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and `CREATE TRIGGER` take brief exclusive locks (milliseconds on production's sizes). Rewrites nothing. Transforms nothing. |
| Reversible | Yes: `ops/rollback/0024_close_rls_gaps.down.sql`, exact (rehearsal restores the identical structure). |
| Preconditions | Migrations 0000–0023 applied (production: yes). The role `avela_app` may be absent (the grants step skips). |
| **Compatibility with the deployed code (`704b7df`)** | **Not compatible.** The old code reads `doctor_profiles` and `users` directly as the restricted role: with 0024 the public doctor directory is empty and counterpart names are missing until the new release is live. Authentication and the rest are unaffected. Pre-launch there are no real users, so the window is acceptable; otherwise deploy the code and the migration in one step (the build does) and keep the build short. |
| Verification | `npm run audit:db` (0 findings), `npm run schema:fingerprint` (post-state fingerprint matches the rehearsal's), `npm run verify:production` (`rls-complete` PASS), `npm run test:live` with `EXPECTED_COMMIT`. |
| Rollback | Redeploy the previous release **and** run the down script, or restore the pre-migration branch. |
| Backup | Neon branch immediately before the build. |

## 3a. Creating the first administrator **[owner]**

There is no public route, default account or hidden backdoor to become an administrator; this is the only way. Three independent things enforce it:
no endpoint creates an administrator (`tests/routeInventory.test.ts`, `tests/accessEndsEverywhere.test.ts`); a database trigger refuses the application's own
role the `admin` role even with full system access (`tests/rlsIdentityTables.test.ts`); and the script below runs only on the owner connection and never changes an
existing account (`tests/operatorScripts.test.ts`). Do it on a trusted machine, by the person who will hold the account.

1. Get the owner connection string for this one command only (the Neon console, or `vercel env pull` to a private folder). The script ignores `APP_DATABASE_URL`:
   it must run as the owner. Plain TCP to Neon may be blocked from some networks (see the WebSocket driver note in §11).
2. Run, with your own address and name (nobody else chooses these for you):
   `DATABASE_URL=<owner url> ADMIN_EMAIL=you@example.org ADMIN_NAME='Your Name' npm run admin:create`
   It **asks for the password at the terminal** (twice, not echoed): it never appears in shell history, a process listing or a file. 12+ characters, not a
   common password, not derived from your address. (An automated run may supply `ADMIN_PASSWORD` in the environment instead. Never type that inline in an
   interactive shell, where history would keep it.)
3. It refuses if the address already has an account, and writes an `admin.bootstrapped` audit entry (operator, host, no password, no address). Check:
   `SELECT action, created_at FROM audit_logs WHERE action = 'admin.bootstrapped'`.
4. Sign in on the live site. You are asked to set up an authenticator app and shown recovery codes **once**: store them offline. (Requires `MFA_ENCRYPTION_KEY`
   in production, which the server insists on.)
5. Delete any local copy of the connection string. Verify: `npm run verify:production` shows `admin` PASS, and `ADMIN_EMAIL=you@example.org DATABASE_URL=<owner url> npm run admin:check` (read-only; prints no address or secret) confirms the account is a live non-fixture `admin`, the bootstrap is recorded once in the audit log, the database guard that stops the application creating or promoting administrators is present, and shows the second-factor state (`none` until your first sign-in, then `enabled`). Run it again after you have enrolled.
6. Rollback: `UPDATE users SET deactivated_at = now() WHERE email = '…' AND role = 'admin'` (and revoke the sessions in `user_devices`).

**Recovery** (each is run by an operator on the owner connection, audited, and ends the account's sessions):
- Lost password and e-mail recovery is unavailable or is the same account: `npm run password:reset -- --email=… --reason="forgot password; identity confirmed by …"`
  (asks for the new password at the terminal). The second factor is untouched: they still need their authenticator.
- Lost authenticator **and** recovery codes: `npm run mfa:reset -- --email=… --reason="…"`.
- Both: run both, in that order.
- Losing `MFA_ENCRYPTION_KEY` itself: every stored second-factor secret becomes unreadable. Set a new key, then reset each clinician's, staff member's and
  administrator's second factor; everyone enrols again. Keep the key in the host's secret store **and** one offline copy.

## 5. Backups and restore

Use the host's managed backups with point-in-time recovery. **A backup that has not been restored is not a backup.** Never restore over production.

**Local rehearsal (done, synthetic data):** `ops/restore-drill.sh` creates a throwaway source database (migrations + fixture people), takes a
`pg_dump`, restores into an empty database, and checks migration records, row counts, the number of RLS-enabled tables, the number of guard
triggers, that re-running `db:migrate` is a no-op, and that the restricted role sees nothing without an identity and the right rows with one.
Result 2026-10-26: all checks pass. It proves the procedure and the schema's restorability; it does **not** prove the provider's backups or timing.

**Provider drill (not yet done; the owner runs it, on a branch, never on production):**
1. In Neon, create a branch from a point in time (or restore a snapshot) into a **new** branch. Never the primary. Note the restore point and the clock time.
2. Take that branch's owner URL (`B`). `DATABASE_URL=$B npm run db:migrate` must print "No pending migrations."
3. **Structure:** `DATABASE_URL=$B npm run schema:fingerprint > branch.txt` and the same on production: `diff` must be empty (migration history, policies, triggers,
   function bodies, privileges all included). `DATABASE_URL=$B npm run audit:db` must print 0 findings.
4. **Roles:** they are cluster-level and are not part of every logical copy. Confirm `avela_runtime` exists and can log in on the branch (connect as it); if it
   cannot, `AVELA_RUNTIME_PASSWORD=… DATABASE_URL=$B npm run db:create-app-role` (which also checks it cannot bypass row-level security).
5. **Data:** compare row counts of `users`, `messages`, `audit_logs`, `appointments` between source and branch (counts only, no row data on screen).
6. **Behaviour as the restricted role:** `DATABASE_URL=$B npm run verify:production` (database checks); point a **preview** deployment at the branch with
   `APP_DATABASE_URL` (the runtime role on the branch) and `DB_ENFORCE_RLS=on`, then `LIVE_URL=<preview> npm run test:live`.
7. Record: restore point, how long each step took (that is your real recovery time), anything that differed. Delete the branch.
Until this is done G16 stays BLOCKED; the local `ops/restore-drill.sh` is not a substitute.

**Failed migration:** the migrator runs each file in a transaction and records it in `schema_migrations`; a failure leaves earlier files applied and
the failing one not. Fix forward with a new migration; do not edit an applied file. If the build step failed, the previous deployment keeps serving.
**Accidentally revoked or rotated runtime credential:** the application stops serving (readiness 503). Fix: as the owner, `AVELA_RUNTIME_PASSWORD=<new> npm run db:create-app-role`,
update `APP_DATABASE_URL`, redeploy. Do **not** fall back to the owner role to "make it work"; if an emergency forces it, set `ALLOW_OWNER_DATABASE_ROLE=true`
knowingly, record why, and reverse it within the day.
Uploaded document files are not in the database; uploads are disabled on Vercel.

## 6. Scheduler

Design, caller options and recovery are in `docs/SCHEDULER.md`. The recommended caller is the Cloudflare Worker (`ops/scheduler-worker`).

**Deployment checklist [owner; BLOCKED until Cloudflare login]:**
1. Generate a Worker-only secret: `ops/generate-rotation-secrets.sh` (writes `CRON_SECRET_CLOUDFLARE` to a private file, prints nothing secret).
2. Set it on the host **first**: `npx vercel env add CRON_SECRET_CLOUDFLARE production --sensitive --scope <team> < <file>`, then redeploy (the server needs a release
   that knows the variable: this one). It must differ from `CRON_SECRET`; the server refuses to start in production if they are equal or the value is short.
3. `cd ops/scheduler-worker && npx wrangler login && npx wrangler secret put CRON_SECRET` (paste the **same** value as `CRON_SECRET_CLOUDFLARE`; the Worker calls it
   `CRON_SECRET`) `&& npx wrangler deploy`. `AVELA_URL` in `wrangler.toml` must be the https address; the Worker refuses anything else.
4. Within ten minutes: `GET /api/health/scheduler` reports `active`; `SELECT source, count(*) FROM job_run_history WHERE started_at > now() - interval '30 minutes' GROUP BY 1`
   shows `cloudflare-worker` (not `claimed:cloudflare-worker`: that means the secret is wrong or shared). Cloudflare's dashboard shows the cron invocations.
5. **Seven-day observation (not started):** `/admin/integrations` reads "Verified" only after seven days each with at least 90% of 288 calls from the attested
   source (`integrations.ts`), and `verify:production` `scheduler-caller` needs 24 hours of the same. Record the start date; do not call G12 passed before day 7.
6. Rollback: `npx wrangler delete`; the endpoint is unchanged and the previous callers still work.

What a `200` from the endpoint means: every step ran and none reported an error. It does **not** mean every reminder was delivered: the response counts
`emailFailed`, `emailRetried` and `truncated` (the time budget ran out; the next run, still inside the three-hour lookback window, continues). E-mail "sent" means the provider
accepted it (§10). A run with any failed step answers 500 and is retried by the Worker up to three times.

### Health endpoints and monitoring

| Endpoint | Answers | Use |
| --- | --- | --- |
| `GET /api/health` | 200 + commit and build time, no database call | "Is the process up, and which build?" |
| `GET /api/health/ready` | 200 `{"ok":true,"database":"up"}` or 503 `{"ok":false,"database":"down"}`; no error text | Uptime monitor for database outages |
| `GET /api/health/scheduler` | 200 only while the reminder job is really running; else 503 with a status word and an age | Uptime monitor / dead-man's switch for reminders |

Set up (owner): an external monitor on the last two, `SCHEDULER_HEARTBEAT_URL` (pinged after each successful run), and `OPS_ALERT_EMAIL`.
Alert payloads carry counts, status words and ages only; never names, addresses or medicines. **Drill before relying on it:** in a preview
deployment pause the caller (or point `CRON_SECRET` at a wrong value), wait one interval, confirm an alert arrives at a monitored address,
restore, confirm recovery. Do not disrupt production to test alerting.

## 7. Routine tasks

- Weekly: look at `/admin/integrations` (every row should be what you expect), `/admin/credentials?filter=expiring`, open message reports, and the reminder status on `/admin/activity`.
- When a clinician's licence is about to expire: record the renewal from `/admin/credentials`; after the expiry date they are unlisted automatically.
- Rotating secrets: follow §9; do not improvise.
- A person loses their authenticator and recovery codes: an administrator resets a clinician or staff member's second factor from the applications screen (audited); an administrator's own is reset by the operator with `npm run mfa:reset`.
- Account closure: `npm run erase:user -- <id>` (dry run without `--apply`); what it keeps and removes is described in its header.

## 8. Incidents

1. **Account compromise:** deactivate the user, revoke `user_devices`, reset the second factor, review `audit_logs` for that actor and subject.
2. **Secret leak:** rotate the secret first, then investigate. `JWT_SECRET` rotation ends all sessions.
3. **Wrong data shown to a user:** preserve `audit_logs`, stop the feature (suspend the route or the deployment), treat as a possible breach and involve whoever is responsible for notification duties in each jurisdiction. Avela has no breach-notification procedure yet; define one.
4. **Scheduler silent:** `GET /api/health/scheduler` returns 503; check the caller, then `job_run_history`, then `/admin/activity`.
5. **E-mail bounces:** `/admin/integrations` shows accepted/delivered/bounced counts for seven days; repeated bounces for one recipient are counted by keyed hash, not address.

## 9. Rotating secrets **[owner]**

**Which secrets may have been exposed (categories; values are never written down here).** 2026-10-26 audit: the owner database credential (and Neon's duplicate
variables for it) was written to a file on the operator's laptop by `vercel env pull` during operations, and again for the audit; the generated runtime database
password, `APP_DATABASE_URL` and `MFA_ENCRYPTION_KEY` are kept in `~/.avela-secrets` (mode 600); `CRON_SECRET` has existed in a file in a scratch folder and is also stored
in the repository's GitHub secrets; `JWT_SECRET` and `CRON_SECRET` are "sensitive" host variables that cannot be read back (so they did not travel with `vercel env pull`), but where they were first generated or pasted cannot be established from here: treat them as unproven. A search of all ten session transcripts for the value of every secret that could be read back
found **none** in any of them (so nothing was printed to the assistant). Treat anything that sat on a laptop as exposed to that laptop and its backups.

**Order matters; do them one at a time and verify each.** For every step: set the new value, redeploy if the host needs it, verify, **then** retire the old one.

| # | Secret | Where it lives | Effect of rotating | How |
| --- | --- | --- | --- | --- |
| 1 | `CRON_SECRET` | host; GitHub Actions secret; any caller | the callers must change together; a mismatch makes scheduled calls 401 | new value to the host and to GitHub, then the Worker (§6); verify with a call using the old value → 401 |
| 2 | `CRON_SECRET_CLOUDFLARE` | host; Worker | introduces/rotates the Worker's identity | §6 |
| 3 | `JWT_SECRET` | host | signs everyone out; MFA challenges in flight fail; **also** changes the keyed hash of e-mail recipients (`hashRecipient`), so past bounce/complaint suppression records stop matching (new bounces re-suppress) | set, redeploy; verify: an old token → 401 |
| 4 | `avela_runtime` password | database role; `APP_DATABASE_URL` | the application cannot connect until the host has the new URL | `AVELA_RUNTIME_PASSWORD=<new> DATABASE_URL=<owner> npm run db:create-app-role` then set `APP_DATABASE_URL` and redeploy **immediately**; verify the old password is refused (connect with it) |
| 5 | Database owner password (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_*`, `PG*`) | Neon role; Vercel (Neon integration variables) | migrations and operator scripts; the runtime does not use it | Reset the role password in the Neon console (the integration updates its variables), or set them by hand; redeploy; verify: the old password is refused; delete every local copy |
| 6 | `MFA_ENCRYPTION_KEY` | host | **see below**: not free once anyone has enrolled | `ops/generate-rotation-secrets.sh`, then below |
| 6b | `IDENTITY_KEY` | host; database key table | rotates the signing identity; no user is signed out | `npm run identity:key -- generate --kid=<new>`, set `IDENTITY_KEY_ID`/`IDENTITY_KEY`, redeploy, then `identity:key -- retire --kid=<old>` (docs/IDENTITY_BOUNDARY.md §3) |
| 7 | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | host; provider | e-mail | rotate in the provider, set, redeploy; verify a message and a signed event |
| 8 | `SCHEDULER_HEARTBEAT_URL`, `OPS_ALERT_EMAIL` | host | monitoring | provider-specific |
| 9 | Vercel / Cloudflare / GitHub tokens and your own login sessions | those services | — | revoke unused tokens; an admin password is changed with `npm run password:reset` |

**`MFA_ENCRYPTION_KEY`.** Production has **zero** enrolled second factors today (`SELECT count(*) FROM user_mfa` = 0), which makes now the one moment a plain replacement costs nothing. If
you rotate after anyone has enrolled: (1) set `MFA_ENCRYPTION_KEY_PREVIOUS` to the old value and `MFA_ENCRYPTION_KEY` to the new, redeploy (the server reads old
secrets with the old key and writes with the new one; recovery codes issued under either keep working); (2) `OWNER_DATABASE_URL=… MFA_ENCRYPTION_KEY=<new> MFA_ENCRYPTION_KEY_PREVIOUS=<old> npm run mfa:rekey -- --status`, then without `--status`
(secrets are re-encrypted; counts only are printed; any unreadable one means that person needs `mfa:reset`); (3) once every person has used up or regenerated their
recovery codes, remove `MFA_ENCRYPTION_KEY_PREVIOUS`. Removing it earlier makes those people's codes stop working. Tested: `tests/mfaKeyRotation.test.ts`.

**Order against the release (docs/RELEASE_PROCEDURE.md).** Rotate secrets 1-6 and 8-9 *before* the release window, each verified on its own; the owner database password (5) especially, because the release uses it. The identity key is created fresh for the release and rotated later with the same command. Nothing in this section is done by the assistant: every step is the owner's, on a trusted machine, with values read from files and never typed or pasted into a chat.

**Proving the old credential is dead** (do this, do not assume): `OLD_OWNER_DATABASE_URL=… OLD_APP_DATABASE_URL=… OLD_CRON_SECRET=… LIVE_URL=… npm run rotation:verify` prints PASS only for an explicit authentication failure (a blocked network is reported INCONCLUSIVE, not PASS). Individually: a request with the old `CRON_SECRET` → 401 (`curl -H "Authorization: Bearer <old>" …/api/cron/reminders`); an old session token → 401 on `/api/auth/me`;
`psql` with the old runtime/owner password → authentication failure; the old `APP_DATABASE_URL` removed from the host; the generated files deleted: `rm -rf ~/.avela-secrets/next-*` after the values are in a password manager.
Never paste a value into chat, an issue or a log.

## 10. E-mail **[owner]**

The integration (`server/services/emailService.ts`, `emailDeliveries.ts`, `routes/webhooks.ts`) states only what is true: **accepted** (the provider took it), then
**delivered / delayed / bounced / complained** only from the provider's signed webhook. The webhook verifies the Svix signature in constant time, rejects timestamps more than
5 minutes old and near-empty secrets, applies each event once (idempotent by event id), keeps an event for a message it has not recorded yet retryable, and never moves a status
backwards. Addresses are stored only as a keyed hash. **After a permanent bounce or a spam complaint, invitations and reminders to that address stop** (`isSuppressed`); a password
reset or confirmation link the person asked for is still attempted. Tests: `tests/emailDeliveries.test.ts`, `emailVerification.test.ts`.

To bring it up: create the provider account; verify a sending domain (SPF, DKIM, DMARC) for `EMAIL_FROM`; set `RESEND_API_KEY`; add the webhook `https://<app>/api/webhooks/resend`
for sent, delivered, delayed, bounced, complained, failed events and set `RESEND_WEBHOOK_SECRET`; redeploy. Verify: sign up with an address you own, confirm the link arrives,
`/admin/integrations` shows one accepted and then one **delivered** event. Until a signed delivered event has been seen the integration reads "configured, unverified".
Data-processing terms with the provider are a legal task (G23); the provider receives recipient addresses and message bodies.

## 11. Alerts and the controlled drill **[owner]**

What exists in code: the scheduler pings `SCHEDULER_HEARTBEAT_URL` after a successful run (and `/fail` after a bad one), e-mails `OPS_ALERT_EMAIL` after repeated failures
and on recovery (counts, a failure kind and a job name only), and `GET /api/health/ready` / `/api/health/scheduler` are for an external monitor. Tested locally against a
stand-in receiver (`tests/scheduler.test.ts`, "telling someone when it is wrong"): this proves the payloads and that a down receiver cannot break a run. It does **not** prove an alert
reaches a person.

Drill in a **preview deployment pointed at a copy of the database**, never on production: (1) create a heartbeat check at an uptime provider with a 15-minute period and an alert
route to a real address; set `SCHEDULER_HEARTBEAT_URL` and `OPS_ALERT_EMAIL` on the preview; (2) run the scheduler normally for an hour; (3) stop it (point `CRON_SECRET` at a wrong
value); (4) record the minute the alert arrives, at which address, and what it says; (5) restore and record the recovery message. G18 stays NOT TESTED until this table is filled
in with real times.

Note on reaching Neon from a laptop: plain TCP to Neon may be blocked on some networks; the operator scripts can be run through the Neon serverless driver (WebSocket). Nothing
in this repository depends on that.
