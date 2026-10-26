# Overnight execution queue

The working checklist for the production transformation. A row is **Done** only when its acceptance criteria are met and the
evidence column names a test or a recorded observation. "Blocked" means engineering has finished what it can and the next step
belongs to someone else. Counts are whatever the last recorded run printed (see the bottom of this file).

Legend — **Indep.**: can be finished without anyone else. **Ext.**: needs an external credential, vendor, legal or clinical decision,
or the owner's authorization to a production change.

## P0 — critical

| # | Task | State | Evidence | Ext. |
| --- | --- | --- | --- | --- |
| P0-1 | No demo login, public credentials or fixture accounts in production | **Done in code.** Live database not yet cleaned | `tests/productionGuards.test.ts`, `tests/retireDemo.test.ts`, `npm run test:prod` | Cutover to a clean database needs owner approval (`OPERATIONS_RUNBOOK.md` §3) |
| P0-2 | Cross-patient access impossible at the database | **Done in code and tests; not enforced in production** | `npm run test:rls`, `npm run test:e2e:rls` | Switching the live role needs owner approval (§2) |
| P0-3 | Real second factor for clinicians, staff, administrators | **Done** | `tests/mfa.test.ts`, `tests/totp.test.ts`, `e2e/mfa.spec.ts` | `MFA_ENCRYPTION_KEY` must be set before deploying |
| P0-4 | Nothing claims a capability that is not connected | **Done** | `tests/messaging.test.ts`, `tests/emailDeliveries.test.ts`, `tests/integrations.test.ts`, `e2e/integrations.spec.ts` | — |
| P0-5 | No cross-organization access | **Done in code and tests** | `tests/orgs.test.ts` (both DB roles), `e2e/orgs.spec.ts` | Independent penetration test not done |

## P1 — launch blockers

