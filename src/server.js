// src/server.js
require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { AdaptiveVAD } = require("./vad");
const { BASE_URL, isProd } = require("./config/baseUrl");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Debug middleware to log all incoming requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  console.log('Headers:', req.headers);
  if (req.method === 'POST') {
    console.log('Body:', req.body);
  }
  next();
});

// --- Step 3: audio helpers ---
const fetch = require("node-fetch");

const SILENCE_MS = 2000;         // end of caller turn after ~2s silence (increased for better speech detection)
const MAX_UTTER_MS = 15000;      // safety cap per utterance (increased)
const BYTES_PER_CHUNK = 160;     // 20ms at 8 kHz μ-law = 160 bytes (Twilio standard)
const MAX_TURNS = 12;
const MIN_UTTER_BYTES = 3200;    // ~0.2s audio minimum (increased)
const MAX_BUFFER_BYTES = 64000;  // ~4 seconds at 8k PCM16 (reduced from 96k)
const FRAME_SIZE = 160;          // Twilio standard frame size
const FRAME_INTERVAL = 20;       // 20ms between frames

// μ-law byte to linear16 sample
function mulawToLinear16Sample(u) {
  u = ~u & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = ((mantissa << 4) + 8) << (exponent + 3);
  return sign * magnitude;
}

// μ-law buffer to PCM16 buffer
function mulawToPCM16(mulawBuffer) {
  const out = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    out[i] = mulawToLinear16Sample(mulawBuffer[i]);
  }
  return Buffer.from(out.buffer);
}

// PCM16 sample to μ-law byte
function linear16ToMulawSample(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const cBias = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + cBias;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const mulawByte = ~(sign | (exponent << 4) | mantissa);
  return mulawByte & 0xFF;
}

// PCM16 buffer to μ-law buffer
function pcm16ToMulaw(pcm16Buffer) {
  const view = new Int16Array(pcm16Buffer.buffer, pcm16Buffer.byteOffset, pcm16Buffer.byteLength / 2);
  const out = Buffer.alloc(view.length);
  for (let i = 0; i < view.length; i++) {
    out[i] = linear16ToMulawSample(view[i]);
  }
  return out;
}

// build a WAV header and wrap raw PCM16
function pcm16ToWav(pcmBuf, sampleRate = 8000) {
  const numChannels = 1, bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuf.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuf]);
}

// improved RMS based silence check on PCM16
function isSilent(pcm16Buf) {
  const view = new Int16Array(pcm16Buf.buffer, pcm16Buf.byteOffset, pcm16Buf.byteLength / 2);
  if (view.length === 0) return true;
  
  // Calculate RMS (Root Mean Square) for better speech detection
  let sum = 0;
  const step = Math.max(1, Math.floor(view.length / 100)); // More samples for better accuracy
  for (let i = 0; i < view.length; i += step) {
    sum += view[i] * view[i]; // Square for RMS
  }
  const rms = Math.sqrt(sum / (view.length / step));
  
  // Balanced threshold - 150 works for most phone audio
  return rms < 150;
}

// --- Slot extraction helpers ---
const PHONE_RE = /(\+1[\s\-\.]?)?(\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4})/;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const EMERGENCY_WORDS = [
  "gas", "smell of gas", "smelling gas", "smells like gas",
  "smoke", "smokey", "water leak", "leaking water",
  "flood", "carbon monoxide", "co alarm", "co detector"
];
const SYSTEM_TYPES = ["furnace","boiler","heat pump","ac","air conditioner","mini split","mini-split","condenser"];

const DIGIT_WORDS = {
  "zero": "0","oh":"0","o":"0",
  "one": "1","two":"2","three":"3","four":"4","for":"4","five":"5",
  "six":"6","seven":"7","eight":"8","ate":"8","nine":"9"
};

function wordsToDigits(s) {
  // convert sequences like "nine seven three five five five…" to "973555..."
  const parts = s.replace(/[-().]/g," ").split(/\s+/);
  const digits = parts.map(w => DIGIT_WORDS[w] ?? (/\d/.test(w) ? w : "")).join("");
  return digits;
}

