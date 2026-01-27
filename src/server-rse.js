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
const twilio = require("twilio");
const { BASE_URL } = require('./config/baseUrl');

// ============================================================================
// IMPORTS
// ============================================================================
const { SYSTEM_PROMPT, GREETING, STATES, INTENT_TYPES, NEUTRAL, OUT_OF_SCOPE, CLOSE, SAFETY, CONFIRMATION } = require('./scripts/rse-script');
const { VAD_CONFIG, BACKCHANNEL_CONFIG, LONG_SPEECH_CONFIG, FILLER_CONFIG } = require('./config/vad-config');
const { createCallStateMachine } = require('./state/call-state-machine');
const { createBackchannelManager, createMicroResponsePayload } = require('./utils/backchannel');
const { logCallIntake } = require('./utils/google-sheets-logger');

// ============================================================================
// CONFIGURATION
// ============================================================================
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// Twilio configuration for transfers
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TRANSFER_PHONE_NUMBER = process.env.TRANSFER_PHONE_NUMBER; // Phone number to transfer to
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN 
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// Voice configuration
// Primary: sage (deeper female voice), Fallback: shimmer
const OPENAI_VOICE_PRIMARY = process.env.OPENAI_REALTIME_VOICE || "sage";
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
// TWILIO TRANSFER ENDPOINT
// ============================================================================
app.post("/twilio/transfer", (req, res) => {
  console.log("🔄 Transfer endpoint called");
  const response = new twilio.twiml.VoiceResponse();
  response.say("Transferring you to a real person now.");
  if (TRANSFER_PHONE_NUMBER) {
    response.dial(TRANSFER_PHONE_NUMBER);
  } else {
    response.say("I'm sorry, the transfer service is not configured. Please call back during business hours.");
  }
  res.type("text/xml").send(response.toString());
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
  let callSid = null;  // Store call SID for transfers
  let callerNumber = null;  // Store caller number for logging
  let openaiWs = null;
  let transferRequested = false;  // Track if transfer has been requested
  let baseUrl = BASE_URL || null;  // Store base URL for transfers (from config/baseUrl.js)
  
  // Determine base URL for transfers if not set from config/environment
  if (!baseUrl && req && req.headers && req.headers.host) {
    const protocol = req.headers.host.includes("localhost") ? "http" : "https";
    baseUrl = `${protocol}://${req.headers.host}`;
  }
  let paceTimer = null;
  let keepAliveTimer = null;
  let silenceTimer = null;
  let lastActivityTime = Date.now();
  
  // Audio buffer for pacing
  let playBuffer = Buffer.alloc(0);
  let responseInProgress = false;
  let audioStreamingStarted = false;
  let totalAudioBytesSent = 0;  // Track total audio in current response
  let currentResponseId = null;  // Track current OpenAI response ID for cancellation
  let waitingForTranscription = false;  // Set when speech stops, cleared when transcript arrives
  let pendingUserInput = null;  // Queue for input that arrives while response is in progress
  
  // TTS failure detection and recovery
  let currentPromptText = null;  // Track the prompt text being sent
  let promptRetryCount = {};  // Track retry attempts per prompt (by prompt text)
  let lastAudioDeltaTime = null;  // Track when last audio delta arrived
  let audioCompletionTimeout = null;  // Timeout to detect if audio stops mid-sentence
  let expectedTranscript = null;  // Expected transcript for current prompt
  let actualTranscript = null;  // Store actual transcript received from OpenAI
  let audioDoneReceived = false;  // Track if response.audio.done was received
  const TTS_FAILURE_TIMEOUT_MS = 8000;  // 8 seconds - if no audio for this long, consider it failed
  const MAX_RETRIES_PER_PROMPT = 2;  // Max retries before transferring to human
  
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
  // SILENCE RECOVERY (for when INCOMPLETE responses leave system stuck)
  // ============================================================================
  let silenceRecoveryTimer = null;       // Timer to recover from stuck state
  const SILENCE_RECOVERY_MS = 6000;      // Wait 6 seconds before prompting
  
  // Global silence monitor - never leave caller in silence
  let globalSilenceMonitor = null;
  let lastAudioPlaybackTime = Date.now();
  const GLOBAL_SILENCE_TIMEOUT_MS = 15000;  // 15 seconds of total silence = transfer
  
  // ============================================================================
  // AUDIO PACING - Send audio to Twilio at correct rate
  // ============================================================================
  function pumpFrames() {
    const FRAME_SIZE = 160;  // 20ms of 8kHz audio
    const FRAME_INTERVAL = 20;
    const SILENCE_FRAME = Buffer.alloc(FRAME_SIZE, 0xFF);  // μ-law silence
    
    // Prevent multiple timers
    if (paceTimer) {
      clearInterval(paceTimer);
    }
    
    paceTimer = setInterval(() => {
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) {
        return; // Can't send without stream
      }
      
      let frame;
      if (playBuffer.length >= FRAME_SIZE) {
        // Send audio from buffer
        frame = playBuffer.slice(0, FRAME_SIZE);
        playBuffer = playBuffer.slice(FRAME_SIZE);
      } else if (playBuffer.length > 0) {
        // Send partial frame padded with silence
        frame = Buffer.concat([
          playBuffer,
          SILENCE_FRAME.slice(0, FRAME_SIZE - playBuffer.length)
        ]);
        playBuffer = Buffer.alloc(0);
      } else {
        // Send silence frame
        frame = SILENCE_FRAME;
      }
      
      try {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: frame.toString("base64") }
        }));
        // Update last audio playback time when we actually send audio to Twilio
        // Only update if this is not a silence frame (silence frames are 0xFF)
        if (frame[0] !== 0xFF || frame.some(b => b !== 0xFF)) {
          lastAudioPlaybackTime = Date.now();
        }
      } catch (err) {
        console.error("❌ Error sending audio frame to Twilio:", err.message);
      }
    }, FRAME_INTERVAL);
    
    console.log("🎵 Audio pump started - will send frames every 20ms");
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
        
        if (elapsed > 20000) {
          // CRITICAL: Do NOT trigger recovery during CONFIRMATION or CLOSE states
          // The user needs time to listen to the full recap (can be 30+ seconds)
          const state = stateMachine.getState();
          if (state === STATES.CONFIRMATION || state === STATES.CLOSE || state === STATES.ENDED) {
            console.log(`⏸️ Keep-alive: Waiting patiently in ${state} state (${elapsed}ms)`);
          } else {
            console.error(`⚠️ No OpenAI activity for ${elapsed}ms!`);
            // If we've been waiting too long and no response is in progress, send recovery prompt
            if (!responseInProgress && elapsed > 20000) {
              console.log(`🔄 Recovery: System went nonverbal, sending next prompt`);
              sendNextPromptIfNeeded();
            }
          }
          // Try to send a ping to keep connection alive
          try {
            openaiWs.ping();
          } catch (e) {
            console.error(`❌ Keep-alive ping failed: ${e.message}`);
          }
        } else {
          // Normal keep-alive ping
          try {
            openaiWs.ping();
          } catch (e) {
            console.error(`❌ Keep-alive ping failed: ${e.message}`);
          }
        }
      } else {
        console.warn(`⚠️ Keep-alive: OpenAI WS not open (state: ${openaiWs?.readyState})`);
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
        // Send greeting ONLY if stream is ready and we haven't sent it yet
        if (streamSid && twilioWs.readyState === WebSocket.OPEN && !greetingSent) {
          console.log("✅ Session configured and stream ready - sending greeting");
          sendGreeting();
        } else if (!streamSid) {
          console.log("⏳ Session configured, waiting for stream to start...");
          // Will send greeting when stream starts (in "start" event handler)
        } else if (greetingSent) {
          console.log("✅ Session updated (greeting already sent)");
        }
        break;
        
      case "response.created":
        currentResponseId = event.response?.id;
        console.log(`🚀 Response started (id: ${currentResponseId})`);
        // DON'T clear playBuffer here - let existing audio finish playing!
        // Audio from new response will be appended, not replace
        // Only clear on explicit cancellation or barge-in
        responseInProgress = true;
        audioStreamingStarted = false;
        totalAudioBytesSent = 0;  // Reset for new response
        lastAudioDeltaTime = Date.now();  // Reset audio delta tracking
        audioDoneReceived = false;  // Reset audio done flag
        actualTranscript = null;  // Reset transcript for new response
        
        // Cancel backchannel timer - real response is coming
        backchannel.cancel();
        
        // Clear silence recovery timer - we're responding
        clearSilenceRecoveryTimer();
        
        // Start timeout to detect if audio stops mid-sentence
        clearAudioCompletionTimeout();
        audioCompletionTimeout = setTimeout(() => {
          checkForTTSFailure();
        }, TTS_FAILURE_TIMEOUT_MS);
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
          totalAudioBytesSent += audioData.length;  // Track total
          lastAudioDeltaTime = Date.now();  // Update last audio delta time
          lastAudioPlaybackTime = Date.now();  // Update global silence monitor
          
          // Reset timeout since we're receiving audio
          clearAudioCompletionTimeout();
          if (responseInProgress && !audioDoneReceived) {
            // Restart timeout - if audio stops for TTS_FAILURE_TIMEOUT_MS, consider it failed
            audioCompletionTimeout = setTimeout(() => {
              checkForTTSFailure();
            }, TTS_FAILURE_TIMEOUT_MS);
          }
          
          // Reset global silence monitor
          resetGlobalSilenceMonitor();
        }
        break;
        
      case "response.audio.done":
        audioDoneReceived = true;
        const audioSeconds = (playBuffer.length / 8000).toFixed(1);
        console.log(`🔊 Audio complete (buffer: ${playBuffer.length} bytes = ~${audioSeconds}s to play)`);
        // Keep responseInProgress true until response.done
        // This prevents new responses from starting while audio is still in buffer
        
        // Clear timeout since audio is done
        clearAudioCompletionTimeout();
        break;
        
      case "response.audio_transcript.done":
        if (event.transcript) {
          actualTranscript = event.transcript;  // Store transcript for completeness checking
          console.log(`📜 AI said: "${event.transcript}"`);
        }
        break;
        
      case "response.done":
        // Clear timeout since response is done
        clearAudioCompletionTimeout();
        
        const status = event.response?.status;
        const currentState = stateMachine.getState();
        
        // Clear response ID when response is done
        if (event.response?.id === currentResponseId) {
          currentResponseId = null;
        }
        
        // Check if audio was cut off mid-sentence
        if (audioStreamingStarted && !audioDoneReceived && totalAudioBytesSent > 0) {
          const audioSeconds = totalAudioBytesSent / 8000;
          if (audioSeconds < 2) {  // Less than 2 seconds of audio - likely cut off
            console.error(`⚠️ Audio cut off mid-sentence: only ${audioSeconds.toFixed(2)}s received`);
            // This will be handled by the timeout check, but mark it as incomplete
            if (status !== "cancelled") {
              // Treat as incomplete to trigger retry logic
              console.log(`🔄 Treating as incomplete due to audio cutoff`);
            }
          }
        }
        
        if (status === "cancelled") {
          console.log(`⚠️ Response CANCELLED`);
          // Don't send any new prompts - we cancelled for a reason
          // Either waiting for transcription, or user barged in
          // Reset tracking
          currentPromptText = null;
          expectedTranscript = null;
          actualTranscript = null;
        } else if (status === "incomplete") {
          console.log(`⚠️ Response INCOMPLETE`);
          
          // CRITICAL: During CONFIRMATION or CLOSE states, do NOT interrupt with recovery
          // The confirmation prompt must be delivered as uninterrupted as possible
          if (currentState === STATES.CONFIRMATION || currentState === STATES.CLOSE) {
            const audioSeconds = totalAudioBytesSent / 8000;
            console.log(`⏸️ User heard ${audioSeconds.toFixed(1)}s of audio in ${currentState} state - waiting for response without recovery`);
            // Mark that confirmation was attempted (for completion tracking)
            const callData = stateMachine.getData();
            if (currentState === STATES.CONFIRMATION && audioSeconds > 5) {
              // If we got 5+ seconds of confirmation audio, mark as delivered
              callData._confirmationDelivered = true;
            }
            // NO recovery timer - just wait for user to respond naturally
            responseInProgress = false;
            audioStreamingStarted = false;
            return; // Don't start recovery timer
          }
          
          if (!audioStreamingStarted || totalAudioBytesSent === 0) {
            // No audio was sent at all - check retry count
            let promptKey = currentPromptText || 'unknown';
            if (currentPromptText === SAFETY.check || (typeof currentPromptText === 'string' && currentPromptText.startsWith(CONFIRMATION.safety_retry))) {
              promptKey = SAFETY.check;
            }
            const retryCount = promptRetryCount[promptKey] || 0;
            const maxRetries = (promptKey === SAFETY.check) ? 1 : MAX_RETRIES_PER_PROMPT;
            
            if (retryCount >= maxRetries) {
              console.error(`🚨 NO AUDIO GENERATED ${retryCount + 1} TIMES - TRANSFERRING TO REAL PERSON`);
              transferToRealPerson();
              responseInProgress = false;
              currentPromptText = null;
              expectedTranscript = null;
              actualTranscript = null;
              return;
            }
            
            promptRetryCount[promptKey] = retryCount + 1;
            console.log(`🔄 No audio was sent - will retry prompt (attempt ${retryCount + 1}/${maxRetries})`);
            responseInProgress = false;
            setTimeout(() => {
              let toSend = currentPromptText;
              if (promptKey === SAFETY.check && (promptRetryCount[SAFETY.check] || 0) === 1) {
                toSend = CONFIRMATION.safety_retry + ' ' + SAFETY.check;
              }
              if (toSend === GREETING.primary && stateMachine.getState() === STATES.GREETING) {
                sendGreetingRetry();
              } else if (toSend) {
                sendStatePrompt(toSend);
              } else {
                sendNextPromptIfNeeded();
              }
            }, 500);
          } else {
            // Audio was sent (user heard something)
            const audioSeconds = totalAudioBytesSent / 8000;
            
            // CRITICAL: Always treat INCOMPLETE as failure. Users consistently report cutoffs
            // (e.g. on "today", "system") even when transcript looks complete. Retry every time.
            let promptKey = currentPromptText || 'unknown';
            if (currentPromptText === SAFETY.check || (typeof currentPromptText === 'string' && currentPromptText.startsWith(CONFIRMATION.safety_retry))) {
              promptKey = SAFETY.check;
            }
            const retryCount = promptRetryCount[promptKey] || 0;
            const maxRetries = (promptKey === SAFETY.check) ? 1 : MAX_RETRIES_PER_PROMPT;
            
            if (retryCount >= maxRetries) {
              console.error(`🚨 INCOMPLETE RESPONSE ${retryCount + 1} TIMES - TRANSFERRING TO REAL PERSON`);
              transferToRealPerson();
              responseInProgress = false;
              audioStreamingStarted = false;
              currentPromptText = null;
              expectedTranscript = null;
              actualTranscript = null;
              return;
            }
            
            console.log(`⚠️ Response INCOMPLETE (audio ${audioSeconds.toFixed(1)}s, transcript ${actualTranscript?.length || 0} chars) - retrying (${retryCount + 1}/${maxRetries})`);
            
            promptRetryCount[promptKey] = retryCount + 1;
            responseInProgress = false;
            audioStreamingStarted = false;
            totalAudioBytesSent = 0;
            lastAudioDeltaTime = null;
            audioDoneReceived = false;
            actualTranscript = null;
            // CRITICAL: Do NOT clear playBuffer. Unplayed audio is still queued; clearing
            // drops it. User would hear only the retry (e.g. "today?") and miss the rest.
            // Let buffer play out; retry audio will be appended via response.audio.delta.
            
            setTimeout(() => {
              let toSend = currentPromptText;
              if (promptKey === SAFETY.check && (promptRetryCount[SAFETY.check] || 0) === 1) {
                toSend = CONFIRMATION.safety_retry + ' ' + SAFETY.check;
              }
              if (toSend === GREETING.primary && stateMachine.getState() === STATES.GREETING) {
                sendGreetingRetry();
              } else if (toSend) {
                sendStatePrompt(toSend);
              } else {
                sendNextPromptIfNeeded();
              }
            }, 500);
            return;
          }
        } else {
          console.log(`✅ Response complete (state: ${currentState})`);
          assistantTurnCount++;  // Track for filler spacing
          
          // Reset retry count on successful completion
          if (currentPromptText) {
            if (currentPromptText === SAFETY.check || (typeof currentPromptText === 'string' && currentPromptText.startsWith(CONFIRMATION.safety_retry))) {
              delete promptRetryCount[SAFETY.check];
            } else {
              delete promptRetryCount[currentPromptText];
            }
            currentPromptText = null;
            expectedTranscript = null;
            actualTranscript = null;
          }
          
          // If confirmation prompt was delivered and completed, mark it
          if (currentState === STATES.CONFIRMATION) {
            const callData = stateMachine.getData();
            callData._confirmationDelivered = true;
          }
          // If close state reached, mark it
          if (currentState === STATES.CLOSE) {
            const callData = stateMachine.getData();
            callData._closeStateReached = true;
          }
          
          // HANG UP after goodbye is delivered in ENDED state
          if (currentState === STATES.ENDED) {
            console.log(`📞 Goodbye delivered - hanging up call in 2 seconds`);
            stateMachine.updateData('_closeStateReached', true);
            // Give audio time to finish playing before disconnecting
            setTimeout(() => {
              console.log(`📞 Disconnecting call`);
              if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.close(1000, 'Call completed');
              }
            }, 2000);
          }
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
        
        // Reset global silence - user spoke, we're not stuck
        resetGlobalSilenceMonitor();
        
        // Clear any pending input - we'll get a fresh transcript
        pendingUserInput = null;
        
        // Clear silence recovery timer - user is responding!
        clearSilenceRecoveryTimer();
        
        // Reset acknowledgement tracking for new user turn
        backchannel.resetTurn();
        
        // AGGRESSIVE BARGE-IN: Immediately stop assistant audio and cancel OpenAI response
        if (playBuffer.length > 0 || responseInProgress) {
          console.log("🛑 Barge-in: stopping assistant audio");
          playBuffer = Buffer.alloc(0);  // Clear audio buffer immediately
          responseInProgress = false;
          audioStreamingStarted = false;
          
          // CRITICAL: Also cancel OpenAI's response generation if it's in progress
          // This prevents OpenAI from continuing to generate audio after user interrupts
          if (openaiWs?.readyState === WebSocket.OPEN && currentResponseId) {
            try {
              openaiWs.send(JSON.stringify({
                type: "response.cancel",
                response_id: currentResponseId
              }));
              console.log(`🛑 Cancelled OpenAI response: ${currentResponseId}`);
            } catch (err) {
              // Ignore cancellation errors (response might already be done)
            }
          }
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
        // 
        // EXCEPTION: If speech was very short (< 1 second), user might still
        // be thinking or about to continue. Wait a bit before canceling.
        // ===================================================================
        if (openaiWs?.readyState === WebSocket.OPEN) {
          if (speechDuration < 1000) {
            // Very short speech - wait a bit in case user continues
            setTimeout(() => {
              if (openaiWs?.readyState === WebSocket.OPEN && !speechStartTime) {
                console.log(`🛑 Pre-emptive cancel: stopping OpenAI auto-response (after short speech delay)`);
                openaiWs.send(JSON.stringify({ type: "response.cancel" }));
                waitingForTranscription = true;
              }
            }, 500); // Wait 500ms to see if user continues
          } else {
            // Normal length speech - cancel immediately
            console.log(`🛑 Pre-emptive cancel: stopping OpenAI auto-response`);
            openaiWs.send(JSON.stringify({ type: "response.cancel" }));
            // Mark that we're waiting for transcription
            waitingForTranscription = true;
          }
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
  // SILENCE RECOVERY TIMER
  // ============================================================================
  function startSilenceRecoveryTimer() {
    // Clear any existing timer
    if (silenceRecoveryTimer) {
      clearTimeout(silenceRecoveryTimer);
    }
    
    // CRITICAL: Do NOT start recovery timer during CONFIRMATION or CLOSE states
    // These states need uninterrupted audio delivery
    const currentState = stateMachine.getState();
    if (currentState === STATES.CONFIRMATION || currentState === STATES.CLOSE) {
      console.log(`⏸️  Silence recovery disabled in ${currentState} state - waiting for user response`);
      return;
    }
    
    silenceRecoveryTimer = setTimeout(() => {
      silenceRecoveryTimer = null;
      
      // Double-check state hasn't changed
      const state = stateMachine.getState();
      if (state === STATES.CONFIRMATION || state === STATES.CLOSE) {
        console.log(`⏸️  Silence recovery cancelled - now in ${state} state`);
        return;
      }
      
      // Only prompt if we're not already in a response and user isn't speaking
      if (!responseInProgress && !speechStartTime) {
        console.log(`⏰ Silence recovery: no user response after ${SILENCE_RECOVERY_MS}ms`);
        
        // Re-send the current prompt with FRESH context
        const currentPrompt = stateMachine.getNextPrompt();
        if (currentPrompt && openaiWs?.readyState === WebSocket.OPEN) {
          // Use special recovery prompt that forces complete re-statement
          sendRecoveryPrompt(currentPrompt);
        }
      }
    }, SILENCE_RECOVERY_MS);
  }
  
  // ============================================================================
  // SEND RECOVERY PROMPT (forces complete re-statement, ignores previous)
  // ============================================================================
  function sendRecoveryPrompt(prompt) {
    if (openaiWs?.readyState === WebSocket.OPEN && !responseInProgress) {
      console.log(`🔄 Recovery prompt: "${prompt}"`);
      
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `IMPORTANT: Your previous response may have been cut off. 
The caller may not have heard you clearly.

Say this COMPLETE sentence FROM THE BEGINNING:
"${prompt}"

DO NOT continue from where you left off.
DO NOT say partial sentences.
Say the ENTIRE sentence above, word for word.`,
          max_output_tokens: 200
        }
      }));
    }
  }
  
  function clearSilenceRecoveryTimer() {
    if (silenceRecoveryTimer) {
      clearTimeout(silenceRecoveryTimer);
      silenceRecoveryTimer = null;
    }
  }
  
  // ============================================================================
  // GLOBAL SILENCE MONITOR - Never leave caller in silence
  // ============================================================================
  function startGlobalSilenceMonitor() {
    if (globalSilenceMonitor) {
      clearInterval(globalSilenceMonitor);
    }
    
    globalSilenceMonitor = setInterval(() => {
      const timeSinceLastAudio = Date.now() - lastAudioPlaybackTime;
      const hasAudioInBuffer = playBuffer.length > 0;
      const isUserSpeaking = speechStartTime !== null;
      const currentState = stateMachine.getState();
      
      // Don't trigger during confirmation/close (user needs time to listen)
      if (currentState === STATES.CONFIRMATION || currentState === STATES.CLOSE || currentState === STATES.ENDED) {
        return;
      }
      
      // If we've been silent too long and no audio is playing and user isn't speaking
      if (timeSinceLastAudio >= GLOBAL_SILENCE_TIMEOUT_MS && !hasAudioInBuffer && !isUserSpeaking && !responseInProgress) {
        console.error(`🚨 GLOBAL SILENCE DETECTED: ${(timeSinceLastAudio / 1000).toFixed(1)}s since last audio`);
        console.error(`   System appears stuck - transferring to real person`);
        
        // Stop monitoring
        stopGlobalSilenceMonitor();
        
        // Transfer to real person
        transferToRealPerson();
      } else if (timeSinceLastAudio >= GLOBAL_SILENCE_TIMEOUT_MS && !hasAudioInBuffer && !isUserSpeaking && responseInProgress) {
        // Response in progress but no audio - likely TTS failure
        console.error(`🚨 RESPONSE IN PROGRESS BUT NO AUDIO: ${(timeSinceLastAudio / 1000).toFixed(1)}s since last audio`);
        checkForTTSFailure();
      }
    }, 2000);  // Check every 2 seconds
  }
  
  function stopGlobalSilenceMonitor() {
    if (globalSilenceMonitor) {
      clearInterval(globalSilenceMonitor);
      globalSilenceMonitor = null;
    }
  }
  
  function resetGlobalSilenceMonitor() {
    lastAudioPlaybackTime = Date.now();
  }
  
  // ============================================================================
  // TTS FAILURE DETECTION AND RECOVERY
  // ============================================================================
  function clearAudioCompletionTimeout() {
    if (audioCompletionTimeout) {
      clearTimeout(audioCompletionTimeout);
      audioCompletionTimeout = null;
    }
  }
  
  function checkForTTSFailure() {
    if (!responseInProgress) {
      return; // Not waiting for a response
    }
    
    const timeSinceLastAudio = lastAudioDeltaTime ? Date.now() - lastAudioDeltaTime : TTS_FAILURE_TIMEOUT_MS;
    const audioSeconds = totalAudioBytesSent / 8000;
    
    // Check if audio stopped mid-sentence
    const audioStoppedMidSentence = (
      audioStreamingStarted &&  // Audio started
      !audioDoneReceived &&    // But audio.done never arrived
      timeSinceLastAudio >= TTS_FAILURE_TIMEOUT_MS &&  // And it's been too long
      audioSeconds > 0 && audioSeconds < 5  // And we got some audio but not enough (likely cut off)
    );
    
    // Check if no audio was generated at all
    const noAudioGenerated = (
      !audioStreamingStarted &&  // No audio started
      timeSinceLastAudio >= TTS_FAILURE_TIMEOUT_MS  // And it's been too long
    );
    
    if (audioStoppedMidSentence || noAudioGenerated) {
      console.error(`❌ TTS FAILURE DETECTED:`);
      console.error(`   Audio streaming started: ${audioStreamingStarted}`);
      console.error(`   Audio done received: ${audioDoneReceived}`);
      console.error(`   Time since last audio: ${timeSinceLastAudio}ms`);
      console.error(`   Audio seconds: ${audioSeconds.toFixed(2)}s`);
      console.error(`   Current prompt: "${currentPromptText}"`);
      
      // Cancel current response
      if (currentResponseId && openaiWs?.readyState === WebSocket.OPEN) {
        console.log(`🛑 Cancelling failed response`);
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
      }
      
      // Check retry count; safety question: 1 retry (apology + full question), then transfer
      let promptKey = currentPromptText || 'unknown';
      if (currentPromptText === SAFETY.check || (typeof currentPromptText === 'string' && currentPromptText.startsWith(CONFIRMATION.safety_retry))) {
        promptKey = SAFETY.check;
      }
      const retryCount = promptRetryCount[promptKey] || 0;
      const maxRetries = (promptKey === SAFETY.check) ? 1 : MAX_RETRIES_PER_PROMPT;
      
      if (retryCount >= maxRetries) {
        console.error(`🚨 TTS FAILED ${retryCount + 1} TIMES - TRANSFERRING TO REAL PERSON`);
        transferToRealPerson();
        return;
      }
      
      promptRetryCount[promptKey] = retryCount + 1;
      console.log(`🔄 Retrying prompt (attempt ${retryCount + 1}/${maxRetries})`);
      
      responseInProgress = false;
      audioStreamingStarted = false;
      totalAudioBytesSent = 0;
      lastAudioDeltaTime = null;
      audioDoneReceived = false;
      playBuffer = Buffer.alloc(0);
      
      setTimeout(() => {
        let toSend = currentPromptText;
        if (promptKey === SAFETY.check && (promptRetryCount[SAFETY.check] || 0) === 1) {
          toSend = CONFIRMATION.safety_retry + ' ' + SAFETY.check;
        }
        if (toSend) {
          console.log(`🔄 Retrying: "${toSend.substring(0, 60)}..."`);
          sendStatePrompt(toSend);
        } else {
          sendNextPromptIfNeeded();
        }
      }, 500);
    }
  }
  
  // ============================================================================
  // SEND GREETING
  // ============================================================================
  function sendGreeting() {
    if (openaiWs?.readyState !== WebSocket.OPEN) return;
    if (responseInProgress) {
      console.log("⏳ Skipping greeting - response in progress");
      return;
    }
    console.log("👋 Sending greeting");
    greetingSent = true;
    currentPromptText = GREETING.primary;
    expectedTranscript = GREETING.primary;
    responseInProgress = true;
    clearAudioCompletionTimeout();
    
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
  
  // Greeting retry (INCOMPLETE / "hello?" repeat): strict repeat-only, no "connect you" / "real person"
  function sendGreetingRetry() {
    if (openaiWs?.readyState !== WebSocket.OPEN) return;
    if (responseInProgress) {
      console.log("⏳ Skipping greeting retry - response in progress");
      return;
    }
    console.log("👋 Sending greeting retry (strict repeat-only)");
    currentPromptText = GREETING.primary;
    expectedTranscript = GREETING.primary;
    responseInProgress = true;
    clearAudioCompletionTimeout();
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `CRITICAL - REPEAT CUT-OFF GREETING ONLY:

The previous greeting was cut off. You must REPEAT the full greeting from the start.

Say EXACTLY and ONLY this text, word for word:
"${GREETING.primary}"

STRICT RULES:
- Do NOT acknowledge any user input. Do NOT say "got it", "connecting you", "let me connect", "real person", or anything else.
- Do NOT interpret "A real person is available on request" as a user request. That is part of the greeting you are repeating.
- IGNORE any user message. You are ONLY repeating the cut-off greeting.
- Say ONLY the exact text above. Nothing before it, nothing after it.`,
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
    
    // Process immediately - no delay needed for name collection
    // The state machine will handle the transition and send the next prompt
    doProcessUserInput(transcript);
  }
  
  // Update state machine without sending a new response
  // (used when OpenAI is already speaking)
  function updateStateOnly(transcript) {
    const currentState = stateMachine.getState();
    const lowerTranscript = transcript.toLowerCase();
    const currentData = stateMachine.getData();
    
    console.log(`📊 State update only (no response): ${currentState}`);
    
    // Intent classification - only if intent is NOT already locked
    let analysis = {};
    if ((currentState === STATES.GREETING || currentState === STATES.INTENT) && !currentData.intent) {
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
  
  // ============================================================================
  // DETECT REAL PERSON REQUEST
  // ============================================================================
  function detectRealPersonRequest(transcript) {
    const lowerTranscript = transcript.toLowerCase();
    const realPersonPatterns = [
      /\b(real person|human|speak to someone|talk to someone|talk to a person|speak to a person)\b/,
      /\b(agent|representative|operator|live person|live agent)\b/,
      /\b(transfer|connect me|put me through|can i speak)\b/,
      /\b(not a robot|not ai|not automated|actual person)\b/
    ];
    
    return realPersonPatterns.some(pattern => pattern.test(lowerTranscript));
  }
  
  // ============================================================================
  // TRANSFER CALL TO REAL PERSON
  // ============================================================================
  async function transferToRealPerson() {
    if (transferRequested) {
      console.log("⚠️ Transfer already requested, skipping");
      return;
    }
    
    transferRequested = true;
    console.log("🔄 Transferring call to real person...");
    
    // Close OpenAI connection
    if (openaiWs?.readyState === WebSocket.OPEN) {
      try {
        openaiWs.close();
      } catch (e) {
        console.error("❌ Error closing OpenAI connection:", e);
      }
    }
    
    // Transfer using Twilio REST API if callSid and transfer number are available
    if (callSid && TRANSFER_PHONE_NUMBER && twilioClient) {
      try {
        if (!baseUrl) {
          throw new Error("BASE_URL not configured and cannot be determined from request");
        }
        
        const transferUrl = `${baseUrl}/twilio/transfer`;
        
        console.log(`📞 Transferring call ${callSid} to ${TRANSFER_PHONE_NUMBER} via ${transferUrl}`);
        await twilioClient.calls(callSid).update({
          url: transferUrl,
          method: 'POST'
        });
      } catch (error) {
        console.error("❌ Error transferring call:", error);
        // Fallback: close the connection and let Twilio handle it
        if (twilioWs?.readyState === WebSocket.OPEN) {
          twilioWs.close();
        }
      }
    } else {
      console.log("⚠️ Transfer not configured - callSid, transfer number, or Twilio client missing");
      console.log(`   callSid: ${callSid ? 'present' : 'missing'}, transfer number: ${TRANSFER_PHONE_NUMBER ? 'present' : 'missing'}, client: ${twilioClient ? 'present' : 'missing'}`);
      // Close Twilio connection as fallback
      if (twilioWs?.readyState === WebSocket.OPEN) {
        twilioWs.close();
      }
    }
  }
  
  function doProcessUserInput(transcript) {
    const currentState = stateMachine.getState();
    const lowerTranscript = transcript.toLowerCase().trim();
    const currentData = stateMachine.getData();
    
    console.log(`🔄 Processing input in state ${currentState}: "${transcript.substring(0, 50)}..."`);
    
    // CRITICAL: Check for real person request FIRST - stop AI flow immediately
    if (detectRealPersonRequest(transcript)) {
      console.log("🚨 Real person requested - stopping AI flow and transferring immediately");
      transferToRealPerson();
      return; // Stop processing - don't continue AI flow
    }
    
    // "Hello?" / "Anybody there?" / "Repeat" - caller didn't hear us, retry last prompt
    const shortUtterance = transcript.trim().length < 35;
    const explicitRepeat = /\b(repeat|say that again|say again|come again|didn\'?t hear|can\'?t hear|anybody there|anyone there)\b/i.test(lowerTranscript);
    const repeatRequest = (shortUtterance && /\b(hello\??|hey\??|hi\??)\b/i.test(lowerTranscript)) || explicitRepeat;
    if (repeatRequest && currentPromptText && ![STATES.CONFIRMATION, STATES.CLOSE, STATES.ENDED].includes(currentState)) {
      console.log(`🔄 User said "${transcript}" - repeating last prompt`);
      if (currentPromptText === GREETING.primary && currentState === STATES.GREETING) {
        sendGreetingRetry();
      } else if (currentPromptText) {
        sendStatePrompt(currentPromptText);
      }
      return;
    }
    
    // Intent classification - only if intent is NOT already locked
    let analysis = {};
    if ((currentState === STATES.GREETING || currentState === STATES.INTENT) && !currentData.intent) {
      analysis.intent = classifyIntent(lowerTranscript);
      if (analysis.intent) {
        console.log(`📋 Detected intent: ${analysis.intent}`);
      }
    } else if (currentData.intent) {
      console.log(`📋 Intent already locked: ${currentData.intent} - skipping classification`);
    }
    
    // Process through state machine
    const result = stateMachine.processInput(transcript, analysis);
    
    console.log(`📍 State machine result: nextState=${result.nextState}, action=${result.action}`);
    
    // Generate appropriate response based on state machine result
    if (result.action === 'end' || result.action === 'end_call') {
      // User indicated end of call - deliver goodbye and mark complete
      console.log(`👋 End of call - delivering goodbye`);
      stateMachine.updateData('_closeStateReached', true);
      sendStatePrompt(result.prompt || CLOSE.goodbye);
    } else if (result.prompt) {
      // CRITICAL: Always use scripted prompts, never let AI go off-script
      // This ensures AI follows the state machine exactly
      sendStatePrompt(result.prompt);
    } else if (result.action === 'redirect_out_of_scope') {
      // Handle out-of-scope request with polite redirect
      sendOutOfScopeResponse(transcript);
    } else if (result.action === 'classify_intent') {
      // Only for intent classification (greeting -> intent transition)
      // Use natural response but keep it brief and on-topic
      sendNaturalResponse(transcript, result.action);
    } else if (result.action === 'answer_question' || result.action === 'handle_correction') {
      // Handle corrections in confirmation state
      if (result.action === 'handle_correction' && result.prompt) {
        // If state machine returned a prompt for correction, use it
        sendStatePrompt(result.prompt);
      } else {
        // Otherwise, get the next prompt from state machine
        console.log(`⚠️  Unexpected action: ${result.action} - falling back to state prompt`);
        const fallbackPrompt = stateMachine.getNextPrompt();
        if (fallbackPrompt) {
          sendStatePrompt(fallbackPrompt);
        } else {
          // Last resort: use natural response but keep it brief
          sendNaturalResponse(transcript, result.action);
        }
      }
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
    
    // Service/repair keywords (HVAC) - HIGH CONFIDENCE patterns
    // These should immediately lock intent as HVAC_SERVICE
    if (/\b(repair|fix|broken|not working|isn't working|isnt working|won't work|wont work|doesn't work|doesnt work)\b/.test(text)) {
      return INTENT_TYPES.HVAC_SERVICE;
    }
    if (/\b(service call|problem|issue|no heat|no cool|no cooling|no heating|not heating|not cooling)\b/.test(text)) {
      return INTENT_TYPES.HVAC_SERVICE;
    }
    if (/\b(noise|leak|leaking|frozen|won't start|wont start|stopped working|not running|won't turn on|wont turn on)\b/.test(text)) {
      return INTENT_TYPES.HVAC_SERVICE;
    }
    if (/\b(heat.{0,10}(not|isn't|isnt|won't|wont|doesn't|doesnt))|((not|isn't|isnt|won't|wont).{0,10}heat)\b/i.test(text)) {
      return INTENT_TYPES.HVAC_SERVICE;
    }
    if (/\b(ac.{0,10}(not|isn't|isnt|won't|wont|doesn't|doesnt))|((not|isn't|isnt|won't|wont).{0,10}(ac|air condition))\b/i.test(text)) {
      return INTENT_TYPES.HVAC_SERVICE;
    }
    if (/\b(blowing.{0,15}(cold|warm|lukewarm|hot))\b/i.test(text)) {
      return INTENT_TYPES.HVAC_SERVICE;
    }
    
    // Membership keywords - HIGH CONFIDENCE patterns
    if (/\b(membership|member|maintenance plan|home comfort plan|service plan|annual coverage|monthly coverage|tune up plan)\b/.test(text)) {
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
    if (openaiWs?.readyState !== WebSocket.OPEN) return;
    if (responseInProgress) {
      console.log(`⏳ Skipping prompt - response in progress`);
      return;
    }
    
    const currentState = stateMachine.getState();
    console.log(`🗣️ State prompt: "${prompt}"`);
    
    // Track the prompt for failure detection
    currentPromptText = prompt;
    expectedTranscript = prompt;  // Store expected transcript
    
    // Clear any existing timeout
    clearAudioCompletionTimeout();
    
    responseInProgress = true;
    
    // CRITICAL: For CONFIRMATION and CLOSE states, use STRICT instructions
    // Do NOT allow AI to go off-script or continue beyond the prompt
    let instructions = '';
    let maxTokens = 500;
    
    if (currentState === STATES.CONFIRMATION) {
      // Confirmation prompt must be delivered completely and uninterrupted
      // After user confirms, IMMEDIATELY proceed - no additional commentary
      instructions = `CRITICAL - CONFIRMATION STATE:

Say EXACTLY this text word-for-word:
"${prompt}"

STRICT RULES:
- Say ONLY the text above, nothing else
- DO NOT add commentary, thanks, or additional questions
- DO NOT say "Great, I've got that" or "We'll be in touch" - that comes AFTER confirmation
- DO NOT continue beyond this prompt
- After saying the text, STOP and wait for user confirmation
- If user says YES: Immediately proceed to "Is there anything else I can help with today?"
- If user says NO: Ask what needs correction

DO NOT DEVIATE FROM THE SCRIPT.`;
      maxTokens = 1200; // More tokens for long confirmation recap
    } else if (currentState === STATES.CLOSE) {
      // Close state - deliver goodbye cleanly
      instructions = `CRITICAL - CLOSE STATE:

Say EXACTLY this text word-for-word:
"${prompt}"

STRICT RULES:
- Say ONLY the text above, nothing else
- DO NOT add commentary or continue beyond this prompt
- After saying the text, the call is complete
- If user hangs up, that's expected behavior

DO NOT DEVIATE FROM THE SCRIPT.`;
      maxTokens = 300;
    } else {
      // Other states - FORCE EXACT OUTPUT
      // The AI has been going off-script. Use extremely strict formatting.
      instructions = `[ROBOT MODE - EXACT OUTPUT ONLY]

YOUR ENTIRE RESPONSE MUST BE:
"${prompt}"

RULES:
- You ARE A SCRIPT READER. You read scripts, nothing else.
- The ONLY words that can come out of your mouth are the exact words in quotes above.
- You may add "Okay, " or "Thanks, " at the very start. NOTHING ELSE.
- After saying the script, STOP. Do not say another word.
- Do NOT add commentary, questions, or helpful information.
- Do NOT say "You too", "Take care", "We've got all the details", or ANYTHING not in the script.
- If the script says "What's the service address?" - you say ONLY that.

ABSOLUTELY FORBIDDEN - you will be FIRED if you say:
- "next week" / "this week" / "Thursday" / any day name
- "lock in a time" / "schedule" / "appointment" / "confirmation"
- "We've got all the key details" / "our team will follow up"
- "You too" / "Take care" / any goodbye unless the script says goodbye
- ANY question that isn't in the script

OUTPUT THE SCRIPT TEXT. THEN STOP. NOTHING MORE.`;
      maxTokens = 200; // Reduce tokens even more to force very short response
    }
    
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: instructions,
        max_output_tokens: maxTokens
      }
    }));
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
    
    // CRITICAL RULES for ALL natural responses
    const forbiddenRules = `
FORBIDDEN - NEVER SAY:
- "next week" or "this week"
- "lock in a time" or "get you scheduled"
- "What day does next week work"
- "Thursday it is" or any day confirmation
- "we'll confirm everything"
- "let me pull up available times"
- Any scheduling language

You do NOT schedule. You only collect information.`;

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

${forbiddenRules}

Keep it SHORT. Two sentences max.`;
    } else if (action === 'answer_question') {
      instruction = `Caller asked: "${userInput}"

Answer briefly. You're intake only - don't schedule or promise times.
If you don't know specifics, say "I can take your info and have someone follow up."

${forbiddenRules}

Keep it SHORT. Two sentences max.`;
    } else if (action === 'handle_correction') {
      instruction = `Caller is correcting something: "${userInput}"

Current info: 
- Name: ${data.firstName || ''} ${data.lastName || ''}
- Phone: ${data.phone || 'not yet'}
- Email: ${data.email || 'not yet'}
- Address: ${data.address || 'not yet'}

Ask what needs fixing, confirm briefly, move on.

${forbiddenRules}

Keep it SHORT.`;
    }
    
    responseInProgress = true;
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
          callSid = msg.start.callSid;  // Store call SID for transfers
          console.log(`📞 Stream started: ${streamSid}`);
          console.log(`📞 Call SID: ${callSid}`);
          console.log(`📞 Stream config:`, JSON.stringify(msg.start, null, 2));
          
          // Store caller number if provided
          if (msg.start.customParameters?.callerNumber) {
            callerNumber = msg.start.customParameters.callerNumber;
            stateMachine.updateData('phone', callerNumber);
          }
          
          // Start audio pump FIRST
          console.log("🎵 Starting audio pump");
          pumpFrames();
          
          // Start global silence monitor to never leave caller in silence
          startGlobalSilenceMonitor();
          
          // Connect to OpenAI
          connectToOpenAI();
          
                  // Send greeting once stream is ready AND session is configured
          // If session is already configured, send greeting now
          // Otherwise, it will be sent when session.updated event arrives
          if (voiceInitialized && openaiWs?.readyState === WebSocket.OPEN && !greetingSent) {
            // Session already configured - send greeting now
            console.log("✅ Stream ready, session configured - sending greeting");
            sendGreeting();
          } else if (!voiceInitialized) {
            console.log("⏳ Stream ready, waiting for session configuration...");
          }
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
    const currentState = stateMachine.getState();
    console.log("📋 Call data collected:", JSON.stringify(data, null, 2));
    console.log(`📋 Final state: ${currentState}`);
    
    // Log to Google Sheets (non-blocking) - only if confirmation succeeded
    logCallIntake(data, currentState, {
      callId: streamSid || `CALL-${Date.now()}`,
      callerNumber: callerNumber
    }).catch(err => {
      console.error('❌ Failed to log to Google Sheets:', err.message);
    });
    
    if (paceTimer) clearInterval(paceTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    if (longSpeechTimer) clearTimeout(longSpeechTimer);
    clearSilenceRecoveryTimer();
    clearAudioCompletionTimeout();
    stopGlobalSilenceMonitor();
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

