# Integrations registry

Every external service Avela can use, its real status, and what it takes to connect it. The same statuses are computed by the
server from its own records and shown to administrators at `/admin/integrations` (`GET /api/admin/integrations`,
`server/services/integrations.ts`); this document is the human-readable version. Nothing is "verified" because a key is
present: verification needs a real provider call or a signed provider event on record.

Status vocabulary: **Verified** (evidence recorded) · **Set up, not yet proven** · **Not set up** · **Not available** (not built:
nothing to configure) · **Failing** (the latest real attempts failed).

| Integration | Status today | Evidence required to read "Verified" |
| --- | --- | --- |
| E-mail sending (Resend) | **Not set up** | At least one message the provider reported **delivered** (signed webhook) |
| E-mail delivery reports (Resend webhook) | **Not set up** | At least one signed event received |
| Reminder scheduler caller | **Not proven** | Seven days, each with ≥ 90% of the expected five-minute calls, from a caller other than GitHub Actions |
| Heartbeat monitor | **Not set up** | A deliberate failure produced a received alert (a drill; recorded by the operator, not computable) |
| Operator alert e-mail | **Not set up** | Same |
| Video consultation | **Not available** | No provider is implemented; the interface offers no video option |
| SMS | **Not available** | Not implemented |
| Push notifications | **Not available** | Not implemented |
| Pharmacy transmission | **Not available** | Not implemented; prescription records say they are not sent anywhere |
| EHR / FHIR | **Not available** | Not implemented; no compatibility is claimed |
| Licence registry lookup | **Not available** | Not implemented; a person records how each licence was checked |
| Single sign-on for organizations | **Not available** | Not implemented; staff use accounts with a second factor |

## What can be configured

### E-mail (Resend)
- **Variables:** `RESEND_API_KEY`, `EMAIL_FROM` (a verified sending domain), `APP_URL` (https).
- **Used for:** password reset, invitations (care circle, organization staff), clinician application notices, pairing notices, reminders.
- **Data sent to the vendor:** recipient address, subject, body. Subjects are generic; reminder text names no medicine or title unless the patient chose it. A pairing code is never e-mailed.
- **Timeout and retries:** each send is abandoned after 8 s (`EMAIL_TIMEOUT_MS`); a failed reminder e-mail is retried by later scheduler runs, at most 3 attempts, only while the reminder is still useful (3 hours). A timed-out send may later turn out to have been accepted, so e-mail is at-least-once in that case. Quiet hours hold reminder e-mail back for good.
- **Failure modes:** missing key (features say e-mail is unavailable and nothing external is claimed), rejected sender, outage, bounce.
- **Evidence recorded:** a row per accepted message in `email_deliveries` (provider message id, purpose, a keyed hash of the address; no address, no content).
- **Privacy:** needs the provider's data-processing terms; whether it will sign a business-associate-type agreement for health-related mail is the owner's question. Not done.

### E-mail delivery reports (Resend webhook)
- **Variable:** `RESEND_WEBHOOK_SECRET`. **Endpoint:** `POST /api/webhooks/resend` (raw body).
- **Authentication:** Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) over the exact bytes; older than five minutes or wrongly signed: refused; no secret configured: 503.
- **Effect:** moves a message from *accepted* to *delivered*, *delayed*, *bounced*, *complained* or *failed*, never backwards, once per event id.

### Scheduler caller
See `docs/SCHEDULER.md`. Options: Cloudflare Worker (`ops/scheduler-worker/`, recommended; needs the operator's Cloudflare login), GitHub Actions (best-effort; **observed not to fire for this repository**), Vercel Cron (once a day on the current plan).

### Monitoring and alerting
`SCHEDULER_HEARTBEAT_URL` (https; a successful run pings it, a failed one pings `<url>/fail`), `OPS_ALERT_EMAIL`, and an uptime monitor on `/api/health/scheduler`.

## Not implemented
Video, SMS, push, pharmacy, registry lookups, EHR/FHIR and single sign-on each require, before any code: a chosen vendor or standard, an
agreement covering health information, a threat review, tests against a sandbox, and an operator runbook. The interface hides
or labels what does not exist.
