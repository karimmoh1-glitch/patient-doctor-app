# Avela

Healthcare, closer to you. Avela connects patients with doctors and keeps everyday care in one place: finding a
doctor, booking a real time, messaging, prescription records and medication reminders. It is built for people who
find health technology hard (older adults, Arabic readers, people with little access to care) and gives doctors
a practical professional workspace.

**Status: a working, tested product prototype, not a launched clinical service.** Read
[`docs/SAFETY_AND_COMPLIANCE.md`](docs/SAFETY_AND_COMPLIANCE.md) and [`docs/AUDIT.md`](docs/AUDIT.md) (what works,
what is not built) before putting real patient data anywhere near it. Avela makes no HIPAA, GDPR or other
compliance claim.

## What works today

**Patients**
- Browse doctors without an account (filter by specialty, **language**, how they see patients, state, and whether
  they have times available), then create an account to connect.
- Short sign-up, with a skippable welcome (text size, optional emergency contact, first doctor).
- Real appointment booking in the patient's own time zone; the database makes double-booking impossible.
- Secure messages with a connected doctor (not an emergency channel, and the app says so).
- Prescriptions the doctor has **authorized**, with plain statements that they are records kept in Avela and are
  **not sent to a pharmacy**. Add them to today's medicines and set **reminders** (times, days, on/pause).
- A privacy page: what each doctor can see (all off until switched on) and a log of who looked.
- Care Circle: a trusted person gets read-only, revocable, scoped access.
- Emergency guidance on every screen (including before sign-in), a persistent Help button, text-size setting,
  a Simple screen, and a short list of four main destinations.
- **Arabic and English** throughout, with right-to-left layout, the language remembered on the device and the account.

**Doctors**
- Register an account, then complete professional details in a short guided form and send it for review.
- **No clinical access until an administrator approves.** States: not sent, waiting for review, more information
  requested, approved, rejected, suspended. Enforced by the server on every clinical route, not only hidden in the UI.
- After approval: a workspace with what needs attention, today and the week ahead, requests, patients, weekly hours
  (in the doctor's time zone), a profile, and a prescription workflow: **draft → review → authorize**, an
  append-only history, and controlled substances refused.

**Administrators**
- Review applications (approve, ask for more information, reject), suspend and reinstate doctors, and see an
  activity log of who did what (never the contents of records). Administrators are created from a trusted shell
  (`npm run admin:create`); there is no public admin sign-up.

## Deliberately not faked

Video visits, SMS or push reminders, live support chat, real pharmacy ordering, payments, EHR sync and independent
licence verification are **not built**. `GET /api/config` reports what is really configured and the interface hides
or labels the rest. Reminders are saved and shown in the app, but are only *delivered* when a scheduler is calling the
reminder endpoint; the app tells patients plainly when that is not happening. See
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

Demonstration-only features (example pharmacy, one-tap demo logins, seeded doctors who cannot reply) exist only
while `DEMO_MODE` is on (automatic in development, a deliberate choice elsewhere), and a banner says so.

## Tech stack

React 19, TypeScript, Vite, Wouter, TanStack Query, Tailwind CSS v4, Radix primitives, self-hosted variable fonts
(Figtree, Fraunces, Noto Sans Arabic) · Express 4, Drizzle ORM, PostgreSQL, JWT sessions with per-device revocation,
luxon for time zones, Resend for email (logged in development when no key is set) · Vitest, Playwright, axe.

## Getting started

```bash
npm install
cp .env.example .env        # set DATABASE_URL and JWT_SECRET at minimum
npm run db:migrate          # applies migrations/*.sql
npm run db:seed             # demo doctors, a demo patient, a caregiver, an admin (refuses to run in production)
npm run dev
```

Demo accounts (password `DemoPass123!`): `patient@avela.dev` (Margaret Johnson, CA), `doctor@avela.dev`
(Dr. Emily Chen), `caregiver@avela.dev`, `admin@avela.dev`. In demo mode the sign-in page also has one-tap demo
buttons. Create a real first administrator with `ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… npm run admin:create`.

## Testing

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | TypeScript, client and server |
| `npm test` | Vitest against a real Postgres `*_test` database: authorization, concurrency, scheduling, doctor verification, prescriptions, reminders, privacy, audit, email, honesty, translations |
| `npm run test:rls` | The same Vitest suite, but the application connects as the **restricted database role** with row-level security enforced (see `docs/SECURITY.md`) |
| `npm run test:e2e` | Playwright (phone profile) with axe checks in English and Arabic, against the dev server on a throwaway database |
| `npm run test:e2e:rls` | The same browser tests with the server connected as the restricted database role |
| `LIVE_URL=… EXPECTED_COMMIT=$(git rev-parse HEAD) npm run test:live` | Read-only browser tests against a **deployed** site (landing, registration, sign-in, reloads, Arabic/RTL, the demo patient and doctor screens, what each role is refused, the commit that is running) |
| `npm run build && npm run test:prod` | Playwright against the **built** app with the production content-security policy: landing page, every script chunk, fonts, sign-in and the signed-in screens for all four roles, nested-route refresh, Arabic/RTL |

Test databases: `TEST_DATABASE_URL`, `E2E_DATABASE_URL`, `PROD_SMOKE_DATABASE_URL` (names must end in `_test`; the
harness refuses to wipe anything else). CI (`.github/workflows/ci.yml`) runs all of the above against a Postgres service,
including the two restricted-role runs and a production-dependency advisory gate. See `docs/TESTING.md` (including the
investigation of intermittent slow test runs) and `docs/SCHEDULER.md` (how reminders are triggered, and what is and is
not yet proven).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API + Vite dev middleware |
| `npm run build` / `npm start` | Production bundle / run it (start applies pending migrations) |
| `npm run db:migrate` | Apply pending SQL migrations (never use `db:push` on a real database) |
| `npm run db:seed` | Demo data |
| `npm run admin:create` | Create an administrator from environment variables |
| `npm run verify:production` | List the blockers that remain before real patients (exit code 1 while any exists) |
| `npm run demo:retire` | Deactivate demonstration accounts without deleting anything (dry run unless `--apply`) |
| `npm run erase:user -- <id>` | Carry out an account-deletion request (dry run unless `--apply`) |

## Documentation

[`AUDIT.md`](docs/AUDIT.md) findings and running checklist · [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`DATA_FLOW.md`](docs/DATA_FLOW.md) where information goes · [`INTEGRATIONS.md`](docs/INTEGRATIONS.md) ·
[`SAFETY_AND_COMPLIANCE.md`](docs/SAFETY_AND_COMPLIANCE.md) decisions that need humans · [`SECURITY.md`](docs/SECURITY.md) boundaries and risks · [`REAL_PATIENT_READINESS.md`](docs/REAL_PATIENT_READINESS.md) the gate before real data · [`OPERATIONS.md`](docs/OPERATIONS.md)

## Before real patients

Everything in `SAFETY_AND_COMPLIANCE.md`, plus: object storage for uploaded documents (local disk is lost on
redeploy), signed agreements with every provider that touches health information, legal and clinical review of
emergency wording, privacy policy and terms, review of the Arabic translation by fluent speakers and clinicians,
a real scheduler for reminders, an independent security test, and testing with real older adults and
assistive-technology users.
