// server-hybrid.js - OpenAI Realtime (text) + ElevenLabs TTS
require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const { Readable } = require("stream");
const { FieldValidator } = require("./field-validator");
const { estimateConfidence, inferFieldContext } = require("./confidence-estimator");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Default: Rachel
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01";

// Validate environment
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is required");
  process.exit(1);
}
if (!ELEVENLABS_API_KEY) {
  console.error("❌ ELEVENLABS_API_KEY is required");
  process.exit(1);
}

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Twilio webhook - returns TwiML to start media stream
app.post("/twilio/voice", (req, res) => {
  console.log("\n📞 Incoming call to /twilio/voice");
  console.log("From:", req.body.From);
  console.log("To:", req.body.To);
  
  try {
    const base = process.env.PUBLIC_BASE_URL;
    if (!base || !/^https:\/\/.+/i.test(base)) {
      console.error("❌ PUBLIC_BASE_URL missing/invalid:", base);
      const errorResponse = new twilio.twiml.VoiceResponse();
      errorResponse.say("We're sorry, the system is not configured properly. Please try again later.");
      return res.type("text/xml").send(errorResponse.toString());
    }

    const host = new URL(base).host;
    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();
    connect.stream({ url: `wss://${host}/hybrid/twilio` });

    const twiml = response.toString();
    console.log("✅ Sending TwiML:", twiml);
    return res.type("text/xml").send(twiml);
  } catch (err) {
    console.error("❌ Error in /twilio/voice:", err);
    const errorResponse = new twilio.twiml.VoiceResponse();
    errorResponse.say("We're sorry, an application error has occurred. Please try again later.");
    return res.type("text/xml").send(errorResponse.toString());
  }
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`✅ OpenAI API key configured`);
  console.log(`✅ ElevenLabs API key configured`);
  console.log(`✅ Public URL: ${process.env.PUBLIC_BASE_URL}`);
});

// WebSocket server for Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/hybrid/twilio" });

