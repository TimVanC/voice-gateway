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
const { VAD_CONFIG, BACKCHANNEL_CONFIG, LONG_SPEECH_CONFIG, FILLER_CONFIG, SILENCE_CONFIG } = require('./config/vad-config');
const { createCallStateMachine } = require('./state/call-state-machine');
const { createBackchannelManager, createMicroResponsePayload } = require('./utils/backchannel');

// ============================================================================
// CONFIGURATION
// ============================================================================
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// Voice configuration
// Primary: coral, Fallback: shimmer
const OPENAI_VOICE_PRIMARY = process.env.OPENAI_REALTIME_VOICE || "coral";
const OPENAI_VOICE_FALLBACK = "shimmer";

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
    voice: OPENAI_VOICE_PRIMARY,
    fallback_voice: OPENAI_VOICE_FALLBACK
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
  // CHATGPT-STYLE TURN-TAKING STATE
  // ============================================================================
  let speechStartTime = null;         // When caller started speaking
  let longSpeechTimer = null;         // Timer for long-speech backchanneling
  let longSpeechBackchannelSent = false;  // Only one backchannel per turn
  let assistantTurnCount = 0;         // Track turns for filler spacing
  
  // ============================================================================
  // VOICE SELECTION (one voice per call, no changes mid-call)
  // ============================================================================
  let callVoice = OPENAI_VOICE_PRIMARY;  // Start with primary, fallback on error
  let voiceInitialized = false;          // Prevent re-initialization
  let currentSilenceDuration = VAD_CONFIG.silence_default;  // Dynamic silence
  
  // ============================================================================
  // GREETING SILENCE FALLBACK
  // ============================================================================
  let greetingSilenceTimer = null;       // Timer for greeting silence fallback
  let awaitingFirstResponse = false;     // True after greeting, until user speaks
  
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
      
      // Configure session with selected voice (set once, no changes mid-call)
      configureSession(callVoice);
    });
    
    // Configure the Realtime session with the specified voice
    function configureSession(voice) {
      if (voiceInitialized) {
        console.log("⚠️ Voice already initialized, skipping reconfiguration");
        return;
      }
      
      console.log(`🎙️ Using OpenAI Realtime voice: ${voice}${voice === OPENAI_VOICE_FALLBACK ? ' (fallback)' : ''}`);
      
      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: SYSTEM_PROMPT,
          voice: voice,  // Set exactly once
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
    }
    
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
        voiceInitialized = true;  // Voice is now locked for this call
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
          assistantTurnCount++;  // Track for filler spacing
          
          // Start greeting silence fallback timer if we just finished the greeting
          if (awaitingFirstResponse && stateMachine.getState() === STATES.GREETING) {
            console.log(`⏱️ Starting ${SILENCE_CONFIG.greeting_fallback_ms}ms greeting silence timer`);
            greetingSilenceTimer = setTimeout(() => {
              if (awaitingFirstResponse) {
                console.log(`🔇 No response after greeting - sending fallback prompt`);
                sendGreetingFallback();
              }
            }, SILENCE_CONFIG.greeting_fallback_ms);
          }
        }
        responseInProgress = false;
        
        // Reset dynamic silence to default after turn completes
        currentSilenceDuration = VAD_CONFIG.silence_default;
        break;
        
      case "input_audio_buffer.speech_started":
        console.log("🎤 User speaking...");
        speechStartTime = Date.now();
        longSpeechBackchannelSent = false;
        
        // Cancel greeting silence timer - user is responding
        if (greetingSilenceTimer) {
          console.log("⏱️ Cancelled greeting silence timer - user speaking");
          clearTimeout(greetingSilenceTimer);
          greetingSilenceTimer = null;
        }
        awaitingFirstResponse = false;
        
        // AGGRESSIVE BARGE-IN: Immediately stop assistant audio
        if (playBuffer.length > 0 || responseInProgress) {
          console.log("🛑 Barge-in: stopping assistant audio");
          playBuffer = Buffer.alloc(0);  // Clear audio buffer immediately
          responseInProgress = false;
        }
        
        // Start long-speech backchannel timer (4-6 seconds)
        if (LONG_SPEECH_CONFIG.enabled && !longSpeechTimer) {
          longSpeechTimer = setTimeout(() => {
            if (!longSpeechBackchannelSent && speechStartTime) {
              const speechDuration = Date.now() - speechStartTime;
              if (speechDuration >= LONG_SPEECH_CONFIG.trigger_after_ms && 
                  speechDuration <= LONG_SPEECH_CONFIG.max_trigger_ms) {
                const phrase = LONG_SPEECH_CONFIG.phrases[
                  Math.floor(Math.random() * LONG_SPEECH_CONFIG.phrases.length)
                ];
                console.log(`💬 Long-speech backchannel: "${phrase}" (${speechDuration}ms)`);
                longSpeechBackchannelSent = true;
                // Note: We don't actually speak this - just log it
                // OpenAI will naturally handle turn-taking
              }
            }
          }, LONG_SPEECH_CONFIG.trigger_after_ms);
        }
        break;
        
      case "input_audio_buffer.speech_stopped":
        const speechDuration = speechStartTime ? Date.now() - speechStartTime : 0;
        console.log(`🔇 User stopped speaking (${speechDuration}ms)`);
        
        // Clear long-speech timer
        if (longSpeechTimer) {
          clearTimeout(longSpeechTimer);
          longSpeechTimer = null;
        }
        speechStartTime = null;
        
        // DYNAMIC SILENCE ADJUSTMENT
        // Short clear answers get faster response, long rambling gets more patience
        if (speechDuration < 2000) {
          // Short answer - caller finished thought quickly
          currentSilenceDuration = VAD_CONFIG.silence_short;
          console.log(`⚡ Dynamic silence: ${currentSilenceDuration}ms (short answer)`);
        } else if (speechDuration > 5000) {
          // Long speech - might pause mid-thought
          currentSilenceDuration = VAD_CONFIG.silence_long;
          console.log(`⏳ Dynamic silence: ${currentSilenceDuration}ms (long speech)`);
        } else {
          currentSilenceDuration = VAD_CONFIG.silence_default;
        }
        
        // Start post-speech backchannel timer (only if not already backchanneled)
        if (BACKCHANNEL_CONFIG.enabled && !longSpeechBackchannelSent) {
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
        const errorMsg = event.error?.message || JSON.stringify(event.error);
        console.error(`❌ OpenAI error: ${errorMsg}`);
        
        // Check for voice-related errors and fall back
        if (!voiceInitialized && errorMsg.toLowerCase().includes('voice')) {
          if (callVoice !== OPENAI_VOICE_FALLBACK) {
            console.log(`⚠️ Voice "${callVoice}" failed, falling back to "${OPENAI_VOICE_FALLBACK}"`);
            callVoice = OPENAI_VOICE_FALLBACK;
            configureSession(callVoice);
          }
        }
        break;
        
      case "rate_limits.updated":
        // Ignore
        break;
        
      default:
        // Ignore frequent/spammy events
        const ignoredEvents = [
          'response.text.delta', 'response.audio_transcript.delta',
          'response.output_item.added', 'response.output_item.done', 
          'response.content_part.added', 'response.content_part.done', 
          'input_audio_buffer.committed', 'conversation.item.created',
          'conversation.item.input_audio_transcription.delta'
        ];
        if (!ignoredEvents.includes(event.type)) {
          console.log(`📨 OpenAI event: ${event.type}`);
        }
    }
  }
  
  // ============================================================================
  // SEND GREETING
  // ============================================================================
  function sendGreeting() {
    console.log("👋 Sending greeting");
    awaitingFirstResponse = true;  // Start watching for silence
    
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Greet the caller. Say exactly: "${GREETING.primary}"

Speak at a normal conversational pace - not slow or formal. Use contractions. Sound natural and friendly, like a real person answering the phone.`,
        max_output_tokens: 300
      }
    }));
  }
  
  // ============================================================================
  // SEND GREETING FALLBACK (when no response after 4 seconds)
  // ============================================================================
  function sendGreetingFallback() {
    if (responseInProgress) {
      console.log("⏳ Response in progress, skipping greeting fallback");
      return;
    }
    
    awaitingFirstResponse = false;
    console.log("📢 Sending greeting fallback");
    
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `The caller hasn't responded. Say exactly: "${GREETING.silence_fallback}"

Speak at a normal conversational pace. Sound helpful and inviting.`,
        max_output_tokens: 300
      }
    }));
  }
  
  // ============================================================================
  // SEND MICRO-RESPONSE (backchannel)
  // ============================================================================
  function sendMicroResponse(phrase) {
    if (openaiWs?.readyState === WebSocket.OPEN && !responseInProgress) {
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
    // Don't process if a response is already in progress
    if (responseInProgress) {
      console.log(`⏳ Skipping input processing - response in progress`);
      return;
    }
    
    // Clear silence timers if still active
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    if (greetingSilenceTimer) {
      clearTimeout(greetingSilenceTimer);
      greetingSilenceTimer = null;
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
    if (openaiWs?.readyState === WebSocket.OPEN && !responseInProgress) {
      // Determine if we should use a filler based on turn count
      const useFiller = assistantTurnCount > 0 && 
                        assistantTurnCount % FILLER_CONFIG.min_turns_between_fillers === 0;
      const fillerHint = useFiller ? 
        `Start with a brief acknowledgement like "Got it" or "Okay", then ` : '';
      
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `${fillerHint}Say: "${prompt}"

CRITICAL RULES:
- Speak at normal conversational speed, not slow
- Use contractions (what's, I'm, you're)  
- Keep it to TWO sentences max: brief acknowledgement + the question
- Sound natural, not robotic or scripted`,
          max_output_tokens: 300
        }
      }));
    } else if (responseInProgress) {
      console.log(`⏳ Skipping prompt - response in progress`);
    }
  }
  
  // ============================================================================
  // SEND NATURAL RESPONSE (let model generate)
  // ============================================================================
  function sendNaturalResponse(userInput, action) {
    if (openaiWs?.readyState !== WebSocket.OPEN) return;
    if (responseInProgress) {
      console.log(`⏳ Skipping natural response - response in progress`);
      return;
    }
    
    const state = stateMachine.getState();
    const data = stateMachine.getData();
    
    // ChatGPT-style response rules
    const styleRules = `
RESPONSE STYLE - FOLLOW EXACTLY:
- Start with brief acknowledgement (one short sentence)
- Then ask ONE question (one sentence)
- Use contractions. Speak naturally.
- Never explain what you're doing
- Never repeat back full info unless confirming at the end`;
    
    let instruction = '';
    
    if (action === 'classify_intent') {
      instruction = `Caller said: "${userInput}"

Figure out what they need. Respond with:
1. Brief acknowledgement
2. One clarifying question
${styleRules}`;
    } else if (action === 'answer_question') {
      instruction = `Caller asked: "${userInput}"

Answer briefly. If you don't know specifics, say "I can take your info and have someone follow up."
${styleRules}`;
    } else if (action === 'handle_correction') {
      instruction = `Caller is correcting something: "${userInput}"

Current info: Name: ${data.name || 'none'}, Phone: ${data.phone || 'none'}, Email: ${data.email || 'none'}, Address: ${data.address || 'none'}

Ask what needs fixing, confirm briefly, move on.
${styleRules}`;
    }
    
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: instruction,
        max_output_tokens: 400
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
    if (greetingSilenceTimer) clearTimeout(greetingSilenceTimer);
    if (longSpeechTimer) clearTimeout(longSpeechTimer);
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
  console.log(`🎙️ Voice: ${OPENAI_VOICE_PRIMARY} (fallback: ${OPENAI_VOICE_FALLBACK})`);
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

