# Safety and compliance: decisions for qualified humans

This is engineering's list of things it **cannot** decide. The software does not claim HIPAA, GDPR or any other
compliance; it implements controls that such programmes usually require.

## Needs legal / compliance review before real patients

- Launch jurisdiction(s) and applicable law (HIPAA, GDPR, state privacy and telehealth-licensure rules).
- Business Associate / data-processing agreements: hosting, database, email, STT, video, AI provider.
- Privacy policy, terms, consent wording, data retention and deletion policy (no export/delete UI exists yet).
- Breach notification procedure and who is on call. A security incident runbook does not exist yet.
- Whether doctors may be shown to patients at all without third-party licence verification. Today an admin
  approves by hand; licence numbers are not looked up.

## Needs clinical review

- Emergency wording (`help.*`, SOS page, strip text). The emergency number is configurable
  (`VITE_EMERGENCY_NUMBER`, default 911) because the right number depends on the country; nothing is hardcoded
  behind login. A clinician must confirm the symptom list and tone.
- The AI assistant boundary: it organises the patient's own data and restates doctor instructions; it must never
  diagnose or change doses. Review the prompts and the "urgent-sounding input → emergency page" rule.
- Prescriptions are recorded notes, not a regulated e-prescribing channel; the refill request is a message to a
  doctor, not an order. Language says so.

## Needs language review

- Spanish strings in `client/src/lib/i18n.tsx` are first drafts, shown in the picker as "translation awaiting
  review". They need a fluent healthcare translator before anyone relies on them.

## Known security gaps

- No MFA. No session-management screen (sessions are revocable server-side). No account lockout UI beyond rate
  limiting. No malware scanning of uploads. No encryption-at-rest of files beyond what the host provides.
- Two npm advisories remain (`zod` memory exhaustion via `openai`). Mitigation: request bodies capped at 100 kb.
  Re-check on each release.
- No penetration test, no independent accessibility audit, no testing with assistive-technology users.
  Automated axe checks pass on the covered screens, which is necessary but far from sufficient.

## Safety behaviours that are tested

Emergency strip and number on every public screen; Emergency + Help on every signed-in patient screen; no fake
video, pharmacy, reminders or support chat; doctors cannot read records without a live relationship and a grant;
double-booking is impossible under concurrency; destructive actions ask for confirmation.
