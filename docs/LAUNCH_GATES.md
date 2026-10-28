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

## D-03c: binding the acting person: status after Mission 7

**What changed (migration 0030, `tests/actorBinding.test.ts`):** a system assertion can now carry the person it acts for: `v1.<kid>.system.<scope>~<actorId>.<exp>.<mac>`. The actor is inside the
signed text, so it cannot be added, swapped, moved to another scope or stripped without the key (tested); a person's assertion never carries one; only three scopes accept one. The actor is set **once**,
by the authentication step (`enterUser` for a session, `bindActor` after a password or a verified challenge in the sign-in steps) and carried into any scope a helper enters, so **a function cannot name its own
actor** (a static test lists the callers of `bindActor`). With the actor in the assertion the database now checks it against the rows:

| Scope | What the database now enforces | Previously |
| --- | --- | --- |
| `orgmember` (new; the 16 organization functions that hold an `OrgAccess`, including `access()`) | the actor is an **active member** of the organization a row belongs to (invitations, memberships, tasks, notes, organization, audit entries of that organization); patient rows only for patients the actor may see by the same rule the code states (accepted connection, a clinician of the organization, staff-visible, or the actor's own if they hold the clinician role); audit entries only in the actor's own name | any row of any organization |
| `mfa` | the actor is the **account holder** for every second-factor row; an administrator's reset is only the function `app_reset_mfa`, which requires an active administrator as the verified actor and gives no read access to a secret | any account's second factor |
| `review` | the actor is an **active administrator** for every command on the review tables (a clinician's credential summary stays readable: patients see it) | any applicant, credential or organization |
| `auth` (public sign-in) | **no longer touches the second-factor tables at all** | all four commands on them |

**Evidence that this is not vacuous:** the forged-capability test builds an `OrgAccess` for another organization (what a missing check or wrong id would produce) and calls every organization function: nothing is returned and
nothing is written (before/after row comparison); mutation checks (drop one actor condition, make every actor an administrator) turn eight to ten of the 16 tests red; the 0030 rehearsal shows an exact rollback.
Also tested: cross-organization reads and writes, a revoked member, a patient entering the scope, no actor, a concurrent revocation (60 reads racing it; every later statement sees nothing), 240 interleaved requests on a shared pool each
reporting its own actor, tampered/moved/stripped/expired/validly-signed-but-misplaced actors.

**What is still application-authorized, exactly:**
1. The **permission matrix** (which role may invite, change roles, write notes) is code. The database checks membership and visibility, not role: a *member* of an organization with a low role could, through a code defect, perform an action
   a higher role may. They still cannot cross organizations or reach a patient they may not see.
2. **`staff`** (10 functions: token-based invitation steps, `createOrg`, `myOrganizations`, the patient-side visibility and notice functions) has no actor: the authority is a single-use token or the person's own id, in code.
3. `review` checks administrator, not *which* application an administrator may decide (any administrator may decide any).
4. An organization member in two organizations is bounded to the union of both (the code works one at a time).
5. The actor is whoever the authentication step said: a flaw in authentication itself, or code that calls `bindActor` with the wrong value, is outside this boundary (the callers are listed and pinned).

**Verdict: D-03c is narrowed again and the cross-tenant and account-ownership parts are now enforced by the database; it is not closed in the sense of "nothing is authorised in code".** Items 1-5 are the residual. For S3 the penetration tester should be pointed at exactly these
five, and the owner should accept them in writing or ask for further work (a role check in SQL is feasible: the role is already in `org_memberships`).
