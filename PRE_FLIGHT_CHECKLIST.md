# ✅ Pre-Flight Checklist - Before First Call

## 🔧 **Railway Environment Variables**

Verify these are set in Railway Dashboard → Variables:

- [ ] `OPENAI_API_KEY` - Your OpenAI API key (starts with `sk-proj-`)
- [ ] `ELEVENLABS_API_KEY` - Your ElevenLabs API key
- [ ] `ELEVENLABS_VOICE_ID` - Voice ID (default: `21m00Tcm4TlvDq8ikWAM` for Rachel)
- [ ] `NODE_ENV` - Set to `production`
- [ ] `PUBLIC_BASE_URL` - Set to `https://voice-gateway-production-187c.up.railway.app`

**Note:** `PORT` is automatically set by Railway, but you can override if needed.

---

## 📞 **Twilio Configuration**

In Twilio Console → Phone Numbers → Your Number:

- [ ] **A CALL COMES IN:** Webhook
- [ ] **URL:** `https://voice-gateway-production-187c.up.railway.app/twilio/voice`
- [ ] **Method:** `HTTP POST`
- [ ] **Save** the configuration

---

## 🧪 **Health Check Test**

**Test the health endpoint:**
```bash
curl https://voice-gateway-production-187c.up.railway.app/health
```

**Expected response:**
```json
{"status":"ok","timestamp":"2025-10-16T..."}
```

If you get a 200 OK, the server is running! ✅

---

## 📊 **Monitor Logs**

**Open Railway logs in a separate terminal:**
```bash
railway logs -f
```

**Or in Railway Dashboard:**
- Go to your service
- Click "View Logs" tab
- Keep it open during your test call

**What to watch for:**
- ✅ `✨ Hybrid Voice Gateway Ready!`
- ✅ `📞 Incoming call to /twilio/voice`
- ✅ `✅ Connected to OpenAI Realtime API`
- ✅ `🎙️ AI: Hi there! Thanks for calling...`
- ✅ `⚡ First audio received in XXXms`
- ✅ `✅ FFmpeg conversion complete`

---

## 🚨 **Common Issues to Watch For**

### ❌ **"OPENAI_API_KEY is required"**
- **Fix:** Add `OPENAI_API_KEY` to Railway variables

### ❌ **"ELEVENLABS_API_KEY is required"**
- **Fix:** Add `ELEVENLABS_API_KEY` to Railway variables

### ❌ **"PUBLIC_BASE_URL missing/invalid"**
- **Fix:** Set `PUBLIC_BASE_URL` to full HTTPS URL (no trailing slash)

### ❌ **"FFmpeg error: Error configuring filter graph"**
- **Status:** Should be fixed with latest deployment
- **If still happening:** Check Railway logs for full error

### ❌ **Call connects but no audio**
- **Check:** Twilio webhook URL is correct
- **Check:** WebSocket path is `/hybrid/twilio` (not `/realtime/twilio`)
- **Check:** Railway logs show "✅ FFmpeg conversion complete"

---

## 🎯 **Ready to Test!**

Once all checkboxes are ✅:

1. **Open Railway logs** (`railway logs -f`)
2. **Call your Twilio number**
3. **Listen for Zelda's greeting:**
   - "Hi there! Thanks for calling RSE Energy. This is Zelda. How can I help you today?"
4. **Watch logs for:**
   - Call received
   - OpenAI connection
   - First audio chunk
   - FFmpeg success

---

## 📝 **What to Test**

1. **Greeting** - Does Zelda speak?
2. **Speech Recognition** - Can you be heard?
3. **Response** - Does Zelda respond to your input?
4. **Audio Quality** - Is it clear?
5. **Latency** - How long between your speech and response?

---

## 🆘 **If Something Goes Wrong**

1. **Check Railway logs** - Look for error messages
2. **Check Twilio logs** - Twilio Console → Monitor → Logs
3. **Verify environment variables** - Railway Dashboard → Variables
4. **Test health endpoint** - Should return 200 OK

---

**Good luck! 🚀**

