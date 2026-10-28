# Avela reminder scheduler (Cloudflare Worker)

Calls `GET /api/cron/reminders` with its own bearer secret (the host's `CRON_SECRET_CLOUDFLARE`; set it on the host first and redeploy, docs/OPERATIONS_RUNBOOK.md §6) every five minutes. See `docs/SCHEDULER.md` for why, how it
compares with the alternatives, how to monitor it, and how to recover.

Deploy (needs the operator's Cloudflare login; nothing here deploys itself):

```bash
cd ops/scheduler-worker
npx wrangler login                    # once, interactive
npx wrangler secret put CRON_SECRET   # paste the value of Avela's CRON_SECRET_CLOUDFLARE (NOT CRON_SECRET: only that one is recorded as the dependable scheduler)
npx wrangler deploy
```

Check: Cloudflare dashboard → Workers → avela-reminder-scheduler → Logs / Cron triggers, and Avela's `/admin/activity`
("calls in the last 24 hours" should list `cloudflare-worker`). The Worker answers 404 to every web request.
