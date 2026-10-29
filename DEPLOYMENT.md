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
   Re-running is a no-op.
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

