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
- **Run by hand:** `node src/monitor/daily-check.js` (exit 0 means all good).
- **Report never arrived?** A SendGrid 202 only means "queued". Run
  `node src/monitor/sendgrid-diagnostics.js` locally with `SENDGRID_API_KEY` in
  your `.env` (never on GitHub: this repo is public, so Actions logs are public).
  It prints per-day delivered/bounced/dropped counts, the suppression lists with
  SendGrid's reasons, and sender-authentication status.

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

