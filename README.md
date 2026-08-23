# MedConnect

A web app connecting patients with doctors. A patient signs up, states their US state and what's
wrong (typed or spoken), gets matched to same-state doctors ranked by specialty relevance, sends a
pairing request, and once a doctor accepts, can click-to-call them. Doctors appear via a seeded
demo directory or their own signup, which goes through admin approval before it's live.

## Tech stack

React 19 + TypeScript, Vite, Wouter, TanStack Query, Tailwind CSS v4, shadcn/ui on the frontend;
Express 5, JWT auth (with per-device revocation), PostgreSQL via Drizzle ORM on the backend; Resend
for email (falls back to console logging without an API key, so nothing needs to be configured to
develop locally).

## Getting started

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and JWT_SECRET at minimum
npm run db:push
npm run db:seed        # demo doctors, a demo patient, one doctor with a login, an admin
npm run dev
```

Demo accounts (password `DemoPass123!` for all): `admin@medconnect.dev`, `patient@medconnect.dev`
(CA), `doctor@medconnect.dev` (CA, Family Medicine).

## What's implemented (v1)

- Patient signup/login, JWT auth with server-enforced per-device revocation.
- Forgot/reset password (emailed single-use token, 1-hour expiry).
- Symptom entry by typing or voice (browser `MediaRecorder` → server-side transcription).
- Deterministic, explainable same-state doctor matching ranked by specialty/keyword overlap.
- Pairing requests (patient → doctor), accept/decline, click-to-call (`tel:` link) revealed only
  once accepted.
- In-app chat between a patient and their accepted doctor (polling-based, PHI redacted from
  server logs, access limited to the two parties on an accepted pairing).
- Patient SOS page: a 911 shortcut plus an urgent-alert message to a connected doctor — clearly
  scoped as not a real-time-monitored emergency channel.
- Doctor self-signup, pending admin approval before the profile goes live.
- Audit logging on PHI-access points (symptom report creation/viewing, match results viewed,
  pairing lifecycle, a doctor opening a paired patient's symptom report).

## Explicitly out of scope for v1

In-app WebRTC/VoIP calling (click-to-call and chat only, no audio/video), a mobile app,
third-party license/NPI verification integration, multi-state licensing logic beyond same-state
matching, video visits, e-prescribing, EHR integration, real-time emergency dispatch.

## Non-code compliance follow-ups

This app is built with real security practices from day one (encryption in transit, audit
logging, RBAC, PHI-aware logging), but **full HIPAA compliance also requires steps outside of
code** that this repo cannot complete on its own:

- A signed Business Associate Agreement (BAA) with your hosting/DB provider and with your
  speech-to-text vendor (see `server/services/speechService.ts` — production requires
  `STT_PROVIDER` to be set, and currently throws until the AWS Transcribe Medical integration is
  actually wired up under an executed BAA).
- Managed Postgres with encryption at rest enabled (Neon, Supabase, RDS) — a deploy-time hosting
  choice, not application code.
- A privacy policy and terms of service.
- Workforce training on PHI handling for anyone with production access.
- Admin doctor-approval in v1 is a manual trust decision — there is no integration with a
  third-party license-verification registry.

Do not point this at real patient data until those are in place.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Express + Vite middleware for local development |
| `npm run build` | Production bundle |
| `npm start` | Run the production build |
| `npm run db:push` | Push the Drizzle schema |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run db:seed` | Populate demo data (refuses to run in production) |