wss.on("connection", async (twilioWs, req) => {
  console.log("\n📞 New Twilio connection from:", req.socket.remoteAddress);
  
  let openaiWs = null;
  let streamSid = null;
  let callSid = null;
  let sessionReady = false;
  let greetingSent = false;  // Prevent duplicate greetings
  let streamStarted = false;  // Track if stream has started
  let lastAIResponse = "";  // Track last AI question for context
  let awaitingVerification = false;  // Flag to prevent OpenAI from processing during verification
  let pendingTranscription = null;  // Store transcription awaiting validation
  let activeResponseInProgress = false;  // Track if OpenAI is currently generating a response
  
  // Field validation and verification
  const fieldValidator = new FieldValidator();
  
  // Playback state for pacing
  let playBuffer = Buffer.alloc(0);
  let paceTimer = null;
  
  // Manual VAD state for detecting speech end
  let speechDetected = false;
  let silenceFrames = 0;
  const SILENCE_THRESHOLD = 0.015;  // RMS threshold for silence (INCREASED to reduce false triggers)
  const SILENCE_FRAMES_REQUIRED = 35;  // ~700ms at 20ms per frame (balanced for natural pauses)
  const MIN_SPEECH_FRAMES = 25;  // ~500ms minimum speech before commit (INCREASED - prevent false triggers from noise)
  const MAX_SPEECH_FRAMES = 500;  // ~10 seconds max per utterance (safety timeout)
  const WAIT_FOR_INITIAL_RESPONSE = 0;  // DISABLED - Don't auto-timeout, let user respond naturally
  let audioFrameCount = 0;
  let speechFrameCount = 0;  // Track how long user has been speaking
  let lastUserTranscript = "";  // Track last thing user said for hallucination detection
  
  // Connect to OpenAI Realtime API
  try {
    console.log("🔌 Connecting to OpenAI Realtime API...");
    openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    // Handle OpenAI connection open
    openaiWs.on("open", () => {
      console.log("✅ Connected to OpenAI Realtime API");
      
      // Configure session - MANUAL commit mode for pre-validation
      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],  // Keep both, but we'll only use text output
          instructions: `You are Zelda, a warm, friendly, and upbeat receptionist for RSE Energy. You're helpful and cheerful without being over-the-top. 

CRITICAL: You MUST speak ONLY in English at all times. Never switch to another language, even if the caller speaks in another language. Always respond in English.

Follow this exact script flow:

**0) GREETING:**
"Hi there! Thanks for calling RSE Energy. This is Zelda. How can I help you today?"

**1) SAFETY CHECK (ALWAYS ASK FIRST):**
"Before we dive in, is anyone in danger or do you smell gas or smoke?"
- If YES: "Please call emergency services now. I'll mark this as urgent for our team."
- If NO: Continue to step 2

**2) COLLECT BASICS (one at a time):**
- "Alright, I'll get a few quick details so we can help fast. What's your full name?"
- "What's the best number to reach you?"
- "What's your email in case we need to send a confirmation?"

**3) CONFIRM BASICS IMMEDIATELY:**
After collecting all three, say:
"Perfect, I have [Full Name] at [Phone Number] and [Email]. Is that right?"
- If unclear or they hesitate: "No problem, happy to spell that with you."
- If correct: Continue to step 4

**4) SERVICE ADDRESS:**
"What's the service address?"
Then immediately confirm: "That's [Address]. Correct?"

**5) CLIENT STATUS:**
"Have we helped you at this address before?"
- If NEW: "Welcome! I'll set you up as a new customer."
- If EXISTING: "Great, we have you on file."

**6) EQUIPMENT AND ISSUE (ask naturally, one at a time):**
- "What type of system do you have, if you know? Mini split, heat pump, or central AC?"
- "About how old is it?"
- "What seems to be the issue today?"
- "Has this happened before?"
- "Would you say it's not urgent, somewhat urgent, or very urgent?"

**7) FINAL RECAP:**
"Thanks. Here's what I have: [brief summary]. Does that sound right?"

**8) WRAP-UP:**
"Great! I'll log this so our team can schedule the visit. You'll get a confirmation by text or email. Anything else I can help with today?"

**9) CLOSING:**
"Thanks for calling RSE Energy. Have a great day!"

**BEHAVIOR RULES:**
- Always confirm personal info immediately after collecting it
- Speak in short, natural sentences
- Ask ONE question at a time
- Use natural pauses and occasional filler words ("um", "let me see")
- Keep tone warm, patient, and friendly
- Do NOT promise arrival times - say "a dispatcher will confirm"
- Always check for emergencies FIRST
- If you're unsure about what you heard (low confidence), ask the caller to spell it or confirm it
- For emails and phone numbers, ask for spelling/digit-by-digit if unclear
- For problem descriptions, repeat back what you heard and ask "Is that correct?"
- Only verify each field ONCE - don't loop verification unless caller requests
- End every call with a polite close`,
          voice: "alloy",  // Not used since we're doing text-only output
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",  // We'll ignore this
          input_audio_transcription: {
            model: "whisper-1"
          },
          turn_detection: null,  // DISABLE server VAD - we'll manually control when to generate responses
          temperature: 0.8,  // Slightly higher for more natural variation
          max_response_output_tokens: 4096
        }
      };
      
      openaiWs.send(JSON.stringify(sessionConfig));
      console.log("📤 Sent session configuration");
    });

    // High-precision audio pacing
    function pumpFrames() {
      if (paceTimer) return;
      
      const silenceFrame = Buffer.alloc(160, 0xFF);
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

    // Stream TTS from ElevenLabs and convert to μ-law
    async function speakWithElevenLabs(text) {
      try {
        if (!text || text.trim().length === 0) {
          console.log("⚠️  Empty text provided to TTS, skipping");
          return;
        }
        
        const displayText = text.length > 60 ? text.substring(0, 60) + "..." : text;
        console.log("🎙️ AI:", displayText);
        
        // ElevenLabs streaming API
        const response = await axios({
          method: 'post',
          url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
          headers: {
            'Accept': 'audio/mpeg',
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json'
          },
          data: {
            text: text,
            model_id: "eleven_turbo_v2_5",  // Fastest, lowest latency
            voice_settings: {
              stability: 0.3,              // Lower = more expressive/varied (more animated)
              similarity_boost: 0.75,       // Voice clarity
              style: 0.5,                   // Moderate style (less dramatic, more natural)
              use_speaker_boost: true       // Enhance clarity
            },
            optimize_streaming_latency: 4,  // Maximum optimization (0-4)
            output_format: "mp3_22050_32"   // Lower bitrate = faster streaming
          },
          responseType: 'stream'
        });

        // Stream MP3 -> μ-law conversion in real-time
        const mp3Stream = response.data;
        
        ffmpeg(mp3Stream)
          .inputFormat('mp3')
          .audioCodec('pcm_mulaw')
          .audioFrequency(8000)
          .audioChannels(1)
          .format('mulaw')
          .on('error', (err) => {
            console.error('❌ FFmpeg error:', err.message);
          })
          .on('end', () => {
            console.log("✅ TTS playback complete");
          })
          .pipe()
          .on('data', (chunk) => {
            // Stream μ-law chunks directly to playback buffer
            playBuffer = Buffer.concat([playBuffer, chunk]);
          });
        
      } catch (error) {
        console.error("❌ ElevenLabs error:", error.message);
        console.error("Stack trace:", error.stack);
        // Continue gracefully - don't crash the call
      }
    }

    // Helper function to calculate RMS of audio buffer
    function calculateRMS(buffer) {
      if (buffer.length === 0) return 0;
      const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const normalized = samples[i] / 32768.0;
        sum += normalized * normalized;
      }
      return Math.sqrt(sum / samples.length);
    }
    
    // Handle OpenAI messages
    openaiWs.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        switch (event.type) {
          case "session.created":
            console.log("🎯 OpenAI session created:", event.session.id);
            break;
            
          case "session.updated":
            console.log("✅ Session updated - hybrid mode with manual VAD enabled");
            sessionReady = true;
            
            // Send greeting if stream has already started
            if (streamStarted && !greetingSent) {
              greetingSent = true;
              setTimeout(() => {
                const greeting = "Hi there! Thanks for calling RSE Energy. This is Zelda. How can I help you today?";
                console.log("👋 Sending greeting");
                speakWithElevenLabs(greeting);
                
                // Add the greeting to conversation history so OpenAI knows we already said it
                const greetingItem = {
                  type: "conversation.item.create",
                  item: {
                    type: "message",
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: greeting
                      }
                    ]
                  }
                };
                openaiWs.send(JSON.stringify(greetingItem));
              }, 300);
            }
            break;
            
          case "conversation.item.created":
            // Silent - too verbose
            break;
            
          case "response.text.delta":
            // Accumulate text deltas for streaming
            if (event.delta) {
              if (!openaiWs.textBuffer) openaiWs.textBuffer = "";
              openaiWs.textBuffer += event.delta;
              
              console.log(`📨 Delta received: "${event.delta}" (buffer: ${openaiWs.textBuffer.length} chars)`);
            }
            break;
            
          case "response.text.done":
            // Speak the complete text when done (simpler and more reliable)
            if (openaiWs.textBuffer && openaiWs.textBuffer.trim().length > 0) {
              const completeText = openaiWs.textBuffer.trim();
              console.log(`🎙️ Complete response ready (${completeText.length} chars): ${completeText.substring(0, 60)}...`);
              
              if (!awaitingVerification) {
                speakWithElevenLabs(completeText);
                lastAIResponse = completeText;
              } else {
                console.log(`⏸️ Skipping TTS - verification in progress`);
              }
              
              openaiWs.textBuffer = "";
            }
            break;
            
          case "response.output_item.done":
            // Silent - handled by audio_transcript.done
            break;
            
          case "input_audio_buffer.speech_started":
            console.log("🎤 User started speaking (buffer event)");
            speechDetected = true;
            silenceFrames = 0;
            playBuffer = Buffer.alloc(0);  // Stop any AI playback
            break;
            
          case "input_audio_buffer.speech_stopped":
            console.log("🔇 User stopped speaking (buffer event)");
            speechDetected = false;
            break;
            
          case "input_audio_buffer.committed":
            console.log("✅ Audio buffer committed, waiting for transcription...");
            break;
            
          case "conversation.item.input_audio_transcription.completed":
            if (!event || !event.transcript) break; // Safety check
            
            const transcript = event.transcript;
            console.log(`📝 Raw transcription received: "${transcript}"`);
            
            // Store last user transcript for hallucination detection
            lastUserTranscript = transcript;
            
            // Check if user wants to CORRECT a previous field (go back)
            // THIS TAKES PRIORITY - check even during verification
            const correctionPhrases = [
              'that\'s not', 'that\'s wrong', 'that is wrong', 'no that\'s', 
              'change my', 'fix my', 'correct my', 'go back',
              'i said', 'i didn\'t say', 'not my name', 'wrong name'
            ];
            const isCorrection = correctionPhrases.some(phrase => transcript.toLowerCase().includes(phrase));
            
            if (isCorrection) {
              console.log(`🔄 CORRECTION DETECTED: "${transcript}"`);
              
              // Determine what field they want to correct
              if (transcript.toLowerCase().includes('name') || transcript.toLowerCase().includes('last')) {
                console.log(`📝 Resetting name fields for correction`);
                
                // Reset BOTH first and last name if either mentioned
                if (transcript.toLowerCase().includes('last')) {
                  fieldValidator.fields.last_name = null;
                  fieldValidator.verificationAttempts.last_name = 0;
                } else {
                  fieldValidator.fields.first_name = null;
                  fieldValidator.verificationAttempts.first_name = 0;
                }
                
                awaitingVerification = false;  // EXIT verification mode
                activeResponseInProgress = false;  // Allow new response
                
                const prompt = "No problem! Let's get that spelling right. Could you spell your last name slowly for me?";
                
                // Update conversation history FIRST
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  openaiWs.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "text", text: prompt }]
                    }
                  }));
                }
                
                speakWithElevenLabs(prompt);
                lastAIResponse = prompt;
                
                // Re-enter verification mode for the correction
                setTimeout(() => {
                  awaitingVerification = true;
                  console.log(`🎧 Now listening for corrected name spelling...`);
                }, 800);
                
                pendingTranscription = null;
                break;
              }
            }
            
            // If we're awaiting verification, handle the verification response
            if (awaitingVerification) {
              console.log(`📝 Processing as verification response`);
              
              const verification = fieldValidator.handleVerificationResponse(transcript);
              
              if (verification.success) {
                console.log(`✅ Verified: ${verification.normalizedValue}`);
                awaitingVerification = false;
                waitingForInitialResponse = false;  // Reset wait flag
                
                // Inject verified value into conversation and trigger response
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  // Check for race condition
                  if (activeResponseInProgress) {
                    console.log(`⏸️  Waiting for active response to complete before creating new one`);
                    setTimeout(() => {
                      if (!activeResponseInProgress && openaiWs.readyState === WebSocket.OPEN) {
                        activeResponseInProgress = true;
                        openaiWs.send(JSON.stringify({
                          type: "conversation.item.create",
                          item: {
                            type: "message",
                            role: "user",
                            content: [{ type: "input_text", text: verification.normalizedValue }]
                          }
                        }));
                        openaiWs.send(JSON.stringify({ type: "response.create" }));
                      }
                    }, 500);
                  } else {
                    activeResponseInProgress = true;
                    
                    // Get field name from the verification object BEFORE it's cleared
                    const verifiedFieldName = fieldValidator.awaitingVerification?.fieldName;
                    
                    // Special handling for names - spell them back for confirmation
                    if (verifiedFieldName === 'first_name' || verifiedFieldName === 'last_name') {
                      const spelledName = verification.normalizedValue.split('').join('-');
                      const confirmPrompt = `Thank you. Just to confirm the spelling, that's ${spelledName}. What's the best number to reach you?`;
                      
                      openaiWs.send(JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                          type: "message",
                          role: "assistant",
                          content: [{ type: "text", text: confirmPrompt }]
                        }
                      }));
                      
                      speakWithElevenLabs(confirmPrompt);
                      lastAIResponse = confirmPrompt;
                    } else {
                      openaiWs.send(JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                          type: "message",
                          role: "user",
                          content: [{ type: "input_text", text: verification.normalizedValue }]
                        }
                      }));
                      openaiWs.send(JSON.stringify({ type: "response.create" }));
                    }
                  }
                }
              } else if (verification.prompt) {
                console.log(`🔄 Re-verification needed`);
                
                // Don't immediately re-verify - reset awaiting flag so we can get fresh input
                awaitingVerification = false;
                
                speakWithElevenLabs(verification.prompt);
                
                // After speaking, wait briefly then re-enable verification listening
                setTimeout(() => {
                  awaitingVerification = true;
                  console.log(`🎧 Now listening for corrected verification response...`);
                }, 800);
                
                if (verification.shouldRetry) {
                  fieldValidator.clearVerification();
                }
              }
              
              pendingTranscription = null;
              break;
            }
            
            // Estimate confidence since OpenAI always returns 1.0
            const fieldContext = inferFieldContext(lastAIResponse);
            const confidenceResult = estimateConfidence(transcript, fieldContext);
            const estimatedConfidence = confidenceResult.confidence;
            
            // Log with estimated confidence and indicators
            const indicatorStr = confidenceResult.indicators.length > 0 
              ? ` [${confidenceResult.indicators.join(', ')}]` 
              : '';
            console.log(`📊 Confidence: ${estimatedConfidence.toFixed(2)}${indicatorStr} | Context: ${fieldContext}`);
            
            // SPECIAL: Check for farewell phrases - NEVER pass to OpenAI, could end call prematurely
            const isFarewell = confidenceResult.indicators.includes('farewell_phrase') || 
                              confidenceResult.indicators.includes('casual_bye');
            if (isFarewell) {
              console.log(`👋 Farewell detected with low confidence (${estimatedConfidence.toFixed(2)}) - ignoring as likely false transcription`);
              // Don't process - likely background noise transcribed incorrectly
              pendingTranscription = null;
              break;
            }
            
            // CRITICAL: Validate BEFORE OpenAI processes it
            if (fieldContext !== 'general' && estimatedConfidence < 0.60 && transcript.trim().length > 0) {
              console.log(`⚠️  LOW CONFIDENCE - Intercepting before OpenAI processes`);
              
              // Store pending transcription
              pendingTranscription = { transcript, fieldContext, confidence: estimatedConfidence };
              
              // Get appropriate verification prompt
              const captureResult = fieldValidator.captureField(fieldContext, transcript, estimatedConfidence);
              
              if (captureResult.needsVerify && captureResult.prompt) {
                awaitingVerification = true;
                console.log(`🔄 Requesting verification (attempt ${fieldValidator.verificationAttempts[fieldContext] || 0}): ${captureResult.prompt}`);
                
                // Add verification prompt to conversation history
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  openaiWs.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "text", text: captureResult.prompt }]
                    }
                  }));
                }
                
                // Speak the verification prompt WITHOUT letting OpenAI respond to original transcript
                speakWithElevenLabs(captureResult.prompt);
                console.log(`🎧 Now listening for verification response...`);
              }
              
              // DO NOT trigger response.create - we're handling this ourselves
              break;
            }
            
            // High confidence - validate the field data
            if (fieldContext !== 'general' && transcript.trim().length > 0) {
              const captureResult = fieldValidator.captureField(fieldContext, transcript, estimatedConfidence);
              
              // Even with high confidence, check if format validation failed
              if (captureResult.needsVerify && captureResult.prompt && !captureResult.alreadyVerified) {
                console.log(`⚠️  Format validation failed despite high confidence - requesting verification`);
                awaitingVerification = true;
                
                // Add verification prompt to conversation history
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  openaiWs.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "text", text: captureResult.prompt }]
                    }
                  }));
                }
                
                // Speak the verification prompt
                speakWithElevenLabs(captureResult.prompt);
                console.log(`🎧 Now listening for verification response...`);
                
                pendingTranscription = null;
                break;
              }
            }
            
            // Check if this is a meta-question about the system itself
            const metaQuestions = ['what are you doing', 'why are you', 'what is this', 'who are you', 'what is going on', 'stop', 'what do you want'];
            const isMetaQuestion = metaQuestions.some(q => transcript.toLowerCase().includes(q));
            
            if (isMetaQuestion) {
              console.log(`🤔 Meta-question detected - providing clarification`);
              const clarification = "I'm Zelda, the RSE Energy receptionist. I'm just collecting some basic information so our team can help with your HVAC issue. Let's continue - is anyone in danger or do you smell gas?";
              
              speakWithElevenLabs(clarification);
              
              // Add to conversation history
              if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: transcript }]
                  }
                }));
                openaiWs.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "text", text: clarification }]
                  }
                }));
              }
              
              pendingTranscription = null;
              break;
            }
            
            // Inject transcript as user message and trigger OpenAI response
            if (openaiWs && openaiWs.readyState === WebSocket.OPEN && !awaitingVerification) {
              // Check for race condition - don't create new response if one is active
              if (activeResponseInProgress) {
                console.log(`⏸️  Skipping response.create - active response in progress`);
                break;
              }
              
              activeResponseInProgress = true;
              openaiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: transcript }]
                }
              }));
              openaiWs.send(JSON.stringify({ type: "response.create" }));
            }
            
            pendingTranscription = null;
            break;
            
          case "response.audio_transcript.done":
            // Skip this - we now stream responses via text.delta for lower latency
            // Only use audio_transcript for tracking context
            if (event.transcript) {
              const aiResponse = event.transcript;
              lastAIResponse = aiResponse;  // Track for context
              
              // Don't speak here - already streamed via text.delta
              console.log(`📝 AI response complete (already streamed): ${aiResponse.substring(0, 60)}...`);
            }
            break;
            
          case "response.audio_transcript.done_old":
            // OLD CODE - keeping for reference but renamed to disable
            if (event.transcript) {
              const aiResponse = event.transcript;
              
              // CHECK: Does OpenAI's response mention data we never captured?
              // This detects hallucinations like "James Morrison" when user said gibberish
              const capturedNames = Object.values(fieldValidator.fields)
                .filter(f => f.field === 'first_name' || f.field === 'last_name')
                .map(f => f.final_value)
                .filter(v => v);
              
              // Look for name-like patterns in response that we didn't capture
              const nameInResponse = aiResponse.match(/(?:Got it|Thanks|Thank you|Perfect),?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
              if (nameInResponse && capturedNames.length === 0) {
                console.log(`⚠️  HALLUCINATION DETECTED: OpenAI mentioned name "${nameInResponse[1]}" but we never captured it!`);
                console.log(`🚫 Blocking hallucinated response - re-asking for name properly`);
                
                // Don't speak the hallucinated response
                // Instead, properly ask for the name
                const correction = "Sorry, I didn't catch your name clearly. Could you please tell me your full name?";
                speakWithElevenLabs(correction);
                lastAIResponse = correction;
                break;
              }
              
              // ALSO detect "You're welcome" when user didn't say thank you
              if (aiResponse.toLowerCase().includes("you're welcome") || aiResponse.toLowerCase().includes("you are welcome")) {
                // Check if last user transcript was actually a thank you
                if (!lastUserTranscript.toLowerCase().includes('thank')) {
                  console.log(`⚠️  HALLUCINATION: OpenAI said "you're welcome" but user didn't say thank you`);
                  console.log(`🚫 Blocking inappropriate 'you're welcome' response`);
                  // Don't speak this, OpenAI is confused - skip to next real response
                  activeResponseInProgress = false;  // Allow next response
                  break;
                }
              }
              
              // This code path disabled - using text.delta streaming instead
            }
            break;
            
          case "response.done":
            // Response complete - mark as no longer active
            activeResponseInProgress = false;
            console.log(`✅ Response complete - ready for next input`);
            break;
            
          case "error":
            console.error("❌ OpenAI error:", event.error);
            break;
            
          default:
            // Silent - only log important events above
            break;
        }
      } catch (err) {
        console.error("❌ Error parsing OpenAI message:", err);
        console.error("Stack trace:", err.stack);
        // Reset states to prevent getting stuck
        awaitingVerification = false;
        activeResponseInProgress = false;
      }
    });

    openaiWs.on("error", (error) => {
      console.error("❌ OpenAI WebSocket error:", error);
    });

    openaiWs.on("close", () => {
      console.log("🔌 OpenAI WebSocket closed");
      if (paceTimer) {
        clearTimeout(paceTimer);
        paceTimer = null;
      }
    });

  } catch (error) {
    console.error("❌ Failed to connect to OpenAI:", error);
    twilioWs.close();
    return;
  }

  // Handle Twilio messages
  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());
      
      switch (msg.event) {
        case "start":
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log("📞 Stream started:", { streamSid, callSid });
          pumpFrames();
          console.log("🎵 Started continuous audio stream");
          streamStarted = true;  // Mark that stream is ready
          break;
          
        case "media":
          // Manual VAD: detect speech end and commit buffer for transcription
          // IMPORTANT: Continue processing audio even during verification (removed !awaitingVerification check)
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN && sessionReady) {
            const mulawData = Buffer.from(msg.media.payload, 'base64');
            
            // Convert to PCM16 for RMS calculation
            const { muLawToPcm16 } = require('./g711');
            const pcm16 = muLawToPcm16(mulawData);
            const pcm16Buffer = Buffer.from(pcm16.buffer);
            const rms = calculateRMS(pcm16Buffer);
            
            audioFrameCount++;
            
            // Detect speech vs silence
            if (rms > SILENCE_THRESHOLD) {
              // Speech detected
              if (!speechDetected) {
                console.log(`🎤 Speech start detected (RMS: ${rms.toFixed(4)})`);
                speechDetected = true;
                speechFrameCount = 0;
              }
              silenceFrames = 0;
              speechFrameCount++;
              
              // Append to buffer
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: msg.media.payload
              };
              openaiWs.send(JSON.stringify(audioAppend));
              
              // Safety timeout: Force commit if speech is too long
              if (speechFrameCount >= MAX_SPEECH_FRAMES) {
                console.log(`⏱️  Max speech duration reached (${speechFrameCount * 20}ms), forcing commit`);
                speechDetected = false;
                silenceFrames = 0;
                speechFrameCount = 0;
                openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              }
            } else {
              // Silence
              if (speechDetected) {
                silenceFrames++;
                
                // Continue appending during hangover period
                const audioAppend = {
                  type: "input_audio_buffer.append",
                  audio: msg.media.payload
                };
                openaiWs.send(JSON.stringify(audioAppend));
                
                // End of speech detected - but only commit if we have minimum speech
                if (silenceFrames >= SILENCE_FRAMES_REQUIRED && speechFrameCount >= MIN_SPEECH_FRAMES) {
                  console.log(`🔇 Speech end detected after ${silenceFrames * 20}ms silence (total speech: ${speechFrameCount * 20}ms)`);
                  speechDetected = false;
                  silenceFrames = 0;
                  speechFrameCount = 0;
                  
                  // Commit buffer to trigger transcription
                  openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
                  console.log(`📤 Committed audio buffer for transcription`);
                } else if (silenceFrames >= SILENCE_FRAMES_REQUIRED && speechFrameCount < MIN_SPEECH_FRAMES) {
                  // Too short speech - probably a false trigger (cough, background noise)
                  console.log(`⏭️  Ignoring short speech burst (${speechFrameCount * 20}ms) - likely noise`);
                  speechDetected = false;
                  silenceFrames = 0;
                  speechFrameCount = 0;
                }
              }
              // No else needed - removed auto-timeout logic
            }
          }
          break;
          
        case "stop":
          console.log("📴 Stream stopped");
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            openaiWs.close();
          }
          if (paceTimer) {
            clearTimeout(paceTimer);
            paceTimer = null;
          }
          break;
          
        case "connected":
          console.log("📨 Twilio connected");
          break;
      }
    } catch (err) {
      console.error("❌ Error parsing Twilio message:", err);
      console.error("Stack trace:", err.stack);
    }
  });

  twilioWs.on("close", () => {
    console.log("🔌 Twilio WebSocket closed");
    
    // Log SharePoint-ready data
    const sharePointData = fieldValidator.getSharePointData();
    if (sharePointData.fields.length > 0 || sharePointData.verification_events.length > 0) {
      console.log("\n📊 Call Summary:");
      console.log("Captured Fields:", JSON.stringify(sharePointData.fields, null, 2));
      console.log("Verification Events:", JSON.stringify(sharePointData.verification_events, null, 2));
      console.log("\n💾 Ready for SharePoint logging\n");
    }
    
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

console.log("\n✨ Hybrid Voice Gateway Ready!");
console.log("📍 Webhook URL: " + process.env.PUBLIC_BASE_URL + "/twilio/voice");
console.log("🎙️ Using ElevenLabs for ultra-natural TTS");
console.log("🤖 Using OpenAI Realtime for conversation");
console.log("🎧 Waiting for calls...\n");
