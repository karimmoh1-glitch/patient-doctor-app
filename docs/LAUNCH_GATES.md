# Launch gates, sorted by what they protect and what they hold up

This sorts the gates in `docs/PRODUCTION_READINESS.md` (IDs G01-G43) by kind, so the shortest honest path is visible. **Nothing here relaxes a gate.** A gate that protects
patients stays a gate; what changes is which *stage* it blocks, and which unrelated work it need not hold up. Status of each gate lives in PRODUCTION_READINESS.md; this page
says what kind of gate it is.

## The stages (each needs the previous one)

| Stage | What it is | Who may use it | Needs |
| --- | --- | --- | --- |
| **S0. Synthetic test site** | The candidate on its own host and database, invented accounts only | Testers the owner chooses | **Done 2026-10-27/28** (`docs/TESTER_CHECKLIST.md`). Nothing real may be entered |
| **S1. Production released, nobody invited** | The candidate on the production host; no users, no clinicians | Nobody but the owner | Section A gates that are release-dependent (G04, G34-G36, G38, G41, G42), G40 on the provider, owner's authorization (D-01), the rollback rehearsed |
| **S2. Limited pilot, no real patient records** | A few invited clinicians and invented patients | Named people who agreed | S1 + section B (administrator, e-mail, restore, monitor, secrets rotated, incident owner) + written approval of that scope by the owner and counsel |
| **S3. Real patient information** | Real patients | Public | S2 + section D reviews (clinical, legal/privacy, penetration test, and for each language/country offered, its review) + D-03c decided + G30 hosting plan |

## A. Critical security and data-integrity gates (a failure here can expose or corrupt a person's record)

These hold up **S1 or S3 as noted**; none may be waived to ship sooner.

| Gate | What | Blocks | State (see PRODUCTION_READINESS.md) |
| --- | --- | --- | --- |
| G02, G05, G06, G08, G10, G32 | Runtime role cannot bypass RLS; append-only records; no fixtures in production; second factor; recovery cannot bypass it; admin bootstrap | already PASS | PASS |
| G03a | Role boundaries hold (owner and restricted role) | S0+ | PASS (CI) |
| G03b | Same denial checked on a live copy with invented accounts | S1 | PASS on the test site (HTTP isolation, journeys); repeat on production after S1 with owner-approved accounts |
| G04, G35 | Every table behind RLS; private account columns unreadable by counterparts | S1 | FAIL on production until released; PASS candidate |
| **G34, G40** | The database verifies who each transaction is for; a pooled connection cannot carry an identity | S1 | **PASS on a real Neon pooler** (test site, see Mission 6); the production-copy rehearsal (migration time, locks, rollback on the provider) is still BLOCKED on the owner |
| G36, G41 | Ending a connection enforced server-side, races closed | S1 (code), S3 (clinical soundness, D-02) | PASS candidate |
| G38, G42 | No unrestricted server scope in the application; single-use links and membership changes atomic | S1 | PASS candidate; **D-03b/D-03c residual below** |
| G39 | Signing key protected; rotation locks nobody out | S1 | PASS candidate; real rotation is part of the release |
| G26 | Secrets that left the platform rotated | S1 (at the release), S2 | FAIL: owner |
| G29 | Deploys only from a green commit | S1 | FAIL: owner (procedure or workflow) |
| G31, G37 | Every migration rehearsed, exact rollback | S1 | PASS locally/CI; provider rehearsal pending |
| G25 | Independent penetration test | S3 | BLOCKED: third party |
| **D-03c** | Acting person bound into the signed identity for `staff`, `review`, `mfa` | S3 (decide before), not S1/S2 | **OPEN, narrowed, guarded and tested (below)** |

## B. Required operational recovery gates (if these are missing, an incident cannot be survived or noticed)

| Gate | What | Blocks | State |
| --- | --- | --- | --- |
| G16 | A backup restores on the real provider and the app works on it | S1 (before release, so the rollback of last resort exists) | BLOCKED: owner (Neon branch/PITR drill; the same Neon authorization as G40 unlocks it) |
| G07, G09 | A real administrator with a second factor, exercised | S2 | FAIL / NOT TESTED: owner |
| G14, G15 | E-mail provider with verified domain and webhook | S2 (password reset and address confirmation do not work without it) | BLOCKED: owner |
| G17, G18 | External monitor on `/api/health/ready`, alert drill | S1 for the monitor, S2 for the drill | BLOCKED: owner |
| G27 | Incident owner, on-call, breach decisions | S2 | NOT TESTED: owner |
| G30 | Hosting plan fit for health information, data-processing terms | S3 | NOT TESTED: owner and counsel |
| G19, G33 | Live checks and `verify:production` on the released build | S1 | run after release |

## C. Product capabilities that can safely stay disabled (and how each is disabled)

