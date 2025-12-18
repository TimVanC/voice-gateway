// server-simple.js - Simplified AI Receptionist
// OpenAI Realtime API only - No ElevenLabs, No validation, No integrations
// Focus: Natural speech, timing, realism

require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;

// OpenAI Realtime API - uses native G.711 μ-law, no conversion needed
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// Voice configuration - SINGLE SOURCE OF TRUTH
// Valid voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse
const OPENAI_VOICE = process.env.OPENAI_REALTIME_VOICE || "shimmer";

// Validate environment
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is required");
  process.exit(1);
}

// ============================================================================
// STATE MACHINE - Simple 5-step flow
// ============================================================================
const STATES = {
  GREETING: "greeting",
  ASK_NAME: "ask_name",
  ASK_PHONE: "ask_phone",
  ASK_EMAIL: "ask_email",
  CLOSING: "closing",
  ENDED: "ended"
};

// State transition logic
function getNextState(currentState) {
  switch (currentState) {
    case STATES.GREETING: return STATES.ASK_NAME;
    case STATES.ASK_NAME: return STATES.ASK_PHONE;
    case STATES.ASK_PHONE: return STATES.ASK_EMAIL;
    case STATES.ASK_EMAIL: return STATES.CLOSING;
    case STATES.CLOSING: return STATES.ENDED;
    default: return STATES.ENDED;
  }
}

// ============================================================================
// EXPRESS ROUTES
// ============================================================================

// Twilio webhook - returns TwiML to start media stream
app.post("/twilio/voice", (req, res) => {
  console.log("\n📞 Incoming call");
  console.log("From:", req.body.From ? req.body.From.replace(/(\d{3})\d{3}(\d{4})/, '$1***$2') : 'Unknown');
  
  const host = new URL(PUBLIC_BASE_URL).host;
  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  connect.stream({ url: `wss://${host}/media` });
  
  res.type("text/xml").send(response.toString());
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", mode: "simple", timestamp: new Date().toISOString() });
});

// ============================================================================
// SERVER SETUP
// ============================================================================
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("\n✨ Simple Voice Gateway Ready!");
  console.log(`📍 Webhook: ${PUBLIC_BASE_URL}/twilio/voice`);
  console.log(`🎙️ Using OpenAI Realtime API (voice: ${OPENAI_VOICE})`);
  console.log(`🎧 Waiting for calls...\n`);
});

server.keepAliveTimeout = 70000;
server.headersTimeout = 75000;

