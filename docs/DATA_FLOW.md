# Data-flow inventory

Where health-related information goes. "PHI" here means anything about a person's health or care.
Keep this current whenever an integration is added; a reviewer should be able to answer "who else can see this?"

| Data | Collected in | Stored | Leaves our servers to | Controls |
| --- | --- | --- | --- | --- |
| Account (name, email, state, time zone, password hash) | Sign-up | Postgres `users` (bcrypt hash) | Resend (email address + name, for sign-in/reset/application mail) | Generic email subjects; links single-use and expiring |
| Symptom description (typed) | Symptom entry | `symptom_reports` | Nobody. Matching is deterministic and local | Doctor can read only while a pairing is requested/accepted; each read is audited fail-closed |
| Symptom description (spoken) | Symptom entry | Audio is **not stored** | Speech-to-text provider **if** `STT_PROVIDER` set; development uses a local mock | Production refuses voice input without a provider; no provider is implemented yet, so voice is off in production. Needs a BAA before enabling |
| Messages patient↔doctor | Chat | `messages` | Nobody | Only the two parties on an accepted pairing; request logs never include bodies |
| Appointments | Booking | `appointments` | Resend only in transactional mail without clinical detail | Role + ownership guards; DB uniqueness prevents double-booking |
| Medications, dose logs | Medications | `medications`, `medication_logs` | Nobody | Doctor sees only with an explicit, revocable per-doctor grant and a live connection; caregiver only via care-circle grant |
| Documents (files) | Documents | **Local disk** `uploads/documents` + metadata row | Nobody | Type allowlist, magic-byte check, never served statically, `nosniff` + sandbox CSP; per-request access check |
| Emergency profile (contact, allergies) | Profile | `users` (emergency_* columns) | Nobody | Shown only to the patient unless they read it to someone |
| AI assistant context | Assistant / Explain simply | Nothing stored beyond the reply | OpenAI **only if** `OPENAI_API_KEY` **and** `AI_PHI_PROCESSING_CONFIRMED=true`; otherwise a local deterministic responder | The two-key gate is checked in code, not docs |
| Audit events | Every sensitive action | `audit_logs` (actor, subject, action, target) | Nobody | No PHI values stored; patient can view their own access log |
| Server logs | Every request | Host log stream | Host's log service | Method, path pattern, status, duration only. No bodies, tokens, query strings, or DB error text |
| Browser storage | Client | `localStorage`: session token, text size, language, simple-mode, return path after expiry | n/a | Cleared on sign-out; cache cleared on sign-in/out |

## Not collected

Analytics, advertising identifiers, location (the SOS "share location" control is explicit, opt-in, and only
sent when the patient then sends an alert), device fingerprints beyond a revocable session label.

## Third parties (all optional; none is required to run)

Resend (email), OpenAI (assistant), an STT provider (voice). Each needs a data-processing agreement / BAA
appropriate to the launch jurisdiction **before** real patient data touches it. See `SAFETY_AND_COMPLIANCE.md`.
