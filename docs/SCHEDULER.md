# The reminder scheduler

Medication reminders are delivered by one job, `GET /api/cron/reminders`, that something outside Avela must call
about every five minutes. This document says what the job does, how it protects itself, which callers were considered,
how to set one up, how to know it is working, and what to do when it is not.

**Status of the claim "reminders are reliable": not established.** The job's logic is tested; a dependable caller is
not yet running. See "Evidence" at the end. Do not describe reminders to patients as dependable until the criteria
there are met.

## What a run does

Authenticated with `Authorization: Bearer $CRON_SECRET` (503 if no secret is configured, 401 if wrong; wrong guesses
are rate limited). Then, in this order, **each step attempted even if an earlier one fails**:

1. `reminders`: deliver every reminder that came due in the last three hours (`REMINDER_LOOKBACK_MINUTES`): an in-app
   notice, and an email if the patient chose one and an email provider is configured.
2. `appointmentNotices`: one "your visit is coming up" notice per confirmed visit in the next 24 hours.
3. `expiry`: mark finished prescriptions expired.

Housekeeping (step 3) failing never delays a medicine reminder.

## Who is calling, and how Avela knows

The endpoint accepts two kinds of secret. `CRON_SECRET` is the general one (GitHub's schedule, a person testing): such a caller may *name itself* in an
`X-Avela-Scheduler` header, which is recorded as a label in `job_run_history.source`. `CRON_SECRET_CLOUDFLARE` belongs to the Worker alone: a call that presents it is
recorded as `cloudflare-worker` **by the server**, whatever its headers say, and a call with the general secret that *claims* to be the Worker is recorded as
`claimed:cloudflare-worker` and counts for nothing. Only an attested source counts as a dependable scheduler in `verify:production` and on `/admin/integrations`. A wrong secret
creates no record at all. Replays of a captured request are harmless: a run is idempotent (lease, unique delivery keys) and the call is over TLS.
(`tests/scheduler.test.ts`, "who called: attested by secret, not by label"; `tests/productionGuards.test.ts`.)

## How a run protects itself

| Risk | Protection | Test |
| --- | --- | --- |
| Two callers at once (a retry, two schedulers) | A lease row in the database. Exactly one run executes; the other answers `202 {skipped:true}` and is recorded as `skipped_overlap`. A crashed run's lease expires by itself (90 s). | `tests/scheduler.test.ts` ("only one run at a time") |
| A late, slow run overwriting a newer run's result | The outcome is written only by the run that still holds the lease; otherwise it is recorded as `superseded` and changes nothing. | same |
| The same reminder delivered twice | A unique key on (reminder, due instant, channel); the in-app notice and its record are one transaction; an email is claimed before it is sent. | `tests/reminders.test.ts` |
| Daylight saving / time zones | Reminders are wall-clock times in the patient's zone; nonexistent local times fire at the next valid minute. | `tests/reminders.test.ts` |
| One bad reminder starving everyone after it | Each reminder is processed in its own error boundary. Others are delivered; the run is marked **failed**. | `tests/scheduler.test.ts` |
| Running past the host's limit (Vercel: 30 s) | A 20 s budget (`SCHEDULER_BUDGET_MS`). Past it, no new work starts; the run reports `truncated` and the next run continues (everything undelivered is still inside the three-hour window). Steady-state runs skip what is already delivered, so a normal run is a few reads. | same |
| A hung email provider | 8 s send timeout (`EMAIL_TIMEOUT_MS`); counted as not accepted; retried by a later run, at most three attempts in total. A timed-out send may in rare cases have been accepted late, so email is at-least-once under provider timeouts. | same |
| A failed run looking healthy | Any failed step, any item error, or a failure to record the outcome makes the run a failure: `500`, `consecutive_failures` increments, status is `failing`, `last_success_at` does not move. | same |
| A run that never happens | Only something outside Avela can notice. See "Alerting". The status turns `stale` after 20 minutes without a success. | `tests/scheduler.test.ts` |
| Secrets in logs | One JSON line per run: ids, source, outcome, duration, counts. Errors log a kind only (`first:Error`). | `tests/scheduler.test.ts`, `tests/logging.test.ts` |

"Sent" for email means **the provider accepted the message**. Avela does not receive delivery receipts and never says an
email arrived. There is no SMS or push channel.

## Seeing what happened

- `GET /api/health/scheduler`: public, no credentials; `200 {"status":"active"}` only while the last run succeeded
  within 20 minutes, otherwise `503`. Reveals a status word and an age. Point an uptime monitor at it.
- `GET /api/config` → `features.reminderDelivery`: `active | stale | failing | not_configured`.
- `/admin/activity` (administrators): last success, failures in a row, 24-hour counts (due, delivered, email accepted,
  failed, gave up, stuck, overdue), **calls in the last 24 hours, the longest silence, and who called**.
- Table `job_run_history`: one row per call (14 days kept): `started_at`, `source`, `outcome`, `duration_ms`, counts.

```sql
-- Calls per hour over the last day, by caller and outcome
SELECT date_trunc('hour', started_at) AS hour, source, outcome, count(*)
FROM job_run_history WHERE job = 'reminders' AND started_at > now() - interval '24 hours'
GROUP BY 1, 2, 3 ORDER BY 1;
```

## Choosing the caller

The caller must be independent of Avela's own hosting, call on time, retry briefly, and fail visibly.

| Option | Verdict for Avela |
| --- | --- |
| **GitHub Actions `schedule`** (`.github/workflows/reminders.yml`) | **Not dependable here, so far.** GitHub documents scheduled runs as best-effort that may be delayed or dropped under load. Observed on this repository (Actions enabled, workflows active on the default branch, GitHub reporting no incident): the reminders workflow first reached `main` at 23:58 UTC on 25 October 2026; at 05:02 UTC on 26 October the repository had **13 workflow runs on record, 12 caused by pushes and 1 by a manual dispatch, and none by a schedule**, across the original `*/5` expression, an off-peak `2-57/5` expression, a no-secrets probe workflow that was also disabled and re-enabled to force re-registration, and a daily check. The cause is not visible from our side. Kept as a free, harmless *secondary* caller (the lease makes extra callers safe). |
| **Vercel Cron** (`vercel.json`) | The current plan allows one run per day, which is not enough for medicine reminders. Kept as a daily floor and a safety net. A paid plan allows per-minute cron; this was not purchased. |
| **Cloudflare Worker with a Cron Trigger** (`ops/scheduler-worker/`) | **Recommended.** Cron Triggers are available on Cloudflare's free plan (down to every minute), independent of both Vercel and GitHub. The secret is a Worker secret. The Worker retries (3 attempts, backoff), refuses redirects, stops retrying a rejected secret, fails the invocation visibly, and can post a failure webhook. **Needs the operator's Cloudflare login to deploy; not deployed yet.** |
| Upstash QStash schedules | A reasonable alternative (managed retries, a dead-letter list). Needs an account and a plan check. |
| cron-job.org or similar | Works (custom header, failure e-mails) but puts the secret with a third party and offers less control over retries. |
| A cloud scheduler (Google Cloud Scheduler, AWS EventBridge) | Dependable, with more setup and a cloud account. |

Costs and plan limits change: confirm them with the provider before relying on them.

### Recommended arrangement
1. **Primary:** the Cloudflare Worker, every 5 minutes.
2. **Secondary:** the GitHub workflow (already in place) and the daily Vercel cron. Overlaps are harmless.
3. **Dead-man's switch:** set `SCHEDULER_HEARTBEAT_URL` to a monitor that alerts when pings stop (Healthchecks.io,
   Better Stack, Cronitor, Uptime Kuma push). A successful run pings it; a failed run pings `<url>/fail`.
