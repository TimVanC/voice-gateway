# Deployment Guide - Railway Production

## 🚂 Railway Production URL
**Live App:** https://voice-gateway-production-187c.up.railway.app

## 📋 Required Environment Variables

Set these in Railway Dashboard → Variables:

```bash
# Core APIs
OPENAI_API_KEY=sk-proj-...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM  # Rachel voice (or your custom voice ID)

# Railway Production
NODE_ENV=production
PUBLIC_BASE_URL=https://voice-gateway-production-187c.up.railway.app
PORT=8080  # Railway sets this automatically, but you can override

# Optional: SharePoint integration (if using)
SHAREPOINT_CLIENT_ID=...
SHAREPOINT_CLIENT_SECRET=...
SHAREPOINT_TENANT_ID=...
```

## 📞 Twilio Webhook Configuration

In Twilio Console → Phone Numbers → Configure your number:

**Voice & Fax:**
- **A CALL COMES IN:** Webhook
- **URL:** `https://voice-gateway-production-187c.up.railway.app/twilio/voice`
- **Method:** `HTTP POST`

## 🔧 Railway Commands

### View Live Logs
```bash
railway logs -f
```

### Deploy Latest from Main
Railway auto-deploys when you push to `main` branch. To manually trigger:

```bash
git push origin main
```

Or in Railway Dashboard:
- Go to Deployments tab
- Click "Deploy" button

### Change Region
In Railway Dashboard:
1. Go to Settings
2. Under "Environment" → Change region (us-west1, eu-west1, etc.)
3. Redeploy

### Rollback
In Railway Dashboard:
1. Go to Deployments tab
2. Find previous working deployment
3. Click "..." → "Redeploy"

## 🧪 Health Check

**Test the health endpoint:**
```bash
curl https://voice-gateway-production-187c.up.railway.app/health
```

**Expected response:**
```json
{"status":"ok","timestamp":"2025-10-15T19:50:00.000Z"}
```

## 🗄️ Call Records in Neon (alongside Google Sheets)

Every finished call is written to two places: the Google Sheet, exactly as
before, and a Neon Postgres database that also keeps the full transcript
(`src/utils/call-db.js`). The Sheet path is untouched; the database write runs
after it, never blocks the call, and logs-and-continues on any failure. With
`DATABASE_URL` unset the server logs one line and only writes to the Sheet.

### One-time setup

1. **Neon project (free tier):** create a project at console.neon.tech and copy
   its connection string (Dashboard → Connect → "Pooled connection" is fine).
   It looks like `postgresql://user:password@ep-...-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`.
2. **Schema:** put `DATABASE_URL=...` in your local `.env` (gitignored) and run

   ```bash
   node scripts/db-migrate.js
   ```

   This applies `db/migrations/*.sql` once each (tracked in `schema_migrations`).
   Re-running is a no-op. `001` creates `calls` and `transcript_turns`; `002`
   adds `recordings` (raw mu-law audio of both sides, written by the test
   caller in `scripts/test-caller`) and `test_runs` (that harness's pass/fail
   and latency numbers), which the web app plays back and shows on the call page.
3. **Railway → Variables**, in BOTH `production` and `staging`:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from step 1 |
   | `TEST_CALLER_NUMBERS` | optional, comma-separated numbers whose calls are flagged `is_test` (RSE's own and Tim's phones); `TWILIO_NUMBER` is always included |

   Staging and production write to the same database; the `environment`
   column records which one wrote each row, and the web app shows it on the
   call page.

### Importing the Sheet history

`scripts/migrate-sheets-to-neon.js` copies every existing Sheet row into the
`calls` table with `source = 'sheets'`. It never writes to the Sheet.

```bash
node scripts/migrate-sheets-to-neon.js --dry-run
```

