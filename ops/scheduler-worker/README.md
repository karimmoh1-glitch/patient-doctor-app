# Avela reminder scheduler (Cloudflare Worker)

Calls `GET /api/cron/reminders` with the bearer secret every five minutes. See `docs/SCHEDULER.md` for why, how it
compares with the alternatives, how to monitor it, and how to recover.

Deploy (needs the operator's Cloudflare login; nothing here deploys itself):

```bash
cd ops/scheduler-worker
npx wrangler login                    # once, interactive
npx wrangler secret put CRON_SECRET   # paste the same value as Avela's CRON_SECRET
npx wrangler deploy
```

Check: Cloudflare dashboard → Workers → avela-reminder-scheduler → Logs / Cron triggers, and Avela's `/admin/activity`
("calls in the last 24 hours" should list `cloudflare-worker`). The Worker answers 404 to every web request.
