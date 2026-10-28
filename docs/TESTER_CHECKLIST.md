# Tester checklist: Avela test site (synthetic data only)

**Site:** https://avela-staging-chi.vercel.app (a separate test deployment: its own database, its own secrets, nothing shared with the real service). Every page shows a yellow
"Test site: synthetic data only" notice.
**Build under test:** the commit shown at `/version.json` (`e27f605` when this was written; the owner will tell you if it changes).

## Ground rules (read first)

1. **No real information, ever.** Use invented names, invented e-mail addresses ending in `@staging.invalid` (for example `yourname1@staging.invalid`), and a throw-away password. Do not type a real
   health detail, phone number or address. The site is on the public internet; anyone with the link can create an account.
2. **This is not a medical service.** Nothing here gives advice. Do not use it for anything real. In an emergency call your local emergency number, not this site.
3. Testers work in pairs: one plays a **patient**, one plays a **clinician**. Clinician and administrator accounts are handed out by the owner (one per pair, passwords sent privately, never in chat
   groups or tickets). `doctor.delta` is reserved for automated checks: do not use it.
4. Sign-up and sign-in attempts are rate limited (a few per ten minutes per network). If several testers share one office network and see "Too many attempts", wait and retry; do not hammer it.
5. Report what you saw, not what you assume: the page, what you did, what you expected, what happened, the time (with time zone), and a screenshot with **no real data** in it.

## What is NOT available (so do not report it as a bug)

| Not available | What you will see |
| --- | --- |
| **E-mail of any kind** (confirmation, password-reset links, invitations by e-mail, reminders by e-mail) | Nothing is sent. A reset link cannot reach you; recovery is done by the owner (see T9). |
| Video visits | "Video visits aren't available." Phone call and messaging only. |
| Saving files / documents upload | "Saving the file itself isn't available on this service yet." A note about the paper can be saved. |
| Text-message and phone-notification reminders | Stated as "not available". In-app reminders are saved; **delivery by a scheduler is not running on this site**, so do not expect a reminder to fire. |
| Emergency numbers | Deliberately not shown: they have not been verified by a person. The emergency screen says so. |
| Live support chat, support phone/e-mail | Not offered. |
| Sending a prescription to a pharmacy | Not offered: prescriptions are written and shown, nothing is sent anywhere. |
| Arabic | A first draft that has **not** been reviewed by a fluent speaker. Report wording problems, but they are known to be unreviewed. |

## Tests

Tick each box. "Expect" is the intended behaviour; anything else is a finding.

**T1. Sign-up and sign-in (patient)**
- [ ] Create an account with an invented name, a `@staging.invalid` address and a strong password. *Expect:* you are signed in and see the patient home.
- [ ] Try a weak password such as `password`. *Expect:* refused with a reason.
- [ ] Sign out, then sign in again with the right password; then with a wrong one. *Expect:* right works; wrong gives a generic message (it must not say whether the address exists).

**T2. Find a doctor (no sign-in needed)**
- [ ] Open "Find doctors" signed out. *Expect:* four clinicians marked "(synthetic)"; no phone numbers, e-mail or licence numbers anywhere on the cards or profile.
- [ ] Filter by specialty, state and language. *Expect:* the list narrows sensibly.

**T3. Connect (patient + clinician)**
- [ ] Patient asks a clinician to connect. *Expect:* "pending"; the patient **cannot** message yet.
- [ ] Clinician signs in. **First sign-in forces a second factor:** scan the QR / enter the secret in any authenticator app, enter the code, and **store the recovery codes** (they are shown once).
- [ ] Clinician accepts the request. *Expect:* the patient sees the connection as active.

**T4. Messaging**
- [ ] Patient sends a message; clinician replies; each sees both. *Expect:* order and sender correct; unread counts update.
- [ ] A third tester, signed in as a different patient, cannot see this conversation by any means you can think of (try URLs). *Expect:* "not found".

**T5. Book a visit**
- [ ] Patient opens booking for the connected clinician. *Expect:* only "Phone call" (video is unavailable); free times in the clinician's time zone, weekdays 9-12 and 13-17.
- [ ] Book a time. Two patients cannot take the same slot. Clinician confirms. *Expect:* both see the visit with the same time.
- [ ] Reschedule and cancel once each. *Expect:* clear confirmations; the slot is released.

**T6. Invitation code**
- [ ] Clinician creates an invitation code. A **second** patient enters it. *Expect:* they see who it is from and must explicitly agree before connecting.
- [ ] Try the same code with a third patient, and a code with a typo. *Expect:* refused with the same generic "isn't valid or has expired".

**T7. Ending a connection**
- [ ] With a visit booked, the patient ends the connection. *Expect:* the app **asks** whether to cancel or keep the booked visits and does not end until you choose.
- [ ] After ending: patient and clinician can no longer message; the patient cannot book; the clinician still has their own record of past visits. *Expect:* no error pages.

**T8. Reminders (saving only)**
- [ ] Create a personal reminder, pause it, resume it, cancel it. *Expect:* saved; the page says plainly that delivery is not running on this site.

**T9. Password recovery**
- [ ] On "Forgot password" enter your address, then an address that does not exist. *Expect:* the **same** message for both.
- [ ] Tell the owner your invented address and ask for a reset. *Expect:* the owner sets a new password out of band; your old sessions stop working; the old password stops working; the new one works.
- [ ] Open a made-up reset link. *Expect:* "isn't valid or has expired".

**T10. Sign-out and sessions**
- [ ] Sign in on two browsers, sign out of one. *Expect:* only that one is signed out. Use the browser's Back button after signing out. *Expect:* no private page reappears.

**T11. Things that must be refused** (any "success" here is a serious finding: stop and tell the owner)
- [ ] As a patient, open clinician or administrator pages by typing their addresses. *Expect:* refused.
- [ ] As patient A, try to open patient B's visit or message by editing an identifier in the address. *Expect:* "not found".
- [ ] Sign-in as a clinician **without** the second-factor code. *Expect:* impossible.

**T12. Accessibility and language (quick pass)**
- [ ] Larger text setting; keyboard-only navigation (Tab / Enter); a phone-sized window. *Expect:* usable, nothing cut off.
- [ ] Switch to Arabic. *Expect:* right-to-left layout; wording unreviewed (note, do not fail).

## Already verified by automated checks (do not spend time repeating)

Run against this very site by the engineers (37 scripted journey checks, 1,503 interleaved requests from 12 synthetic users with no identity or data crossing, database audit): see
`docs/PRODUCTION_READINESS.md` "Mission 6". Human testing adds what scripts cannot: confusing wording, awkward flows, layout problems, and surprises.

## When you are done

Tell the owner which boxes you ticked, which failed, and send your findings. The owner can delete all test accounts by resetting the test database; nothing on this site is kept.
