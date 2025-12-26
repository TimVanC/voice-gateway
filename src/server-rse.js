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
const { SYSTEM_PROMPT, GREETING, STATES, INTENT_TYPES, NEUTRAL, OUT_OF_SCOPE } = require('./scripts/rse-script');
const { VAD_CONFIG, BACKCHANNEL_CONFIG, LONG_SPEECH_CONFIG, FILLER_CONFIG } = require('./config/vad-config');
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
  let waitingForTranscription = false;  // Set when speech stops, cleared when transcript arrives
  let pendingUserInput = null;  // Queue for input that arrives while response is in progress
  
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
  // GREETING STATE
  // ============================================================================
  let greetingSent = false;              // Track if greeting was sent
  
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
        // DON'T clear playBuffer here - let existing audio finish playing!
        // Audio from new response will be appended, not replace
        // Only clear on explicit cancellation or barge-in
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
        const audioSeconds = (playBuffer.length / 8000).toFixed(1);
        console.log(`🔊 Audio complete (buffer: ${playBuffer.length} bytes = ~${audioSeconds}s to play)`);
        // Keep responseInProgress true until response.done
        // This prevents new responses from starting while audio is still in buffer
        break;
        
      case "response.audio_transcript.done":
        if (event.transcript) {
          console.log(`📜 AI said: "${event.transcript}"`);
        }
        break;
        
      case "response.done":
        const status = event.response?.status;
        const currentState = stateMachine.getState();
        
        if (status === "cancelled") {
          console.log(`⚠️ Response CANCELLED`);
          // Don't send any new prompts - we cancelled for a reason
          // Either waiting for transcription, or user barged in
        } else if (status === "incomplete") {
          console.log(`⚠️ Response INCOMPLETE`);
          // NOTE: Do NOT auto-retry here! The AI was already speaking and will
          // assume context from its incomplete response. The user will respond
          // to what they heard, and we'll handle it naturally. Only retry if
          // no audio was sent at all.
          if (!audioStreamingStarted) {
            console.log(`🔄 No audio was sent - will retry prompt`);
            setTimeout(() => {
              sendNextPromptIfNeeded();
            }, 100);
          }
          // If audio was streaming (user heard something), don't retry
          // The user will respond and we'll handle it
        } else {
          console.log(`✅ Response complete (state: ${currentState})`);
          assistantTurnCount++;  // Track for filler spacing
        }
        responseInProgress = false;
        audioStreamingStarted = false;  // Reset for next response
        
        // Reset dynamic silence to default after turn completes
        currentSilenceDuration = VAD_CONFIG.silence_default;
        
        // Process any pending input that arrived while response was in progress
        if (pendingUserInput && status !== "cancelled") {
          console.log(`📤 Processing queued input: "${pendingUserInput.substring(0, 50)}..."`);
          const input = pendingUserInput;
          pendingUserInput = null;
          processUserInput(input);
        }
        break;
        
      case "input_audio_buffer.speech_started":
        console.log("🎤 User speaking...");
        speechStartTime = Date.now();
        longSpeechBackchannelSent = false;
        
        // Clear any pending input - we'll get a fresh transcript
        pendingUserInput = null;
        
        // Reset acknowledgement tracking for new user turn
        backchannel.resetTurn();
        
        // AGGRESSIVE BARGE-IN: Immediately stop assistant audio
        if (playBuffer.length > 0 || responseInProgress) {
          console.log("🛑 Barge-in: stopping assistant audio");
          playBuffer = Buffer.alloc(0);  // Clear audio buffer immediately
          responseInProgress = false;
          audioStreamingStarted = false;
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
        
        // ===================================================================
        // CRITICAL: Cancel OpenAI's auto-response!
        // OpenAI's VAD triggers a response immediately when speech stops,
        // but the transcription takes 1-2 seconds to arrive. If we don't
        // cancel, the AI will respond with a generic "please continue" before
        // we even know what the user said.
        // ===================================================================
        if (openaiWs?.readyState === WebSocket.OPEN) {
          console.log(`🛑 Pre-emptive cancel: stopping OpenAI auto-response`);
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          // Mark that we're waiting for transcription
          waitingForTranscription = true;
        }
        break;
        
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          const transcript = event.transcript.trim();
          console.log(`📝 User said: "${transcript}"`);
          
          // Clear the waiting flag - we have the transcript now
          waitingForTranscription = false;
          
          // If a response is already in progress (shouldn't happen after our cancel),
          // log it but still process the input
          if (responseInProgress) {
            console.log(`⚠️ Response was in progress when transcript arrived`);
            if (audioStreamingStarted) {
              console.log(`🎵 Audio already streaming - will queue input`);
              // Let current response finish, queue this input
              pendingUserInput = transcript;
              return;
            }
          }
          
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
    greetingSent = true;
    
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
    if ([STATES.NAME, STATES.PHONE, STATES.EMAIL, STATES.ADDRESS, STATES.AVAILABILITY].includes(state)) {
      return 'after_capture';
    }
    return 'general';
  }
  
  // ============================================================================
  // PROCESS USER INPUT THROUGH STATE MACHINE
  // ============================================================================
  
  // Track if we've already processed this turn's input
  let lastProcessedTranscript = null;
  
  function processUserInput(transcript) {
    // Clear silence timer if still active
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    
    // Avoid processing the same transcript twice
    if (transcript === lastProcessedTranscript) {
      console.log(`⏭️ Skipping duplicate transcript`);
      return;
    }
    lastProcessedTranscript = transcript;
    
    // If OpenAI is already speaking (audio streaming), let it finish
    // We'll just update our state machine without sending a new response
    if (audioStreamingStarted && responseInProgress) {
      console.log(`🎵 Audio already streaming - updating state only, no new response`);
      updateStateOnly(transcript);
      return;
    }
    
    // If response just started but no audio yet, we can safely cancel and take over
    if (responseInProgress && !audioStreamingStarted) {
      console.log(`🛑 Cancelling OpenAI auto-response (no audio yet)`);
      openaiWs.send(JSON.stringify({ type: "response.cancel" }));
      playBuffer = Buffer.alloc(0);  // Clear buffer since we're cancelling
      responseInProgress = false;
    }
    
    // Small delay to ensure cancel is processed
    setTimeout(() => {
      doProcessUserInput(transcript);
    }, 50);
  }
  
  // Update state machine without sending a new response
  // (used when OpenAI is already speaking)
  function updateStateOnly(transcript) {
    const currentState = stateMachine.getState();
    const lowerTranscript = transcript.toLowerCase();
    
    console.log(`📊 State update only (no response): ${currentState}`);
    
    // Intent classification for greeting/intent states
    let analysis = {};
    if (currentState === STATES.GREETING || currentState === STATES.INTENT) {
      analysis.intent = classifyIntent(lowerTranscript);
      if (analysis.intent) {
        console.log(`📋 Detected intent: ${analysis.intent}`);
      }
    }
    
    // Process through state machine to update state
    const result = stateMachine.processInput(transcript, analysis);
    console.log(`📍 State updated to: ${result.nextState}`);
    
    // Don't send a response - let OpenAI's current response finish
  }
  
  // Send the next prompt based on current state (used for recovery)
  function sendNextPromptIfNeeded() {
    if (responseInProgress) {
      console.log(`⏳ Skipping recovery prompt - response in progress`);
      return;
    }
    
    const prompt = stateMachine.getNextPrompt();
    if (prompt) {
      console.log(`🔄 Recovery: sending prompt for state ${stateMachine.getState()}`);
      sendStatePrompt(prompt);
    }
  }
  
  function doProcessUserInput(transcript) {
    const currentState = stateMachine.getState();
    const lowerTranscript = transcript.toLowerCase();
    
    console.log(`🔄 Processing input in state ${currentState}: "${transcript.substring(0, 50)}..."`);
    
    // Intent classification for greeting/intent states
    let analysis = {};
    if (currentState === STATES.GREETING || currentState === STATES.INTENT) {
      analysis.intent = classifyIntent(lowerTranscript);
      if (analysis.intent) {
        console.log(`📋 Detected intent: ${analysis.intent}`);
      }
    }
    
    // Process through state machine
    const result = stateMachine.processInput(transcript, analysis);
    
    console.log(`📍 State machine result: nextState=${result.nextState}, action=${result.action}`);
    
    // Generate appropriate response based on state machine result
    if (result.prompt) {
      sendStatePrompt(result.prompt);
    } else if (result.action === 'redirect_out_of_scope') {
      // Handle out-of-scope request with polite redirect
      sendOutOfScopeResponse(transcript);
    } else if (result.action === 'classify_intent' || result.action === 'answer_question' || result.action === 'handle_correction') {
      // Let the model generate a natural response
      sendNaturalResponse(transcript, result.action);
    }
  }
  
  // ============================================================================
  // SEND OUT OF SCOPE RESPONSE
  // ============================================================================
  function sendOutOfScopeResponse(transcript) {
    if (openaiWs?.readyState === WebSocket.OPEN && !responseInProgress) {
      const lowerTranscript = transcript.toLowerCase();
      
      // Determine specific response based on what was asked
      let response = OUT_OF_SCOPE.general;
      if (lowerTranscript.includes('solar')) {
        response = OUT_OF_SCOPE.solar;
      } else if (lowerTranscript.includes('electric') || lowerTranscript.includes('wiring')) {
        response = OUT_OF_SCOPE.electrical;
      } else if (lowerTranscript.includes('plumb') || lowerTranscript.includes('water heater')) {
        response = OUT_OF_SCOPE.plumbing;
      }
      
      console.log(`🚫 Out-of-scope response: "${response}"`);
      responseInProgress = true;
      
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Say exactly: "${response}"

Then ask: "Is there anything else I can help with?"
Sound polite and helpful, not dismissive.`,
          max_output_tokens: 200
        }
      }));
    }
  }
  
  // ============================================================================
  // INTENT CLASSIFICATION
  // ============================================================================
  function classifyIntent(text) {
    // ============================================================
    // DISALLOWED SERVICES - Check first and reject
    // ============================================================
    if (/\b(solar|photovoltaic|pv panel|solar panel|solar audit|solar energy|solar install)\b/.test(text)) {
      console.log('⚠️ Detected disallowed service: SOLAR');
      return INTENT_TYPES.OUT_OF_SCOPE;
    }
    
    if (/\b(electrical|electrician|wiring|outlet|circuit|breaker|panel upgrade)\b/.test(text) && 
        !/\b(generator|hvac|furnace|ac|air condition)\b/.test(text)) {
      console.log('⚠️ Detected disallowed service: ELECTRICAL');
      return INTENT_TYPES.OUT_OF_SCOPE;
    }
    
    if (/\b(plumbing|plumber|water heater|pipe|drain|toilet|faucet|sewer)\b/.test(text)) {
      console.log('⚠️ Detected disallowed service: PLUMBING');
      return INTENT_TYPES.OUT_OF_SCOPE;
    }
    
    if (/\b(roofing|roof|insulation|window|door|siding)\b/.test(text) && 
        !/\b(hvac|furnace|ac|air condition|rooftop unit)\b/.test(text)) {
      console.log('⚠️ Detected disallowed service: OTHER HOME IMPROVEMENT');
      return INTENT_TYPES.OUT_OF_SCOPE;
    }
    
    // Energy audit only allowed if HVAC-related
    if (/\b(energy audit)\b/.test(text) && !/\b(hvac|heating|cooling)\b/.test(text)) {
      console.log('⚠️ Detected disallowed service: ENERGY AUDIT');
      return INTENT_TYPES.OUT_OF_SCOPE;
    }
    
    // ============================================================
    // ALLOWED SERVICES - Order matters! Check installation FIRST
    // ============================================================
    
    // Generator keywords
    if (/\b(generator|generac|cummins|backup power|standby|whole house power)\b/.test(text)) {
      return INTENT_TYPES.GENERATOR;
    }
    
    // Installation/upgrade keywords - CHECK BEFORE service keywords
    // "new", "install", "replace" indicate installation, not service
    if (/\b(new|install|installation|replace|replacement|upgrade|estimate|quote|cost|price|proposal)\b/.test(text)) {
      console.log('📋 Detected installation/upgrade keywords');
      return INTENT_TYPES.HVAC_INSTALLATION;
    }
    
    // Service/repair keywords (HVAC) - only for actual problems
    if (/\b(repair|fix|broken|not working|service call|problem|issue|no heat|no cool|noise|leak|frozen|won't start|stopped working|maintenance)\b/.test(text)) {
      return INTENT_TYPES.HVAC_SERVICE;
    }
    
    // Membership keywords
    if (/\b(membership|member|plan|home comfort|tune up|annual service|monthly plan)\b/.test(text)) {
      return INTENT_TYPES.MEMBERSHIP;
    }
    
    // Existing project keywords
    if (/\b(existing project|current project|in progress|follow up|following up|job|quote you gave|estimate you gave|spoke to someone)\b/.test(text)) {
      return INTENT_TYPES.EXISTING_PROJECT;
    }
    
    // HVAC system mentions without clear intent - default to service
    if (/\b(furnace|boiler|ac|air condition|heat pump|mini split|hvac|heating|cooling|thermostat|ductwork)\b/.test(text)) {
      return INTENT_TYPES.HVAC_SERVICE;
    }
    
    // If nothing matched, return null to let AI classify naturally
    return null;
  }
  
  // ============================================================================
  // SEND STATE PROMPT
  // ============================================================================
  function sendStatePrompt(prompt) {
    if (openaiWs?.readyState === WebSocket.OPEN && !responseInProgress) {
      // Determine if we should use a filler based on turn count
      const useFiller = assistantTurnCount > 0 && 
                        assistantTurnCount % FILLER_CONFIG.min_turns_between_fillers === 0;
      const ack = useFiller ? 'Okay. ' : '';
      
      console.log(`🗣️ State prompt: "${ack}${prompt}"`);
      
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `YOU MUST SAY EXACTLY THIS (you can add a brief acknowledgement first):

"${ack}${prompt}"

CRITICAL - DO NOT DEVIATE:
- Say ONLY what is written above
- Do NOT add extra questions
- Do NOT skip ahead in the intake process
- Sound natural, use contractions
- Keep it short`,
          max_output_tokens: 200
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
    
    console.log(`💬 Natural response: action=${action}, state=${state}`);
    
    // STRICT COLLECTION ORDER - the AI must follow this exactly
    const collectionOrder = `
STRICT INTAKE ORDER - YOU MUST FOLLOW THIS:
1. Understand what they need (HVAC service, installation, generator, membership, existing project)
2. If it's a service issue: Ask about safety first (smoke, gas smell, sparks?)
3. Ask for first AND last name
4. Ask for phone number
5. Ask for email (optional)
6. Ask about the situation/problem details
7. Ask for service address
8. Ask for availability
9. Read back ALL info for confirmation
DO NOT SKIP ANY STEP. DO NOT ASK FOR ADDRESS BEFORE PHONE.`;
    
    let instruction = '';
    
    if (action === 'classify_intent') {
      instruction = `Caller said: "${userInput}"

You are an intake receptionist. Figure out what they need.

ALLOWED SERVICES ONLY:
- HVAC (heating, AC, service, maintenance, installation, upgrades)
- Generators (service, maintenance, installation)
- Memberships (Home Comfort Plans)
- Existing projects

If they mention something else (solar, electrical, plumbing), say:
"We specialize in HVAC and generators. I can help with that if you need."

Respond with:
1. Brief acknowledgement (one short sentence)
2. One clarifying question about their need

Keep it SHORT. Two sentences max.`;
    } else if (action === 'answer_question') {
      instruction = `Caller asked: "${userInput}"

Answer briefly. You're intake only - don't schedule or promise times.
If you don't know specifics, say "I can take your info and have someone follow up."

Keep it SHORT. Two sentences max.`;
    } else if (action === 'handle_correction') {
      instruction = `Caller is correcting something: "${userInput}"

Current info: 
- Name: ${data.firstName || ''} ${data.lastName || ''}
- Phone: ${data.phone || 'not yet'}
- Email: ${data.email || 'not yet'}
- Address: ${data.address || 'not yet'}

Ask what needs fixing, confirm briefly, move on.
Keep it SHORT.`;
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