| # | Task | State | Evidence | Ext. |
| --- | --- | --- | --- | --- |
| P1-1 | Production DB role + RLS enforced | **Prepared, not enabled** | Runbook §2, `npm run db:create-app-role`, readiness checks | Owner approval and run |
| P1-2 | Reminders on a schedule, proven repeatedly | **Blocked** | Code and tests done; **no dependable caller** (GitHub's schedule never fired; the Cloudflare Worker is built, not deployed) | `wrangler login` and deploy (§6), then 7 days of recorded calls |
| P1-3 | E-mail with delivery evidence | **Code done; provider not configured** | `tests/emailDeliveries.test.ts` | Provider key, domain, webhook secret, agreement |
| P1-4 | Clinician credential verification | **Done** (a person records source, evidence, expiry) | `tests/credentials.test.ts`, `e2e/credentials.spec.ts` | The review process itself is the owner's |
| P1-5 | Backups restore verified | **Blocked** | Documented only | A rehearsed restore on the real provider |
| P1-6 | Monitoring and alerts proven | **Blocked** | Code done | Heartbeat monitor, `OPS_ALERT_EMAIL`, one drill |
| P1-7 | Country-aware emergency information (Egypt, United States) | **Researched, not human-reviewed** | `tests/emergencyInfo.test.ts`, `e2e/resilience.spec.ts`; production serves no number until `EMERGENCY_DATA_REVIEWED_BY` is set | A person confirms each number (Egypt: no Egyptian official source found) |

## P2 — core product

| # | Task | State | Evidence |
| --- | --- | --- | --- |
| P2-1 | Reliable messaging (idempotent, honest states, inbox, search, report/block) | **Done** | `tests/messaging.test.ts`, `e2e/messaging.spec.ts` |
| P2-2 | Appointments: concurrency, history | **Done** | `tests/scheduling.test.ts` (eight-way races, history) |
| P2-3 | Patient onboarding: allergies (explicit states), medicines, history, emergency contact, consent with provenance, save/resume | **Done** | `tests/healthProfile.test.ts`, `e2e/health-profile.spec.ts` |
| P2-4 | Clinician-assisted completion under a patient grant, amendments audited | **Done** | `tests/healthProfile.test.ts` (no grant, expired, revoked, consent withdrawn, other doctors) |
| P2-5 | QR / short-code pairing | **Done** (clinician-generated; patient-generated QR **not built**) | `tests/pairingInvitations.test.ts` (expiry, reuse, revocation, concurrency, suspended/expired clinician, rollback), `e2e/pairing-invitations.spec.ts` |
| P2-6 | Patients without a doctor; subscription, bill and general reminders | **Done** | `tests/personalSchedule.test.ts`, `tests/personalReminders.test.ts`, `e2e/reminders.spec.ts` |
| P2-7 | Provider search says why a provider appears | **Done** for specialty, state, language, modality, availability, name. Location/service-area and organization filters **not built** | `tests/directoryReasons.test.ts` |
| P2-8 | Organizations, staff roles, permission matrix, tenant isolation, tasks, notes, dashboard, activity search | **Done** | `tests/orgs.test.ts`, `e2e/orgs.spec.ts` |
| P2-9 | Organization-specific provider directory | **Not built** | — |
| P2-10 | Country-aware phone formatting | **Not built** | — |

## P3 — quality

| # | Task | State |
| --- | --- | --- |
| P3-1 | Accessibility checks, English and Arabic, on every new screen | **Done** (axe, serious and critical, in each new spec) |
| P3-2 | Review of Arabic text by a fluent speaker and a clinician | **Blocked** (owner) |
| P3-3 | Older-adult usability testing with real people | **Blocked** (owner); the interface uses large type, plain wording and confirmation before consequential changes |
| P3-4 | Documentation current | **Done** for this transformation: `PRODUCTION_READINESS.md`, `OPERATIONS_RUNBOOK.md`, `PRODUCT_ARCHITECTURE.md`, `DATA_FLOW.md`, `INTEGRATIONS.md`, `THREAT_MODEL.md`, `SECURITY.md`; `AUDIT.md` and `ARCHITECTURE.md` are marked historical |

## Independent review of the new security-critical code

A separate reviewer read the organization, health-information, pairing, webhook, credential, reminder and emergency code adversarially
(no critical or high findings). Each substantiated finding was fixed and pinned by a test (`tests/reviewFindings.test.ts` and the module tests):

| Finding | Outcome |
| --- | --- |
| Inviter could create the invitee's account from the link they were given | Fixed: for a verified organization the link is e-mailed only; for an unverified one no e-mail is sent and the limitation is documented (T26) |
| Organization staff see a patient by default, unannounced; a clinician could not leave | Fixed: the patient is told when their clinician joins an organization and at connection (preview and notice); anyone can leave. **The default remains "visible, with a switch"**; that default needs the owner's and counsel's decision (`SAFETY_AND_COMPLIANCE.md`) |
| One reminder with a date in year 1 cost seconds of CPU; scheduler starvation | Fixed: dates bounded, renewal arithmetic starts near the window; truncation is reported |
| A patient could replace a clinician-verified entry or overwrite a reviewed allergy statement by "amending" | Fixed: dispute instead; a clinician can read the history of an amendment |
| Organization activity showed a member's actions in other organizations and after they left | Fixed: events carry the organization id; the view shows only those |
| Invitation endpoint revealed whether an address had an account of another kind; unlimited invitations | Fixed: not revealed; capped; e-mail only for verified organizations |
| Last-owner check raced | Fixed: owners locked in a transaction |
| Reminder e-mail to an unconfirmed (possibly someone else's) address with chosen text | Fixed: new e-mail confirmation flow; reminder e-mail only to a confirmed address; daily cap |
| A renewal anchored on a day with no midnight in its zone (Cairo, 24 April 2026) never fired | Fixed (noon-based days) with a test |
| Same-instant notices lost one; weekly on every day was daily; reminders fired for moments before creation | Fixed |
| One reviewer name marked every country, any version, as reviewed; unset `NODE_ENV` counted as development | Fixed: reviewer, version and countries required; unset means production |
| Webhook used up an event before the message existed; near-empty secret accepted | Fixed |
| Pairing "repeat" answered forever; verified organization stayed verified after a rename; role/account-kind mismatch; legacy profile with no check listed; credential list truncated | Fixed |
| Trigger on health entries allows status or verification columns to be changed by a direct database write | **Not changed** (needs the application role not to be trusted with direct SQL, which is the same limit documented in `SECURITY.md`) |
| Eight-character codes have about 40 bits of entropy | **Accepted**: 15-minute life, 40 failures per person per day, single use |

## Things engineering cannot finish

Legal and clinical review of consent and emergency wording; the credential-review process; deciding and running the production
database role switch and the move to a clean database; provider accounts (e-mail, scheduler caller, monitor); a restore drill;
Arabic review; a penetration test; rotating secrets that were copied to a developer machine.

## Process notes (kept honest)

- One commit was pushed with failing tests (`5e39bde`, a chained command committed after a failing run); the next commit fixed it.
  CI flagged intermittent browser assertions (a toast announced twice, two matching elements) several times; each was fixed by
  making the assertion unambiguous, not by loosening what it checks.
- The Arabic strings were written by the engineering assistant and are marked as awaiting review.

## Last recorded verification

See the final report in the working session and `git log`; commands: `npm run typecheck`, `npm test`, `npm run test:rls`,
`npm run test:e2e`, `npm run test:e2e:rls`, `npm run build && npm run test:prod`, `npm audit --omit=dev`.
