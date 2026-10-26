# Security boundaries: what is enforced, where, and how it is tested

Honest summary: access control is enforced **in the application layer** on every request and re-checked live from the
database. A second, independent layer exists **inside the database** (a restricted role and row-level security), and
the append-only and frozen-prescription rules are enforced by triggers. **Production has connected as the restricted role since 2026-10-26** (rollout record below), so this layer is in force
there. There is no independent penetration test.

## Enforced boundaries

| Boundary | Enforced by | Verified by |
| --- | --- | --- |
| Nothing is reachable without a session, except the deliberately public endpoints | `requireAuth` on every router; sessions need a live, unrevoked device row | `tests/routeInventory.test.ts` enumerates every endpoint and fails if any other one answers an anonymous caller |
| Who may reach each read endpoint, by role | `requireRole`, `requireApprovedDoctor`, `requirePatientOrApprovedDoctor` | `tests/roleBoundaries.test.ts`: a written matrix for patient / approved doctor / unapproved doctor / administrator / caregiver; a new endpoint must be classified or the test fails |
| One patient cannot read another's records | every query is keyed by the session's user id; ownership re-checked per record; **and, once rolled out, row-level security** | `tests/authorization.test.ts`, `tests/dataRights.test.ts`, per-feature tests, `tests/rls.test.ts` |
| A doctor sees a patient only through a live connection, and only what was shared | pairing status checked live; sharing grants count only while connected; the database policy requires an accepted connection and an active doctor profile | `tests/authorization.test.ts`, `tests/documents.test.ts`, `tests/rls.test.ts` |
| Pending, rejected and suspended doctors have no clinical access | `requireApprovedDoctor` reads status live on every request; suspension revokes sessions in the same transaction | `tests/doctorOnboarding.test.ts`, `tests/suspendedDoctor.test.ts`, `tests/rls.test.ts` (suspension and ended connections remove database access) |
| Roles and statuses never come from the request | role fixed server-side at creation and read live from the database; strict schemas reject unknown fields; a forged token with a role claim is refused | `tests/doctorOnboarding.test.ts`, `tests/sessionCookie.test.ts` |
| Administrators cannot be created publicly, and cannot read patient records | only `npm run admin:create`; no endpoint exposes records to the admin role; **the database policies give the administrator no access to any patient-data table** | role matrix; `tests/rls.test.ts` |
| Caregivers are read-only and scoped | care-circle permissions checked per request; database policies allow reading, never writing | `tests/careCircle.test.ts`, `tests/rls.test.ts` |
| A prescription is written, authorized and cancelled only by its doctor of record; an authorized one is frozen | route checks, atomic transitions, **database triggers**, and (restricted role) row policies | `tests/prescriptions.test.ts`, `tests/dbGuards.test.ts` |
| The access log and prescription history cannot be altered | **database triggers** make them append-only; the restricted role also lacks the privilege | `tests/dbGuards.test.ts`, `tests/rls.test.ts` |
| The running application cannot change the database's structure | the restricted role (`avela_app`) has no DDL, no TRUNCATE, cannot disable triggers or row-level security, cannot read the migration record | `tests/rls.test.ts` ("the restricted role really is restricted") |
| Browser session | `HttpOnly`, `SameSite=Strict`, `Secure` (over https, with the `__Host-` prefix) cookie; no token in script-readable storage; cookie-authenticated changes require our own header and a same-host `Origin`; logout and "sign out of all devices" revoke on the server | `tests/sessionCookie.test.ts`, `e2e/session-migration.spec.ts`, `e2e/resilience.spec.ts` |
| Demo accounts open nothing in a real deployment | `users.is_demo` refused at sign-in and on every request when demo mode is off; production refuses to start in demo mode without a second acknowledgement | `tests/demoIsolation.test.ts`; rehearsed against a production build (below) |
| Account recovery | single-use hashed links, 1-hour expiry, newest link only, all sessions revoked on reset, weak passwords refused, generic responses | `tests/auth.test.ts` |
| No sensitive data in logs | request logs carry method, path, status, time; errors log a kind only; scheduler logs counts only | `tests/logging.test.ts` scans every `console.*` call; `tests/scheduler.test.ts` |
| File uploads | type allowlist, magic-byte check, never served statically, sandbox CSP; **off entirely on serverless hosting** | `tests/documents.test.ts` |
| Rate limiting | login (per address and per account), registration, messaging, invitations, public directory, scheduler secret guesses. **In production the counters live in Postgres, shared by every serverless instance**; if the database cannot be reached each instance falls back to its own memory | `tests/rateLimits.test.ts`, `tests/rateLimitStore.test.ts` |
| Dependencies | production dependencies have **no known advisories**; CI fails on a high-severity one | `npm audit --omit=dev --audit-level=high` in CI |

