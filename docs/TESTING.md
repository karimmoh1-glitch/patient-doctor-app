# Testing

## Layers

| Command | What it exercises | Where it runs |
| --- | --- | --- |
| `npm run typecheck` | The whole TypeScript project, server, client and tests | CI, locally |
| `npm test` | Vitest against a **real Postgres** `*_test` database (a mock database would hide exactly the bugs worth finding): authorization, concurrency, scheduling, prescriptions, reminders and the scheduler, privacy, audit, rate limits, sessions, database guards | CI (Postgres service), locally |
| `npm run test:e2e` | Playwright (phone profile) with axe accessibility scans in English and Arabic, against the dev server | CI, locally |
| `npm run build && npm run test:prod` | Playwright against the **built** app with the production content-security policy | CI, locally |
| `LIVE_URL=… EXPECTED_COMMIT=… npm run test:live` | Read-only browser tests against a **deployed** site; never types a password | by hand after a deploy; `.github/workflows/live-check.yml` |

Test databases must have names ending in `_test`; the suite refuses to start otherwise. No test sends a real email
(the provider is replaced by a stand-in), calls a real third party, or uses real patient information.

## The scheduler's tests

`tests/scheduler.test.ts` (lease, overlap, expiry, supersession, failure isolation, deadline, hung provider,
heartbeat, alerts, monitor endpoint, evidence), `tests/schedulerWorker.test.ts` (the external caller, with a
stand-in network), `tests/reminders.test.ts` (time zones, daylight saving, retries, deduplication).
A passing run says nothing about whether a scheduler is calling the production site: see `docs/SCHEDULER.md`.

## Intermittent multi-second stalls: investigation

**Symptom.** On 25 October 2026, between about 17:40 and 18:00 (Pacific), seven of about eighteen runs of `npm test`
(whole suite or a four-file subset) each had one test take 39-56 seconds (against a normal 100 ms), failing on the
20-second timeout. A different test each time; always one that signs a user up or writes several rows. Dozens of runs
before and after that window were clean. At the time they were put down to "the environment" without evidence, and for a
while to a change that happened to be in the working tree (the stalls appeared only with it, then did not recur in 25
later runs with it still there, so that was coincidence).

**What was ruled out, with evidence.**
- *The tests' own logic and the code under test:* the same test passes in about a second alone, and the stall moved
  between different tests and files.
- *Postgres faults:* the server log for the window has no errors, lock waits or deadlocks; checkpoint syncs took under
  0.1 s.
- *CPU contention:* with 20 busy loops on 10 cores (load average 26) a full run took 90-110 s instead of 30 s and **every
  test passed, with no stall**.
- *DNS, pool or connection slowness, event-loop blocking by the code:* `tests/stallProbe.ts` (opt-in, `STALL_PROBE=<file>`)
  logs event-loop lag, slow DNS lookups, slow pool connects and slow queries with CPU use. In 14 clean runs it logged nothing.

**What reproduced it.** Saturating the disk (four parallel 2 GB writes with `sync`) while running the suite: one full run
took **449 s** instead of 30 s, and the probe recorded single `COMMIT`s of 1.4-1.6 s and event-loop stalls with almost no
CPU used (the process was waiting on the operating system). A synchronous commit waits for the disk to confirm the
write; a test that makes a dozen commits on a busy disk takes tens of seconds. That is the same signature as the
original stalls: one slow test, no errors, nothing wrong in the code.

**Honest limit.** The mechanism is reproduced and measured. It cannot be proved to be what happened in that 20-minute
window on that date, because nothing was recording then. The disk was busy at the time (a build, a deployment, browser
test artefacts and background syncing were all running from the same machine).

**Fix (tests only).** Test connections set `synchronous_commit=off` (`tests/fastCommit.ts`, applied in
`tests/setup.ts` and `tests/globalSetup.ts`, and only to a database whose name ends in `_test`). A test database has no
need to survive a power cut. Measured under the *same* disk saturation: **449 s -> 84-98 s**. The application's own
connections are unchanged. If a stall is seen again, run with `STALL_PROBE=/tmp/stall.log npm test` and read the log:
`QUERY_SLOW ... commit` points at the disk, `LOOP_LAG` with little CPU points at the operating system, `DNS_SLOW`
or `POOL_CONNECT_SLOW` at the network path.