4. **Uptime monitor** on `https://<host>/api/health/scheduler` (alert on non-200).
5. **E-mail:** set `OPS_ALERT_EMAIL` (needs `RESEND_API_KEY`) to be told when failures begin (and hourly while they
   continue) and when the scheduler recovers. No patient information is in the message.

## Setup

Common to every caller: the same secret in three places.
```bash
openssl rand -hex 32                      # generate once; never paste it into chat, a ticket or a log
# Vercel (production): CRON_SECRET     -> redeploy
# GitHub repo secrets:  CRON_SECRET, AVELA_URL
# Cloudflare Worker:    npx wrangler secret put CRON_SECRET
```

Cloudflare Worker: see `ops/scheduler-worker/README.md`.

Environment variables (all optional unless noted):

| Variable | Purpose | Default |
| --- | --- | --- |
| `CRON_SECRET` (required) | Bearer secret the caller presents | none: endpoint answers 503 |
| `SCHEDULER_HEARTBEAT_URL` | https URL pinged after each run (`/fail` appended on failure) | off |
| `OPS_ALERT_EMAIL` | Recipient for failure/recovery e-mails | off |
| `REMINDER_LOOKBACK_MINUTES` | How late a reminder may still be delivered | 180 |
| `REMINDER_MAX_RUN_AGE_MINUTES` | A success older than this is `stale` | 20 |
| `SCHEDULER_BUDGET_MS` | Stop starting new work after this long | 20000 |
| `SCHEDULER_LEASE_MS` | How long a crashed run blocks the next | 90000 |
| `EMAIL_TIMEOUT_MS` | Give up on one email send after | 8000 |

