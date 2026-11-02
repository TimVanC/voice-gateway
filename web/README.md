# Ava call log

Read-only web view of the calls Ava (the RSE AI receptionist) has handled,
backed by the Neon database the voice server writes to.

- `/` paginated call list with search, date range and a test-call filter
- `/calls/<id>` every intake field, call metadata, the transcript, and, for
  calls placed by the test caller (`scripts/test-caller`), a recording player
  (stereo: caller left, Ava right) and the test run's checks and latency numbers
- `/calls/<id>/recording` that call's recording as a WAV, built on request from
  the stored mu-law tracks
- `/login` single shared password (`APP_PASSWORD`), 30-day cookie

## Run locally

```bash
npm install
cp .env.example .env.local   # DATABASE_URL, APP_PASSWORD, SESSION_SECRET
npm run dev
```

## Deploy

Vercel, Root Directory `web`, with the three variables above. Details in
[../DEPLOYMENT.md](../DEPLOYMENT.md#-call-log-web-app-web-vercel).

## Layout

- `app/page.tsx` call list, `app/calls/[id]/page.tsx` call detail, `app/login` sign-in
- `lib/queries.ts` all SQL, `lib/db.ts` the `pg` pool, `lib/auth.ts` the signed cookie,
  `lib/wav.ts` mu-law to WAV for the recording route
