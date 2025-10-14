# 🎙️ Voice Gateway - AI Phone Receptionist for RSE Energy

A production-ready AI phone receptionist system for RSE Energy's HVAC service scheduling using Twilio, OpenAI, and ElevenLabs.

## 🆕 Latest Update: Real-Time Transcription Pre-Validation

**October 14, 2025** - Major enhancement to confidence handling! We've implemented a pre-validation system that intercepts low-confidence transcriptions **before** OpenAI processes them, preventing bad data from entering the conversation. See [SOLUTION.md](SOLUTION.md) for complete details.

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

## 🔍 **Confidence Checking & Verification**

The system automatically validates and verifies all collected information to ensure accuracy **before** OpenAI processes it.

### **How It Works:**

**1. Pre-Validation Interception (NEW!):**
- Manual VAD detects when user stops speaking
- System requests transcription from OpenAI
- **CRITICAL**: Transcription is validated **BEFORE** OpenAI processes it
- Low-confidence data triggers clarification **BEFORE** model responds
- Only verified data enters the conversation history

**2. Confidence Estimation:** 
- OpenAI Realtime API doesn't provide real confidence scores (always returns 1.0)
- We use **heuristic estimation** based on transcription quality indicators:
  - Transcription artifacts ([inaudible], [unclear])
  - Unusual length for field type
  - Excessive filler words (um, uh, like)
  - Gibberish patterns (random consonant clusters)
  - Repeated words
  - Field-specific format validation
  - Very short responses to open questions
- If estimated confidence ≤ 0.60, verification is triggered **before** OpenAI sees it

**3. Format Validation:**
- **Email:** Regex validation (must have @, domain, TLD)
- **Phone:** 10-11 digit validation
- **Address:** Minimum length and letter presence
- **Names:** Check for unlikely characters (numbers, symbols)

**Implementation:**
See [SOLUTION.md](SOLUTION.md) for technical details on the manual VAD and pre-validation architecture.

**4. Verification Prompts:**

**Personal Info (spelling required):**
- First/Last Name: "Could you please spell your [first/last] name for me?"
- Email: "Do you mind spelling out that email for me?"
- Phone: "Could you say your phone number slowly, digit by digit?"
- Address: "Could you please spell that street name for me?"

**Problem Context (repeat-back):**
- Issue/Equipment/Symptoms: "I heard: '[transcript]'. Is that correct?"
- If NO: "No problem. Please repeat that once more, and I will confirm."

**5. Once-Per-Field Rule:**
- Each field is only verified ONCE
- After successful verification, field is marked as `verified: true`
- Won't loop unless caller explicitly requests correction

**6. Data Structure:**

Each captured field stores:
```json
{
  "field": "email",
  "raw_value": "tim at example dot com",
  "final_value": "tim@example.com",
  "confidence": 0.54,
  "verified": true,
  "verified_at": "2025-10-13T21:30:00.000Z"
}
```

Verification events log:
```json
{
  "field": "email",
  "reason": "low_confidence",
  "prompt_used": "Do you mind spelling out that email for me?",
  "timestamp": "2025-10-13T21:30:00.000Z",
  "confidence": 0.54
}
```

**7. SharePoint Integration:**

At call end, the system outputs:
- `fields[]` - All captured and verified fields
- `verification_events[]` - Log of all verification attempts

Ready for direct SharePoint/database logging.

### **Monitored Fields:**

**Personal Info:**
- first_name, last_name
- email, phone
- street, city, state, zip
- preferred_contact_method

**Problem Context:**
- issue_description
- equipment_type, brand
- symptoms, urgency

## 📊 System Prompt

Edit the `instructions` field in either server file to customize:
- Information to collect
- Conversation style
- Emergency handling
- Tone and personality
- Script flow and phrasing
- Verification behavior

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
