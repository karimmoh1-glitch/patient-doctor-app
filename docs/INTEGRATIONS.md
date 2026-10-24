# Integrations: what exists, what does not

Nothing here is shown to patients as working unless `GET /api/config` says it is configured.

| Capability | State | What is needed to turn it on |
| --- | --- | --- |
| Click-to-call | Works (`tel:` link, revealed after a doctor accepts) | Doctor enters a real number |
| Email | Works with `RESEND_API_KEY` + verified sender domain; otherwise logged in development only | Resend account, domain DNS, BAA if mail may contain PHI (it is written not to) |
| Video visits | **Not built.** Boundary in `server/services/videoService.ts`; endpoint returns `available:false` with a phone fallback | Pick provider (Daily, Twilio Video, LiveKit, Zoom SDK). Implement `VideoProvider`, register by name, sign BAA, set `VIDEO_PROVIDER` + credentials. Cost is per participant-minute; recordings must stay off unless a policy says otherwise |
| SMS reminders / OTP | **Not built** (`features.smsReminders=false`) | SMS provider (Twilio etc.), sender registration (10DLC or local equivalent), consent capture, quiet hours, a job runner |
| Speech-to-text | Dev mock only; production refuses | AWS Transcribe Medical (or equivalent) under BAA; implement in `speechService.ts` |
| AI assistant | Deterministic local fallback works; OpenAI path gated | Key + `AI_PHI_PROCESSING_CONFIRMED=true` only after a signed agreement |
| Pharmacy | Demo only, refused outside `DEMO_MODE` (501) | A real e-prescribing / pharmacy network contract; regulated, clinical + legal review |
| EHR / FHIR | **Not built** | Per-site agreement and SMART-on-FHIR credentials; map to Patient, Appointment, MedicationRequest |
| Payments | **Not built** | Payment processor; decide whether payments are in scope at all |
| Live support chat | **Not built** (`features.liveSupportChat=false`) | Staffing first, then software. The Help page shows phone/email only when `SUPPORT_*` is set |
| Interpreter, transport, affordability | **Not built** | Partner organisations; nothing is invented |

## Adding a provider safely

1. Implement behind an interface; the default must be "not configured" and must say so.
2. Report it in `/api/config` and make the UI depend on that, never on an assumption.
3. Add the data to `DATA_FLOW.md`; get the agreement signed; only then set credentials in the host environment.
4. Add a test proving the unconfigured path is honest, and one for failure (provider down).
