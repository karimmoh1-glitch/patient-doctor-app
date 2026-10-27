# Ending a connection: what it means in Avela

Implemented 2026-10-27 (`PATCH /api/pairings/:id/end`, migration `0027_connection_end_semantics.sql`, `tests/connectionEnd.test.ts`). This is the
engineering default, chosen to be conservative. **It is for clinical and legal review; engineering does not decide it alone** (decision D-02).

## The rule

A patient can end a connection at any time. Ending it **immediately revokes everything that depended on it**, in the routes and in the database:

| Stops at once for the clinician | Why |
| --- | --- |
| The conversation (read and write), notifications about it | It existed only because of the connection |
| The symptom report sent with the request; every category of shared records; sharing grants | Consent was tied to the connection |
| Follow-up tasks for the patient | The patient's list is theirs; a clinician sees a patient's tasks only through a live connection |
| The patient's account row (name) *unless* a visit still ties them (below) | Needed only to work with a patient |
| Assisted health-profile help, organization-staff visibility | Both require an accepted connection |
| Booking new visits | Requires an accepted connection |

| Stays | Why |
| --- | --- |
| **The patient's whole history**, including the ended conversation, read-only | It is their record |
| **What the clinician authored**: prescriptions they wrote (they remain the clinician's record, and a recall must remain possible) | Standard retention of a provider's own record of care |
| **Visits the clinician provides or provided** (time, reason, status, the patient's name), with the clinician able to change a visit only while it is still open | The visit record is part of the provider's record |
| **Audit records** (append-only; both sides' access is logged) | Accountability |

## Visits that have not happened yet

They are **never cancelled or kept silently**. If any exist, ending returns `409 decide_upcoming_visits` with the list (type and time; never the reason) and changes nothing.
The patient chooses:

* **cancel** them: the visits are cancelled, each with an audit entry saying why (`because: connection_ended`), and the clinician is told by a notice that carries
  counts only, no name and no reason;
* **keep** them: the visits stay confirmed; the clinician can see **those visits** and complete them, and nothing else about the patient; the patient keeps being reminded.

Booking and ending serialise on the connection's row (Mission 4, found by `tests/connectionEndRaces.test.ts`): the end takes the row exclusively before it asks about visits, a booking takes it shared before it writes one. A booking in flight therefore finishes first and is seen by the question (the patient is asked about it); a booking that starts after the end is refused ("no longer connected"). There is no longer any way for an end to leave a visit standing that the patient was not asked about. (Before this fix, the visit booked in that instant was silently kept and recorded as `kept_by_default`; that value no longer exists.) Two simultaneous ends: exactly one finishes, the other is told the connection is not active.

## Not decided here (for review)

1. **Retention periods.** Avela states none. How long a clinician keeps a visit record or a prescription after the connection ends is a legal question per jurisdiction.
2. **Emergency access.** None exists; a patient's emergency information is shown only to the patient. Any "break the glass" access would need its own authorization model.
3. **Whether an ended connection should also hide the clinician's own prescriptions from the patient** (currently the patient keeps seeing authorized prescriptions).
4. **Clinical hand-over.** Ending a connection does not notify any other clinician or transfer care; the patient's other connections are unaffected.

## Verified by

`tests/connectionEnd.test.ts` (no visits, decision required, invalid answers, cancel, keep and complete, database-level shut-out of messages and tasks, retained visits,
name visibility, reminders follow the decision, reconnecting), `tests/accessEndsEverywhere.test.ts` (six clinician endpoints and the caregiver, before and after).