prints counts (rows, per month, per status), the auto-detected date of the
caller-ID fix (before it, every row shows RSE's own number), and the rows it
would flag `is_test`, with reasons. When that looks right:

```bash
node scripts/migrate-sheets-to-neon.js --write
```

Safe to re-run: rows whose `call_id` is already present (including calls the
server has since written live) are skipped. Options:
`--caller-id-fix-date=YYYY-MM-DD` to override the detected date,
`--own-numbers=+1...,+1...` for extra RSE numbers, `--limit=N` for a trial.

### Flags on each row

- `is_test`: caller number is `TWILIO_NUMBER` / `TRANSFER_PHONE_NUMBER` /
  `TEST_CALLER_NUMBERS`, or (imported rows) the name/email/summary contains
  "test". `test_reason` says which. Flagged calls are kept, never dropped.
- `pre_caller_id_fix`: imported rows from before caller ID was passed through
  (Apr 16 – Jun 2, 2026). Their phone column is RSE's own number unless the
  caller stated one, so they are not treated as test calls by number.

## 🖥️ Call Log Web App (`web/`, Vercel)

A small Next.js app that shows the calls table: paginated list with search,
date range and test-call filter, and a call page with every intake field and
the transcript. Single shared password.

### Run locally

```bash
cd web && npm install
cp .env.example .env.local   # fill in DATABASE_URL, APP_PASSWORD, SESSION_SECRET
npm run dev                  # http://localhost:3000
```

### Deploy to Vercel (free Hobby tier)

**Current state (Oct 29, 2026):** the project exists as `rse-ava-calls` on Vercel
(team "Tim's projects"), live at https://rse-ava-calls.vercel.app, with the three
variables set for Production and Preview. It is connected to the
`TimVanC/voice-gateway` GitHub repo with Root Directory `web` and the Next.js
preset, so every push builds: `main` becomes production, any other branch gets
a preview deployment at
`rse-ava-calls-git-<branch>-tims-projects-6e08583a.vercel.app` (preview URLs
ask for a Vercel login first; the production URL does not). Until the Neon PR
merges, `main` has no `web/` folder, so production stays on the last good
deployment. A manual deploy from the local folder still works:

```bash
cd web && vercel deploy --prod
```

The steps below describe that Git-connected setup from scratch.

1. Vercel → Add New Project → import `TimVanC/voice-gateway`.
2. **Root Directory:** `web` (Framework preset: Next.js is detected automatically).
3. **Environment Variables** (Production and Preview):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon **pooled** connection string (host contains `-pooler`) |
   | `APP_PASSWORD` | the password that opens the app |
   | `SESSION_SECRET` | any long random string, e.g. `openssl rand -base64 32`; changing it signs everyone out |

4. Deploy. Later pushes to `main` redeploy the app; pushes to other branches
   get preview URLs (same password).

Vercel only ever reads the database. The server on Railway is the only writer
besides the one-time import.
## 📬 Daily Health Check (8:00 AM Eastern)

`src/monitor/daily-check.js` tests Anthropic, OpenAI Realtime, Google Sheets, the
email/transfer config and the public `/health` endpoint, then emails one report.

- **Where it runs:** inside the production server on Railway
  (`src/monitor/schedule.js`), at 8:00 AM and 4:00 PM America/New_York,
  DST-aware. Change the times with `DAILY_CHECK_TIMES` (default `08:00,16:00`).
  Only the Railway `production` environment runs it; `staging` and local
  servers log "schedule off". Force either way with `DAILY_CHECK_SCHEDULE=on|off`.
- **Recipient:** `MONITOR_EMAIL_TO` (default timvancau@gmail.com), sent through
  SendGrid from `EMAIL_FROM`. The subject and "Run at" line show Eastern time.
- **Health URL:** `MONITOR_HEALTH_URL`. Inside the server it defaults to
  `https://$RAILWAY_PUBLIC_DOMAIN/health`; the one-shot script requires it.
- **Twilio balance:** opt-in with `MONITOR_TWILIO_BALANCE=on`. Never enable it
  anywhere with a changing IP; Twilio locked the account twice in Sep 2026 when
  the check ran from GitHub-hosted runners.
- **Backup:** `.github/workflows/daily-check.yml` still runs on GitHub's cron
  (8 AM and 4 PM targets, in practice hours late). Scheduled runs email only
  when something fails (`MONITOR_EMAIL_ONLY_ON_FAILURE`); it exists to catch the
  one thing the server cannot report: the server being down. A manual
  "Run workflow" always emails the full report, which is how to test the email
  path. Each run re-enables the workflow, because GitHub switches off cron in
  public repositories after 60 days without a push.
- **Daily smoke call:** see the next section. When it is on, its line
  (`Ava answers the phone`) is part of this report.
- **Run by hand:** `node src/monitor/daily-check.js` (exit 0 means all good).
- **Report never arrived?** A SendGrid 202 only means "queued". Run
  `node src/monitor/sendgrid-diagnostics.js` locally with `SENDGRID_API_KEY` in
  your `.env` (never on GitHub: this repo is public, so Actions logs are public).
  It prints per-day delivered/bounced/dropped counts, the suppression lists with
  SendGrid's reasons, and sender-authentication status.

## 📞 Daily Smoke Call (Ava answers the phone)

Once a day the production server phones Ava's own number and checks that she
answers with her opening greeting (`src/monitor/smoke-call.js`). It is the one
check that proves the whole path a customer takes: Twilio, the webhook, the
media stream, OpenAI Realtime and Ava's greeting.

- **What happens:** at the 8:00 AM daily check the server calls `TWILIO_NUMBER`
  from `SMOKE_CALL_FROM` with TwiML that streams the call back to the server
  at `wss://<PUBLIC_BASE_URL host>/smoke/stream`. The server stays silent,
  collects about 15 s of audio after Ava's first sound, hangs up, transcribes
  the clip once (`gpt-4o-mini-transcribe`) and compares it with
  `GREETING.primary` in `src/scripts/rse-script.js` (at least 70% of the
  greeting's words, in order; case and punctuation ignored).
  **PASS** = audio within 10 s of the stream starting and the greeting heard.
  **FAIL** names the reason: the call never connected, no audio, or a
  transcript that is not the greeting (quoted).
- **Where it shows:** one line in the daily check email
  (`[PASS] Ava answers the phone: answered 2.9 s after the stream started and
  said her greeting (...)`), one log line (`✅ Daily smoke call PASS` /
  `❌ Daily smoke call FAIL`), and, with `DATABASE_URL` set, the web app's
  **Test calls** tab (scenario `daily-greeting`, with the transcript, the
  reason on failure and the recording). The call is marked `is_test` with
  reason "daily smoke call", so the main Calls list hides it. It attaches to
  the row Ava writes for the call; if she never answered, it writes its own
  row with source `smoke-test` so the failure is visible.
- **Flags (Railway → Variables, production):**

  | Variable | Value |
  |---|---|
  | `DAILY_SMOKE_CALL` | `on` to enable. Unset or anything else: no call is ever placed. |
  | `SMOKE_CALL_FROM` | the Twilio number to call from, E.164. Default: the first number in `TEST_CALLER_NUMBERS` (today the backup (973) number). Must be a number on the account and must differ from `TWILIO_NUMBER`. |

  It also needs `TWILIO_NUMBER`, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`,
  `OPENAI_API_KEY` and `PUBLIC_BASE_URL` (or Railway's `RAILWAY_PUBLIC_DOMAIN`),
  all already set in production. The server logs at start-up whether the
  smoke call is on and which numbers it will use.
- **When:** inside the daily check, so production only (`DAILY_CHECK_SCHEDULE`
  rules apply) and at its times (`DAILY_CHECK_TIMES`, default 8 AM and 4 PM).
  A passing morning call is not repeated at the 4 PM check (its line repeats
  the morning result); a failed one is tried again. A restart between the two
  can cost one extra call.
- **Never from GitHub Actions.** Twilio locked the account twice for API calls
  from Actions runners. The one-shot `node src/monitor/daily-check.js` never
  places the call, and `smoke-call.js` refuses when `GITHUB_ACTIONS` is set.
- **How the GitHub email still gets the line:** the server shows its newest
  result on `/health` (`smoke_call: { enabled, last: { at, passed, summary } }`,
  reloaded from Neon after a restart). Any daily-check run that did not place
  the call itself, which is the GitHub Actions backup and any server with the
  smoke call off, reads that and adds the `Ava answers the phone` line from
  it: PASS/FAIL for today's call, FAIL when there was no call today, WARNING
  when the smoke call is off. GitHub's run starts hours after 8 AM, so by
  then the day's call has happened.
- **Cost:** about 30 s of Twilio outbound + inbound legs and two media
  streams (roughly 3 to 5 cents), one 15 s transcription (well under a cent)
  and Ava's own Realtime session for the greeting (a few cents). Budget
  about 10 cents a day. No Realtime session is opened on the smoke side.
- **Local run:** start a tunnel (`ngrok http 8099`), then

  ```bash
  PORT=8099 PUBLIC_BASE_URL=https://xxxx.ngrok.app DAILY_SMOKE_CALL=on   DAILY_CHECK_SCHEDULE=on DAILY_CHECK_TIMES=HH:MM MONITOR_HEALTH_URL=http://localhost:8099/health   node src/server-rse.js
  ```

  with `HH:MM` a minute or two ahead (Eastern). The local server places the
  call; whoever answers `TWILIO_NUMBER` (production Ava) is what gets checked.

## 🧪 Pipeline Prototype (staging only)

`src/server-pipeline.js` is a side-by-side prototype of Ava on a Sierra-style
pipeline (streaming speech-to-text → state machine / LLM → streaming
text-to-speech) instead of one OpenAI Realtime speech-to-speech session. It
serves the same `/twilio/voice`, `/twilio/transfer`, `/stream` and `/health`
as `server-rse.js`, uses the same state machine, script, intent classifier and
hang-up logging (Sheets, Neon, email), and does not change `server-rse.js`.

Start it with `npm run pipeline` (or `node src/server-pipeline.js`). On Railway
the **staging** service runs it with a custom start command; production keeps
`node src/server-rse.js` from the Dockerfile.

Providers are picked by environment variables, every key stays in Railway /
`.env`:

```bash
STT_PROVIDER=deepgram|openai       # default: deepgram when DEEPGRAM_API_KEY is set, else openai
DEEPGRAM_API_KEY=...               # Nova-3 (DEEPGRAM_MODEL=nova-3) or Flux (DEEPGRAM_MODEL=flux-general-en)
TTS_PROVIDER=elevenlabs|cartesia   # default: elevenlabs
ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL   # a premade voice; library voices need a paid plan
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
CARTESIA_API_KEY=... CARTESIA_VOICE_ID=... CARTESIA_MODEL_ID=sonic-3
LLM_PROVIDER=anthropic|openai      # default: anthropic when ANTHROPIC_API_KEY is set, else openai (gpt-4o-mini)
LLM_MODEL=claude-sonnet-5-5
AMBIENCE=office                    # continuous low-level room tone under Ava (AMBIENCE_LEVEL_DB=-50)
BARGE_GRACE_MS=900                 # how long the caller must keep talking to cut Ava off
```

With only `OPENAI_API_KEY` set the prototype still runs: speech-to-text falls
back to a Realtime session used for its VAD and `gpt-4o-mini-transcribe`
(no speech is generated by it), and the LLM to chat completions.

`/health` reports the providers in use and the prompt cache (`prompt_cache.ready`,
`fixed`, `from_disk`). The greeting and every fixed script line are rendered at
start-up and kept under `data/prompt-cache/` (gitignored) so a restart costs no
TTS characters; dynamic lines (read-backs, the recap) are synthesised live.

Measure it with the test caller: `node scripts/test-caller/run.js --scenario no-heat --spawn --server src/server-pipeline.js`
(`--server-env TTS_PROVIDER=cartesia` and similar pass extra variables to the
spawned server). The server prints a per-call latency and cost line at hang-up
(`⏱️ Turn latency ...`, `💵 Pipeline cost estimate ...`).

## 💻 Local Development

### Environment Variables
Create a `.env` file in project root:

```bash
# Local Development
NODE_ENV=development
LOCAL_PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app
PORT=8080

# APIs (same as production)
OPENAI_API_KEY=sk-proj-...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

### Running Locally

```bash
# Install dependencies
npm install

# Run hybrid mode (OpenAI + ElevenLabs) with auto-reload
npm run hybrid:dev

# Run realtime mode (OpenAI only)
npm run realtime:dev

# Run legacy mode
npm run dev
```

### Local Webhook Testing with ngrok

1. Start ngrok:
```bash
ngrok http 8080
```

2. Copy the HTTPS URL (e.g., `https://abc123.ngrok-free.app`)

3. Update `.env`:
```bash
LOCAL_PUBLIC_BASE_URL=https://abc123.ngrok-free.app
```

4. Update Twilio webhook to point to ngrok URL:
```
https://abc123.ngrok-free.app/twilio/voice
```

## 📊 Monitoring Logs

### Key Log Events to Watch

**Successful Call Flow:**
```
📞 Incoming call to /twilio/voice
📞 New Twilio connection from: <IP>
🔌 Connecting to OpenAI Realtime API...
✅ Connected to OpenAI Realtime API
🎯 OpenAI session created: sess_...
👋 Sending greeting
🎙️ AI: Hi there! Thanks for calling...
📝 Raw transcription received: "..."
```

**Latency Metrics:**
```
⏱️  Webhook → OpenAI session: 450ms
⏱️  First LLM token: 380ms
⏱️  First TTS audio: 520ms
```

### Common Issues

**❌ "PUBLIC_BASE_URL missing/invalid"**
- Check Railway environment variables
- Ensure `PUBLIC_BASE_URL` is set to full HTTPS URL

**❌ "OPENAI_API_KEY is required"**
- Add `OPENAI_API_KEY` to Railway variables

**❌ "Call connects but no audio"**
- Check Twilio webhook points to correct URL
- Verify WebSocket path: `/hybrid/twilio` or `/realtime/twilio`

**❌ "FFmpeg error"**
- Dockerfile includes ffmpeg - check build logs

## 🔒 Security Notes

- All logs automatically mask PII (phone numbers, emails)
- Never commit `.env` file to git
- Rotate API keys periodically
- Use Railway's built-in secrets management

## 🚀 Deployment Checklist

After deploying to Railway:

- [ ] GET `/health` returns `200 OK`
- [ ] Make a test call to Twilio number
- [ ] Verify logs show:
  - [ ] Twilio webhook received
  - [ ] OpenAI Realtime session opened
  - [ ] First LLM token received
  - [ ] First TTS audio chunk played
- [ ] Call quality is good (no lag, clear audio)
- [ ] Call completes successfully and logs customer data

## 📦 Docker Build (Optional)

Railway auto-detects and uses the Dockerfile. To test locally:

```bash
# Build
docker build -t voice-gateway .

# Run
docker run -p 8080:8080 --env-file .env voice-gateway

# Test
curl http://localhost:8080/health
```

## 🔄 CI/CD

Railway automatically:
1. Detects push to `main` branch
2. Builds Docker image from Dockerfile
3. Runs health checks
4. Routes traffic to new deployment
5. Keeps previous deployment for rollback

**Zero downtime deployments!** 🎉

