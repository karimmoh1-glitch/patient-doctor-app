# The smallest safe pilots

Two pilots, in order. The second does **not** start until its conditions are met and the owner has approved this page's scope in writing. Neither involves real patient information.
Stages are defined in `docs/LAUNCH_GATES.md` (S0 synthetic test site, S1 production released with nobody invited, S2 limited pilot, S3 real patient information).

## Pilot 0: synthetic-data testing (stage S0): available now

| | |
| --- | --- |
| Where | the test site `https://avela-staging-chi.vercel.app` (its own database and secrets; nothing shared with production) |
| Who | testers the owner names, working in patient/clinician pairs. Checklist: `docs/TESTER_CHECKLIST.md` |
| Data allowed | **invented only**: invented names, `@staging.invalid` addresses, throw-away passwords |
| Data prohibited | any real person's name, e-mail, phone, address, date of birth, health detail, photo, licence number; any real credential reused from another service |
| Enabled | sign-up, sign-in (clinicians and administrators with a second factor), directory, connection request/acceptance, messaging, visit booking (phone), invitation codes, ending a connection, in-app reminders (saved, not delivered), personal profile |
| Disabled or absent | e-mail of any kind, video visits, file upload, SMS/push reminders, reminder delivery, emergency numbers (shown only once a person has verified them), pharmacy ordering, live support chat. The interface says so |
| Removing accounts | the owner resets or deletes the test database (everything is synthetic), or `npm run erase:user` per account |
| Incidents | testers tell the owner; the owner decides whether to pause the site (delete the deployment alias). Nothing here is a real incident unless real data was entered: then follow the "real data entered" rule below |
| Expand when | every box of the tester checklist has been ticked by two pairs, no finding is open at "refused action succeeded", and the engineers have reproduced and fixed or accepted each finding |

**Real data entered by mistake:** stop, tell the owner at once, do not copy it anywhere, the owner deletes that account (`erase:user`) and, because the test site's logs are retained by the host for a short time, notes the time of entry. The test site is public: sign-up is open.

## Pilot 1: limited clinician pilot with invented patients (stage S2): NOT YET AVAILABLE

**Conditions (all, with evidence, before anyone is invited):** the candidate released to production and verified (RELEASE_CHECKLIST §2); the provider rehearsal and restore drill done; secrets rotated; a real administrator with a second factor; the e-mail provider verified (password reset must work); an external monitor with a tested alert; an incident owner
named; the owner's and counsel's **written** approval of this scope.

| | |
| --- | --- |
| Where | production, after S1 |
| Who | a handful of clinicians the owner knows personally, each agreeing in writing to the rules below. **No real patients.** Patients are played by the clinicians' colleagues using invented identities |
| Data allowed | the clinician's own professional details (name, specialty, state, the licence information needed for verification, which a human administrator checks); invented patient identities and invented messages/visits |
| Data prohibited | **any real patient's identity or health information**, children's information, anything that is, or could be mistaken for, a real clinical decision (do not prescribe, diagnose, advise or triage through Avela), screenshots of real records, anything entered "just to see how it looks" |
| Enabled | clinician registration with administrator approval and second factor, directory, connection, messaging, booking (phone), invitation codes, ending a connection, password reset by e-mail |
| Disabled | **organization-staff module** (`ORGANIZATIONS_DISABLED=true`; its endpoints answer "not available": the largest authorization surface not needed to learn from a clinician pilot), reminder delivery (until the Cloudflare scheduler has run seven days at >= 90%), video, uploads, SMS/push, emergency numbers (until verified by a person), pharmacy. *Not technically switchable today:* prescriptions (instruct testers not to use them) and the Arabic interface (unreviewed; instruct testers to use English) |
| Removing accounts | `npm run erase:user` (owner connection, audited); a clinician may leave at any time and the owner confirms within one working day |
| Incidents | a named incident owner (runbook §8). **Stop immediately and roll back** on: any response seen to be about another account, a failed `release:verify`, a 5xx on a used route, a second-factor or password-reset failure that locks someone out, real patient data found. Report to the owner within the hour; the incident owner decides on notification duties with counsel |
| Evidence required to expand | two weeks without a stop condition; every pilot clinician's feedback recorded; the alert drill received; the scheduler observation complete if reminders are to be offered; D-03c residual risks accepted in writing or closed; **and every stage-S3 gate** before any real patient |

## Real patient information (stage S3): not a pilot

Requires everything above plus the clinical, legal/privacy, penetration-test reviews (and Arabic / emergency-number reviews for what is offered), D-03c decided, and a hosting plan with a data-processing agreement
(`docs/LAUNCH_GATES.md` §A-D). Until then the answer is no.