function isTrivialUtterance(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return true;
  if (t.split(/\s+/).length < 2) return true;
  if (t.length < 3) return true;
  
  // Check for system noise/artifacts
  if (/microsoft|word|document|msword|title|bam|bang/i.test(t)) return true;
  
  const trivial = ["you","thanks","thank you","okay","ok","hello","hi","yes","no","i don't understand","thank you for your time","the end","stars","bye","goodbye"];
  return trivial.includes(t);
}

// normalize helpers
function normalizePhone(s) {
  const digits = (s || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return s;
}
function looksLikeAddress(s) {
  // simple heuristic: starts with a number and has a streety word
  return /^\s*\d{1,6}\s+.+/.test(s) && /(st|street|ave|avenue|rd|road|blvd|lane|ln|dr|drive|court|ct|way|terr|terrace|cir|circle)/i.test(s);
}

function extractSlotsFromUserText(userText, lastPrompt = "") {
  const out = {};
  const text = (userText || "").trim();
  const lower = text.toLowerCase();

  // emergency
  if (EMERGENCY_WORDS.some(w => lower.includes(w))) out.emergency_flag = true;

  // phone — try spoken digits -> numeric first
  const spokenDigits = wordsToDigits(lower);              // NEW helper
  const phoneCandidate = spokenDigits.match(PHONE_RE) || text.match(PHONE_RE);
  if (phoneCandidate) {
    out.phone = normalizePhone(phoneCandidate[0]);
  } else {
    // Also try to extract partial phone numbers (3+ digits)
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 3 && digits.length <= 11) {
      out.phone = normalizePhone(digits);
    }
  }

  // email
  const em = text.match(EMAIL_RE);
  if (em) out.email = em[0];

  // system type
  const sys = SYSTEM_TYPES.find(t => lower.includes(t));
  if (sys) out.system_type = sys;

  // address (only if it looks like one)
  if (looksLikeAddress(text)) out.address = text;

  // NAME — only if (a) lastPrompt asked for name OR (b) user uses a self-ident phrase
  const askedForName = /name/i.test(lastPrompt);
  const selfIdent = /^(my name is|this is|i am|i'm)\b/i.test(lower);
  if ((askedForName || selfIdent) && !looksLikeAddress(text) && !isTrivialUtterance(text)) {
    const maybeName = text.replace(/^(my name is|this is|i am|i'm)\s+/i, "").trim();
    // Very strict name validation - must be 2+ words, letters only, not trivial, reasonable length
    if (/^[a-z\s\.'\-]{4,}$/i.test(maybeName) && 
        maybeName.split(/\s+/).length >= 2 && 
        !isTrivialUtterance(maybeName) &&
        maybeName.length > 6 &&
        !/\d/.test(maybeName) && // no numbers in names
        !/thank|you|bye|hello|hi|ok|okay/i.test(maybeName)) { // no common words
      out.name = maybeName;
    }
  }

  // symptoms — only if we didn't capture address & text has at least 3 words & not already captured as other slots
  if (!out.address && !out.phone && !out.name && !out.email && !out.system_type && !isTrivialUtterance(text) && text.length > 10) {
    out.symptoms = text;
  }

  return out;
}

function nextPrompt(slots) {
  const reqOrder = ["name", "phone", "address", "symptoms"];

  // emergencies take priority
  if (slots.emergency_flag) {
    return "I detected a possible emergency. Are you safe right now?";
  }

  // ask for first missing required field
  for (const k of reqOrder) {
    if (!slots[k]) {
      if (k === "name") return "What is your full name?";
      if (k === "phone") return "What is the best phone number to reach you?";
      if (k === "address") return "What is the service address including city and zip?";
      if (k === "symptoms") return "Briefly describe the issue with your system.";
    }
  }

  // all required present → collect optional or confirm
  if (!slots.email) return "What is your email for the confirmation?";
  if (!slots.system_type) return "What type of system is it? For example heat pump or furnace.";
  if (!slots.system_age) return "About how old is the system?";
  return "Thanks. I will create your case now.";
}

function buildIntakePayload(slots, callMeta = {}) {
  const caseId = `INT-${Date.now().toString().slice(-8)}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  return {
    case_id: caseId,
    timestamp: new Date().toISOString(),
    name: slots.name,
    phone: slots.phone,
    address: slots.address,
    email: slots.email,
    system_type: slots.system_type,
    system_age: slots.system_age,
    symptoms: slots.symptoms,
    emergency_flag: !!slots.emergency_flag,
    notes: Array.isArray(slots.notes) ? slots.notes.join("; ") : "",
    call_meta: callMeta
  };
}

// --- Step 4: API helpers ---
async function sttOpenAIFromWav(wavBuf) {
  // Validate API key
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in environment variables");
  }
  
  const FormData = require("form-data");
  const form = new FormData();
  form.append("file", wavBuf, { filename: "audio.wav", contentType: "audio/wav" });
  form.append("model", "whisper-1");
  form.append("language", "en");
  form.append("prompt", "This is a phone call about HVAC service. The person is providing their name, phone number, address, or describing heating and cooling problems.");
  form.append("temperature", "0.0");
  form.append("response_format", "text");
  
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  
  if (!r.ok) {
    const errorText = await r.text();
    console.error(`OpenAI API Error ${r.status}:`, errorText);
    throw new Error(`STT failed ${r.status}: ${errorText}`);
  }
  
  // Handle both JSON and plain text responses from OpenAI
  const contentType = r.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    const j = await r.json();
    return j.text?.trim() || "";
  } else {
    // OpenAI returned plain text (likely an error message)
    const text = await r.text();
    console.warn("OpenAI returned non-JSON response:", text);
    return "";  // Skip this utterance
  }
}

async function chatOpenAI(userText, slots) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are an HVAC intake assistant. Goal: capture required fields name, phone, address, symptoms. Optional: email, system type, system age, notes. Ask one question at a time. Confirm captured values briefly. If unclear, re-ask briefly. Keep replies under 20 words. Be polite and efficient."
        },
        {
          role: "user",
          content:
            `Current data: ${JSON.stringify({
              name: slots.name,
              phone: slots.phone,
              address: slots.address,
              symptoms: slots.symptoms,
              email: slots.email,
              system_type: slots.system_type,
              system_age: slots.system_age,
              emergency_flag: slots.emergency_flag
            })}\nUser said: "${userText}"\nRespond with a single short sentence that either confirms a captured value or asks for the next missing field.`
        }
      ]
    })
  });
  if (!r.ok) throw new Error(`Chat failed ${r.status}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || "";
}

// Get PCM16 from ElevenLabs at 8kHz, then convert to μ-law for Twilio
async function ttsElevenLabsUlaw8k(text) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is not set");
  }
  
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "Rachel";
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      output_format: "pcm_16000"  // Get PCM16 at 16kHz
    })
  });
  
  if (!r.ok) {
    const errorText = await r.text();
    console.error(`ElevenLabs Error ${r.status}:`, errorText);
    throw new Error(`TTS failed ${r.status}`);
  }
  
  // Get PCM16 at 16kHz
  const pcm16kHz = Buffer.from(await r.arrayBuffer());
  
  // Downsample from 16kHz to 8kHz (take every other sample)
  const pcm8kHz = Buffer.alloc(pcm16kHz.length / 2);
  for (let i = 0; i < pcm8kHz.length; i += 2) {
    pcm8kHz[i] = pcm16kHz[i * 2];
    pcm8kHz[i + 1] = pcm16kHz[i * 2 + 1];
  }
  
  // Convert PCM16 8kHz to μ-law
  const mulawAudio = pcm16ToMulaw(pcm8kHz);
  return mulawAudio;
}

