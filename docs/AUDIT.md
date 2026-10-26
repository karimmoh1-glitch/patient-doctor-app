# Avela — implementation audit & checklist

> **Historical snapshot (2026-10-24).** Written before the production transformation; several items here (demo mode,
> simulated pharmacy, AI assistant, "no MFA", "no export/delete UI") no longer apply. The current state is in
> [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) and [`OVERNIGHT_EXECUTION.md`](OVERNIGHT_EXECUTION.md).


Audited 2026-10-24 against the working tree (≈12.6k lines, 20 tables, 20 route files, 71 client files).
This document is the running checklist: `[x]` done and verified, `[ ]` open, `[~]` partial.

## 1. Stack and architecture

React 19 + TypeScript + Vite + Wouter + TanStack Query + Tailwind v4 (client); Express 4 + Drizzle ORM +
PostgreSQL (server); JWT sessions with a server-side per-device revocation table; Resend for email (falls back
to console); optional OpenAI. One process serves API and SPA. Roles: patient, doctor, caregiver, admin.

## 2. What exists and works (preserve)

Patient/doctor/caregiver auth, same-state explainable matching, pairing request/accept, patient↔doctor chat
(polling), appointments, prescriptions (explicitly demo), medication logging, document uploads, per-doctor
sharing grants, Care Circle (read-only, permission-scoped caregiver dashboard), SOS page, Simple Mode, audit
log, doctor application + admin approval.

## 3. What was simulated or missing at audit time (status in sections 4 and 4b)

- Pharmacy ordering is a demo; the patient can advance their own order to "delivered".
- Health Handoff "share" only writes an audit row; nothing is sent.
- "Reminders" are display-only; no scheduler, SMS, or push exists.
- No video/audio consultation (click-to-call and chat only). No doctor availability model.
- Seeded doctors have no login and cannot respond.
- No tests existed. No error monitoring, backups doc, or runbooks.

## 4. Findings (ranked) and status

### Critical / High — server
- [x] Appointment read/cancel open to caregiver & admin roles (IDOR) — `appointments.ts`
- [x] Doctor can read symptom report before accepting / after decline — `pairings.ts`
- [x] Patient cannot end an accepted connection — missing route
- [x] JWTs and PHI field values written to server logs — `index.ts` deny-list redaction
- [x] Care Circle invite logs an *existing* account in with no password; invites never expire
- [x] Mock email prints reset/invite links in any environment
- [x] PHI sent to OpenAI with no explicit compliance gate
- [x] Login reveals deactivated/existing accounts; no constant-time work — fixed, tested
- [x] Password reset did not revoke existing sessions — fixed, tested
- [x] Tokens with no/unknown device record accepted; dev JWT secret allowed outside dev/test — fixed
- [x] Audit-log read path loses events (last-300 filter) and swallows write failures

### Medium — server
- [x] Double-booking: no overlap/future-date checks, no availability model
- [x] Refill counter, pairing status transitions, appointment completion not atomic/guarded
- [x] Emails not case-normalised; names interpolated unescaped into email HTML
- [x] Upload type/extension trust, inline serving, rejected file still returns 201
- [x] Sharing grants (medications/appointments/history) gate nothing server-side — UI over-promises
- [x] Per-account lockout, endpoint-specific rate limits (invites, pairing requests)
- [x] `render.yaml` runs `db:push` against production on every deploy
- [~] Unbounded lists / N+1 queries / missing indexes — unique indexes added where integrity needs them; list pagination still open

### Critical / High — accessibility & UX
- [x] Pinch-zoom disabled (`maximum-scale=1`) — removed
- [x] 1px focus rings → global 3px ring on every focusable element
- [x] Touch targets 32–36px → 44–48px (primitives and page-level controls; asserted by an e2e test)
- [x] 401/expired session not handled; no error/retry/offline states
- [x] No confirmation on cancel appointment / remove caregiver / sign out; no undo for dose log
- [x] No persistent SOS/help on most screens; no emergency guidance before login
- [x] Copy that overstates capability ("reminders", "we'll review", "Summary shared", "Doctors near you")
- [x] Muted text 4.4–5.0:1 → 7:1; form-control borders 1.26:1 → 3.6:1; primary 7.5:1
- [x] 25 `<Label>`s without `htmlFor`; no `aria-invalid/describedby/role=alert`; `<Link><Button>` nesting
- [x] Demo controls and credentials shown in the production UI
- [x] Text-size setting, low-bandwidth route splitting, system fonts
- [~] i18n foundation: English + draft Spanish for navigation, emergency, settings, home and help only; every other screen is still English (falls back safely); Spanish needs native and clinical review

## 4b. Directive requirements not yet built (be honest about these)

- [ ] Reminders/notifications service (scheduler, SMS/push/email preferences, quiet hours, retry). Nothing is
      pretended: the UI does not promise reminders.
- [ ] Referrals, results, and follow-up task workflows beyond the follow-up note a doctor writes at completion.
- [ ] Organisation/facility multi-tenancy, coordinators, interpreter/transport/affordability integrations.
- [ ] MFA, account/data export and deletion, session list UI, admin beyond doctor approval.
- [ ] Voice navigation, service-worker offline caching, SMS fallback.
- [ ] Real video provider (boundary and honest phone fallback exist; no provider is implemented).
- [ ] EHR/FHIR, e-prescribing, real pharmacy, payments.
- [ ] Analytics (none collected by design until a privacy review decides what is acceptable).
- [ ] Full translation coverage and professional translation review.
- [ ] Load, penetration and independent accessibility testing; assistive-technology testing with real users.