// ============================================================================
// WEBSOCKET SERVER - Handles Twilio Media Streams
// ============================================================================
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs, req) => {
  console.log("📞 New connection");
  
  let openaiWs = null;
  let streamSid = null;
  let callState = STATES.GREETING;
  let sessionReady = false;
  let responseInProgress = false;  // Track if OpenAI is generating a response
  
  // Audio pacing
  let playBuffer = Buffer.alloc(0);
  let paceTimer = null;
  
  // Collected data (just for logging, no export)
  const collectedData = {
    name: null,
    phone: null,
    email: null
  };

  // ============================================================================
  // CONNECT TO OPENAI REALTIME API
  // ============================================================================
  openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");
    
    // Configure session with natural conversation settings
    const sessionConfig = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `You are a friendly, natural-sounding receptionist named Sarah. You work for a home services company.

CRITICAL: You MUST speak ONLY in English. Never use any other language. All responses must be in English.

PERSONALITY:
- Warm, friendly, and genuinely conversational
- Speak naturally with varied intonation - not monotone
- Use contractions naturally (I'm, you're, we'll, that's)
- Add warmth with phrases like "Oh great!", "Perfect!", "Awesome!"
- Occasionally use light fillers like "So...", "Alright...", "Okay so..."
- Keep responses SHORT - one or two sentences max
- Sound genuinely interested and helpful

YOUR ONLY JOB:
1. Greet the caller warmly and ask their name
2. Get their phone number  
3. Get their email address
4. Thank them warmly and end the call

RULES:
- ALWAYS speak in English only
- Ask for ONE piece of info at a time
- Confirm what you heard with enthusiasm ("Got it, John Smith - nice to meet you!")
- If something is unclear, ask naturally ("Sorry, I didn't quite catch that - could you say it one more time?")
- Keep it simple, warm, and friendly
- Sound like a real person having a pleasant conversation
- Don't be overly formal - be casual and personable

EXAMPLE PHRASES:
- "Hi there! Thanks so much for calling. I'm Sarah - who do I have the pleasure of speaking with?"
- "Oh awesome, nice to meet you [name]! So what's the best number to reach you at?"
- "Perfect, got it! And what's your email?"
- "Great, thanks so much [name]! We'll be in touch real soon. You have a wonderful day!"`,
        voice: OPENAI_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "whisper-1"
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,           // Higher = less sensitive to background noise
          prefix_padding_ms: 400,   // More padding before speech
          silence_duration_ms: 700  // Wait longer to confirm speech ended
        },
        temperature: 0.9,           // More variation = more natural
        max_response_output_tokens: 200
      }
    };
    
    openaiWs.send(JSON.stringify(sessionConfig));
  });

  // ============================================================================
  // AUDIO PACING - Send audio to Twilio at correct rate
  // ============================================================================
  function pumpFrames() {
    if (paceTimer) return;
    
    const silenceFrame = Buffer.alloc(160, 0xFF);  // μ-law silence
    let startTime = process.hrtime.bigint();
    let frameCount = 0;
    
    function sendNextFrame() {
      if (twilioWs.readyState !== WebSocket.OPEN) {
        paceTimer = null;
        return;
      }
      
      let chunk;
      if (playBuffer.length >= 160) {
        chunk = playBuffer.subarray(0, 160);
        playBuffer = playBuffer.subarray(160);
      } else if (playBuffer.length > 0) {
        chunk = Buffer.concat([playBuffer, silenceFrame.subarray(0, 160 - playBuffer.length)]);
        playBuffer = Buffer.alloc(0);
      } else {
        chunk = silenceFrame;
      }
      
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: { payload: chunk.toString('base64') }
      }));
      
      frameCount++;
      const expectedTime = startTime + BigInt(frameCount * 20_000_000);
      const currentTime = process.hrtime.bigint();
      const drift = Number(expectedTime - currentTime) / 1_000_000;
      const nextDelay = Math.max(1, Math.min(40, Math.round(20 + drift)));
      paceTimer = setTimeout(sendNextFrame, nextDelay);
    }
    
    paceTimer = setTimeout(sendNextFrame, 20);
  }

  // ============================================================================
  // HANDLE OPENAI MESSAGES
  // ============================================================================
  openaiWs.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());
      
      switch (event.type) {
        case "session.created":
          console.log("🎯 Session created:", event.session.id);
          break;
          
        case "session.updated":
          console.log("✅ Session configured");
          sessionReady = true;
          break;
          
        case "response.audio.delta":
          if (event.delta) {
            const audioData = Buffer.from(event.delta, 'base64');
            playBuffer = Buffer.concat([playBuffer, audioData]);
          }
          break;
          
        case "response.audio.done":
          console.log("🔊 Audio complete");
          responseInProgress = false;
          break;
          
        case "input_audio_buffer.speech_started":
          console.log("🎤 User speaking...");
          // Clear any pending audio when user starts speaking (barge-in)
          playBuffer = Buffer.alloc(0);
          responseInProgress = false;  // Cancel any pending response
          break;
          
        case "input_audio_buffer.speech_stopped":
          console.log("🔇 User stopped speaking");
          // OpenAI will automatically generate a response via server VAD
          responseInProgress = true;
          break;
          
        case "conversation.item.input_audio_transcription.completed":
          if (event.transcript) {
            const transcript = event.transcript.trim();
            console.log(`📝 User said: "${transcript}"`);
            
            // Simple state tracking based on what we collected
            if (callState === STATES.ASK_NAME && transcript.length > 0) {
              collectedData.name = transcript;
              console.log(`📋 Name: ${transcript}`);
              callState = getNextState(callState);
            } else if (callState === STATES.ASK_PHONE && /\d/.test(transcript)) {
              collectedData.phone = transcript;
              console.log(`📋 Phone: ${transcript}`);
              callState = getNextState(callState);
            } else if (callState === STATES.ASK_EMAIL && transcript.includes('@')) {
              collectedData.email = transcript;
              console.log(`📋 Email: ${transcript}`);
              callState = getNextState(callState);
            }
          }
          break;
          
        case "response.done":
          console.log("✅ Response complete");
          responseInProgress = false;
          
          // Advance state after greeting
          if (callState === STATES.GREETING) {
            callState = STATES.ASK_NAME;
            console.log(`📍 State: ${callState}`);
          }
          break;
          
        case "error":
          console.error("❌ OpenAI error:", event.error);
          break;
      }
    } catch (err) {
      console.error("❌ Error processing OpenAI message:", err);
    }
  });

  openaiWs.on("error", (error) => {
    console.error("❌ OpenAI WebSocket error:", error);
  });

  openaiWs.on("close", () => {
    console.log("🔌 OpenAI disconnected");
    if (paceTimer) {
      clearTimeout(paceTimer);
      paceTimer = null;
    }
  });

  // ============================================================================
  // HANDLE TWILIO MESSAGES
  // ============================================================================
  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());
      
      switch (msg.event) {
        case "start":
          streamSid = msg.start.streamSid;
          console.log("📞 Stream started:", streamSid);
          pumpFrames();
          
          // Trigger greeting once stream is ready
          if (sessionReady) {
            triggerGreeting();
          } else {
            // Wait for session to be ready
            const checkReady = setInterval(() => {
              if (sessionReady) {
                clearInterval(checkReady);
                triggerGreeting();
              }
            }, 50);
          }
          break;
          
        case "media":
          // Forward audio to OpenAI
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN && sessionReady) {
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload
            }));
          }
          break;
          
        case "stop":
          console.log("📴 Stream stopped");
          console.log("\n📋 Call Summary:");
          console.log("  Name:", collectedData.name || "(not collected)");
          console.log("  Phone:", collectedData.phone || "(not collected)");
          console.log("  Email:", collectedData.email || "(not collected)");
          console.log("");
          
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          if (paceTimer) {
            clearTimeout(paceTimer);
            paceTimer = null;
          }
          break;
      }
    } catch (err) {
      console.error("❌ Error processing Twilio message:", err);
    }
  });
  
  function triggerGreeting() {
    console.log("👋 Sending greeting");
    responseInProgress = true;
    
    // Let OpenAI generate the greeting naturally
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Greet the caller warmly and enthusiastically IN ENGLISH. Ask for their name. Be natural, warm and friendly. Example: 'Hi there! Thanks so much for calling. I'm Sarah - who do I have the pleasure of speaking with today?'"
        }
      }));
    }
  }

  twilioWs.on("close", () => {
    console.log("🔌 Twilio disconnected");
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
    if (paceTimer) {
      clearTimeout(paceTimer);
      paceTimer = null;
    }
  });

  twilioWs.on("error", (error) => {
    console.error("❌ Twilio WebSocket error:", error);
  });
});

console.log("🚀 Simple Voice Gateway initializing...");

