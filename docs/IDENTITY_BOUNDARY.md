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
| SQL injection in a *public* route (sign-in, sign-up, password reset, invitation preview/accept, webhook, cron) | Those transactions are `system`: the injection would have system access. The code has none (`sqlHygiene.test.ts` forbids interpolated, concatenated and `sql.raw` queries); the surface is 16 routes behind rate limits and single-use tokens. **Not closed** (§5). |
| A stolen runtime database credential, no application code | Sees nothing but what "nobody" sees (the public directory and free/busy). |
| A stolen owner credential or backup | Can read the key table and mint anything. Out of scope for a database boundary; protect by rotation and by keeping it off the application. |
| Full code execution in the application process | Holds the signing key, can sign anyone. Not defended; limits remain (no DDL, cannot disable audit or the guards, cannot read the key table). |
| Replay of a captured assertion | Valid for the same identity until it expires (≤ 60 s); cannot be altered; useless after the transaction on any other identity. |
| A caller whose clock is wrong | The database rejects assertions more than 300 s ahead or already expired. |

## 5. Remaining trust boundary (unresolved by design)

1. **`system` is one broad capability.** 55 of the 100 policies include `app_is_system()`. A scoped design (separate assertions for "authentication", "scheduler", "webhook",
   "organization staff", "administrator action", each allowed only the tables it needs) would shrink what an injection in a public route could do. It is recommended
   before real patients and is a policy rewrite, not a patch (decision D-03b).
2. **The application process is trusted with the key.** Mitigated by custody and rotation, not removed.
3. **Per-request, not per-statement, intent.** A signed person identity lets that person's request read everything the policies allow that person; the policies, not the
   signature, decide what that is.
