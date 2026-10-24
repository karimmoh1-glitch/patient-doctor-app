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