## Sessions

The web app signs in with `X-Avela-Client: web` and receives a cookie; the response body carries no token. Other
callers (tests, scripts, a future mobile client) still receive a bearer token, which is never ambient and so needs no
forgery defence. A cookie-authenticated request that is not a read must carry the same header and, if the browser sent
an `Origin`, that origin must be this site's host. A bearer token that is wrong never falls back to a cookie.

A browser that signed in before this change still holds a token in `localStorage`. On the next load, before the app
renders, the page exchanges it once for a cookie (`POST /api/auth/session`) and deletes it. A token that is no longer
valid simply signs the person out, as it would have.

Signing out has to reach the server, because script cannot delete an `HttpOnly` cookie. The sign-out request is sent with
`keepalive` (it survives the tab closing); if it gets no answer (offline) the app records that and finishes the sign-out
the next time it opens or comes back online, and a new sign-in cancels the queued one. **Residual risk:** on a device
that signed out while offline, the browser keeps a live session cookie behind a signed-out screen until the app next
runs online (at most 24 hours, the cookie's life). Covered by `e2e/session-migration.spec.ts`.

What this does and does not do: an injected script can no longer **copy** the session and use it from elsewhere. It can
still act inside the open page, so the strict production content-security policy (`script-src 'self'`, no inline
script) remains important. There is still no multi-factor authentication.

## Database layer: restricted role and row-level security

Implemented by migration `0014_least_privilege_and_rls.sql`, `server/dbContext.ts`, `server/db.ts`.

**The restricted role.** `avela_app` can read and write rows. It cannot create, alter or drop anything, truncate,
disable triggers or row-level security, read `schema_migrations`, or update/delete the audit log and prescription
history (the privilege is withheld in addition to the triggers). A login member of it, `avela_runtime`, is created by
the operator with `npm run db:create-app-role`.

**Who is asking.** Before each statement the application tells the database who the request is for, as session
settings `app.user_id` / `app.system`. There are three states and the default is the safe one:
`user` (a signed-in person), `system` (background work and the few steps that must happen before anyone is signed in:
sign-in, sign-up, password reset, accepting an invitation, the scheduler, an administrator acting on someone else's
account), and **nothing established, in which case every protected table is empty and every write is refused**. A
code path that forgets to say who it is gets no data, not all data. System access is declared route by route
(`server/middleware/systemAccess.ts`) and in a handful of named storage methods.

**What the policies say** (the first 19 tables below; migration 0024 adds the rest: see `docs/DATABASE_ACCESS_AUDIT.md`). Owner-only: notifications (anyone signed in may leave one for another person,
nobody may read another's), AI messages, data requests, sessions. System-only: password-reset and e-mail tokens.
Patient records (medicines, dose logs, reminders, symptom reports, documents, pharmacy orders, follow-up tasks,
appointments, prescriptions, sharing decisions, connections, messages, care circle): readable by the patient, a doctor
with an **accepted connection** who is **active** (suspension removes access), and an invited caregiver; writable by the
patient or a connected doctor, never a caregiver. A doctor can create a prescription only for a connected patient and
only in their own name; drafts are invisible to the patient. Administrators have no access. A doctor sees the symptom
report attached to a request addressed to them even before accepting. Booking needs to know which times are taken: a
narrow database function returns only the doctor, start and length of busy times, never whose visit it is.

**Limits, stated plainly.**
- The policies are deliberately **coarser than the application's rules**: they do not check which sections a patient
  chose to share or a caregiver's individual permissions. They stop one person's records reaching an unrelated person;
  the application still narrows what a related person sees.
- Every table is now behind row-level security (migration 0024; `docs/DATABASE_ACCESS_AUDIT.md` lists each table's policy and why). `users` is
  visible to the person themself, the other side of a connection or care-circle invitation, and colleagues; an administrator sees clinicians,
  administrators, staff and message reporters, never other patients. What the database cannot narrow is *columns*: a connected doctor who may see
  a patient's account row can, in SQL, select every column of it (the application selects only what the screens need).
- Row-level security protects against **mistakes in query scoping** (a missing `WHERE`, a forgotten check). It does not
  stop an attacker who can run arbitrary SQL as the application role, because that role also sets the identity.
  Preventing injection is the application's job (parameterized queries throughout).
- Cost: one extra round trip when a connection changes identity.
- Evidence: `npm run test:rls` runs the entire server test suite as `avela_app` with enforcement on, and
  `npm run test:e2e:rls` runs all browser tests against a server connected that way. Both run in CI. Running them
  found real mismatches during development (creating a notice for another person, availability, suspension revoking
  someone else's sessions, notification de-duplication, an administrator's counts view, a lazy query escaping its identity
  scope, operator scripts picking up the restricted role), all fixed and covered by tests.

### Rolling out the restricted role (done for production on 2026-10-26; kept for any new database)

Nothing below happens automatically, and the migration alone changes nothing for a deployment that connects as the
owner (the owner is exempt from row-level security).

1. Deploy a release containing migration 0014 (applied by the normal build step). Role and policies now exist, unused.
2. As the owner, with a password you generate and keep (32+ random characters; the script never prints it):
   `DATABASE_URL=<owner url> AVELA_RUNTIME_PASSWORD=… npm run db:create-app-role`. It reports `PASS` or lists what is wrong.
3. Build `APP_DATABASE_URL` (same host and database as `DATABASE_URL`, user `avela_runtime`, that password). On Neon use
   the **pooled** host if the owner string does; confirm the role may connect from the hosting provider.
4. Set `APP_DATABASE_URL` and `DB_ENFORCE_RLS=on` on the host; keep `DATABASE_URL` as the owner (migrations and operator
   scripts use it; they refuse the restricted role). Redeploy. If the role could bypass row-level security the server
   refuses to serve a single request, so a misconfiguration fails loudly rather than silently unprotected.
5. Verify: `npm run verify:production` (reports `rls-enforced` and `app-role`), then `npm run test:live`, then sign in
   as each role. Watch the error rate for an hour.
6. **Back out**: remove `APP_DATABASE_URL` and `DB_ENFORCE_RLS`, redeploy. No data or schema change is involved.

Risks of the switch: a code path not exercised by the tests would see no data (fail closed) until fixed; latency rises
slightly. Rehearse on a copy of production data in a non-production environment first.

## Database guards beyond row policies (migration 0024)

A row policy cannot say "this column may not change"; triggers bound to the restricted role can: it cannot create an `admin` or change anyone's role, e-mail
address or fixture flag, declare its own address verified, re-activate a suspended clinician or edit their licence and verification, approve its own
doctor application, or move a connection, appointment or follow-up to another patient or doctor. The first administrator is made by the operator on the
owner connection (`npm run admin:create`). The public doctor directory is a read-only view that omits phone and licence numbers. `PUBLIC` holds no
`EXECUTE` on any function, and the application role may execute only the policy helpers. `npm run audit:db` and `tests/rlsIdentityTables.test.ts` enforce all of this.

## Known gaps and risks
- **Production runs the restricted role since 2026-10-26.** Row-level security still protects against mistakes in query scoping, not against SQL
  injection or a stolen runtime credential (the role also sets the identity): see `docs/DATABASE_ACCESS_AUDIT.md` §3 and decision D-03.
- **A second factor exists** (TOTP, encrypted secret, recovery codes, lock-out, replay refusal) for clinicians, organization
  staff and administrators; **patients and caregivers are not required to use one.** Losing `MFA_ENCRYPTION_KEY` locks those accounts out.
- **Credentials are checked by a person, not by a registry.** The record says how and when; nothing is looked up automatically.
- **Organization staff work through server-side scoping, not row-level policies**, because a staff member has no relationship
  row (a connection, a grant) that a policy could test. All of it lives in `server/services/orgs.ts` after a permission check
  and is attacked from the outside by `tests/orgs.test.ts` (cross-organization, escalation, last owner, hidden patients).
  Treat that file as security-critical when changing it.
- **Rate limits** fall back to per-instance memory if the shared store is unreachable (by design). A distributed attacker
  still gets one window per address, not per instance. Pairing-code and invitation guessing are additionally limited per person per day.
- **Password reset timing**: identical response, a little more work for an existing account.
- **Dev-tool advisories**: moderate advisories remain in `drizzle-kit`'s own copy of `esbuild` (development-only CLI).
- **No malware scanning of uploads**; uploads are disabled on Vercel.
- **Retired demonstration data** still sits in the live database until the cutover in the runbook is approved and run. Production
  code refuses those accounts and hides those doctors regardless.
- **No independent penetration test has been performed.**
- Audit logging of reads is fail-closed for doctor, caregiver, clinician-assisted and staff-note reads; other events are best-effort.
- E-mail reminder sending is at-least-once if the provider times out after accepting a message.
- Secrets pulled to a developer machine during operations must be rotated before launch.
