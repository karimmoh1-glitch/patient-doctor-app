# Safety and compliance: decisions for qualified humans

This is engineering's list of things it **cannot** decide. The software does not claim HIPAA, GDPR or any other
compliance; it implements controls that such programmes usually require.

## Needs legal / compliance review before real patients

- Launch jurisdiction(s) and applicable law (HIPAA, GDPR, state privacy and telehealth-licensure rules).
- Business Associate / data-processing agreements: hosting, database, email, STT, video, AI provider.
- Privacy policy, terms, **the health-information consent wording** (`hp.consent.*`, versioned in `server/services/healthProfile.ts`),
  and the data retention and deletion policy. Account download, closure and erasure exist (`npm run erase:user`); what they
  keep (clinician-authored records, the audit log) is a legal decision documented in `server/services/erasure.ts`.
- Breach notification procedure and who is on call (`docs/OPERATIONS_RUNBOOK.md` section 8 is a starting point only).
- Whether clinicians may be shown at all without third-party licence verification. Today a reviewer records how a licence was
  checked (document, public register, or confirmation from the issuer), what they saw and its expiry; Avela looks nothing up itself.
- Whether organization staff (coordinators, schedulers) may see a patient's name and appointment times by default. The product
  tells the patient and lets them switch it off per doctor; the default and the wording need legal review.

## Needs clinical review

- Emergency wording (`help.*`, `emi.*`, the SOS page). **Emergency numbers are per country, chosen by the person (never inferred
  from language, address or device), with their sources in `shared/emergency.ts`.** United States: 911 (FCC and 911.gov). Egypt:
  123 ambulance, 122 police, 180 fire, taken from a United States government compilation because **no Egyptian official source
  could be found**; numbers seen only on unofficial sites (112, 126, 125) are not shown. In production none of these is shown
  until a person has compared them with the sources and set `EMERGENCY_DATA_REVIEWED_BY`. A clinician must confirm the
  symptom list and tone.
- Clinical content in health-information onboarding: Avela records what the patient or a clinician says, marks who said it and
  whether a clinician checked it, never infers "no allergies" from an empty list, and never interprets medicine instructions.
  Review the wording of the allergy and medicine screens.
- Prescriptions are recorded notes, not a regulated e-prescribing channel; the refill request is a message to a
  doctor, not an order. Language says so.

## Needs clinical and pharmacy-regulation review (prescriptions)

- Avela records prescriptions; it does not issue legally valid ones. Whether "authorized in Avela" has any legal
  standing depends on the jurisdiction. Nothing is transmitted to a pharmacy, and the interface says so each time.
- Controlled substances are refused in code. A doctor who answers "yes" is sent to their jurisdiction's system.
- Avela does not check doses, interactions, allergies or duplicates. A pharmacist or clinical-safety review should
  decide whether to add checks before any claim of clinical decision support.
- The list of prescription routes, the 0-4 times-a-day limit and the wording of warnings need clinician sign-off.

## Doctor verification

- Approval is a person reading what the applicant typed. It is **not** independent verification and the interface
  never calls it that ("Reviewed by the Avela team", with a note that licences are not checked against a register).
  Real launch needs a defined process per jurisdiction: registry lookups, document checks, re-verification.
- Who the reviewers are, how they are trained and audited, and how long applications may wait are operational decisions.

## Needs language review

- Arabic strings in `client/src/locales/ar/` are first drafts and the language picker says "translation awaiting
  review". Phrasing was chosen for plain, gender-neutral wording and Western digits (0-9) so doses and times
  read the same against pharmacy labels; both choices need confirming with Arabic-speaking patients and clinicians.
  Emergency, prescription and consent wording especially must be reviewed before anyone relies on it.
- Doctor-written text is never translated by Avela. A patient reading Arabic sees the doctor's words as written.

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