const PORT = process.env.PORT || 8080;
const MEDIA_STREAM_PATH = "/media-stream";

// 1) Twilio Voice webhook: return TwiML that starts a Media Stream to our WS
app.post("/twilio/voice", (req, res) => {
  const webhookStart = Date.now();
  console.log("\n📞 Incoming call to /twilio/voice");
  console.log("From:", req.body.From ? req.body.From.replace(/(\d{3})\d{3}(\d{4})/, '$1***$2') : 'Unknown');
  console.log("To:", req.body.To);
  
  try {
    if (!BASE_URL || !/^https?:\/\/.+/i.test(BASE_URL)) {
      console.error("❌ BASE_URL missing/invalid:", BASE_URL);
      const errorResponse = new twilio.twiml.VoiceResponse();
      errorResponse.say("We're sorry, the system is not configured properly.");
      return res.type("text/xml").send(errorResponse.toString());
    }

    const host = new URL(BASE_URL).host;
    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();
    const stream = connect.stream({ url: `wss://${host}/media-stream` });
    stream.parameter({ name: 'track', value: 'both_tracks' });

    console.log(`⏱️  Webhook processed in ${Date.now() - webhookStart}ms`);
    return res.type("text/xml").send(response.toString());
  } catch (err) {
    console.error("❌ Error in /twilio/voice:", err);
    const errorResponse = new twilio.twiml.VoiceResponse();
    errorResponse.say("We're sorry, an error occurred.");
    return res.type("text/xml").send(errorResponse.toString());
  }
});

