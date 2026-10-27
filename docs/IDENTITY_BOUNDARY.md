# The identity boundary: who is asking, and how the database knows

Written 2026-10-27 for review. Migration `0025_verified_identity.sql`, `server/identity.ts`, `server/db.ts`, `tests/identityBoundary.test.ts`.
Everything here is stated with the evidence that supports it; where a defence is partial, the page says what remains.

## 1. The questions, answered

| # | Question | Before (candidate 38205ed and production's design) | After |
| --- | --- | --- | --- |
| 1 | Can an ordinary request make SQL run with an identity the caller chose? | **No.** The identity is set once per request by `requireAuth`, from a session token that must match a live, unrevoked device row; nothing in a request body, header or query reaches it (`tests/identityBoundary.test.ts`, "identity comes from the session, never from the request"). | Same. |
| 2 | Can arbitrary SQL under `avela_runtime` set or impersonate another identity? | **Yes, completely.** Identity was two plain settings (`app.user_id`, `app.system`); `SELECT set_config('app.system','on',false)` made every policy true. | **No**, unless it holds the signing key. A value is believed only if it carries a valid, unexpired HMAC under a key stored in a table the role cannot read (`identityBoundary.test.ts`: 21 forged/tampered/expired/mis-keyed variants, the plain settings, key table access, function replacement). |
| 3 | Transaction-scoped, connection-scoped, or leaking through pooling? | **Connection-scoped, and leaking.** Measured against production's pooler (Neon PgBouncer, transaction mode; the runtime URL host is a `-pooler` host): 8 clients each set a marker session-wide and read it back 25 times: **own value returned 3 of 200 times, another client's value 26 of 200, the server connection changed 154 times**. (A read-only experiment with a harmless setting name; no data touched. The marker may linger on a few pooled server connections until they recycle.) With real traffic one person's request could therefore run as another's. Live suite passes only because it is one client at a time. | **Transaction-local** (`set_config(..., true)`): nothing survives the transaction for the next user of a connection. Proven by `identityBoundary.test.ts` ("leaves nothing on the connection…", sixty concurrent requests on a small pool, a left-behind session setting cannot decide a later request) and by the mutation check that a session-wide setting fails them. |
| 4 | Can any route, job, function or system-access helper bypass the boundary? | System access is declared (`systemAccess` on 16 public routes, `runAsSystem` in services, 29 sites in `orgs.ts`). Those run as the *server*; they are not bypasses but they are broad. | System identity now needs a signed `system` assertion like any other; it is minted only by server code. The breadth of what `system` may do is unchanged (see §5). |
| 5 | Does an injection or a compromised application path let a user reach unrelated patients? | An injection anywhere could become the server in one statement. No injection exists in the code (`tests/sqlHygiene.test.ts`), but the consequence was total. | An injection inside a request for person X can act as X (it can read X's assertion) for up to a minute, and no one else. In a *public pre-sign-in* endpoint the transaction is `system`, so an injection there still has system access (§5). A stolen runtime credential **without** the app process's key can act as nobody. |
| 6 | Can a caller forge the context used by policies, audit triggers or functions? | Yes, all of them read the same plain settings. | The guard triggers, `app_is_admin`, `app_can_see_user` and every policy call `app_user_id()` / `app_is_system()`, which now answer only from the verified identity. |

## 2. Design

**Assertion.** `v1.<kid>.<mode>.<sub>.<exp>.<mac>`: `mode` is `user` (`sub` = the person's id) or `system` (`sub` = `-`); `exp` is epoch seconds;
`mac` = base64url(HMAC-SHA256(key, `avela-identity-v1\n kid \n mode \n sub \n exp`)). The application signs one per transaction with a 60-second
life (`ASSERTION_TTL_SECONDS`); the database refuses anything expired or more than 300 seconds ahead (`app_identity_config.max_ttl_seconds`).
Canonical message fields cannot contain a newline or a dot (both the signer and the verifier enforce the character set), so no two different
assertions share a message.

**Verification, inside a trusted boundary.** `avela_identity_check()` is a `SECURITY DEFINER` function (owner's rights, fixed `search_path`) that
reads the assertion from the transaction's `app.assertion` setting, checks its shape, looks up the key, recomputes the HMAC, and compares the
**SHA-256 digests** of the two values so timing reveals nothing about a partial match. It never raises: anything wrong is "nobody". It is not
executable by the application role. `app_verified_user()` / `app_verified_system()` expose only its answer, and the helpers every policy already
used (`app_user_id()`, `app_is_system()`) call those. HMAC is computed with the built-in `sha256` from two pre-XORed key blocks (RFC 2104;
the database stores those blocks, never the key itself), so no extension is needed. A test pins the construction to Node's `createHmac`.

**Key custody.** The key exists in the application's environment (`IDENTITY_KEY_ID`, `IDENTITY_KEY`, 32 random bytes) and, as two derived pad
blocks, in `app_identity_keys`, which has row-level security on, no policy and no privilege for the application role (`audit:db` and
`rlsIdentityTables.test.ts` enforce it). The key is in no function's source (test). No function the role can execute signs, mints or returns
anything that could be used to become somebody. Anyone who can read `app_identity_keys` (the owner role, a backup) can mint any identity, which is
why the owner credential is not the runtime credential and backups are sensitive.

**Per-transaction carriage.** `server/db.ts` wraps every checked-out connection: a single statement runs as `BEGIN; set_config('app.assertion', …, true)`,
the statement, `COMMIT`; inside `db.transaction` the assertion is set straight after `BEGIN` and re-set if the code switches identity; with nobody
established an empty assertion is set, so a setting left on the connection for the whole session by anything that could run SQL on it cannot decide
a later transaction. The identity is read from the async context when the statement is issued. Cost: two extra round trips per statement
(measured on a local server: the full suite takes ~100 s against ~80 s before; against a remote database it is two network round trips more per statement, to be measured on the Neon branch).

**Start-up probe.** The first use of the pool signs an assertion for a fictitious person and asks the database who that is; if the answer is not
the same person (key not registered, retired, wrong, migration missing) the server **refuses to serve** (`tests/identityBoundary.test.ts`).

**Roll-out switch.** `app_identity_config.enforce` starts `false`: a database without a key, or an old application release that still writes the plain
settings, keeps working; plain settings are honoured only in that state, and an assertion that is present but invalid is never honoured even then. The
operator registers the key, deploys the matching release, checks it, and turns enforcement on (`npm run identity:enforce -- on`). `verify:production`
fails until it is on. Turning it off is the recovery step.

## 3. Operating it

```bash
# once, with the OWNER connection, from a trusted shell (nothing prints a key)
DATABASE_URL=<owner url> npm run identity:key -- generate          # registers the key in the database; writes IDENTITY_KEY_ID/IDENTITY_KEY to a mode-600 file
# put the two values on the host without echoing them (Vercel sensitive variables), deploy the release that signs, then:
DATABASE_URL=<owner url> npm run identity:key -- status            # one active key, enforcement off
npm run verify:production && LIVE_URL=… EXPECTED_COMMIT=… npm run test:live
DATABASE_URL=<owner url> npm run identity:enforce -- on            # only now are plain settings ignored
```

*Rotation:* `identity:key -- generate --kid=<new>` (the database now accepts both), set the host's `IDENTITY_KEY_ID`/`IDENTITY_KEY`, redeploy, confirm
requests succeed, `identity:key -- retire --kid=<old>`. The command refuses to retire the only active key. *Recovery:* if requests are being rejected,
`identity:enforce -- off` restores the old behaviour at once; if the key was lost, generate another (the database may hold several); if the owner
credential is needed and unavailable, the database cannot be changed, which is the intended property.

## 4. What this defends against, and what it does not

| Attacker | Outcome |
| --- | --- |
| SQL injection in a signed-in request | Acts as that one person for ≤ 60 s. Cannot become another person, an administrator, or the server. |
| SQL injection in a *public* route (sign-in, sign-up, password reset, invitation preview/accept, webhook, cron) | Since migration 0028 those transactions are **scoped** (§5): an injection there has the access of that one scope (e.g. `auth`: accounts, tokens, devices, second-factor rows, its own audit/e-mail ledger entries; **not** medicines, messages, visits, prescriptions, documents, symptom reports or sharing decisions), never the unrestricted `server` scope. The code has no such injection (`sqlHygiene.test.ts` forbids interpolated SQL) |
| A stolen runtime database credential, no application code | Sees nothing but what "nobody" sees (the public directory and free/busy). |
| A stolen owner credential or backup | Can read the key table and mint anything. Out of scope for a database boundary; protect by rotation and by keeping it off the application. |
| Full code execution in the application process | Holds the signing key, can sign anyone. Not defended; limits remain (no DDL, cannot disable audit or the guards, cannot read the key table). |
| Replay of a captured assertion | Valid for the same identity until it expires (≤ 60 s); cannot be altered; useless after the transaction on any other identity. |
| A caller whose clock is wrong | The database rejects assertions more than 300 s ahead or already expired. |

## 5. Scoped system identities (migration 0028, Mission 4)

"System" used to be one identity that every policy accepted. The assertion now names a **scope** (`v1.<kid>.system.<scope>.<exp>.<mac>`; `server/identity.ts` `SYSTEM_SCOPES`)
and the database lets each narrow scope touch only the tables its job needs. `app_is_system()` means the unrestricted scope **`server`** only, so anything not explicitly opened
to a narrower scope stays closed to it (fail closed). An unknown or edited scope fails verification and is nobody (`tests/systemScopes.test.ts`).

| Scope | Used by | Tables it may touch (read/write as the existing policies allow) |
| --- | --- | --- |
| `auth` | sign-up, sign-in, e-mail confirmation, password reset, second factor, clinician registration | users, user_devices, password_reset_tokens, email_verification_tokens, user_mfa, mfa_recovery_codes, audit_logs, email_deliveries, doctor_applications |
| `invite` | redeeming care-circle and organization invitations | users, user_devices, audit_logs, care_circle_members, org_invitations, org_memberships, organizations |
| `session` | the lookup of a session token | user_devices, users |
| `scheduler` | the reminder run (`/api/cron/reminders`) | medication_reminders, medications, prescriptions, reminder_deliveries, notifications, appointments, personal_reminders, personal_reminder_deliveries, job_runs, job_run_history, email_deliveries, users |
| `webhook` | the e-mail provider's reports | email_deliveries, email_webhook_events |
| `ratelimit` | shared rate-limit counters | rate_limit_hits |
| `server` | code that acts for an already signed-in person after its own permission check (organization staff, administrators, the person's own background work), tests | everything `system` ever reached |

How it is built: the added access is a set of extra permissive policies `avela_scope_<table>_<command>` (the existing policies are not edited, so the rollback is exact: `ops/rollback/0028…down.sql`
drops them); the four functions that release private account columns (`app_user_credentials`, `_by_id`, `app_user_private`, `app_user_contacts`) and the e-mail-confirmation guard check the scope.
The application tags every public route with `systemAccess("<scope>")` (`tests/systemScopes.test.ts` lists them and fails if one names `server` or nothing); a helper called from inside a narrow scope
inherits it, it cannot widen it.

How it is checked: (1) the structural test compares the policies the database has with a second, independent list of the intended permissions; (2) rows that exist are read/written
by each narrow scope directly to prove what is *denied* (clinical, messaging and visit tables for `auth`, `invite`, `session`, `webhook`, `ratelimit`; messages, documents, symptom reports,
sharing decisions, care-circle, follow-ups, pairings for `scheduler`); (3) scenario tests do each scope's real work end to end (`tests/scopeScenarios.test.ts`: reminder run with e-mail,
personal reminders, visit notices, expiry, the job ledger; sign-up, recovery with its e-mail ledger; the webhook) plus the whole suite as the oracle; (4) a leave-one-out run removed each
grant in turn and re-ran the scenario files: see the list at the end of this section; (5) a spy proves public flows never mint the `server` scope.

**Leave-one-out result.** Every (table, scope) entry of the matrix was removed one at a time from a scratch database and the behavioural tests re-run. The first draft had 46 entries. Nine were dropped at once because the whole suite passed without them (`notifications`/`auth`; `email_deliveries`, `notifications`, `mfa_recovery_codes`, `pairing_requests`, `doctor_profiles`/`invite`; `audit_logs`, `doctor_profiles`, `pairing_requests`/`scheduler`). The other 37 were tested one at a time: **33 were needed** (removing any one made a scenario, a route test or the best-effort-write detector fail) and **4 were not and were removed**: `doctor_profiles`/`auth`, `health_entries`/`scheduler`, `prescription_events`/`scheduler`, `user_mfa`/`invite`. The matrix above is the 33 that remain. The detector matters: audit entries, the e-mail ledger and notices swallow their own failures, so a removed grant would otherwise pass silently (`AVELA_FAIL_ON_SWALLOWED=1` makes such a log line fail the test that caused it). **Limit:** a grant is "needed" only if some test exercises it; a code path no test reaches could still need one, and would fail closed (an error or a missing audit row), not open. That is why the scenario files are part of the suite.

### Remaining trust boundary

1. **The `server` scope is still broad.** About 90 call sites (organization staff services 29, `storage.ts` 18, invitations/credentials/e-mail services) still run unscoped after an
   authenticated person's own permission check. An injection *inside one of those code paths* would run as `server`. Nothing reachable without signing in runs as `server`
   (checked by `tests/systemScopes.test.ts`). The next narrowing is scopes for `staff` (organizations), `admin` and `maintenance`, each a matrix like the above; it is mechanical now and
   still open (decision D-03b, narrowed but **not closed**).
2. **The application process is trusted with the key.** Mitigated by custody and rotation (`tests/identityKeyRotation.test.ts`: both keys verify while both are registered, retiring the old one
   locks nobody out, re-registering an id replaces its value, neither the key nor a signed identity appears in console output or responses), not removed.
3. **Per-request, not per-statement, intent.** A signed person identity lets that person's request read everything the policies allow that person; the policies, not the
   signature, decide what that is.
4. **Measured only against a local PostgreSQL 16, with a small shared pool of the application's own (`tests/poolConcurrency.test.ts`, `identityBoundary.test.ts`), not a real PgBouncer.** The production pooler
   (PgBouncer transaction mode in front of PostgreSQL 18) has not been exercised with these tests; no pooler is installed on the development machine and installing one was not authorised; that is the Neon safe-branch step in `docs/RELEASE_PROCEDURE.md` §1.3 (BLOCKED on the owner's `npx neonctl auth`).
