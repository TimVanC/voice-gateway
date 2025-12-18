// server-simple.js - Simplified AI Receptionist
// OpenAI Realtime API only - No ElevenLabs, No validation, No integrations
// Focus: Natural speech, timing, realism

require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const twilio = require("twilio");

// ============================================================================
// PROCESS-LEVEL ERROR HANDLERS - Catch crashes
// ============================================================================
process.on('uncaughtException', (err) => {
  console.error('💀 UNCAUGHT EXCEPTION:', err);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💀 UNHANDLED REJECTION:', reason);
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received - shutting down');
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received - shutting down');
});

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

// Process heartbeat - proves the event loop is still running
let heartbeatCount = 0;
setInterval(() => {
  heartbeatCount++;
  // Only log every minute to avoid spam
  if (heartbeatCount % 6 === 0) {
    console.log(`💗 Process heartbeat #${heartbeatCount} - event loop alive`);
  }
}, 10000);

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
  let keepAliveTimer = null;
  let lastActivityTime = Date.now();
  
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
          threshold: 0.75,          // Balanced - ignore noise but allow real interruptions
          prefix_padding_ms: 500,   // Padding before speech detection
          silence_duration_ms: 800  // Wait to confirm speech ended
        },
        temperature: 0.9,           // More variation = more natural
        max_response_output_tokens: 1000  // High ceiling, only pay for what's actually used
      }
    };
    
    openaiWs.send(JSON.stringify(sessionConfig));
    
    // Start keep-alive ping every 20 seconds
    keepAliveTimer = setInterval(() => {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        // Send a ping to keep connection alive
        try {
          openaiWs.ping();
          const stallTime = Date.now() - lastActivityTime;
          console.log(`💓 Keep-alive ping (last activity: ${stallTime}ms ago, state: ${callState})`);
          
          // Warn if no activity for a while
          if (stallTime > 10000) {
            console.warn(`⚠️ No OpenAI activity for ${stallTime}ms!`);
          }
        } catch (e) {
          console.error("❌ Keep-alive ping failed:", e.message);
        }
      } else {
        console.warn("⚠️ Keep-alive: OpenAI WS not open");
      }
    }, 20000);
  });
  
  openaiWs.on("pong", () => {
    lastActivityTime = Date.now();
  });

  // ============================================================================
  // AUDIO PACING - Send audio to Twilio at correct rate
  // ============================================================================
  let audioFramesSent = 0;
  
  function pumpFrames() {
    if (paceTimer) {
      console.log("⚠️ pumpFrames already running");
      return;
    }
    
    console.log("🎵 Starting audio pump");
    const silenceFrame = Buffer.alloc(160, 0xFF);  // μ-law silence
    let startTime = process.hrtime.bigint();
    let frameCount = 0;
    
    function sendNextFrame() {
      if (twilioWs.readyState !== WebSocket.OPEN) {
        console.log("⚠️ Twilio WS not open, stopping pump");
        paceTimer = null;
        return;
      }
      
      let chunk;
      let hasAudio = false;
      if (playBuffer.length >= 160) {
        chunk = playBuffer.subarray(0, 160);
        playBuffer = playBuffer.subarray(160);
        hasAudio = true;
      } else if (playBuffer.length > 0) {
        chunk = Buffer.concat([playBuffer, silenceFrame.subarray(0, 160 - playBuffer.length)]);
        playBuffer = Buffer.alloc(0);
        hasAudio = true;
      } else {
        chunk = silenceFrame;
      }
      
      try {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: chunk.toString('base64') }
        }));
        audioFramesSent++;
        
        // Log every 250 frames (~5 seconds) OR when buffer has audio
        if (audioFramesSent % 250 === 0) {
          console.log(`🔈 Audio frames sent: ${audioFramesSent}, buffer: ${playBuffer.length} bytes`);
        }
      } catch (e) {
        console.error("❌ Error sending audio to Twilio:", e.message);
        console.error("❌ Error details:", e.stack);
        paceTimer = null;
        return;
      }
      
      frameCount++;
      const expectedTime = startTime + BigInt(frameCount * 20_000_000);
      const currentTime = process.hrtime.bigint();
      const drift = Number(expectedTime - currentTime) / 1_000_000;
      const nextDelay = Math.max(1, Math.min(40, Math.round(20 + drift)));
      
      try {
        paceTimer = setTimeout(sendNextFrame, nextDelay);
      } catch (e) {
        console.error("❌ setTimeout failed:", e.message);
      }
    }
    
    try {
      paceTimer = setTimeout(sendNextFrame, 20);
    } catch (e) {
      console.error("❌ Initial setTimeout failed:", e.message);
    }
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
          lastActivityTime = Date.now();
          if (event.delta) {
            const audioData = Buffer.from(event.delta, 'base64');
            playBuffer = Buffer.concat([playBuffer, audioData]);
            // Log occasionally to show audio is streaming
            if (playBuffer.length % 5000 < 200) {
              console.log(`🎵 Audio streaming: ${playBuffer.length} bytes buffered`);
            }
          }
          break;
          
        case "response.audio.done":
          console.log(`🔊 Audio complete (buffer: ${playBuffer.length} bytes)`);
          responseInProgress = false;
          break;
          
        case "response.audio_transcript.done":
          if (event.transcript) {
            console.log(`📜 AI said: "${event.transcript}"`);
          }
          break;
          
        case "input_audio_buffer.speech_started":
          console.log("🎤 User speaking...");
          // DON'T immediately clear buffer - this causes "ghost sound" interruptions
          // Let the AI audio keep playing. When OpenAI sends a new response,
          // the response.created event will clear the buffer.
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
            } else if (callState === STATES.ASK_EMAIL && (transcript.includes('@') || /\bat\b/i.test(transcript))) {
              // Handle both "@" symbol and spoken "at" (e.g., "tim at gmail.com")
              collectedData.email = transcript;
              console.log(`📋 Email: ${transcript}`);
              callState = getNextState(callState);
            }
          }
          break;
          
        case "response.done":
          // Check if response was cancelled/interrupted
          const status = event.response?.status;
          if (status === "cancelled") {
            console.log(`⚠️ Response CANCELLED (interrupted by speech detection)`);
          } else if (status === "incomplete") {
            console.log(`⚠️ Response INCOMPLETE (may have been cut off)`);
          } else {
            console.log(`✅ Response complete (state: ${callState})`);
          }
          responseInProgress = false;
          lastActivityTime = Date.now();
          
          // Advance state after greeting
          if (callState === STATES.GREETING) {
            callState = STATES.ASK_NAME;
            console.log(`📍 State: ${callState}`);
          }
          break;
          
        case "rate_limits.updated":
          // Ignore rate limit updates
          break;
          
        case "error":
          console.error("❌ OpenAI error:", event.error);
          break;
          
        case "response.created":
          console.log(`🚀 Response started (id: ${event.response?.id})`);
          // Clear buffer here - this is when we KNOW a new response is coming
          // (instead of clearing on speech_started which can be triggered by ghost sounds)
          playBuffer = Buffer.alloc(0);
          responseInProgress = true;
          break;
          
        default:
          // Log unhandled events for debugging
          if (!['response.audio.delta', 'response.text.delta', 'response.content_part.added', 
                'response.output_item.added', 'conversation.item.created',
                'input_audio_buffer.committed', 'response.content_part.done', 'response.output_item.done',
                'conversation.item.input_audio_transcription.delta', 'response.audio_transcript.delta'].includes(event.type)) {
            console.log(`📨 Event: ${event.type}`);
          }
          break;
      }
    } catch (err) {
      console.error("❌ Error processing OpenAI message:", err);
    }
  });

  openaiWs.on("error", (error) => {
    console.error("❌ OpenAI WebSocket error:", error);
  });

  openaiWs.on("close", (code, reason) => {
    console.log(`🔌 OpenAI disconnected (code: ${code}, reason: ${reason || 'none'})`);
    if (paceTimer) {
      clearTimeout(paceTimer);
      paceTimer = null;
    }
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
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
          console.log("📞 Stream config:", JSON.stringify(msg.start, null, 2));
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
          console.log("  Final state:", callState);
          console.log("");
          
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          if (paceTimer) {
            clearTimeout(paceTimer);
            paceTimer = null;
          }
          if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
          }
          break;
          
        case "mark":
          // Twilio mark event - ignore
          break;
          
        default:
          console.log(`📨 Twilio event: ${msg.event}`);
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

  twilioWs.on("close", (code, reason) => {
    console.log(`🔌 Twilio disconnected (code: ${code}, reason: ${reason || 'none'})`);
    console.log("  Final state:", callState);
    console.log("  Data collected:", JSON.stringify(collectedData));
    
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
    if (paceTimer) {
      clearTimeout(paceTimer);
      paceTimer = null;
    }
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  });

  twilioWs.on("error", (error) => {
    console.error("❌ Twilio WebSocket error:", error);
  });
});

console.log("🚀 Simple Voice Gateway initializing...");

