# Integrations registry

Every external service Avela can use, its real status, and what it takes to connect it. The same statuses are computed
by the server and shown to administrators (`/admin/integrations`, `GET /api/admin/integrations`); this document is the
human-readable version. Nothing is marked operational unless a real call or a real provider event proved it.

Status vocabulary: **Verified** (a real provider call or event succeeded and is recorded) · **Configured, unverified** (keys
present, nothing proved) · **Not configured** · **Unavailable** (nothing to configure: not implemented) · **Failed** (last
check failed).

| Integration | Status today | Purpose | Notes |
| --- | --- | --- | --- |
| E-mail (Resend) | **Not configured** | Password reset, invitations, reminders, notices | Code complete; no key, no sending domain |
| E-mail delivery receipts (Resend webhook) | **Not configured** | Turn "provider accepted" into "provider reports delivered / bounced" | Endpoint with signature verification; needs the webhook secret |
| Reminder scheduler caller | **Not verified** | Calls `/api/cron/reminders` | GitHub schedule has never fired here; Cloudflare Worker built, undeployed |
| Heartbeat / uptime monitor | **Not configured** | Notices a scheduler that stops | `SCHEDULER_HEARTBEAT_URL`, uptime monitor on `/api/health/scheduler` |
| Operator alert e-mail | **Not configured** | Failure and recovery e-mail | `OPS_ALERT_EMAIL` (needs e-mail provider) |
| SMS | **Unavailable** | Reminders | Not implemented; no provider chosen |
| Push notifications | **Unavailable** | Reminders, messages | Not implemented |
| Video consultation | **Unavailable** | Visits | Not implemented; the interface offers no video option |
| Clinician credential verification | **Unavailable** | Independent licence check | No registry integrated; verification is manual and is described as such |
| Pharmacy transmission | **Unavailable** | Sending prescriptions | Not implemented. Prescription records say they are not sent anywhere |
| EHR / FHIR | **Unavailable** | Interoperability | Not implemented; no FHIR compatibility is claimed |
| Identity provider / SSO | **Unavailable** | Organization staff sign-in | Not implemented |
| AI provider (OpenAI) | **Not configured** | Optional assistant | Off unless a key and `AI_PHI_PROCESSING_CONFIRMED=true` are set; no substitute responder is shown |
| Speech-to-text | **Unavailable** | Voice symptom entry | Not implemented for production |

## Details for each integration that can be configured

### E-mail (Resend)
- **Variables:** `RESEND_API_KEY`, `EMAIL_FROM` (a verified sending domain), `APP_URL` (https).
- **Data sent to the vendor:** recipient address, subject, body. Reminder e-mails name no medicine unless the patient
  chose that; subjects are generic. Nothing else.
- **Timeout / retry:** each send is abandoned after 8 s (`EMAIL_TIMEOUT_MS`); a failed reminder e-mail is retried by later
  scheduler runs, at most 3 attempts, only while the reminder is still useful (3 hours). A timed-out send may later turn out
  to have been accepted, so e-mail is at-least-once in that case.
- **Failure modes:** missing key (features report e-mail unavailable and nothing external is claimed), rejected sender,
  provider outage, bounce.
- **Verification evidence required:** one real message accepted in production **and** a delivery event received through the webhook.
- **Privacy:** requires the provider's data-processing terms; confirm whether the provider will sign a business-associate-type
  agreement before any health-related content is sent. Not done.

### E-mail delivery receipts (Resend webhook)
- **Variables:** `RESEND_WEBHOOK_SECRET`. **Endpoint:** `POST /api/webhooks/resend`.
- **Authentication:** Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) verified with the secret; requests older
  than 5 minutes or with a bad signature are refused.
- **Effect:** records `delivered`, `bounced` or `complained` against the matching reminder delivery. Without a received event
  Avela says only "accepted by the e-mail service".

### Scheduler caller
See `docs/SCHEDULER.md`. Options: Cloudflare Worker (`ops/scheduler-worker/`), GitHub Actions (best-effort; observed not to
fire), Vercel Cron (once a day on the current plan). **Verification evidence required:** at least 7 consecutive days of calls in
`job_run_history` from a dependable caller.

### Monitoring and alerting
`SCHEDULER_HEARTBEAT_URL` (https; a successful run pings it, a failed run pings `<url>/fail`), `OPS_ALERT_EMAIL`, and an uptime
monitor on `/api/health/scheduler`. **Verification evidence required:** a deliberate failure produced a received alert.

### Video, SMS, push, pharmacy, credential registry, EHR/FHIR, SSO
Not implemented. Each requires, before any code: a chosen vendor or standard, an agreement covering health information, a
data-flow description added here, an implemented adapter with a timeout and retry policy, authenticated webhooks where
applicable, and tests with the vendor's sandbox. Until then the product shows the capability as unavailable. No mock adapter is
ever substituted in production.
