# Railway Production Cutover - Summary

## ✅ Completed Tasks

### 1. Configuration System
- ✅ Created `src/config/baseUrl.js`
  - Dynamic URL handling: `PUBLIC_BASE_URL` (prod) vs `LOCAL_PUBLIC_BASE_URL` (dev)
  - Automatic environment detection via `NODE_ENV`
  - URL validation

### 2. Server Hardening
- ✅ All 3 servers bind to `0.0.0.0` (Railway requirement)
- ✅ Production timeouts added:
  - `keepAliveTimeout: 70s`
  - `headersTimeout: 75s`
- ✅ Health endpoint standardized: `{status: "ok", timestamp: "..."}`

### 3. Structured Latency Logs
Added timing metrics in `server-hybrid.js`:
- ⏱️ Webhook → OpenAI connection
- ⏱️ Session ready time
- ⏱️ First LLM token latency
- ⏱️ First TTS audio chunk latency

### 4. PII Masking
- ✅ Phone numbers masked in logs: `973***2528`
- ✅ No API keys in logs

### 5. Docker Support
- ✅ Created `Dockerfile`:
  - Node 20 Alpine base
  - FFmpeg pre-installed for audio processing
  - Health check endpoint
  - Defaults to `server-hybrid.js`

### 6. Documentation
- ✅ Created `DEPLOYMENT.md`:
  - Railway environment variables
  - Twilio webhook configuration
  - Railway commands (`railway logs -f`, deploy, rollback, region change)
  - Local development setup with ngrok
  - Monitoring and troubleshooting

### 7. Updated All Servers
- ✅ `src/server-hybrid.js` - Production default (OpenAI + ElevenLabs)
- ✅ `src/server-realtime.js` - Full duplex mode
- ✅ `src/server.js` - Legacy mode

### 8. Package Configuration
- ✅ Updated `package.json`:
  - `npm start` now runs `server-hybrid.js` (production default)
  - All dev scripts preserved

## 🚀 Deployment Steps

### Quick Deploy to Railway

```bash
# 1. Create PR and merge to main
git checkout main
git merge chore/railway-prod-cutover
git push origin main

# 2. Railway auto-deploys from main
# Watch logs:
railway logs -f
```

### Required Railway Environment Variables

```bash
NODE_ENV=production
PUBLIC_BASE_URL=https://voice-gateway-production-187c.up.railway.app
OPENAI_API_KEY=sk-proj-...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

### Update Twilio Webhook

Point your Twilio phone number to:
```
https://voice-gateway-production-187c.up.railway.app/twilio/voice
```

## ✅ Post-Deploy Checklist

- [ ] `GET /health` returns `200 OK`
- [ ] Test call connects
- [ ] Logs show:
  - [ ] Webhook received
  - [ ] OpenAI session opened
  - [ ] First LLM token timing
  - [ ] First TTS audio timing
- [ ] Call quality is good
- [ ] No crashes or errors

## 🔍 Monitoring

### Expected Log Flow

```
📞 Incoming call to /twilio/voice
From: 973***2528
⏱️  Webhook processed in 45ms

📞 New Twilio connection from: <IP>
🔌 Connecting to OpenAI Realtime API...
✅ Connected to OpenAI Realtime API
⏱️  Webhook → OpenAI connection: 450ms

🎯 OpenAI session created: sess_...
⏱️  Session ready in 120ms

⏱️  First LLM token: 380ms
⏱️  First TTS audio chunk: 520ms

🎙️ AI: Hi there! Thanks for calling...
```

### Troubleshooting

**No audio:**
- Check Twilio webhook URL
- Verify WebSocket path: `/hybrid/twilio`

**500 errors:**
- Check Railway logs: `railway logs -f`
- Verify environment variables are set

**Slow responses:**
- Check latency metrics in logs
- Consider region change (Railway dashboard)

## 📦 Files Changed

```
New:
  DEPLOYMENT.md
  Dockerfile
  src/config/baseUrl.js

Modified:
  package.json           - Default start script
  src/server-hybrid.js   - BASE_URL, timeouts, latency logs
  src/server-realtime.js - BASE_URL, timeouts
  src/server.js          - BASE_URL, timeouts
```

## 🎉 Benefits

1. **Production Ready**: Proper timeouts, health checks, error handling
2. **Observability**: Structured latency logs for debugging
3. **Security**: PII masking in logs
4. **Developer Experience**: Easy local dev with ngrok
5. **Auto Deploy**: Railway detects main branch changes
6. **Zero Downtime**: Railway handles blue/green deployments
7. **Flexibility**: Easy region switching, rollbacks

## 📚 Next Steps

After merging and deploying:
1. Test the production endpoint
2. Monitor first few calls closely
3. Tune latency based on logs
4. Optional: Add custom domain
5. Optional: Add autoscaling rules

