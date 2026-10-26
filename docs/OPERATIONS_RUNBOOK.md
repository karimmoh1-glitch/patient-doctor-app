# Operations runbook

Everything an operator needs to deploy, switch the database role, cut over to a clean database, recover, and respond.
Commands that change production are marked **[owner]**: they are prepared here and have **not** been run.
Never print, paste or commit a secret. Use the host's secret store.

## 1. Environment

Required in production (the server refuses to start otherwise; `server/config.ts` lists every problem at once):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` (or `OWNER_DATABASE_URL`) | Owner connection: migrations and operator scripts only |
| `APP_DATABASE_URL`, `DB_ENFORCE_RLS=on` | The restricted runtime role (see §2). Until set, `ALLOW_OWNER_DATABASE_ROLE=true` is needed (a deliberate, visible exception) |
| `JWT_SECRET` | 32+ random characters |
| `MFA_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Losing it locks every clinician and administrator out of their second factor |
| `APP_URL` | `https://…`, no trailing slash |
| `CRON_SECRET` | Bearer secret for the scheduler |
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

## 5. Backups and restore (to be rehearsed)

Use the host's managed backups with point-in-time recovery. A backup that has not been restored is not a backup.
Rehearsal: restore into a scratch database/branch, run `npm run db:migrate` (a no-op), run `npm run verify:production`
against it with the scratch URL, count rows in `users`, `messages`, `audit_logs`, record how long it took. Uploaded document
files are not in the database; uploads are disabled on Vercel.

## 6. Scheduler

Design, caller options and recovery are in `docs/SCHEDULER.md`. To start the recommended caller **[owner]**:
`cd ops/scheduler-worker && npx wrangler login && npx wrangler secret put CRON_SECRET && npx wrangler deploy`. Then watch
`GET /api/health/scheduler` and the "Reminder scheduler" row on `/admin/integrations`; it reads "Verified" only after seven days
of dependable calls.

## 7. Routine tasks

- Weekly: look at `/admin/integrations` (every row should be what you expect), `/admin/credentials?filter=expiring`, open message reports, and the reminder status on `/admin/activity`.
- When a clinician's licence is about to expire: record the renewal from `/admin/credentials`; after the expiry date they are unlisted automatically.
- Rotating secrets: `JWT_SECRET` signs everyone out; `MFA_ENCRYPTION_KEY` **cannot** be rotated without re-enrolling every second factor (do not change it casually); `CRON_SECRET` must change in the host and in the caller together.
- A person loses their authenticator and recovery codes: an administrator resets a clinician or staff member's second factor from the applications screen (audited); an administrator's own is reset by the operator with `npm run mfa:reset`.
- Account closure: `npm run erase:user -- <id>` (dry run without `--apply`); what it keeps and removes is described in its header.

## 8. Incidents

1. **Account compromise:** deactivate the user, revoke `user_devices`, reset the second factor, review `audit_logs` for that actor and subject.
2. **Secret leak:** rotate the secret first, then investigate. `JWT_SECRET` rotation ends all sessions.
3. **Wrong data shown to a user:** preserve `audit_logs`, stop the feature (suspend the route or the deployment), treat as a possible breach and involve whoever is responsible for notification duties in each jurisdiction. Avela has no breach-notification procedure yet; define one.
4. **Scheduler silent:** `GET /api/health/scheduler` returns 503; check the caller, then `job_run_history`, then `/admin/activity`.
5. **E-mail bounces:** `/admin/integrations` shows accepted/delivered/bounced counts for seven days; repeated bounces for one recipient are counted by keyed hash, not address.
