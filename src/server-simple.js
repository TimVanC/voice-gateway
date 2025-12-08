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

// Validate environment
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is required");
  process.exit(1);
}

// ============================================================================
// MICRO-RESPONSE LIBRARY - Pre-encoded μ-law audio for instant backchanneling
// These are ~0.5-1 second phrases that play while waiting for OpenAI
// ============================================================================
const MICRO_RESPONSES = [
  "Okay, one moment.",
  "Got it, one sec.",
  "Alright, let me see.",
  "Mm-hmm, okay.",
  "Sure thing.",
];

// Track which micro-response to use next (round-robin)
let microResponseIndex = 0;

function getNextMicroResponse() {
  const phrase = MICRO_RESPONSES[microResponseIndex];
  microResponseIndex = (microResponseIndex + 1) % MICRO_RESPONSES.length;
  return phrase;
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
  console.log(`🎙️ Using OpenAI Realtime API (voice: shimmer)`);
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
  
  // Backchanneling state
  let speechEndTime = null;
  let backchannelTimer = null;
  let backchannelPlayed = false;
  let audioStreaming = false;
  
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

PERSONALITY:
- Warm, casual, and conversational
- Use natural speech patterns with occasional "um," "okay," "alright"
- Keep responses SHORT - one or two sentences max
- Sound like a real person, not a robot
- Add small acknowledgments like "Great!" or "Perfect!"

YOUR ONLY JOB:
1. Greet the caller warmly
2. Get their first and last name
3. Get their phone number  
4. Get their email address
5. Thank them and end the call

RULES:
- Ask for ONE piece of info at a time
- Confirm what you heard naturally ("Got it, John Smith")
- If unclear, ask them to repeat casually ("Sorry, could you say that again?")
- Keep it simple and friendly
- No technical jargon, no complex sentences
- Sound natural, like you're having a real conversation

EXAMPLE FLOW:
"Hi there! Thanks for calling. My name's Sarah. Who am I speaking with today?"
[User: John Smith]
"Great, nice to meet you John! And what's the best number to reach you?"
[User: 555-123-4567]
"Got it. And your email address?"
[User: john@email.com]
"Perfect! Thanks so much John. We'll be in touch soon. Have a great day!"`,
        voice: "shimmer",  // Natural female voice
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "whisper-1"
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500  // Faster response
        },
        temperature: 0.8,
        max_response_output_tokens: 150  // Keep responses short
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
  // BACKCHANNELING - Play quick filler while waiting for OpenAI
  // ============================================================================
  function startBackchannelTimer() {
    // Clear any existing timer
    if (backchannelTimer) {
      clearTimeout(backchannelTimer);
    }
    
    backchannelPlayed = false;
    audioStreaming = false;
    
    // Start timer - if no audio in 200ms, play micro-response
    backchannelTimer = setTimeout(() => {
      if (!audioStreaming && !backchannelPlayed) {
        playMicroResponse();
      }
    }, 200);  // 200ms delay before backchanneling
  }
  
  function playMicroResponse() {
    if (backchannelPlayed || audioStreaming) return;
    
    backchannelPlayed = true;
    const phrase = getNextMicroResponse();
    console.log(`💬 Backchannel: "${phrase}"`);
    
    // Send micro-response to OpenAI for quick TTS
    // This uses the same voice for consistency
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: `Say exactly this in a casual, quick way: "${phrase}"`
        }
      }));
    }
  }
  
  function cancelBackchannel() {
    if (backchannelTimer) {
      clearTimeout(backchannelTimer);
      backchannelTimer = null;
    }
    audioStreaming = true;
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
          // Audio streaming from OpenAI - cancel backchannel timer
          cancelBackchannel();
          
          if (event.delta) {
            const audioData = Buffer.from(event.delta, 'base64');
            playBuffer = Buffer.concat([playBuffer, audioData]);
          }
          break;
          
        case "response.audio.done":
          console.log("🔊 Audio complete");
          break;
          
        case "input_audio_buffer.speech_started":
          console.log("🎤 User speaking...");
          // Clear any pending audio when user starts speaking (barge-in)
          playBuffer = Buffer.alloc(0);
          break;
          
        case "input_audio_buffer.speech_stopped":
          console.log("🔇 User stopped speaking");
          // Start backchannel timer
          startBackchannelTimer();
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
    
    // Let OpenAI generate the greeting naturally
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Greet the caller warmly and ask for their name. Be natural and friendly. Keep it short - just a greeting and ask who you're speaking with."
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
    if (backchannelTimer) {
      clearTimeout(backchannelTimer);
      backchannelTimer = null;
    }
  });

  twilioWs.on("error", (error) => {
    console.error("❌ Twilio WebSocket error:", error);
  });
});

console.log("🚀 Simple Voice Gateway initializing...");

