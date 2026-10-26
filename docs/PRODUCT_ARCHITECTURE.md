# Product architecture (what exists)

This describes the implementation in the repository at the commit named in `GET /api/health`. Anything not listed here does
not exist. Where something is built but not connected to a real service, it says so.

## Shape of the system

| Layer | Implementation |
| --- | --- |
| Client | React 19 + TypeScript, Vite, Wouter, TanStack Query, Tailwind v4 (logical properties, so right-to-left works), Radix. English plus a lazily loaded Arabic bundle. |
| API | One Express 4 application (`server/app.ts`); on Vercel a single serverless function (`server/vercel.ts`, bundled to `api/index.js`). Provider webhooks are mounted before the JSON parser so their signatures cover the exact bytes. |
| Data | PostgreSQL (Neon) through Drizzle ORM and hand-written, idempotent SQL migrations (`migrations/`, recorded in `schema_migrations`); `drizzle-kit push` is never used on a real database. |
| Database identity | Every request runs as a signed-in person, as the system (a short list of pre-sign-in steps), or as nobody (sees nothing). With `APP_DATABASE_URL` and `DB_ENFORCE_RLS=on` the application connects as a restricted role and row-level security applies (`docs/SECURITY.md`). |
| Sessions | Signed JWT (24 h) checked on every request against a revocable device row and the live user row; browser: `HttpOnly`, `SameSite=Strict` cookie plus CSRF header and Origin check; other clients: bearer token. Clinicians, organization staff and administrators need a second factor (TOTP) before any session exists. |
| Background work | One authenticated HTTP endpoint (`/api/cron/reminders`) that an external caller must invoke; steps: medicine reminders, personal reminders, appointment notices, prescription expiry. A database lease prevents overlap; every run is recorded. |
| Hosting | Vercel (project `avela`), Neon Postgres, GitHub for source and CI. |

## Who can sign in (global roles) and what organization roles add

`patient`, `doctor` (status: incomplete, pending, needs_info, approved, rejected, suspended), `caregiver`, `admin` (Avela
reviewers), `staff` (an organization's coordinators, schedulers, auditors and administrators, made from an invitation).
Inside an organization: `owner`, `admin`, `clinician`, `coordinator`, `scheduler`, `auditor`, with permissions from one table
(`shared/permissions.ts`). **No organization role grants access to clinical records.** A system operator is not an application role.

## Capabilities that work against real records

- **Accounts.** Patient sign-up; clinician registration with an application and a recorded licence check; staff accounts by
  invitation; caregiver invitation; password reset; sign-out everywhere; account download; closure and erasure.
- **Directory and matching.** Public search by specialty, state, language, modality, availability, each result saying which
  of the person's filters it satisfies. Availability is derived from published weekly hours minus booked times. The symptom
  matcher is a deterministic keyword table, not a clinical tool.
- **Connections.** By request (the doctor accepts) or by a single-use, 15-minute code or QR the doctor shows and the patient confirms
  (`pairing_invitations`; only keyed hashes stored; one winner under concurrency). A connection authorizes messaging, appointments and prescriptions; it does **not** by itself open the patient's health information.
- **Messaging.** Idempotent sends, honest sent/delivered/read, inbox with unread counts, per-user search, report and block, no edits or deletion.
- **Appointments.** Slot generation in the doctor's zone (daylight-saving safe), conflict prevention by row lock and a unique index, request/confirm/reschedule/cancel/complete, history for both parties, notices.
- **Health information.** Allergy statements, medicines the patient lists, conditions, procedures, providers, accessibility needs; provenance on every entry; amendments supersede (never overwrite); consent by version; clinician help only under a patient grant that expires and can be revoked.
- **Reminders.** Personal reminders (medicines, appointments, tasks, bills, subscriptions) and clinician-authorized medication reminders; in-app always, e-mail when configured, SMS/push not available.
- **Prescription records.** Doctor-drafted, doctor-authorized, frozen after authorization by triggers, append-only history. Not transmitted anywhere.
- **Care circle.** Caregivers with granular, revocable permissions.
- **Organizations.** Staff roles, invitations, tasks, internal notes, dashboard counts from real rows, activity search; patients decide per connection whether organization staff may see their name and appointment times.
- **Credentials.** `doctor_credentials` with source, evidence, reviewer, expiry; events append-only; expiry unlists a clinician.
- **Emergency information.** Numbers by country the person chooses, with sources; shown in production only after a person has reviewed them.
- **Administration.** Applications, licence checks, organizations, message reports, integration status, activity.
- **Audit log.** Append-only; actor, subject, action; never record contents.

## Not built (and shown as not available)

Video, SMS, push, pharmacy transmission, EHR/FHIR, licence-registry lookups, single sign-on, payments, and hospital modules
beyond appointments, staff, tasks and an activity log. There is no AI assistant, no simulated pharmacy and no demo mode.

## Where the important code is

| Concern | Files |
| --- | --- |
| Authentication, sessions, CSRF, second factor | `server/middleware/auth.ts`, `server/routes/auth.ts`, `server/services/mfaService.ts` |
| Role guards and the role matrix test | `server/middleware/*`, `tests/roleBoundaries.test.ts`, `tests/routeInventory.test.ts` |
| Organization permissions and tenant scoping | `shared/permissions.ts`, `server/services/orgs.ts`, `tests/orgs.test.ts` |
| Database identity and row-level security | `server/dbContext.ts`, `server/db.ts`, migrations `0014`, `0016`, `0017`, `0019`–`0023` |
| Health information | `server/services/healthProfile.ts`, `server/routes/healthProfile.ts`, `server/routes/assistedProfile.ts` |
| Pairing codes | `server/services/pairingInvitations.ts` |
| Reminders and the scheduler | `server/lib/personalSchedule.ts`, `server/services/personalReminders.ts`, `server/services/reminderService.ts`, `server/services/schedulerRun.ts` |
| E-mail evidence and the integration registry | `server/services/emailDeliveries.ts`, `server/routes/webhooks.ts`, `server/services/integrations.ts` |
| Credentials | `server/services/credentialService.ts` |
| Emergency data | `shared/emergency.ts`, `server/services/emergencyInfo.ts` |
| Release gates | `server/services/readiness.ts`, `server/config.ts`, `script/verify-production.ts` |
