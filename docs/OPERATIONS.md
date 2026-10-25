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