// 2) Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Catch-all route for debugging
app.use((req, res) => {
  console.log(`Catch-all route hit: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: "Not Found", 
    method: req.method, 
    path: req.path,
    message: "This endpoint doesn't exist. Check your webhook URL configuration."
  });
});

// 3) Start HTTP server first with production hardening
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("\n✨ Legacy Voice Gateway Ready!");
  console.log(`📍 Webhook URL: ${BASE_URL}/twilio/voice`);
  console.log(`🎧 Waiting for calls...\n`);
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`✅ Public URL: ${BASE_URL}`);
  console.log(`🌍 Environment: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  
  // Validate environment variables
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY is not set");
    process.exit(1);
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error("❌ ELEVENLABS_API_KEY is not set");
    process.exit(1);
  }
  
  console.log(`✅ OpenAI API key configured`);
  console.log(`✅ ElevenLabs API key configured`);
});

// Production-grade timeouts for Railway
server.keepAliveTimeout = 70000;
server.headersTimeout = 75000;

// 4) WebSocket server to receive Twilio Media Streams
const wss = new WebSocketServer({ server, path: MEDIA_STREAM_PATH });

// --- Step 5: WebSocket handler with Adaptive VAD ---
wss.on("connection", (ws, req) => {
  console.log("🔌 Twilio Media Stream connected:", req.socket.remoteAddress);

  // per call state
  let speaking = false;
  let processing = false;
  let currentUtteranceBuffer = [];  // Array of PCM16 buffers for current utterance
  let framesSent = 0;
  let sequenceNumber = 0;
  let greetingSent = false;

  // session state for structured conversation
  const session = {
    slots: {
      name: null,
      phone: null,
      address: null,
      symptoms: null,
      email: null,
      system_type: null,
      system_age: null,
      emergency_flag: false,
      notes: []
    },
    lastPrompt: "",
    turnCount: 0
  };

  // Initialize Adaptive VAD
  const vad = new AdaptiveVAD();

  // Helper function to send TTS audio to Twilio
  async function speakToUser(text) {
    if (ws.readyState !== 1) return;
    
    console.log(`💬 Speaking: "${text}"`);
    speaking = true;
    
    try {
      const ulaw8k = await ttsElevenLabsUlaw8k(text);
      console.log(`🔊 TTS audio: ${ulaw8k.length} bytes, ${Math.ceil(ulaw8k.length / FRAME_SIZE)} frames`);
      console.log(`🔍 First 16 bytes:`, ulaw8k.slice(0, 16).toString('hex'));

      let offset = 0;
      framesSent = 0;
      
      const sendFrame = () => {
        if (ws.readyState !== 1 || !speaking) {
          console.log("🛑 TTS stopped");
          speaking = false;
          return;
        }
        
        if (offset >= ulaw8k.length) {
          ws.send(JSON.stringify({ event: "mark", mark: { name: "tts_done" } }));
          console.log(`✅ TTS complete: ${framesSent} frames`);
          speaking = false;
          vad.reset();  // Reset VAD after speaking
          return;
        }
        
        const chunk = ulaw8k.slice(offset, offset + FRAME_SIZE);
        offset += FRAME_SIZE;
        framesSent++;
        
        ws.send(JSON.stringify({ 
          event: "media", 
          media: { 
            payload: chunk.toString("base64"),
            sequenceNumber: sequenceNumber++
          } 
        }));
        
        setTimeout(sendFrame, FRAME_INTERVAL);
      };
      
      sendFrame();
    } catch (e) {
      console.error("❌ TTS error:", e);
      speaking = false;
    }
  }

  // Process completed utterance
  async function processUtterance({ durationMs, reason }) {
    if (processing) return;
    if (currentUtteranceBuffer.length === 0) return;
    
    processing = true;
    console.log(`\n📊 Processing utterance: ${durationMs}ms, reason: ${reason}`);
    
    try {
      const wavPcm16 = Buffer.concat(currentUtteranceBuffer);
      currentUtteranceBuffer = [];
      
      if (wavPcm16.length < 1600) {  // < 0.1s
        console.log("⏭️  Audio too short, skipping");
        return;
      }
      
      const wav = pcm16ToWav(wavPcm16, 8000);
      const userText = await sttOpenAIFromWav(wav);
      console.log(`🗣️  STT: "${userText}"`);
      
      if (!userText || isTrivialUtterance(userText)) {
        console.log("⏭️  Trivial/empty utterance, skipping");
        if (reason === 'timeout') {
          await speakToUser("I didn't catch that. Could you repeat?");
        }
        return;
      }

      session.turnCount++;
      let replyText;
      
      // Extract slots with prompt awareness
      const found = extractSlotsFromUserText(userText, session.lastPrompt);
      Object.assign(session.slots, Object.fromEntries(
        Object.entries(found).filter(([_, v]) => v != null)
      ));

      const requiredDone = session.slots.name && session.slots.phone && 
                           session.slots.address && session.slots.symptoms;

      if (requiredDone) {
        replyText = `Got it. Name ${session.slots.name}. Phone ${session.slots.phone}. Address noted. Issue recorded.`;
        session.finalPayload = buildIntakePayload(session.slots, {});
      } else {
        const planned = nextPrompt(session.slots);
        session.lastPrompt = planned;
        replyText = await chatOpenAI(`${userText}\nPlanner says: ${planned}`, session.slots);
      }

      console.log(`📋 Slots:`, JSON.stringify(session.slots, null, 2));
      await speakToUser(replyText);

    } catch (e) {
      console.error("❌ Processing error:", e);
    } finally {
      processing = false;
    }
  }

  // VAD callbacks
  vad.setCallbacks({
    onUtteranceStart: () => {
      console.log("🎤 Utterance started");
      // Stop TTS if user starts speaking (barge-in)
      if (speaking) {
        console.log("🛑 Barge-in detected, stopping TTS");
        speaking = false;
      }
      currentUtteranceBuffer = [];
    },
    onUtteranceEnd: processUtterance,
    onHardFlush: () => {
      console.log("⚠️  Hard flush triggered");
    }
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        console.log("📞 Stream start:", data.start);
        
        // GREET IMMEDIATELY on connect (don't wait for silence)
        setTimeout(async () => {
          if (!greetingSent && ws.readyState === 1) {
            greetingSent = true;
            session.lastPrompt = "What's your name?";
            await speakToUser("Hello! I'm your HVAC service assistant. What's your name?");
          }
        }, 200);  // Small delay to ensure connection is stable
        
      } else if (data.event === "media") {
        // Ignore caller audio while we are speaking (half-duplex)
        if (!speaking && !processing) {
          const ulaw = Buffer.from(data.media.payload, "base64");
          const pcm = mulawToPCM16(ulaw);
          
          // Convert to Int16Array for VAD
          const int16Frame = new Int16Array(
            pcm.buffer,
            pcm.byteOffset,
            pcm.byteLength / 2
          );
          
          // Feed frame to VAD
          const { level, noise, isVoiced } = vad.ingestFrame(int16Frame);
          
          // If in speech state, accumulate audio
          if (vad.state === 'speech') {
            currentUtteranceBuffer.push(Buffer.from(pcm));
          }
        }
      } else if (data.event === "dtmf") {
        console.log("🔢 DTMF:", data.dtmf?.digit);
      } else if (data.event === "stop") {
        console.log("📴 Stream stop");
      }
    } catch (e) {
      console.error("❌ Message error:", e);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WebSocket closed");
    speaking = false;
    processing = false;
    currentUtteranceBuffer = [];
  });
});