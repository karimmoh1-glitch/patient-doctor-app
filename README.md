# CareConnect

A patient–doctor app: patients describe what's wrong (by voice or text) and get matched
with nearby doctors, or pair directly with their existing doctor via an invite code. Paired
patients and doctors can message each other, and patients can call their doctor directly.

## Getting started

Requires a Postgres database (local or hosted — e.g. the free one this repo's `render.yaml`
provisions on Render).

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and JWT_SECRET
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy on Render

This repo includes a `render.yaml` blueprint that provisions a free web service and a free
Postgres database together.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Click the button above (or go to the Render dashboard → **New +** → **Blueprint** and point
   it at this GitHub repo).
2. Sign in to Render (GitHub sign-in is one click if you're already logged into GitHub).
3. Render reads `render.yaml`, creates the database and web service, and generates a
   `JWT_SECRET` automatically — no manual config needed.
4. First deploy takes a few minutes. After that you'll have a public URL you can open on your
   phone.

## How it works

- **Sign up** as a Patient or Doctor.
- **Doctors** set a specialty, phone number, and location, and get a shareable invite code.
- **Patients** describe their symptoms (speaking uses the browser's built-in speech-to-text)
  and either enter a doctor's invite code to pair directly, or search for nearby doctors —
  results are ranked by a keyword-based specialty match plus distance (browser geolocation).
- Once paired, patients and doctors can **chat**, and patients get a **Call** button that
  dials the doctor's real phone number (`tel:` link).

## Notes

- Data lives in a local SQLite file (`prisma/dev.db`) — nothing to configure.
- Specialty matching is keyword-based (see `src/lib/specialty.ts`), not an LLM call, so it
  works offline with no API keys.
- Chat updates via polling (every 3s) rather than websockets, to keep the stack simple.
