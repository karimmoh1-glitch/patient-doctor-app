# Product architecture (what exists)

This describes the implementation in the repository at the commit named in `GET /api/health`. Anything not listed
here does not exist. Where something is built but not connected to a real service, it says so.

## Shape of the system

| Layer | Implementation |
| --- | --- |
| Client | React 19 + TypeScript, Vite, Wouter routing, TanStack Query, Tailwind v4 (logical properties, so right-to-left works), Radix primitives. English plus a lazily loaded Arabic bundle. |
| API | One Express 4 application (`server/app.ts`). On Vercel it runs as a single serverless function (`server/vercel.ts` bundled to `api/index.js`); locally and on other hosts as a long-running process. |
| Data | PostgreSQL (Neon in production) through Drizzle ORM and hand-written, idempotent SQL migrations (`migrations/`, recorded in `schema_migrations`). `drizzle-kit push` is never used on a real database. |
| Sessions | A signed JWT, valid 24 h, checked on every request against a revocable device row and the live user row. The browser holds it in an `HttpOnly`, `SameSite=Strict` cookie; non-browser clients use a bearer token. |
| Background work | One authenticated HTTP endpoint (`/api/cron/reminders`) that an external caller must invoke; no in-process timers. |
| Hosting | Vercel (project `avela`), Neon Postgres, GitHub for source and CI. |

## Roles that exist today

`patient`, `doctor` (with a status: incomplete, pending, needs_info, approved, rejected, suspended), `caregiver`,
`admin`. There are **no organizations, no clinic or hospital staff roles, and no tenant boundary** yet; every doctor is an
individual. (Being built in this transformation: see `docs/PRODUCTION_READINESS.md`.)

## Capabilities that exist and work against real records

- **Accounts.** Patient sign-up, doctor registration with an application and administrator review, caregiver invitation
  by e-mail link, password reset by single-use hashed link, "sign out of all devices", account-closure request, data export.
- **Doctor directory and matching.** Search by name, specialty, state, language, modality; availability derived from the
  doctor's published weekly hours minus booked times; a symptom-to-specialty matcher (`matchingService.ts`) that is a
  deterministic keyword table, not a clinical tool.
- **Connections.** A patient asks a doctor to connect; the doctor accepts or declines; an accepted connection is what
  authorizes messaging, prescriptions and shared data. Sharing decisions are patient-controlled.
- **Messaging.** Text messages between the two parties of a connection, newest-last, with notification to the other party.
  (Delivery/read states and unread counts: not yet.)
- **Appointments.** Real slot generation in the doctor's time zone (daylight-saving safe), conflict prevention by a row
  lock plus a unique index, request / confirm / decline / reschedule / cancel / complete, 24-hour "visit soon" notices.
- **Prescriptions.** Doctor-drafted, doctor-authorized records, frozen after authorization by database triggers, with an
  append-only event history. Not transmitted to any pharmacy.
- **Medication reminders.** Patient-set wall-clock times in the patient's zone, in-app delivery, optional e-mail, bounded
  retries, per-delivery status, honest "provider accepted" wording, delivered by the scheduler endpoint.
- **Care circle.** Caregivers with granular, revocable permissions.
- **Audit log.** Append-only (trigger and privilege), actor/subject/action, no record contents.
- **Administration.** Doctor application review (approve / ask for more / reject / suspend / reinstate), scheduler health,
  access-log view.

## Things present in the code that are **not real** (being retired)

| Item | What it actually does |
| --- | --- |
| One-tap demo sign-in, `DEMO_MODE`, demo banner, `users.is_demo` | Signs in to 4 seeded accounts whose password is published in the repository |
| 12 seeded doctor profiles (`source = 'seed'`) | Fabricated providers; 11 have no login at all and could never answer a request |
| Pharmacy ordering (`/api/pharmacy`, `pharmacies` table) | A simulation: invented pharmacies, invented delivery fees ("$2.99 demo delivery"), a control that lets a patient mark their own order delivered |
| "Share health summary" (`/api/health-summary/share`) | Writes an audit row and replies "shared ... within this demo environment"; nothing is sent anywhere |
| Rule-based assistant fallback (`aiService.ts`) | A keyword responder shown as an assistant when no AI provider is configured; its system prompt calls the product a "hackathon demo" |
| Mock voice transcription | Development only; production refuses the endpoint without a real provider |

## Integrations

None is connected in production today: no e-mail provider, no SMS, no push, no video, no pharmacy, no credential
registry, no EHR/FHIR, no identity provider, no monitoring sink. See `docs/INTEGRATIONS.md` for the registry and
`docs/PRODUCTION_READINESS.md` for status.

## Where the important code is

| Concern | Files |
| --- | --- |
| Authentication, sessions, CSRF | `server/middleware/auth.ts`, `server/middleware/session.ts`, `server/routes/auth.ts` |
| Authorization by role | `server/middleware/auth.ts` (`requireRole`), `server/middleware/doctor.ts`; matrix test `tests/roleBoundaries.test.ts` |
| Database identity and row-level security | `server/dbContext.ts`, `server/db.ts`, `migrations/0014_least_privilege_and_rls.sql` |
| Scheduling | `server/services/schedulingService.ts` |
| Reminders and the scheduler | `server/services/reminderService.ts`, `server/services/schedulerRun.ts`, `server/routes/cron.ts` |
| Doctor onboarding | `server/routes/doctors.ts`, `server/routes/admin.ts`, `server/storage.ts` |
| Release gates | `server/services/readiness.ts`, `script/verify-production.ts` |
