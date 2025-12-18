/**
 * RSE Energy Group - AI Receptionist Server
 * 
 * OpenAI Realtime + Twilio Media Streams
 * Full intake flow with state machine and backchanneling
 */

require("dotenv").config();

const express = require("express");
const { WebSocket, WebSocketServer } = require("ws");
const http = require("http");

// ============================================================================
// IMPORTS
// ============================================================================
const { SYSTEM_PROMPT, GREETING, STATES, INTENT_TYPES } = require('./scripts/rse-script');
const { VAD_CONFIG, BACKCHANNEL_CONFIG, SILENCE_CONFIG } = require('./config/vad-config');
const { createCallStateMachine } = require('./state/call-state-machine');
const { createBackchannelManager, createMicroResponsePayload } = require('./utils/backchannel');

// ============================================================================
// CONFIGURATION
// ============================================================================
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_VOICE = process.env.OPENAI_REALTIME_VOICE || "shimmer";
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// Validate API key
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY environment variable");
  process.exit(1);
}

// ============================================================================
// SERVER SETUP
// ============================================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ============================================================================
// HEALTH ENDPOINT
// ============================================================================
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    service: "RSE Voice Gateway",
    voice: OPENAI_VOICE
  });
});

// ============================================================================
// TWILIO WEBHOOK - RETURNS TWIML TO START STREAM
// ============================================================================
app.post("/twilio/voice", (req, res) => {
  console.log("\n📞 Incoming call");
  console.log(`From: ${req.body.From?.replace(/(\d{3})\d{4}(\d{4})/, '$1***$2') || 'Unknown'}`);
  
  const host = req.headers.host;
  const protocol = host?.includes("localhost") ? "ws" : "wss";
  
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${protocol}://${host}/stream">
      <Parameter name="callerNumber" value="${req.body.From || ''}" />
    </Stream>
  </Connect>
</Response>`);
});

// ============================================================================
// WEBSOCKET HANDLER - MAIN CALL LOGIC
// ============================================================================
wss.on("connection", (twilioWs, req) => {
  console.log("📞 New connection");
  
  // ============================================================================
  // CALL SESSION STATE
  // ============================================================================
  let streamSid = null;
  let openaiWs = null;
  let paceTimer = null;
  let keepAliveTimer = null;
  let silenceTimer = null;
  let lastActivityTime = Date.now();
  
  // Audio buffer for pacing
  let playBuffer = Buffer.alloc(0);
  let responseInProgress = false;
  let audioStreamingStarted = false;
  
  // State machine for this call
  const stateMachine = createCallStateMachine();
  
  // Backchannel manager for this call
  const backchannel = createBackchannelManager();
  
  // ============================================================================
  // AUDIO PACING - Send audio to Twilio at correct rate
  // ============================================================================
  function pumpFrames() {
    const FRAME_SIZE = 160;  // 20ms of 8kHz audio
    const FRAME_INTERVAL = 20;
    
    paceTimer = setInterval(() => {
      if (playBuffer.length >= FRAME_SIZE && streamSid && twilioWs.readyState === WebSocket.OPEN) {
        const frame = playBuffer.slice(0, FRAME_SIZE);
        playBuffer = playBuffer.slice(FRAME_SIZE);
        
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: frame.toString("base64") }
        }));
      }
    }, FRAME_INTERVAL);
  }
  
  // ============================================================================
  // CONNECT TO OPENAI REALTIME API
  // ============================================================================
  function connectToOpenAI() {
    openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });
    
    openaiWs.on("open", () => {
      console.log("✅ Connected to OpenAI Realtime");
      
      // Configure session
      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: SYSTEM_PROMPT,
          voice: OPENAI_VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: {
            model: "whisper-1"
          },
          turn_detection: {
            type: "server_vad",
            threshold: VAD_CONFIG.threshold,
            prefix_padding_ms: VAD_CONFIG.prefix_padding_ms,
            silence_duration_ms: VAD_CONFIG.silence_duration_ms
          },
          temperature: 0.8,
          max_response_output_tokens: 1000
        }
      };
      
      openaiWs.send(JSON.stringify(sessionConfig));
    });
    
    openaiWs.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        handleOpenAIEvent(event);
      } catch (err) {
        console.error("❌ Error parsing OpenAI message:", err);
      }
    });
    
    openaiWs.on("close", (code, reason) => {
      console.log(`🔌 OpenAI disconnected (code: ${code}, reason: ${reason || 'none'})`);
    });
    
    openaiWs.on("error", (err) => {
      console.error("❌ OpenAI WebSocket error:", err.message);
    });
    
    // Keep-alive ping every 20 seconds
    keepAliveTimer = setInterval(() => {
      if (openaiWs?.readyState === WebSocket.OPEN) {
        const elapsed = Date.now() - lastActivityTime;
        console.log(`💓 Keep-alive (last activity: ${elapsed}ms ago, state: ${stateMachine.getState()})`);
        
        if (elapsed > 10000) {
          console.error(`⚠️ No OpenAI activity for ${elapsed}ms!`);
        }
        
        openaiWs.ping();
      }
    }, 20000);
  }
  
  // ============================================================================
  // HANDLE OPENAI EVENTS
  // ============================================================================
  function handleOpenAIEvent(event) {
    lastActivityTime = Date.now();
    
    switch (event.type) {
      case "session.created":
        console.log(`🎯 Session created: ${event.session?.id}`);
        break;
        
      case "session.updated":
        console.log("✅ Session configured");
        // Send greeting
        sendGreeting();
        break;
        
      case "response.created":
        console.log(`🚀 Response started (id: ${event.response?.id})`);
        playBuffer = Buffer.alloc(0);
        responseInProgress = true;
        audioStreamingStarted = false;
        
        // Cancel backchannel timer - real response is coming
        backchannel.cancel();
        break;
        
      case "response.audio.delta":
        if (event.delta) {
          // Stop backchannel if it was playing
          if (backchannel.isPlaying()) {
            backchannel.stop();
            playBuffer = Buffer.alloc(0); // Clear backchannel audio
          }
          
          audioStreamingStarted = true;
          const audioData = Buffer.from(event.delta, "base64");
          playBuffer = Buffer.concat([playBuffer, audioData]);
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
        
      case "response.done":
        const status = event.response?.status;
        if (status === "cancelled") {
          console.log(`⚠️ Response CANCELLED`);
        } else if (status === "incomplete") {
          console.log(`⚠️ Response INCOMPLETE`);
        } else {
          console.log(`✅ Response complete (state: ${stateMachine.getState()})`);
        }
        responseInProgress = false;
        break;
        
      case "input_audio_buffer.speech_started":
        console.log("🎤 User speaking...");
        break;
        
      case "input_audio_buffer.speech_stopped":
        console.log("🔇 User stopped speaking");
        
        // Start backchannel timer
        if (BACKCHANNEL_CONFIG.enabled) {
          const context = getBackchannelContext();
          backchannel.start((microResponse) => {
            console.log(`💬 Backchannel: "${microResponse}"`);
            sendMicroResponse(microResponse);
          }, context);
        }
        break;
        
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          const transcript = event.transcript.trim();
          console.log(`📝 User said: "${transcript}"`);
          
          // Process through state machine
          processUserInput(transcript);
        }
        break;
        
      case "error":
        console.error(`❌ OpenAI error: ${event.error?.message || JSON.stringify(event.error)}`);
        break;
        
      case "rate_limits.updated":
        // Ignore
        break;
        
      default:
        // Log unknown events for debugging
        if (!['response.text.delta', 'response.output_item.added', 
              'response.output_item.done', 'response.content_part.added',
              'response.content_part.done', 'input_audio_buffer.committed',
              'conversation.item.created'].includes(event.type)) {
          console.log(`📨 OpenAI event: ${event.type}`);
        }
    }
  }
  
  // ============================================================================
  // SEND GREETING
  // ============================================================================
  function sendGreeting() {
    console.log("👋 Sending greeting");
    
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Greet the caller with EXACTLY this greeting (speak naturally, warmly): "${GREETING.primary}"`,
        max_output_tokens: 100
      }
    }));
    
    // Start silence timer for greeting fallback
    silenceTimer = setTimeout(() => {
      if (stateMachine.getState() === STATES.GREETING) {
        console.log("⏰ Silence after greeting - sending fallback");
        stateMachine.setSilenceAfterGreeting();
        
        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: `The caller hasn't responded. Say EXACTLY: "${GREETING.silence_fallback}"`,
            max_output_tokens: 100
          }
        }));
      }
    }, SILENCE_CONFIG.greeting_fallback_seconds * 1000);
  }
  
  // ============================================================================
  // SEND MICRO-RESPONSE (backchannel)
  // ============================================================================
  function sendMicroResponse(phrase) {
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(createMicroResponsePayload(phrase)));
    }
  }
  
  // ============================================================================
  // GET BACKCHANNEL CONTEXT
  // ============================================================================
  function getBackchannelContext() {
    const state = stateMachine.getState();
    
    if (state === STATES.CONFIRMATION) {
      return 'before_confirmation';
    }
    if ([STATES.NAME, STATES.PHONE, STATES.EMAIL, STATES.ADDRESS].includes(state)) {
      return 'after_capture';
    }
    return 'general';
  }
  
  // ============================================================================
  // PROCESS USER INPUT THROUGH STATE MACHINE
  // ============================================================================
  function processUserInput(transcript) {
    // Clear silence timer if still active
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    
    const currentState = stateMachine.getState();
    const lowerTranscript = transcript.toLowerCase();
    
    // Intent classification for greeting/intent states
    let analysis = {};
    if (currentState === STATES.GREETING || currentState === STATES.INTENT) {
      analysis.intent = classifyIntent(lowerTranscript);
    }
    
    // Process through state machine
    const result = stateMachine.processInput(transcript, analysis);
    
    // Generate appropriate response based on state machine result
    if (result.prompt) {
      sendStatePrompt(result.prompt);
    } else if (result.action === 'classify_intent' || result.action === 'answer_question' || result.action === 'handle_correction') {
      // Let the model generate a natural response
      sendNaturalResponse(transcript, result.action);
    }
  }
  
  // ============================================================================
  // INTENT CLASSIFICATION
  // ============================================================================
  function classifyIntent(text) {
    // Service/repair keywords
    if (/\b(repair|fix|broken|not working|service|problem|issue|no heat|no cool|noise|leak|frozen|won't start)\b/.test(text)) {
      if (/\b(generator|generac|cummins|backup power)\b/.test(text)) {
        return INTENT_TYPES.GENERATOR;
      }
      return INTENT_TYPES.HVAC_SERVICE;
    }
    
    // Generator keywords
    if (/\b(generator|generac|cummins|backup power|standby|whole house)\b/.test(text)) {
      return INTENT_TYPES.GENERATOR;
    }
    
    // Membership keywords
    if (/\b(membership|member|plan|maintenance|home comfort|tune up|annual|monthly)\b/.test(text)) {
      return INTENT_TYPES.MEMBERSHIP;
    }
    
    // Existing project keywords
    if (/\b(existing|current|in progress|follow up|following up|scheduled|appointment|job|project|quote|estimate you gave)\b/.test(text)) {
      return INTENT_TYPES.EXISTING_PROJECT;
    }
    
    // Estimate/new installation
    if (/\b(estimate|quote|new|install|replace|upgrade|cost|price)\b/.test(text)) {
      if (/\b(generator)\b/.test(text)) {
        return INTENT_TYPES.GENERATOR;
      }
      return INTENT_TYPES.HVAC_SERVICE; // Default to HVAC for general estimates
    }
    
    return INTENT_TYPES.OTHER;
  }
  
  // ============================================================================
  // SEND STATE PROMPT
  // ============================================================================
  function sendStatePrompt(prompt) {
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Respond naturally and briefly. Say something like: "${prompt}" - but make it sound natural, not robotic. Keep it SHORT - one or two sentences max.`,
          max_output_tokens: 200
        }
      }));
    }
  }
  
  // ============================================================================
  // SEND NATURAL RESPONSE (let model generate)
  // ============================================================================
  function sendNaturalResponse(userInput, action) {
    if (openaiWs?.readyState !== WebSocket.OPEN) return;
    
    const state = stateMachine.getState();
    const data = stateMachine.getData();
    
    let instruction = '';
    
    if (action === 'classify_intent') {
      instruction = `The caller just said: "${userInput}". 
Determine what they need help with and respond appropriately:
- If it's about HVAC service/repair, ask clarifying questions
- If it's about generators, ask if it's existing or new installation
- If it's about membership/plans, acknowledge and ask about coverage
- If it's about an existing project, ask which site/job

Keep your response SHORT - one sentence, then ask ONE question to clarify.`;
    } else if (action === 'answer_question') {
      instruction = `The caller asked: "${userInput}".
Answer their question briefly and helpfully based on what you know about RSE Energy Group.
Keep it SHORT - one or two sentences.
If you don't know something specific, say "I can take your info and someone will follow up with those details."`;
    } else if (action === 'handle_correction') {
      instruction = `The caller is correcting something. They said: "${userInput}".
Current info we have:
- Name: ${data.name || 'not yet collected'}
- Phone: ${data.phone || 'not yet collected'}
- Email: ${data.email || 'not yet collected'}
- Address: ${data.address || 'not yet collected'}

Ask them what needs to be corrected, update it, then read back the corrected info.
Keep it brief and natural.`;
    }
    
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: instruction,
        max_output_tokens: 300
      }
    }));
  }
  
  // ============================================================================
  // HANDLE TWILIO MESSAGES
  // ============================================================================
  twilioWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      switch (msg.event) {
        case "connected":
          console.log("📨 Twilio event: connected");
          break;
          
        case "start":
          streamSid = msg.start.streamSid;
          console.log(`📞 Stream started: ${streamSid}`);
          console.log(`📞 Stream config:`, JSON.stringify(msg.start, null, 2));
          
          // Store caller number if provided
          if (msg.start.customParameters?.callerNumber) {
            stateMachine.updateData('phone', msg.start.customParameters.callerNumber);
          }
          
          // Start audio pump
          console.log("🎵 Starting audio pump");
          pumpFrames();
          
          // Connect to OpenAI
          connectToOpenAI();
          break;
          
        case "media":
          // Forward audio to OpenAI
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload
            }));
          }
          break;
          
        case "stop":
          console.log("📞 Stream stopped");
          cleanup();
          break;
      }
    } catch (err) {
      console.error("❌ Error processing Twilio message:", err);
    }
  });
  
  twilioWs.on("close", (code, reason) => {
    console.log(`🔌 Twilio disconnected (code: ${code})`);
    cleanup();
  });
  
  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WebSocket error:", err.message);
  });
  
  // ============================================================================
  // CLEANUP
  // ============================================================================
  function cleanup() {
    // Log collected data before cleanup
    const data = stateMachine.getData();
    console.log("📋 Call data collected:", JSON.stringify(data, null, 2));
    
    if (paceTimer) clearInterval(paceTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    backchannel.cancel();
    
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  }
});

// ============================================================================
// START SERVER
// ============================================================================
server.listen(PORT, () => {
  console.log(`🚀 RSE Voice Gateway initializing...`);
  console.log();
  console.log(`✨ RSE Energy Group Receptionist Ready!`);
  console.log(`📍 Webhook: https://<your-domain>/twilio/voice`);
  console.log(`🎙️ Using OpenAI Realtime API (voice: ${OPENAI_VOICE})`);
  console.log(`⚙️ VAD: threshold=${VAD_CONFIG.threshold}, silence=${VAD_CONFIG.silence_duration_ms}ms`);
  console.log(`🎧 Waiting for calls...`);
  console.log();
});

// ============================================================================
// PROCESS-LEVEL ERROR HANDLING
// ============================================================================
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection:', reason);
});

// Heartbeat
setInterval(() => {
  console.log(`💗 Process heartbeat - event loop alive`);
}, 30000);

