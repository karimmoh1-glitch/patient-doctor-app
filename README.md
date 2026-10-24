# Avela

A web app that helps patients (especially older adults, caregivers and people who are not comfortable with
technology) find a doctor in their own state, book a real appointment, keep track of their care, and know
what to do next. Doctors publish their hours and manage requests; a family member can be given limited,
revocable, read-only access.

**Status: a working, tested prototype, not a launched clinical product.** Read
[`docs/AUDIT.md`](docs/AUDIT.md) (what was found and fixed, what is still not built) and
[`docs/SAFETY_AND_COMPLIANCE.md`](docs/SAFETY_AND_COMPLIANCE.md) before putting real patient data anywhere near it.
It makes no HIPAA, GDPR or other compliance claim.

## What works today

- **Find a doctor.** Describe what's wrong (typed; voice input in development only) and your state. Matching is
  deterministic and explained ("same state, specialty matches 'headache'"); no AI is involved.
- **Book a real visit.** Doctors publish weekly hours in their own time zone. Patients choose from generated
  30-minute slots shown in the patient's own time zone. The database makes double-booking impossible, including
  under simultaneous requests. Reschedule and cancel with confirmation.
- **Connect, then call.** A patient requests a connection; once a doctor accepts, a click-to-call link appears.
  Patients can end a connection, which also ends all sharing.
- **Messages** between a patient and an accepted doctor (polling, not real-time push).
- **Medicines, prescriptions, documents, timeline.** Doctors record prescriptions as notes; patients track daily
  doses. Documents are type-checked and only served through an authorized request.
- **Privacy you can see and change.** Everything beyond messages and the original request is off until the
  patient turns it on per doctor, and is enforced by the server. A patient can read who looked at their
  information.
- **Care Circle.** A trusted person gets a read-only dashboard limited to what the patient granted; the patient can
  revoke it. Medicine status says "confirmed / not confirmed", never "taken".
- **Emergency and help everywhere.** Emergency guidance is on every screen, including before sign-in. The number
  is configurable per country (`VITE_EMERGENCY_NUMBER`, default 911).
- **Accessible by design.** 18px base text with a text-size setting, 48px touch targets, 3px focus outlines,
  high-contrast tokens, keyboard and screen-reader support, reduced motion, no zoom lock, system fonts, route
  splitting for slow connections, and a Simple screen. Four main destinations for patients.
- **Languages.** English, plus a first-draft Spanish for navigation, emergency, settings, home and help
  (labelled "translation awaiting review").
- **Admin.** Doctor applications are approved by a person; licence numbers are *not* checked automatically.

## Deliberately not faked

Video visits, SMS/push reminders, live support chat, real pharmacy ordering, EHR sync and payments are **not
built**. The app reports its real capabilities at `GET /api/config`; the interface hides or labels anything
missing instead of pretending. Demonstration-only features (example pharmacy, one-tap demo logins, seeded
doctors who cannot reply) exist only while `DEMO_MODE` is on, which is automatic in development and must be
chosen deliberately elsewhere. See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

## Tech stack

React 19, TypeScript, Vite, Wouter, TanStack Query, Tailwind CSS v4, Radix UI primitives · Express 4, Drizzle
ORM, PostgreSQL, JWT sessions with per-device revocation, luxon for time zones, Resend for email (logged to the
console in development when no key is set).

## Getting started

```bash
npm install
cp .env.example .env        # set DATABASE_URL and JWT_SECRET at minimum
npm run db:migrate          # applies migrations/*.sql
npm run db:seed             # demo doctors, a demo patient, a caregiver, an admin (refuses to run in production)
npm run dev
```

Demo accounts (password `DemoPass123!`): `patient@avela.dev` (Margaret Johnson, CA),
`doctor@avela.dev` (Dr. Emily Chen, with published hours), `caregiver@avela.dev` (Sarah, Margaret's
daughter), `admin@avela.dev`. In demo mode the login page also has one-tap demo buttons.

## Testing

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | TypeScript, client and server |
| `npm test` | Vitest unit and integration tests against a real Postgres `*_test` database (authorization, concurrency, scheduling, privacy, rate limits, audit, honesty, i18n) |
| `npm run test:e2e` | Playwright on a phone profile and desktop, with axe accessibility checks, on a throwaway `*_e2e_test` database |

Test databases: `TEST_DATABASE_URL` (default `postgresql://<you>@localhost:5432/patient_doctor_app_test`, create it
first) and `E2E_DATABASE_URL`. Both names must end in `_test`; the harness refuses to wipe anything else. CI
(`.github/workflows/ci.yml`) runs all of the above against a Postgres service.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API + Vite dev middleware |
| `npm run build` / `npm start` | Production bundle / run it (start applies pending migrations) |
| `npm run db:migrate` | Apply pending SQL migrations (never use `db:push` on a real database) |
| `npm run db:seed` | Demo data |

## Documentation

[`AUDIT.md`](docs/AUDIT.md) findings and running checklist · [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`DATA_FLOW.md`](docs/DATA_FLOW.md) where information goes · [`INTEGRATIONS.md`](docs/INTEGRATIONS.md) ·
[`SAFETY_AND_COMPLIANCE.md`](docs/SAFETY_AND_COMPLIANCE.md) decisions that need humans · [`OPERATIONS.md`](docs/OPERATIONS.md)

## Before real patients

Everything in `SAFETY_AND_COMPLIANCE.md`, plus: object storage for uploaded documents (local disk is lost on
redeploy), signed agreements with every provider that touches health information, legal and clinical review of
emergency wording, native review of translations, an independent security test, and testing with real older
adults and assistive-technology users.