Keeping these off does not weaken a safeguard, and none of them needs to hold up S0, S1 or S2. Each is **already switched off by configuration or by absence**, and the product says so:

| Capability | How it is disabled | Verified by |
| --- | --- | --- |
| Reminder delivery (G12, G13) | The scheduler is not running; `/api/config` reports `reminderDelivery: stale`; the interface says reminders are saved but not delivered. Becomes a gate only if reminders are *offered* | `tests/honesty.test.ts`; seen on the test site |
| E-mail features beyond password reset (G15) | No provider key: `features.email: false`; invitations/reminders by e-mail are not offered | `/api/config` |
| Video visits | No provider: refused at booking (phone only) | journeys, `tests/honesty.test.ts` |
| File upload for documents | `DOCUMENT_UPLOADS_ENABLED` false on this host | UI wording |
| Text-message / phone-notification reminders | Not implemented: stated as unavailable | UI wording |
| Emergency numbers (G20, G21) | Served only after a named person sets `EMERGENCY_DATA_REVIEWED_*`; otherwise the screen shows **no number** and says so | `tests/emergencyInfo.test.ts` |
| Prescriptions to pharmacies | Not implemented: prescriptions are displayed only | UI wording |
| Arabic interface (G24) | **Not technically switchable yet**; labelled as a draft. Small change if wanted: a `LOCALES_ENABLED` setting that hides the switcher | decision for the owner |
| Organization staff module | **Not technically switchable yet**; guarded by membership + permission matrix (below) | `tests/scopeAuthority.test.ts` |
| Clinician self-registration | Registration gives no clinical access until an administrator approves (G07) | `tests/credentials.test.ts` |

## D. Independent reviews (engineering cannot self-certify; each needs a named person)

| Review | Gate | Blocks | Packet |
| --- | --- | --- | --- |
| Clinical safety of wording and the connection-end rule (D-02) | G22, G36 | S3 | `docs/REVIEW_PACKETS.md` §1 |
| Legal and privacy per jurisdiction, retention, breach duties | G23 | S3 (and S2's written approval) | §2 |
| Fluent Arabic | G24 | only the Arabic interface | §3 |
| Emergency numbers | G21 | only emergency numbers (already hidden until reviewed) | §4 |
| Penetration test | G25 | S3 | §5 |
| E-mail provider terms | (G14) | S2 | §6 |

---

## D-03c: the `staff`, `review` and `mfa` scopes: what is guaranteed, what is not, and the smallest model

**What the database enforces for these three scopes (tested, `tests/narrowScopes.test.ts`):** only the named tables and commands are open to them (for example `staff` cannot read
`messages`, `prescriptions`, `symptom_reports`, password hashes or private account columns; `mfa` cannot touch anything but the second-factor tables; `review` cannot read the health-record tables such as `messages`, `prescriptions` or `symptom_reports`; it does read message reports, which administrators handle by design). A bug or injection in these paths therefore cannot reach clinical content.

**What it does not enforce:** *which* organization, applicant or account inside those tables. A code path that entered `staff` with the wrong organization id could read or change
that other organization's staff list, tasks, notes and audit entries; one that entered `mfa` for the wrong user could touch that user's second factor. The database cannot tell, because
the signed assertion names the scope but not the person acting.

**The smallest model that is honest about this (implemented and pinned by `tests/scopeAuthority.test.ts`):**
1. The call sites of the three scopes are an exact reviewed set (26 `staff`, 10 `review`, 10 `mfa` across 3 files); a new one fails the test until reviewed.
2. Every organization function that reads or writes organization data takes an `OrgAccess`, a capability minted in exactly one place (`access()`: active membership + the permission matrix, "not found" for
   non-members). The 11 functions without one are an exact reviewed list, each justified in the test (own-id only, or a single-use token).
3. Every `/:orgId` route obtains the capability before doing anything.
4. `review` is reachable only from the administrator router (`adminOnly`); `mfa` only for the account holder who just proved their password (a signed challenge) or the audited operator scripts.
5. The behavioural attacks (cross-organization, role confusion, concurrent revocation, forbidden tables) are in `orgs.test.ts` and `narrowScopes.test.ts` and pass.

**What closing it would take (not done; a decision, not a defect):** put the acting user into the signed assertion for these three scopes (`system.staff~<userId>`), expose `app_verified_actor()`
to the database, and add to the `staff` policies "the actor is an active member of the row's organization", to the `review` policies "the actor is an active administrator", and to the `mfa` policies
"the row belongs to the actor". That is one migration (0030), its exact rollback, a signing change, and a second release; it turns a code-level guarantee into a database-level one.

**Recommendation:** not needed for S0-S2 (synthetic data, a few invited clinicians, no patient records reachable through these scopes anyway). **Decide before S3**: either implement 0030, or have the
penetration tester attack exactly this boundary and record the owner's written acceptance of the residual risk. Until then the risk is *reduced, listed, guarded and tested*, **not closed**.