## 5. Target architecture (incremental, no rewrite)

Keep the single-process modular monolith; add (a) a tested domain layer for scheduling, matching and
authorization decisions, (b) integration adapters (video, SMS/email, EHR/FHIR, payments) behind interfaces that
report `configured: false` honestly, (c) background-job table with retry-safe workers for reminders and
follow-ups, (d) organisation/facility scoping on clinical tables before any multi-clinic deployment.

## 6. Order of work

1. Security fixes above, each with a failing test first.  2. Scheduling correctness (availability, overlap,
   time zones).  3. Patient experience: design tokens (done), home, navigation, error/offline states, SOS.
4. Video-consult integration boundary + honest fallback.  5. Clinician workspace gaps.  6. i18n, low-bandwidth.
7. Hardening: a11y automation, e2e, runbooks.

## 7. First end-to-end slice

"Patient books an appointment that cannot be double-booked, can reschedule/cancel it with confirmation, and a
caregiver/another patient is provably denied" — server constraint + tests + accessible UI.

## 8. Decisions that need a human

- Launch country/jurisdiction (HIPAA vs GDPR vs other), hosting BAA, and the emergency number(s) to show.
- Video provider (Twilio / Daily / Zoom SDK / self-hosted LiveKit) and who pays; SMS provider.
- Whether OpenAI may receive PHI at all (needs a signed BAA/zero-retention agreement).
- Which languages launch first; who reviews clinical translations.
- Which clinics/hospitals are real partners — nothing here fabricates them.


## 9. Release 2 checklist: Avela product transformation

Status key: `[x]` done and verified by tests, `[~]` partial, `[ ]` not built.

- [x] Production-build smoke suite in CI (landing, all chunks, fonts under production CSP, four roles, nested refresh, Arabic)
- [x] Premium design system: Avela wordmark and mark, deep teal / warm white tokens, self-hosted Figtree + Fraunces + Noto Sans Arabic
- [x] Landing page: hero, two account paths, how it works, honest feature list, trust, "not yet available", footer with language switcher
- [x] Account-type choice drives separate registration and workspaces
- [x] Patient sign-up (short, language, state with reason) and skippable welcome
- [x] Doctor registration, multi-step profile, explicit verification states, server-enforced access, admin review (approve / ask for more / reject / suspend / reinstate / activity log)
- [x] Admin provisioning only from a trusted shell
- [x] Doctor discovery on real records (specialty, language, modality, state, availability); public browse
- [x] Appointments (real slots, time zone, no double booking); video can no longer be booked
- [x] Prescription lifecycle: draft / authorize / cancel / expire, history, controlled substances refused, never "sent"
- [x] Patient prescription view with honest transmission wording; doctor's private note hidden
- [x] Reminders: persisted schedule, time zones and DST, idempotent dispatcher, cron endpoint, in-app + optional email, truthful delivery status
- [x] In-app notifications; no medicine names unless the patient chooses
- [x] Doctor dashboard: attention list, today, week ahead, drafts, missing hours
- [x] Arabic across registration, login, discovery, appointments, prescriptions, reminders, settings, privacy; RTL layout; localized emails and server-written text
- [x] Accessibility scans (axe) of public and signed-in screens in English and Arabic
- [~] Caregivers cannot set reminders (read-only by design); family-managed reminders are not built
- [~] Messaging: persisted, authorized, no unread indicators or delivery states beyond sent/failed; no attachments
- [~] Doctor profile photo, insurance and document upload are not collected
- [ ] Real video, SMS/push, pharmacy transmission, registry verification (external services)
- [ ] Row-level security in the database (authorization is enforced in the application layer and tested there)
- [ ] Data export / deletion, MFA, retention policy
- [ ] Review of Arabic by fluent speakers and clinicians; legal review of privacy and terms

## 10. Phase B checklist: verification and hardening

- [x] Production smoke detects the previously broken build (re-proved: fails on the circular chunk split, passes on the fix)
- [x] CI executes build and browser tests on GitHub; first run found a real regression (medications start date compared in UTC), fixed and covered
- [x] Deployed build stamped with its commit (`/version.json`, `/api/health`); live browser tests check it
- [x] Reminder delivery: atomic in-app delivery, bounded email retries, abandoned-send recovery, failure recording, health view, honest patient wording
- [x] Demo isolation: marked accounts refused when demo is off; production refuses demo mode without acknowledgement; `verify:production`, `demo:retire`
- [x] Database-level protection: append-only audit log and prescription history; authorized prescriptions frozen
- [x] Route inventory test (every endpoint, anonymous) and role access matrix
- [x] Suspended / pending doctor boundaries tested with before/after controls
- [x] Account: sign out everywhere, data export, deletion request, operator erasure, weak-password refusal, single-use recovery links
- [x] Logging: error kinds only, enforced by a test
- [~] Row-level security: evaluated, **not** enabled (see SECURITY.md)
- [ ] Multi-factor authentication, HttpOnly cookie sessions, independent credential verification, penetration test, incident response, retention policy
