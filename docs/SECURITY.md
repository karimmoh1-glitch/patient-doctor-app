# Security boundaries: what is enforced, where, and how it is tested

Honest summary: access control is enforced **in the application layer** on every request and re-checked live from the
database; a few critical records are also protected **inside the database**. There is no independent penetration test.

## Enforced boundaries

| Boundary | Enforced by | Verified by |
| --- | --- | --- |
| Nothing is reachable without a session, except 12 deliberately public endpoints | `requireAuth` on every router; sessions need a live, unrevoked device row | `tests/routeInventory.test.ts` enumerates all 110 endpoints and fails if any other one answers an anonymous caller |
| Who may reach each read endpoint, by role | `requireRole`, `requireApprovedDoctor`, `requirePatientOrApprovedDoctor` | `tests/roleBoundaries.test.ts`: a written matrix for patient / approved doctor / unapproved doctor / administrator / caregiver; a new endpoint must be classified or the test fails |
| One patient cannot read another's records | every query is keyed by the session's user id; ownership re-checked per record | `tests/authorization.test.ts`, `tests/dataRights.test.ts`, per-feature tests |
| A doctor sees a patient only through a live connection, and only what was shared | pairing status checked live; sharing grants count only while connected | `tests/authorization.test.ts`, `tests/documents.test.ts` |
| Pending, rejected and suspended doctors have no clinical access | `requireApprovedDoctor` reads status live on every request; suspension revokes sessions in the same transaction | `tests/doctorOnboarding.test.ts`, `tests/suspendedDoctor.test.ts` (reads, writes, messages, shared documents, with a before/after control) |
| Roles and statuses never come from the request | role fixed server-side at creation; strict schemas reject unknown fields | `tests/doctorOnboarding.test.ts` |
| Administrators cannot be created publicly, and cannot read patient records | only `npm run admin:create`; there are no endpoints that expose records to the admin role | role matrix; `tests/doctorOnboarding.test.ts` |
| Caregivers are read-only and scoped | care-circle permissions checked per request | `tests/careCircle.test.ts`, role matrix |
| A prescription is written, authorized and cancelled only by its doctor of record; an authorized one is frozen | route checks, atomic transitions, **and database triggers** | `tests/prescriptions.test.ts`, `tests/dbGuards.test.ts` (direct SQL is refused) |
| The access log and prescription history cannot be altered | **database triggers** make them append-only | `tests/dbGuards.test.ts` |
| Demo accounts open nothing in a real deployment | `users.is_demo` refused at sign-in and on every request when demo mode is off; production refuses to start in demo mode without a second acknowledgement | `tests/demoIsolation.test.ts`; verified against a built production server |
| Account recovery | single-use hashed links, 1-hour expiry, newest link only, all sessions revoked on reset, weak passwords refused, generic responses | `tests/auth.test.ts` |
| No sensitive data in logs | request logs carry method, path, status, time; errors log a kind only | `tests/logging.test.ts` scans every `console.*` call |
| File uploads | type allowlist, magic-byte check, never served statically, sandbox CSP; **off entirely on serverless hosting** | `tests/documents.test.ts` |
| Rate limiting | login (per address and per account), registration, messaging, invitations, public directory, scheduler secret guesses | `tests/rateLimits.test.ts` |

## Row-level security: evaluated, not enabled
Postgres (including Neon) supports row-level security. It was **not** enabled because doing it safely needs a change
to how the application reaches the database, and a half-measure would give false assurance:
- The app connects through one pooled role that owns the tables, which bypasses row-level policies.
- Policies need the current user on every statement (`SET LOCAL app.user_id` inside a per-request transaction) and a
  separate role without `BYPASSRLS`. Every route would run inside such a transaction; background jobs, the scheduler
  and administrators need their own, narrower paths.
- Doctor access depends on joins (connection and sharing grant), so those policies are non-trivial and must be
  load-tested.
Recommended staged plan: create the restricted role; add the per-request transaction helper; enable policies first on
simple patient-owned tables (`notifications`, `medication_reminders`, `ai_messages`, `documents`), then connection-based
tables; run the **whole test suite twice**, as owner and as the restricted role, before turning anything on in production.
Until then the application layer is the only line of defence for read access, apart from the triggers above.

## Known gaps and risks
- **Session tokens are in browser storage (`localStorage`)**, so a script injection would expose them. Mitigated by a strict production CSP (`script-src 'self'`), no inline scripts, and revocable sessions; the real fix is `HttpOnly` cookies with CSRF protection.
- **No multi-factor authentication.** Strongly recommended for doctors and administrators before any real data.
- **Credentials are self-reported.** See `docs/REAL_PATIENT_READINESS.md`.
- **Rate limits are in memory per server instance**; with several instances (serverless) the effective limit is higher. A shared store is needed for strict limits.
- **Password reset timing**: the response is identical, but an existing account does a little more work (one database write), a measurable difference in principle.
- **Dependency advisories**: `zod` < 4.6.6 (memory exhaustion on oversized arrays), through `openai`. Mitigated by a 100 kb JSON body cap. Fix requires a breaking upgrade.
- **No malware scanning of uploads**; uploads are disabled on Vercel.
- **Demo deployment**: the demo accounts and their published password exist on the live demo site by design. It must never hold real data (`docs/OPERATIONS.md`).
- Audit logging of reads is fail-closed for doctor and caregiver reads of patient data; other events are best-effort.
