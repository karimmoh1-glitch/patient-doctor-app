# Before any real patient information is accepted

Avela today is a **demonstration with working software**, not a service that may hold real health information.
This checklist is the gate. Engineering can complete the items marked **[eng]**; the rest need a person with the
authority, licence or contract to complete them. **Nothing here is a claim of compliance or clinical safety.** Each
item needs evidence (a document, a signed agreement, a test report, a name) before it is ticked.

Run `npm run verify:production` on the real deployment. It checks the technical blockers below and exits non-zero while
any remain. Passing it is necessary, never sufficient.

## 1. Law and jurisdiction (needs counsel)
- [ ] Decide where the service operates and for whom. This sets the privacy and health-data law (for example HIPAA, GDPR, or others), telehealth and prescribing rules, and the emergency number. Avela currently supports US states only and a configurable emergency number.
- [ ] A lawyer reviews and replaces the draft Privacy and Terms pages (`client/src/locales/*/legal.ts`). They say plainly that they are drafts.
- [ ] Decide the lawful basis and consent wording for collecting health information, and who the "controller/covered entity" is.
- [ ] Decide retention periods (see 5) and record them.

## 2. Doctors (needs a clinical lead and a verification process)
- [ ] Choose how credentials are **independently** verified per jurisdiction (registry lookup, document check, re-verification schedule). Today an administrator reads what the applicant typed. The product says so on every profile; it must not say more until a real check exists.
- [ ] Name the people who review applications, how they are trained, and how long an application may wait.
- [ ] Decide what "suspended" means operationally (who decides, how the doctor appeals, what happens to their patients).

## 3. Clinical content (needs a clinician and a pharmacist)
- [ ] Review the prescription form: routes, the 1-4 times a day limit, warnings, and the rule that controlled substances are refused. Decide whether Avela may record prescriptions at all in the target jurisdiction. It does **not** transmit them anywhere, and says so.
- [ ] Review reminders: wording, the rule that a reminder never changes a dose and never marks a dose missed, and the default of not naming the medicine.
- [ ] Review the emergency guidance and the symptom-matching keyword list (`shared/specialties.ts`).
- [ ] Decide whether any dose or interaction checking is required before real use. None exists.

## 4. Language (needs fluent human review)
- [ ] Arabic translations (`client/src/locales/ar/`) are first drafts. Have them reviewed by Arabic-speaking clinicians and patients, especially emergency, prescription, consent and privacy wording.
- [ ] Confirm the choice of Western digits (0-9) with Arabic-speaking users and pharmacists.

## 4b. Privacy and security review (needs an independent reviewer)
- [ ] Independent penetration test and a review of `docs/SECURITY.md`.
- [ ] Decide on multi-factor sign-in for doctors and administrators (**not built; strongly recommended before real data**).
- [ ] Accessibility audit by a specialist and testing with older adults and screen-reader users (automated checks pass; they are not enough).

## 5. Patient rights (partly built)
- [x] [eng] Patients can download a copy of their information (`Settings → Download my information`).
- [x] [eng] Patients can close their account (signs out everywhere, blocks sign-in, records a request).
- [x] [eng] An operator can erase identity and patient-written text (`npm run erase:user`), keeping what doctors authored without the patient's name.
- [ ] Decide what must be kept for medical-record law and for how long, then confirm the erasure script's "retained" list is right.
- [ ] Name who processes deletion requests and the deadline you promise. There is no automatic expiry today.
- [ ] Doctors' and administrators' own data requests are not built.

## 6. Operations
- [ ] **Incident response**: who is on call, how a breach is assessed and reported, how patients are told. No runbook exists beyond `docs/OPERATIONS.md`.
- [ ] **Backups and recovery**: managed point-in-time recovery on the database, a written restore objective, and a rehearsed restore. Uploaded files are not in the database (document uploads are off on Vercel).
- [ ] **Support ownership**: a staffed support phone or email, published through `SUPPORT_*`. Without it the Help page says nobody can be reached.
- [ ] **Monitoring**: someone watches the reminder health view (`/admin/activity`) and error logs, with an escalation path.
- [ ] A real **scheduler** for reminders: five-minute calls to `/api/cron/reminders`. The GitHub Actions workflow is best-effort; use a reliable scheduler or a paid plan for minute-level cron.
- [ ] Production email provider with a verified sending domain (reset links and email reminders need it).

## 7. Vendors and agreements (needs contracts)
- [ ] Hosting and database provider agreements covering health information (for example a BAA where required).
- [ ] Email provider agreement; confirm what message content is permitted.
- [ ] If an AI provider is ever enabled: a signed agreement, then `AI_PHI_PROCESSING_CONFIRMED=true`. Off by default.
- [ ] If speech-to-text is ever enabled: same.

## 8. Technical blockers (verified by `npm run verify:production`)
- [ ] `DEMO_MODE` is off and `DEMO_MODE_ACKNOWLEDGED` is unset.
- [ ] No demo account is active (`npm run demo:retire -- --apply` after reviewing the dry run). Seeded demonstration doctors are hidden.
- [ ] A real administrator exists (`npm run admin:create`), created from a trusted shell.
- [ ] `JWT_SECRET` is long and random; `CRON_SECRET` is set; `APP_URL` is https; the emergency number is set for the country.
- [ ] The reminder job has succeeded within the last 30 minutes.
- [ ] A **separate production database**, never the one a demonstration has used.
- [ ] Object storage with encryption for uploaded documents before enabling uploads.

## What still prevents real use today
1. No legal review, no jurisdiction decision, no agreements with vendors.
2. Doctor credentials are not independently verified.
3. No multi-factor sign-in; session tokens live in browser storage.
4. Reminders are not reliably delivered by a monitored scheduler; email and SMS/push are unproven in production.
5. Arabic wording unreviewed; no clinical sign-off on prescriptions or reminders.
6. No incident response, backup rehearsal, support staffing, retention policy, or penetration test.
7. Database row-level security is not enabled (see `docs/SECURITY.md`).
