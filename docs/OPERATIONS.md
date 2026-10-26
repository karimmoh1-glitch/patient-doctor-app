# Operations

## Environment

See `.env.example`. Required in production: `DATABASE_URL`, `JWT_SECRET` (the server refuses to start without
it), `APP_URL`. Leave `DEMO_MODE` unset. Set `SUPPORT_PHONE`/`SUPPORT_EMAIL` only if people really answer them.

## Deploying

1. `npm run build`
2. `npm run db:migrate` (the start script runs it too; it is transactional and a no-op when nothing is pending)
3. `npm start`

Never run `drizzle-kit push` against a live database. Add a numbered file to `migrations/`, make it idempotent,
and test it with `npm run test:db:migrate`.

## Hosting on Vercel

The Express API runs as one serverless function (`server/vercel.ts`, bundled to `api/index.js` by `npm run build`);
the built client is served from `dist/public`. `vercel.json` holds the rewrites, security headers and the build
command, which also applies pending migrations (needs `DATABASE_URL` at build time).

- Deploy from the checkout: `npx -y vercel@65.0.0 deploy --prod --yes --scope <team>`.
- Set `DATABASE_URL`, `JWT_SECRET`, `APP_URL`; set `DEMO_MODE=true` only for a demonstration site (it shows a
  "made-up information only" banner on every screen).
- Serverless has no persistent disk: saving document *files* is switched off (`features.documentUploads=false`),
  titles and notes still save. Rate limits are per warm instance, not global.
- Voice input is off in production until a speech provider is implemented.

## Scheduled jobs

Reminders (and the daily expiry of finished prescriptions) run when something calls `GET /api/cron/reminders` with
`Authorization: Bearer $CRON_SECRET`. With no `CRON_SECRET` the endpoint answers 503 and the app tells patients that
automatic reminders are off. Vercel Cron (see `vercel.json`) sends the header itself, but the free plan allows only
a daily run; `.github/workflows/reminders.yml` calls it every five minutes once `AVELA_URL` and `CRON_SECRET` are
repository secrets. The app counts delivery as "active" only if a run completed in the last two hours.

## Administrators

`ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD='(12+ characters)' npm run admin:create` creates one; it never changes
an existing account. Suspending a doctor from the admin screen signs them out immediately.

## Verifying a deployment

After every deploy: `npm run build && npm run test:prod` (the built app with the production CSP), then open the live
URL, check `GET /api/health`, `GET /api/config`, sign in as each role, and reload a nested route. A development-server
pass is not evidence the deployed bundle works.

## Reminders: knowing whether they are really being delivered

- `/admin/activity` (administrators) shows the scheduler's last successful run, failed runs in a row, and for the last
  24 hours how many reminders fell due, were delivered in the app, were accepted by the email service, failed (and will
  be retried, at most three attempts and only while a reminder is still useful), gave up, stuck, or went overdue (came
  due, outlived the three-hour window, and were never delivered). Counts only.
- Patients see the same truth in plain words: whether automatic delivery is running, what happened to each recent
  reminder, and a notice when a time passed undelivered. "Sent" for email means **the email service accepted it**;
  Avela cannot see an inbox and never says it arrived.
- The status is `active` only if the last run **succeeded within 20 minutes** (`REMINDER_MAX_RUN_AGE_MINUTES`), `failing`
  if the latest run failed, `stale` if no recent success, `not_configured` without `CRON_SECRET`. A workflow file
  existing proves nothing: check `GET /api/config` → `features.reminderDelivery` and the admin view.
- Failures are logged as a kind only (`[reminders] run failed: Error`), never a message, address or medicine.
- Environment: `CRON_SECRET` (long, random; the scheduler sends it as a bearer token), `RESEND_API_KEY` + `EMAIL_FROM`
  (email reminders), `REMINDER_LOOKBACK_MINUTES` (default 180), `REMINDER_MAX_RUN_AGE_MINUTES` (default 20).
  GitHub repository secrets for `.github/workflows/reminders.yml`: `AVELA_URL`, `CRON_SECRET`.

## Demo mode: switching it off for a real deployment

Demo mode is on when `DEMO_MODE=true`, or automatically in development and tests. **In production it needs a second
switch, `DEMO_MODE_ACKNOWLEDGED=true`**, or the server refuses to start; any other value of `DEMO_MODE` (including none)
is real mode. In real mode: one-tap demo sign-in does not exist, the seeded accounts (marked `is_demo`) are refused at
sign-in with the same message as a wrong password and lose their sessions, simulated pharmacy and demo labels are gone,
and seeded demonstration doctors are not listed.

To retire a demonstration that shares a database with anything real (do not do this; use a separate database):
1. `npm run demo:retire` shows what would change. Review it.
2. `npm run demo:retire -- --apply` deactivates demo accounts, revokes their sessions and hides seeded doctors. Nothing is deleted.
3. Unset `DEMO_MODE` and `DEMO_MODE_ACKNOWLEDGED`; set a real administrator with `npm run admin:create`.
4. `npm run verify:production` must print no `FAIL`.
The demonstration site must use its **own** database. Never point a real deployment at it.

## Checking that a deployment is the commit you meant to ship

`GET /version.json` and `GET /api/health` carry the build's commit id. Deploy with
`vercel deploy --prod --build-env BUILD_COMMIT=$(git rev-parse HEAD)`, then
`LIVE_URL=https://… EXPECTED_COMMIT=$(git rev-parse HEAD) npm run test:live` drives the deployed site as a visitor (read-only,
demo buttons only, never a password) and fails if the commit differs.

## Backups and recovery (to be arranged by the operator)

Use the database host's managed backups with point-in-time recovery; write down the restore time objective and
rehearse a restore. Uploaded documents are not in the database: until object storage is adopted they need their
own backup, or they are lost on redeploy.

## Health check

`GET /api/health` returns 200 without touching the database. Use it for the load balancer.

## Incident basics

- Suspected account compromise: set the user inactive, revoke their devices (`user_devices.revoked_at`).
- Suspected secret leak: rotate `JWT_SECRET` (signs everyone out) and provider keys.
- Wrong data shown to a user: preserve `audit_logs`, treat as a potential breach, contact compliance.
