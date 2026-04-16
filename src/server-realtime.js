// server-realtime.js - Twilio → OpenAI Realtime API relay (FIXED)
require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const { Readable } = require("stream");
const { pcm16ToMuLaw, muLawToPcm16, pcm16leBufferToInt16, int16ToPcm16leBuffer } = require("./g711");
const { downsampleTo8k, upsample8kTo24k } = require("./resample");
const { FieldValidator, getFieldThreshold } = require("./field-validator");
const { estimateConfidence, inferFieldContext } = require("./confidence-estimator");
const { BASE_URL, isProd } = require("./config/baseUrl");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// Validate environment
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is required");
  process.exit(1);
}

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Twilio webhook - returns TwiML to start media stream
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
    connect.stream({ url: `wss://${host}/realtime/twilio` });

    console.log(`⏱️  Webhook processed in ${Date.now() - webhookStart}ms`);
    return res.type("text/xml").send(response.toString());
  } catch (err) {
    console.error("❌ Error in /twilio/voice:", err);
    const errorResponse = new twilio.twiml.VoiceResponse();
    errorResponse.say("We're sorry, an error occurred.");
    return res.type("text/xml").send(errorResponse.toString());
  }
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start HTTP server with production hardening
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("\n✨ Realtime Voice Gateway Ready!");
  console.log(`📍 Webhook URL: ${BASE_URL}/twilio/voice`);
  console.log(`🤖 Using OpenAI Realtime (full duplex)`);
  console.log(`🎧 Waiting for calls...\n`);
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`✅ OpenAI API key configured`);
  console.log(`✅ Public URL: ${BASE_URL}`);
  console.log(`🌍 Environment: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
});

// Production-grade timeouts for Railway
server.keepAliveTimeout = 70000;
server.headersTimeout = 75000;

// WebSocket server for Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/realtime/twilio" });

wss.on("connection", async (twilioWs, req) => {
  console.log("\n📞 New Twilio connection from:", req.socket.remoteAddress);
  
  let openaiWs = null;
  let streamSid = null;
  let callSid = null;
  let sessionReady = false;
  let realtimeOutputRate = 24000;  // Default assumption; updated when session confirms
  let deltaCount = 0;
  let lastAIResponse = "";  // Track last AI question for context
  let awaitingVerification = false;  // Flag to prevent processing during verification
  let pendingTranscription = null;  // Store transcription awaiting validation
  let activeResponseInProgress = false;  // Track if OpenAI is currently generating a response
  
  // Field validation and verification
  const fieldValidator = new FieldValidator();
  let currentIntakeState = "greeting";
  let allowCurrentResponseAudio = null;
  let sessionOutputFormat = "g711_ulaw";
  let pendingMulawAudioChunks = [];
  let pendingEncodedAudioChunks = [];
  
  // Playback state for pacing
  let playBuffer = Buffer.alloc(0);
  let paceTimer = null;
  
  // Manual VAD state for detecting speech end
  let speechDetected = false;
  let silenceFrames = 0;
  const SILENCE_THRESHOLD = 0.01;  // RMS threshold for silence
  const SILENCE_FRAMES_REQUIRED = 30;  // ~600ms at 20ms per frame (REDUCED for faster responses)
  const MAX_SPEECH_FRAMES = 500;  // ~10 seconds max per utterance (safety timeout)
  const NO_SPEECH_TIMEOUT = 150;  // ~3 seconds - if no speech detected, assume user not responding
  let audioFrameCount = 0;
  let speechFrameCount = 0;  // Track how long user has been speaking
  let silentFramesSinceLastSpeech = 0;  // Track total silence after last speech

  function sendConversationText(role, text) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !text) return;
    const contentType = role === "user" ? "input_text" : "text";
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role,
        content: [{ type: contentType, text }]
      }
    }));
  }

  function getFieldLabel(fieldName) {
    const labels = {
      first_name: "first name",
      last_name: "last name",
      name: "name",
      phone: "phone number",
      email: "email",
      street: "street address",
      city: "city",
      state: "state",
      zip: "zip code",
      issue_description: "issue description"
    };
    return labels[fieldName] || fieldName || "field";
  }

  function formatEmailForSpeech(email) {
    return String(email || "")
      .toLowerCase()
      .replace(/@/g, " at ")
      .replace(/\./g, " dot ");
  }

  function formatPhoneForSpeech(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return digits ? digits.split("").join(" ") : String(phone || "");
  }

  function buildVerificationAcknowledgment(fieldName, value) {
    const safeValue = String(value || "").trim();
    switch (fieldName) {
      case "email":
        return `Got it, I have your email as ${formatEmailForSpeech(safeValue)}.`;
      case "phone":
        return `Got it, I have your phone number as ${formatPhoneForSpeech(safeValue)}.`;
      case "first_name":
        return `Got it, I have your first name as ${safeValue}.`;
      case "last_name":
        return `Got it, I have your last name as ${safeValue}.`;
      default:
        return `Got it, I have your ${getFieldLabel(fieldName)} as ${safeValue}.`;
    }
  }

  function inferIntakeStateFromAssistantText(text) {
    const lowered = String(text || "").toLowerCase();
    if (!lowered) return currentIntakeState;
    if (/thanks for calling|how can i help/.test(lowered)) return "greeting";
    if (/here'?s what i have|does that sound right|is that right/.test(lowered)) return "recap";
    if (/have a great day|goodbye/.test(lowered)) return "closing";
    if (/full name|first and last name|your name/.test(lowered)) return "collecting_name";
    if (/issue today|what seems to be the issue|problem today|what's going on/.test(lowered)) return "collecting_issue";
    if (/availability|what time works|best time|time window/.test(lowered)) return "collecting_availability";
    return currentIntakeState;
  }

  function isShortDeclarativeResponse(text) {
    const candidate = String(text || "").trim();
    if (!candidate) return false;
    if (candidate.includes("?")) return false;
    const words = candidate.split(/\s+/).filter(Boolean);
    return words.length >= 2 && words.length <= 28 && candidate.length <= 180 && /[a-z]/i.test(candidate);
  }

  function isDomainRelevantOutput(text) {
    const candidate = String(text || "").trim();
    if (!candidate) return false;
    const lowered = candidate.toLowerCase();
    const strictStates = new Set(["greeting", "recap", "closing"]);
    const declarativeAllowStates = new Set(["collecting_name", "collecting_issue", "collecting_availability"]);
    const closing = /\b(thanks for calling|thank you for calling|have a great day|goodbye|anything else)\b/;
    const contact = /\b(name|phone|number|email|address|contact|reach|spell|digit)\b|@/;
    const issue = /\b(issue|problem|service|repair|hvac|heating|cooling|system|gas|smoke|urgent|danger)\b/;
    const scheduling = /\b(schedule|scheduling|appointment|dispatcher|visit|availability|time window)\b/;
    const capturedValues = fieldValidator
      .getAllFields()
      .map((field) => String(field.final_value || "").toLowerCase().trim())
      .filter((value) => value.length >= 3);
    const mentionsCapturedValue = capturedValues.some((value) => lowered.includes(value));
    const keywordMatch = closing.test(lowered) || contact.test(lowered) || issue.test(lowered) || scheduling.test(lowered) || mentionsCapturedValue;
    if (keywordMatch) return true;
    if (!strictStates.has(currentIntakeState) && declarativeAllowStates.has(currentIntakeState) && isShortDeclarativeResponse(candidate)) {
      return true;
    }
    return false;
  }

  function startModelResponse(modalities = ["audio", "text"], instructions) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    activeResponseInProgress = true;
    allowCurrentResponseAudio = null;
    pendingMulawAudioChunks = [];
    pendingEncodedAudioChunks = [];
    const response = { modalities };
    if (instructions) response.instructions = instructions;
    openaiWs.send(JSON.stringify({ type: "response.create", response }));
  }

  function triggerNextQuestionAfterVerification(fieldName, normalizedValue) {
    const assistantAck = buildVerificationAcknowledgment(fieldName, normalizedValue);
    sendConversationText("user", normalizedValue);
    sendConversationText("assistant", assistantAck);
    currentIntakeState = inferIntakeStateFromAssistantText(assistantAck);
    startModelResponse(
      ["audio", "text"],
      `The caller's ${getFieldLabel(fieldName)} is verified as "${normalizedValue}" and already acknowledged as: "${assistantAck}".
Ask only the next intake question. Do not ask for this ${getFieldLabel(fieldName)} again.`
    );
  }

  async function detectMp3SampleRate(mp3Buffer) {
    const tempFilePath = path.join(os.tmpdir(), `voice-gateway-rt-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
    try {
      await fs.writeFile(tempFilePath, mp3Buffer);
      const metadata = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(tempFilePath, (err, data) => {
          if (err) return reject(err);
          resolve(data);
        });
      });
      const audioStream = (metadata.streams || []).find((stream) => stream.codec_type === "audio");
      const parsedRate = Number(audioStream?.sample_rate);
      return Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 22050;
    } finally {
      await fs.unlink(tempFilePath).catch(() => {});
    }
  }

  async function decodeCompressedToPcm16(audioBuffer) {
    const compressedStream = Readable.from(audioBuffer);
    return new Promise((resolve, reject) => {
      const pcmChunks = [];
      ffmpeg(compressedStream)
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .format("s16le")
        .on("error", (err) => reject(err))
        .on("end", () => resolve(Buffer.concat(pcmChunks)))
        .pipe()
        .on("data", (chunk) => pcmChunks.push(chunk))
        .on("error", (err) => reject(err));
    });
  }

  async function normalizeAudioChunkToMulaw(chunkBuffer) {
    if (sessionOutputFormat === "g711_ulaw") {
      return chunkBuffer;
    }
    if (sessionOutputFormat === "pcm16") {
      const pcmInt16 = pcm16leBufferToInt16(chunkBuffer);
      const downsampled = downsampleTo8k(pcmInt16, realtimeOutputRate || 24000);
      return pcm16ToMuLaw(downsampled);
    }
    // Defensive fallback: detect sample rate for compressed payloads and downsample.
    const detectedRate = await detectMp3SampleRate(chunkBuffer);
    const pcm16 = await decodeCompressedToPcm16(chunkBuffer);
    const pcmInt16 = pcm16leBufferToInt16(pcm16);
    const downsampled = downsampleTo8k(pcmInt16, detectedRate);
    return pcm16ToMuLaw(downsampled);
  }

  async function flushPendingAudioIfAllowed() {
    if (allowCurrentResponseAudio !== true) return;
    if (pendingEncodedAudioChunks.length > 0) {
      const encodedBuffer = Buffer.concat(pendingEncodedAudioChunks);
      try {
        const mulawBuffer = await normalizeAudioChunkToMulaw(encodedBuffer);
        pendingMulawAudioChunks.push(mulawBuffer);
      } catch (err) {
        console.error("❌ Failed to normalize encoded model audio:", err.message);
      } finally {
        pendingEncodedAudioChunks = [];
      }
    }
    if (pendingMulawAudioChunks.length > 0) {
      playBuffer = Buffer.concat([playBuffer, ...pendingMulawAudioChunks]);
      pendingMulawAudioChunks = [];
    }
  }
  
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
      
      // FIX 1: Configure session FIRST with EXPLICIT 8kHz format objects
      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: `You are Zelda, a warm and professional receptionist for RSE Energy.

CRITICAL: You MUST speak ONLY in English at all times. Never switch to another language, even if the caller speaks in another language. Always respond in English.

Follow this exact script flow:

**0) GREETING:**
"Thanks for calling RSE Energy. This is Zelda. How can I help today?"

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
- Keep tone warm, patient, and friendly
- Do NOT promise arrival times - say "a dispatcher will confirm"
- Always check for emergencies FIRST
- Spell back details only when unsure or caller requests
- End every call with a polite close`,
          voice: "alloy",
          input_audio_format: "g711_ulaw",   // Native 8kHz μ-law support!
          output_audio_format: "g711_ulaw",  // Native 8kHz μ-law support!
          input_audio_transcription: {
            model: "whisper-1"
          },
          turn_detection: null,  // DISABLE server VAD - manual control for pre-validation
          temperature: 0.7,
          max_response_output_tokens: 4096
        }
      };
      
      openaiWs.send(JSON.stringify(sessionConfig));
      console.log("📤 Sent session configuration, waiting for confirmation...");
    });

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
    
    // Handle audio deltas. Buffer until text relevance decision is made.
    function handleRealtimeDelta(base64Audio) {
      const audioBuf = Buffer.from(base64Audio, "base64");
      
      // Log first 10 deltas
      if (deltaCount < 10) {
        deltaCount++;
        console.log(`🔊 Delta ${deltaCount}: ${audioBuf.length} bytes format=${sessionOutputFormat}`);
      }

      if (sessionOutputFormat === "g711_ulaw") {
        pendingMulawAudioChunks.push(audioBuf);
      } else {
        pendingEncodedAudioChunks.push(audioBuf);
      }
    }
    
    function pumpFrames() {
      // Start pacing loop if not already running
      if (paceTimer) return;
      
      // μ-law silence byte is 0xFF (not 0x00!)
      const silenceFrame = Buffer.alloc(160, 0xFF);
      
      // High-precision timer using hrtime for drift correction
      let startTime = process.hrtime.bigint();
      let frameCount = 0;
      
      function sendNextFrame() {
        if (twilioWs.readyState !== WebSocket.OPEN) {
          paceTimer = null;
          return;
        }
        
        // Send frame
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
        
        // Calculate next frame time with drift correction
        frameCount++;
        const expectedTime = startTime + BigInt(frameCount * 20_000_000); // 20ms in nanoseconds
        const currentTime = process.hrtime.bigint();
        const drift = Number(expectedTime - currentTime) / 1_000_000; // Convert to ms
        
        // Schedule next frame with drift correction (clamp between 1-40ms)
        const nextDelay = Math.max(1, Math.min(40, Math.round(20 + drift)));
        paceTimer = setTimeout(sendNextFrame, nextDelay);
      }
      
      // Start the loop
      paceTimer = setTimeout(sendNextFrame, 20);
    }

    // Handle OpenAI messages
    openaiWs.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        switch (event.type) {
          case "response.created":
            allowCurrentResponseAudio = null;
            pendingMulawAudioChunks = [];
            pendingEncodedAudioChunks = [];
            break;

          case "session.created":
            console.log("🎯 OpenAI session created:", event.session.id);
            break;
            
          case "session.updated":
            // Extract the actual sample rate from session confirmation
            const inRate = event.session?.input_audio_format?.sample_rate_hz;
            const outRate = event.session?.output_audio_format?.sample_rate_hz;
            const outFormat = typeof event.session?.output_audio_format === "string"
              ? event.session.output_audio_format
              : event.session?.output_audio_format?.format || sessionOutputFormat;
            console.log("✅ Session updated with manual VAD - formats:", 
              `input=${inRate}Hz`, `output=${outRate}Hz`, `format=${outFormat}`);
            
            if (outRate) realtimeOutputRate = outRate;
            if (outFormat) sessionOutputFormat = outFormat;
            sessionReady = true;
            
            // Send greeting manually with manual trigger
            setTimeout(() => {
              if (openaiWs.readyState === WebSocket.OPEN) {
                const greeting = "Thanks for calling RSE Energy. This is Zelda. How can I help today?";
                lastAIResponse = greeting;
                currentIntakeState = inferIntakeStateFromAssistantText(greeting);
                
                // Add greeting to conversation history
                sendConversationText("assistant", greeting);
                
                // Trigger audio generation
                startModelResponse(["audio"], `Say exactly: "${greeting}"`);
                console.log("👋 Sent initial greeting");
              }
            }, 250);
            break;
            
          case "conversation.item.created":
            console.log("💬 Conversation item created");
            break;
            
          case "response.audio.delta":
            if (event.delta) {
              const deltaSize = Buffer.from(event.delta, 'base64').length;
              console.log(`🔊 Received audio delta: ${deltaSize} bytes (base64 decoded)`);
              handleRealtimeDelta(event.delta);
            }
            break;
            
          case "response.audio.done":
            console.log("✅ Audio response complete");
            if (allowCurrentResponseAudio === true) {
              flushPendingAudioIfAllowed().catch((err) => {
                console.error("❌ Failed to flush pending audio:", err.message);
              });
            } else if (allowCurrentResponseAudio === false) {
              pendingMulawAudioChunks = [];
              pendingEncodedAudioChunks = [];
              if (twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
              }
            }
            // Send mark to Twilio
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({
                event: "mark",
                streamSid: streamSid,
                mark: { name: "audio_done" }
              }));
            }
            break;
            
          case "response.text.delta":
            // Log the text being generated
            if (event.delta) {
              process.stdout.write(event.delta);
            }
            break;
            
          case "response.text.done":
            if (event.text) {
              console.log("\n📝 AI said:", event.text);
              lastAIResponse = event.text;  // Track for context inference
              currentIntakeState = inferIntakeStateFromAssistantText(event.text);
              if (isDomainRelevantOutput(event.text)) {
                allowCurrentResponseAudio = true;
                flushPendingAudioIfAllowed().catch((err) => {
                  console.error("❌ Failed to flush domain-approved audio:", err.message);
                });
              } else {
                allowCurrentResponseAudio = false;
                pendingMulawAudioChunks = [];
                pendingEncodedAudioChunks = [];
                console.warn(`🚫 Discarded off-domain model output: "${event.text}"`);
              }
            }
            break;
            
          case "input_audio_buffer.speech_started":
            console.log("🎤 User started speaking (buffer event)");
            speechDetected = true;
            silenceFrames = 0;
            playBuffer = Buffer.alloc(0);  // Clear playback buffer on barge-in
            break;
            
          case "input_audio_buffer.speech_stopped":
            console.log("🔇 User stopped speaking (buffer event)");
            speechDetected = false;
            break;
            
          case "input_audio_buffer.committed":
            console.log("✅ Audio buffer committed, waiting for transcription...");
            break;
            
          case "conversation.item.input_audio_transcription.completed":
            if (!event || !event.transcript) break;
            
            const transcript = event.transcript;
            console.log(`📝 Raw transcription received: "${transcript}"`);
            
            // If we're awaiting verification, handle the verification response
            if (awaitingVerification) {
              console.log(`📝 Processing as verification response`);
              
              const verificationContext = fieldValidator.getCurrentVerification();
              const verification = fieldValidator.handleVerificationResponse(transcript);
              
              if (verification.success) {
                console.log(`✅ Verified: ${verification.normalizedValue}`);
                awaitingVerification = false;
                
                // Inject verified user value + assistant acknowledgment, then ask next question.
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  triggerNextQuestionAfterVerification(
                    verificationContext?.fieldName,
                    verification.normalizedValue
                  );
                }
              } else if (verification.prompt) {
                console.log(`🔄 Re-verification needed`);
                // Speak verification prompt using OpenAI TTS
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  sendConversationText("assistant", verification.prompt);
                  startModelResponse(["audio"], `Say exactly: "${verification.prompt}"`);
                }
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
            const qualitySignalsPoor = confidenceResult.indicators.includes('transcription_artifact') ||
              confidenceResult.indicators.includes('gibberish_pattern') ||
              confidenceResult.indicators.includes('multiple_question_marks') ||
              confidenceResult.indicators.includes('repeated_words');
            const fieldThreshold = getFieldThreshold(fieldContext);
            
            // CRITICAL: Validate BEFORE OpenAI processes it using field-specific thresholds.
            if (fieldContext !== 'general' && transcript.trim().length > 0 && estimatedConfidence < fieldThreshold) {
              console.log(`⚠️  LOW CONFIDENCE - Intercepting before OpenAI processes`);
              
              // Store pending transcription
              pendingTranscription = { transcript, fieldContext, confidence: estimatedConfidence };
              
              // Get appropriate verification prompt
              const captureResult = fieldValidator.captureField(fieldContext, transcript, estimatedConfidence, {
                qualityPoor: qualitySignalsPoor || estimatedConfidence < 0.40,
                indicators: confidenceResult.indicators
              });
              
              if (captureResult.needsVerify && captureResult.prompt) {
                awaitingVerification = true;
                
                // Add verification prompt to conversation history immediately
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  sendConversationText("assistant", captureResult.prompt);
                }
                
                // Speak the verification prompt WITHOUT letting OpenAI respond to original transcript
                setTimeout(() => {
                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                    startModelResponse(["audio"], `Say exactly: "${captureResult.prompt}"`);
                  }
                }, 200);
              }
              
              // DO NOT trigger response.create - we're handling this ourselves
              break;
            }
            
            // High confidence - validate the field data
            if (fieldContext !== 'general' && transcript.trim().length > 0) {
              const captureResult = fieldValidator.captureField(fieldContext, transcript, estimatedConfidence, {
                qualityPoor: qualitySignalsPoor || estimatedConfidence < 0.40,
                indicators: confidenceResult.indicators
              });
              
              // Even with high confidence, check if format validation failed
              if (captureResult.needsVerify && captureResult.prompt && !captureResult.alreadyVerified) {
                console.log(`⚠️  Format validation failed despite high confidence - requesting verification`);
                awaitingVerification = true;
                
                // Add verification prompt to conversation history immediately
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  sendConversationText("assistant", captureResult.prompt);
                }
                
                // Speak the verification prompt
                setTimeout(() => {
                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                    startModelResponse(["audio"], `Say exactly: "${captureResult.prompt}"`);
                  }
                }, 200);
                
                pendingTranscription = null;
                break;
              }
            }
            
            // Inject transcript as user message and trigger OpenAI response
            if (openaiWs && openaiWs.readyState === WebSocket.OPEN && !awaitingVerification) {
              // Check for race condition - don't create new response if one is active
              if (activeResponseInProgress) {
                console.log(`⏸️  Skipping response.create - active response in progress`);
                break;
              }
              
              sendConversationText("user", transcript);
              startModelResponse(["audio", "text"]);
            }
            
            pendingTranscription = null;
            break;
            
          case "response.done":
            // Response complete - mark as no longer active
            activeResponseInProgress = false;
            pendingMulawAudioChunks = [];
            pendingEncodedAudioChunks = [];
            console.log("✅ Response complete - ready for next input");
            break;
            
          case "error":
            console.error("❌ OpenAI error:", event.error);
            break;
            
          default:
            // Uncomment to see all events:
            // console.log("📨 OpenAI event:", event.type);
            break;
        }
      } catch (err) {
        console.error("❌ Error parsing OpenAI message:", err);
      }
    });

    // Handle OpenAI errors
    openaiWs.on("error", (error) => {
      console.error("❌ OpenAI WebSocket error:", error);
    });

    // Handle OpenAI close
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
          
          // Start continuous audio pacing immediately
          pumpFrames();
          console.log("🎵 Started continuous audio stream to Twilio");
          break;
          
        case "media":
          // Manual VAD: detect speech end and commit buffer for transcription
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN && sessionReady && !awaitingVerification) {
            const mulawData = Buffer.from(msg.media.payload, 'base64');
            
            // Convert to PCM16 for RMS calculation
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
                
                // End of speech detected
                if (silenceFrames >= SILENCE_FRAMES_REQUIRED) {
                  console.log(`🔇 Speech end detected after ${silenceFrames * 20}ms silence (total speech: ${speechFrameCount * 20}ms)`);
                  speechDetected = false;
                  silenceFrames = 0;
                  speechFrameCount = 0;
                  
                  // Commit buffer to trigger transcription
                  openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
                  console.log(`📤 Committed audio buffer for transcription`);
                }
              }
            }
          }
          break;
          
        case "mark":
          // Audio playback marker from Twilio
          break;
          
        case "stop":
          console.log("📴 Stream stopped");
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            // Commit any pending audio
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
          
        default:
          console.log("📨 Twilio event:", msg.event);
          break;
      }
    } catch (err) {
      console.error("❌ Error parsing Twilio message:", err);
    }
  });

  // Handle Twilio close
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

  // Handle Twilio errors
  twilioWs.on("error", (error) => {
    console.error("❌ Twilio WebSocket error:", error);
  });
});

console.log("\n✨ Voice Gateway Ready!");
console.log("📍 Webhook URL: " + process.env.PUBLIC_BASE_URL + "/twilio/voice");
console.log("🎧 Waiting for calls...\n");
