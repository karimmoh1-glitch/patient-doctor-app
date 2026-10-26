# Architecture

> **Historical snapshot (2026-10-24).** Written before the production transformation; several items here (demo mode,
> simulated pharmacy, AI assistant, "no MFA", "no export/delete UI") no longer apply. The current state is in
> [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) and [`OVERNIGHT_EXECUTION.md`](OVERNIGHT_EXECUTION.md).


One Node process serves the JSON API and the single-page app. It is a modular monolith on purpose: a small
team can run it, and each seam below is where something would be split out later.

```
Browser (React 19, Vite, Wouter, TanStack Query, Tailwind v4)
   │  fetch + Bearer JWT, X-Timezone header
   ▼
Express (server/app.ts → createApiApp)          server/index.ts adds Vite (dev) / static files (prod) + listen
   ├─ middleware/   auth (JWT + live device check on EVERY request), rateLimit, role guards
   ├─ routes/       one file per area; thin: validate (zod) → authorize → call storage/services → audit
   ├─ services/     schedulingService (slots, booking), matchingService, auditService, emailService,
   │                aiService (gated), speechService (gated), videoService (boundary only), fulfillmentService
   ├─ storage.ts    all SQL via Drizzle; transitions that must be atomic live here
   └─ lib/localTime.ts  time-zone arithmetic (luxon)
PostgreSQL ← migrations/*.sql (hand-written, idempotent, recorded in schema_migrations)
uploads/documents ← patient files on LOCAL DISK (see Known limits)
```

## Decisions worth knowing

- **Schema changes are SQL files, not `drizzle-kit push`.** `push` can drop data and does not diff partial-index
  predicates. `npm run db:migrate` applies pending files in order inside transactions; the server runs it at
  start. A database provisioned before the runner existed is baselined automatically.
- **Integrity lives in the database.** One live connection per patient–doctor pair, one live appointment per
  doctor start time, one pharmacy order per prescription, unique lower(email) are unique indexes, so concurrent
  requests cannot create duplicates; routes also translate the violation into a friendly 409.
- **Sessions are revocable.** A JWT is valid only while its `user_devices` row exists and is unrevoked. Password
  reset revokes every device. Sign-out revokes the current one.
- **Time zones.** Doctors publish hours as local wall-clock windows in their own zone; slots are generated in that
  zone (DST gaps skipped) and stored as UTC instants. Patients see times in their own zone (header + stored).
- **Authorization is by relationship, not role alone.** A doctor reads a patient's symptom report only while a
  requested/accepted pairing exists; shared records require both a live connection and an explicit grant;
  caregivers see only what the care-circle grant allows. Every one of these has a negative test.
- **Honesty is a feature flag, not a comment.** `GET /api/config` reports what is actually configured
  (`demoMode`, `features.*`, `support.*`). The UI hides or labels anything simulated; the server refuses to
  simulate outside demo mode (e.g. pharmacy ordering returns 501).
- **Audit trail is subject-indexed.** Each event records actor and the patient it concerns, so a patient can see
  "who looked at my information". Reads of another person's data are *fail-closed*: if the audit row cannot be
  written, the data is not returned.

## Doctor verification

A doctor registers an account (`users.role = doctor`) and an application row in status `incomplete`. They complete it,
it becomes `pending`, and an administrator moves it to `approved`, `needs_info` (back to the doctor to edit) or
`rejected`; an approved doctor can be `suspended` and reinstated. **Only approval creates the doctor profile**, and
`requireApprovedDoctor` (checked live on every clinical request) refuses everyone else, so a pending, rejected or
suspended doctor cannot read any patient or record even with a valid session. Role and status never come from
request bodies. Suspension also revokes the doctor's sessions in the same transaction. Credentials are
self-reported and reviewed by a person; there is no registry lookup and no credential documents are stored.

## Prescriptions

`draft` (visible only to the doctor of record) → `active` (= authorized, with who and when) → `completed`,
`expired` or `cancelled`. Only an approved doctor connected to the patient can write one; authorizing needs an
explicit confirmation and is atomic (one winner under concurrent clicks); an authorized prescription is immutable
(cancel and rewrite). Every step is appended to `prescription_events`. `transmission` stays `not_sent` because there
is no pharmacy integration. Controlled substances are refused outright.

## Reminders and notifications

`medication_reminders` (times and weekdays as wall-clock values in the patient's time zone, so DST never moves a
reminder) and `reminder_deliveries` with a unique key on (reminder, due instant, channel): that key is what makes
delivery safe to retry and to run twice at once. `dispatchDueReminders` is triggered over HTTP by a scheduler that
presents `CRON_SECRET`; it looks back three hours (a reminder is never delivered half a day late), writes an in-app
notification, and emails if the patient chose it and a provider is configured. Notification rows hold a kind and
small parameters, never sentence text, and never the medicine's name unless the patient chose to show it. The app
reports whether delivery is really running (`/api/config` → `features.reminderDelivery`) from a `job_runs` record.

## Internationalisation

English is the source; Arabic loads on demand. Strings live in `client/src/locales/<language>/<area>.ts` and are
read through typed keys (plurals via `_one/_two/_few/_many/_other` suffixes and `Intl.PluralRules`). A test fails
on a duplicate key, an Arabic key with no English source, or a dropped placeholder. Text the server writes (the
access log, the timeline, emails) is localised server-side from the account's language (`server/services/serverText.ts`,
`emailService.ts`). Layout uses logical CSS properties only, directional icons flip, and phone numbers, emails and
doses are isolated left-to-right. `<html lang dir>` follow the language.

## Client

- Four patient destinations (Home, My Doctors, Appointments, My Health) in a bottom tab bar on phones and a
  sidebar on desktop; Emergency and Help are in the header on every signed-in screen and in a strip on every
  public screen.
- Routes are lazy-loaded; a route-level error boundary handles a failed chunk when offline.
- 18px base type, user text-size setting (125%/144%), system fonts only, 48px targets, 3px focus ring.
- i18n: `client/src/lib/i18n.tsx`. English is source and fallback. Doctor-written content is never translated.

## Known limits (honest list)

- **Uploads are stored on the server's local disk.** On hosts with ephemeral disks (Render free, Vercel) files
  vanish on redeploy. Production needs object storage with encryption and signed, short-lived access.
- Chat is polling, not push. There is no always-on worker: reminders are delivered by an external scheduler calling a protected endpoint, so they are only as punctual as that scheduler.
- Single organisation: no clinic/facility scoping yet.
- Rate limiter is in-process memory; with more than one instance it needs a shared store.
