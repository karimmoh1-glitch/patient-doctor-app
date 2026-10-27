# What only the owner can do, in order

Everything engineering could do without your credentials or authorization has been done and tested; this is what is left, with the exact commands. Rules that apply to
every step: never paste a password, key, token or MFA code into a chat, an issue, a commit or a command line you will keep in shell history; read secret values from files
(mode 600) or a password manager; tell the assistant only "done" or "failed" and what the command printed (the commands below print no secret).

| # | Action | Why now | Commands / where |
| --- | --- | --- | --- |
| 1 | **Decide D-01**: approve deploying PR #1 (migrations 0024-0028, the Mission 4 candidate) after reading `docs/RELEASE_PROCEDURE.md`. Optionally review the diff. | Production's identity handling leaks between concurrent clients (R21). Safe only while there are no users. **Do not invite anyone first.** | `gh pr view 1`; `git diff 704b7df..HEAD --stat` |
| 2 | **Log the Neon CLI in** (opens your browser; no secret is typed into any chat), then say **"authorized: Neon rehearsal branch"** if you want the assistant to run RELEASE_PROCEDURE §1.3 on a *copy* (a Neon branch of production, deleted afterwards). A branch may count against your Neon plan's limits: your call. | The only way to learn how the real pooler and PostgreSQL 18 behave with the migrations, the migration's time and locks, the cost of the identity round trips (`npm run pooler:check`), and to rehearse the provider restore (G16, G37, G40). | `npx neonctl auth` then `npx neonctl me` |
| 3 | **Cloudflare login** so the scheduler Worker can be deployed. | Starts the seven-day scheduler observation (G12). | `cd ops/scheduler-worker && npx wrangler login` (interactive). The Worker's secret is the host's **`CRON_SECRET_CLOUDFLARE`** (runbook §6; the README used to say otherwise and was corrected). |
| 4 | **Rotate secrets** with the checklist below, in order, each verified. Rotate the MFA key now (no factor is enrolled). | The owner database credential and others were copied to this laptop (G26). | `ops/generate-rotation-secrets.sh` (writes new values to private files, prints none) |
| 5 | **Create the real administrator**, yourself. | Nobody can approve a clinician without one (G07). | see the block below |
| 6 | **Run the release** (RELEASE_PROCEDURE §2-4) once 1-2 are done, or authorize the assistant to run it with you watching ("authorized: production release at <time>"). | Closes G04, G34-G36, G38, G41 on the live site. | `docs/RELEASE_PROCEDURE.md` |
| 7 | **Create the e-mail provider account**, verify the sending domain, create the webhook and the API key. | Password reset and address confirmation cannot work without it (G14). | runbook §10 |
| 8 | **Create the external monitor** (uptime on `/api/health/ready` and `/api/health/scheduler`; a heartbeat check) and give it an alert address you read. Then allow the controlled failure drill in a preview. | G17, G18. | runbook §11 |
| 9 | **Send the review packets** to the people who must decide (clinical, legal, Arabic, emergency numbers, penetration test). | G21-G25. | `docs/REVIEW_PACKETS.md` |
| 10 | **Decide**: D-02 retention/connection-end default (with the reviewers), D-03b the remaining unrestricted `server` scope (narrowed in Mission 4, not closed), D-06 hosting plan. | Before real patients. | `docs/PRODUCTION_READINESS.md` |

Nothing in this list is done for you by the assistant without the specific words of authorization shown; none needs you to paste a secret into the chat.

## Secrets rotation checklist (docs/OPERATIONS_RUNBOOK.md §9 has the detail)

Each line: do it, run the check, tick it. Never paste a value anywhere; new values live in files of mode 600 under `~/.avela-secrets/` until they are in your password manager and on the host.

| Step | Secret | Verify afterwards | Done |
| --- | --- | --- | --- |
| 0 | `ops/generate-rotation-secrets.sh` | it prints file names, not values; `ls -l ~/.avela-secrets/next-*` shows mode `-rw-------` | ☐ |
| 1 | `CRON_SECRET` (host + GitHub secret) | a call with the old value answers 401: `OLD_CRON_SECRET=… LIVE_URL=… npm run rotation:verify` | ☐ |
| 2 | `CRON_SECRET_CLOUDFLARE` (host first, redeploy, then the Worker) | `/admin/integrations` lists `cloudflare-worker` after the next 5 minutes | ☐ |
| 3 | `JWT_SECRET` (signs everyone out) | sign in again; past e-mail suppression records stop matching (runbook note) | ☐ |
| 4 | `avela_runtime` password (`db:create-app-role`, then `APP_DATABASE_URL`, redeploy) | the app answers; `rotation:verify` with the old `OLD_APP_DATABASE_URL` prints an authentication failure | ☐ |
| 5 | Database owner password in the Neon console | `OLD_OWNER_DATABASE_URL` fails; migrations still run with the new one | ☐ |
| 6 | `MFA_ENCRYPTION_KEY` (free while `SELECT count(*) FROM user_mfa` is 0; otherwise `MFA_ENCRYPTION_KEY_PREVIOUS` + `mfa:rekey`) | sign-in with a second factor works for a throwaway staff account | ☐ |
| 6b | `IDENTITY_KEY` (created fresh for the release; later rotations: `identity:key -- generate`, deploy, `retire`) | `npm run identity:key -- status`: one active key, enforcement ON; `release:verify` passes | ☐ |
| 7-9 | provider keys, tokens, sessions | runbook §9 rows 7-9 | ☐ |
| end | delete `~/.avela-secrets/next-*` only after every value is in the password manager **and** on the host | `ls ~/.avela-secrets` | ☐ |

## Creating the administrator (step 5)

On a trusted machine, with your own details (the assistant never chooses them):

```bash
# 1. the owner connection string: from the Neon console, into a variable for this shell session only
read -rs OWNER_URL && export DATABASE_URL="$OWNER_URL" && unset OWNER_URL     # paste it; nothing is echoed
# 2. create the account: it asks for the password at the terminal, twice, not echoed
ADMIN_EMAIL='you@your-domain.example' ADMIN_NAME='Your Name' npm run admin:create
# 3. check what can be checked from the database (prints no address or secret)
ADMIN_EMAIL='you@your-domain.example' npm run admin:check
# 4. sign in on the site, set up the authenticator app, store the recovery codes OFFLINE, then run step 3 again: second factor now "enabled"
npm run verify:production        # the `admin` check now passes
unset DATABASE_URL
```

If something goes wrong: `npm run password:reset -- --email=… --reason="…"` (new password, all sessions ended) and `npm run mfa:reset -- --email=… --reason="…"` (authenticator removed, all
sessions ended); both write an audit entry without secrets and need the owner connection. Recovery does not bypass the second factor: a reset password still needs the authenticator, and a reset
authenticator still needs the password.

## After each step

Tell the assistant "step N done" (and anything a command printed that was not `PASS`). It will run the matching checks (`release:verify`, `audit:db`, `admin:check`, `rotation:verify`,
`test:live`) and update `docs/PRODUCTION_READINESS.md`. A step is not a gate: the gate changes only when its evidence exists.