## Recovery

| Symptom | Check | Action |
| --- | --- | --- |
| `stale`, no recent calls in `job_run_history` | Is the caller running? Cloudflare → Workers → Logs; GitHub → Actions → "Deliver reminders" | Fix or restart the caller. Reminders that came due while it was down are delivered on the next run if still inside the 3-hour window; older ones are shown as **overdue** and are never sent late (a late "take your medicine" is worse than none). |
| Calls arrive but `401` | Secret mismatch | Make `CRON_SECRET` identical in Vercel, the caller and GitHub; redeploy. |
| Calls arrive but `503` | `CRON_SECRET` not set in the production environment | Set it and redeploy. |
| `failing` | Admin view "last error"; logs: `{"event":"scheduler.run","outcome":"failed","error":"expiry:Error"}` names the step | Fix the cause. The next successful run clears the streak. A reminder that cannot be processed is isolated: others still go out. |
| `skipped_overlap` rows only | A lease is held by a run that died | It expires in 90 s by itself. Clear manually only if needed: `UPDATE job_runs SET lease_run_id=NULL, lease_until=NULL WHERE job='reminders';` |
| E-mails "failed" | Provider status; `RESEND_API_KEY`; sending domain | Retried automatically (3 attempts, inside the window). In-app notices are unaffected. |
| Rotating the secret | | Change it in all three places in one sitting; calls fail with 401 until they match, and the admin view shows it. |

## Evidence

Passing tests prove the job's logic. They do not prove that something calls it. The criteria below must be met, and
recorded here with dates, before anyone says reminders are reliable:

- [ ] A caller that is not GitHub's scheduler has been calling every 5 minutes for **at least 7 consecutive days**, shown
      by `job_run_history` (no silence longer than 15 minutes, `ok` rate above 99%).
- [ ] A deliberately broken caller (wrong secret) and a deliberately stopped caller were each noticed by the heartbeat or
      uptime monitor, and the operator was alerted. Date and screenshot recorded.
- [ ] A real email provider is configured and one reminder email was accepted in production (acceptance only).
- [ ] The overdue count over those days is explained.

**Observed so far** (updated at each release): see the Phase C section of `docs/REAL_PATIENT_READINESS.md`.
