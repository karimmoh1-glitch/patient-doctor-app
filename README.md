# Avela

Healthcare communications and care coordination: find a doctor, connect, message, book real times, keep your own health
information, and set reminders for medicines, appointments, bills and subscriptions. Built for people who find health
technology hard (older adults, Arabic readers) and for the clinicians and clinics who look after them.

**Status: a tested product, not a launched clinical service. Launch decision: NO-GO** (see
[`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) for every gate and what closes it). Avela makes no HIPAA,
GDPR or Egyptian-law compliance claim, is not an emergency service, and does not replace a hospital information system.

## What works (and is tested)

**Patients**: browse doctors without an account, with the reason each doctor appears; sign up; connect by asking a
doctor or by a **code or QR** the doctor shows (the patient sees who it is from and must confirm); messages whose status
says only what is known (*sent*, *delivered* when their app fetched it, *read* when they opened it and allow receipts),
with search, report and block; real appointment booking in their own time zone with history; **health information**
(allergies with an explicit "no known allergies" that is never inferred from an empty list, medicines they take, history,
emergency contact) where every item says who entered it and whether a clinician checked it, with versioned consent and a
time-limited, revocable grant before any clinician may help fill it in; **reminders** for medicines, appointments, tasks,
bills and subscriptions (month ends, leap years, daylight saving handled), with or without a doctor; a Care Circle; a
privacy page with who looked; an account download and closure. Arabic and English with right-to-left layout; the country
(for emergency numbers) is chosen separately from the language.

**Clinicians**: register, apply, and become visible only after an administrator records **how the licence was checked, what
was seen and when it expires** (an expired check unlists them); a second factor is required. Connect patients by code,
manage requests, hours, appointments, prescription records (draft, review, authorize; never sent anywhere), and help a
patient fill in their health information when that patient has allowed it.

**Organizations and staff**: a clinic or hospital can be created, invite staff (coordinator, scheduler, auditor,
administrator) by an e-mail-bound link, and keep follow-up tasks and internal notes. Roles and permissions come from one
table (`shared/permissions.ts`). Staff see only patients connected to the organization's own clinicians who have not hidden
themselves from staff, and only a name and appointment times; no role reads clinical records. Another organization's
patients do not exist to them (`tests/orgs.test.ts`).

**Administrators**: review clinician applications and licences, organizations, message reports, integration status and
activity. There is no public administrator sign-up (`npm run admin:create`).

## Deliberately not built, and shown as such

Video visits, SMS, push notifications, pharmacy transmission, EHR/FHIR, licence-registry lookups, single sign-on,
payments, and hospital modules (admissions, beds, laboratory, radiology, billing, pharmacy stock). `/admin/integrations`
and `GET /api/config` report what is really configured and what has been *proven* (for example e-mail is "accepted" until the
provider's signed webhook says "delivered"). See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

## Tech stack

React 19, TypeScript, Vite, Wouter, TanStack Query, Tailwind v4 (logical properties, RTL), Radix · Express 4, Drizzle ORM,
PostgreSQL (hand-written idempotent migrations), session cookies and bearer tokens, TOTP second factor, luxon, Resend ·
Vitest, Playwright, axe.

## Getting started (development)

```bash
npm install
cp .env.example .env        # set DATABASE_URL and JWT_SECRET at minimum
npm run db:migrate
npm run db:seed             # development fixtures only; refused when NODE_ENV=production
npm run dev
```

Fixture accounts (development and tests only, password `DemoPass123!`, second-factor secret in `script/fixtures.ts`):
`patient@avela.dev`, `doctor@avela.dev`, `caregiver@avela.dev`, `admin@avela.dev`. A production server refuses every account
marked as a fixture and never lists fixture clinicians, whatever is in the database. Create the first real administrator with
`ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… npm run admin:create`.

## Testing

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | TypeScript, client and server |
| `npm test` | Vitest against a real Postgres `*_test` database (authorization, tenant isolation, concurrency, scheduling, reminders, consent, messaging, credentials, e-mail evidence, emergency data, translations, production guards) |
| `npm run test:rls` | The same suite with the application connected as the **restricted database role** and row-level security enforced |
| `npm run test:e2e` / `npm run test:e2e:rls` | Playwright (phone profile) with axe checks in English and Arabic, as the owner and as the restricted role |
| `npm run build && npm run test:prod` | Playwright against the **built** app with production configuration and the production content-security policy |
| `LIVE_URL=… EXPECTED_COMMIT=$(git rev-parse HEAD) npm run test:live` | Read-only visitor checks of a **deployed** site and which commit is running |

Test databases: `TEST_DATABASE_URL`, `E2E_DATABASE_URL`, `PROD_SMOKE_DATABASE_URL` (names must end in `_test`).
CI (`.github/workflows/ci.yml`) runs all of the above with a production-dependency advisory gate. See `docs/TESTING.md`.

## Scripts

`npm run dev` · `npm run build` / `npm start` (start applies pending migrations) · `npm run db:migrate` · `npm run db:create-app-role`
· `npm run admin:create` · `npm run mfa:reset` · `npm run verify:production` (lists launch blockers) · `npm run demo:retire`
(dry run unless `--apply`) · `npm run erase:user -- <id>` (dry run unless `--apply`).

## Documentation

Start with [`PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) (what is true, what blocks launch) and
[`OPERATIONS_RUNBOOK.md`](docs/OPERATIONS_RUNBOOK.md) (deploy, database role, cutover, backup, incidents).
Then [`PRODUCT_ARCHITECTURE.md`](docs/PRODUCT_ARCHITECTURE.md) · [`SECURITY.md`](docs/SECURITY.md) ·
[`THREAT_MODEL.md`](docs/THREAT_MODEL.md) · [`DATA_FLOW.md`](docs/DATA_FLOW.md) · [`INTEGRATIONS.md`](docs/INTEGRATIONS.md) ·
[`SCHEDULER.md`](docs/SCHEDULER.md) · [`SAFETY_AND_COMPLIANCE.md`](docs/SAFETY_AND_COMPLIANCE.md) ·
[`OVERNIGHT_EXECUTION.md`](docs/OVERNIGHT_EXECUTION.md) (the working queue with evidence). `AUDIT.md` and `ARCHITECTURE.md` are
earlier snapshots, kept for history.
