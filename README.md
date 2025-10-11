# 🎙️ Voice Gateway - AI Phone Receptionist for RSE Energy

A production-ready AI phone receptionist system for RSE Energy's HVAC service scheduling using Twilio, OpenAI, and ElevenLabs.

## 🚀 Features

- **Real-time voice conversation** over phone
- **Automated information collection:** name, phone, email, address, equipment details, issue
- **Natural, human-like voice** responses with inflections and pauses
- **Immediate confirmation** of personal details (sounds more professional)
- **Safety-first protocol** - checks for emergencies before proceeding
- **New vs. existing customer** detection
- **Urgency assessment** for prioritization
- **Multiple architecture options** (OpenAI-only vs. Hybrid with ElevenLabs)

## 📋 Prerequisites

- Node.js 16+
- Twilio account with phone number
- OpenAI API key (for Realtime API)
- ElevenLabs API key (for hybrid mode)
- ngrok or similar for local development

## 🛠️ Installation

```bash
npm install
```

## ⚙️ Configuration

Create a `.env` file:

```env
# Server
PORT=8080
PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app

# Twilio
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_NUMBER=+1234567890

# OpenAI
OPENAI_API_KEY=sk-proj-...

# ElevenLabs (for hybrid mode)
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

## 🎯 Architecture Modes

### 1. **OpenAI Realtime (Recommended for Speed)** 
```bash
npm run realtime
```

**Pros:**
- ✅ Lowest latency (~300ms)
- ✅ No audio conversion needed (native G.711 μ-law)
- ✅ Integrated STT + conversation + TTS
- ✅ High-precision audio timing

**Cons:**
- ⚠️ Voice sounds slightly robotic
- ⚠️ Limited voice customization

**Best for:** Speed and reliability

---

### 2. **Hybrid Mode (Recommended for Quality)** 🌟
```bash
npm run hybrid
```

**Pros:**
- ✅ Ultra-natural ElevenLabs voice (inflections, pauses, "uh"s)
- ✅ OpenAI Realtime for conversation intelligence
- ✅ Best of both worlds

**Cons:**
- ⚠️ Slightly higher latency (~500-800ms)
- ⚠️ Requires ffmpeg for audio conversion
- ⚠️ Higher API costs (both OpenAI + ElevenLabs)

**Best for:** Maximum naturalness and user experience

---

### 3. **Legacy Mode**
```bash
npm run dev
```

**Pros:**
- ✅ Full control over each component

**Cons:**
- ⚠️ Complex audio pipeline
- ⚠️ Higher latency
- ⚠️ More prone to audio quality issues

**Best for:** Custom implementations

---

## 📞 Twilio Setup

1. Go to Twilio Console → Phone Numbers
2. Select your phone number
3. Under "Voice Configuration":
   - **A CALL COMES IN**: Webhook
   - **URL**: `https://your-ngrok-url.ngrok-free.app/twilio/voice`
   - **HTTP**: POST
4. Save

## 🧪 Testing

1. Start ngrok:
   ```bash
   ngrok http 8080
   ```

2. Update `PUBLIC_BASE_URL` in `.env` with ngrok URL

3. Start server:
   ```bash
   npm run hybrid  # or npm run realtime
   ```

4. Call your Twilio number!

## 🎨 Voice Customization

### OpenAI Realtime
Edit `src/server-realtime.js`:
```javascript
voice: "alloy"  // Options: alloy, echo, fable, onyx, nova, shimmer
```

### ElevenLabs (Hybrid)
Edit `src/server-hybrid.js` or set in `.env`:
```javascript
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM  // Rachel (default)
```

Browse voices: https://elevenlabs.io/voice-library

## 📋 **Conversation Flow:**

The AI receptionist (Zelda) follows this structured script:

1. **Greeting** - "Thanks for calling RSE Energy. This is Zelda..."
2. **Safety Check** - Asks about emergencies FIRST (gas/smoke/danger)
3. **Basic Info** - Collects name, phone, email (one at a time)
4. **Immediate Confirmation** - Repeats back: "I have [Name] at [Phone] and [Email]. Is that right?"
5. **Service Address** - Gets address and confirms immediately
6. **Client Status** - Checks if new or existing customer
7. **Equipment Details** - System type, age, issue, history, urgency
8. **Final Recap** - Summarizes all collected information
9. **Wrap-up** - Explains next steps (confirmation via text/email)
10. **Closing** - Professional sign-off

### **Key Features:**
- ✅ Confirms personal details immediately after collection
- ✅ Asks ONE question at a time
- ✅ Natural, conversational tone
- ✅ Safety-first approach
- ✅ Professional but warm

## 📊 System Prompt

Edit the `instructions` field in either server file to customize:
- Information to collect
- Conversation style
- Emergency handling
- Tone and personality
- Script flow and phrasing

## 🔧 Troubleshooting

### Audio is choppy
- Check server CPU usage
- Verify ngrok connection is stable
- Ensure no other processes are using port 8080

### No audio heard
- Verify Twilio webhook URL is correct
- Check server logs for errors
- Test with `npm run realtime` first (simpler)

### ElevenLabs errors (hybrid mode)
- Verify API key is valid
- Check ElevenLabs quota/credits
- Ensure ffmpeg is installed correctly

## 📝 License

ISC

## 🤝 Contributing

Pull requests welcome!

---

**Built with ❤️ for seamless customer service automation**
