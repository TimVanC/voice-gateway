// server-realtime.js - Twilio → OpenAI Realtime API relay (FIXED)
require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { pcm16ToMuLaw, muLawToPcm16, pcm16leBufferToInt16, int16ToPcm16leBuffer } = require("./g711");
const { downsampleTo8k, upsample8kTo24k } = require("./resample");
const { FieldValidator } = require("./field-validator");
const { estimateConfidence, inferFieldContext } = require("./confidence-estimator");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01";

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
  try {
    const base = process.env.PUBLIC_BASE_URL;
    if (!base || !/^https:\/\/.+/i.test(base)) {
      console.error("PUBLIC_BASE_URL missing/invalid:", base);
      return res.status(500).send("PUBLIC_BASE_URL missing or invalid");
    }

    const host = new URL(base).host;
    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();
    connect.stream({ url: `wss://${host}/realtime/twilio` });

    return res.type("text/xml").send(response.toString());
  } catch (err) {
    console.error("Error in /twilio/voice:", err);
    return res.status(500).send("Internal Server Error");
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
  console.log(`✅ Public URL: ${process.env.PUBLIC_BASE_URL}`);
});

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
  
  // Playback state for pacing
  let playBuffer = Buffer.alloc(0);
  let paceTimer = null;
  
  // Manual VAD state for detecting speech end
  let speechDetected = false;
  let silenceFrames = 0;
  const SILENCE_THRESHOLD = 0.01;  // RMS threshold for silence
  const SILENCE_FRAMES_REQUIRED = 40;  // ~800ms at 20ms per frame (INCREASED to give users more time)
  const MAX_SPEECH_FRAMES = 500;  // ~10 seconds max per utterance (safety timeout)
  let audioFrameCount = 0;
  let speechFrameCount = 0;  // Track how long user has been speaking
  
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
          instructions: `You are Zelda, a warm and professional receptionist for RSE Energy. Follow this exact script flow:

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
    
    // Handle audio deltas - OpenAI sends μ-law directly, just pace it!
    function handleRealtimeDelta(b64Mulaw) {
      const mulawBuf = Buffer.from(b64Mulaw, 'base64');  // Already μ-law at 8kHz!
      
      // Log first 10 deltas
      if (deltaCount < 10) {
        deltaCount++;
        console.log(`🔊 Delta ${deltaCount}: ${mulawBuf.length} bytes μ-law (8kHz)`);
      }
      
      // Queue for Twilio pacing (160 bytes per 20 ms)
      playBuffer = Buffer.concat([playBuffer, mulawBuf]);
      
      // Pacing is always running, no need to start it here
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
          case "session.created":
            console.log("🎯 OpenAI session created:", event.session.id);
            break;
            
          case "session.updated":
            // Extract the actual sample rate from session confirmation
            const inRate = event.session?.input_audio_format?.sample_rate_hz;
            const outRate = event.session?.output_audio_format?.sample_rate_hz;
            console.log("✅ Session updated with manual VAD - formats:", 
              `input=${inRate}Hz`, `output=${outRate}Hz`);
            
            if (outRate) realtimeOutputRate = outRate;
            sessionReady = true;
            
            // Send greeting manually with manual trigger
            setTimeout(() => {
              if (openaiWs.readyState === WebSocket.OPEN) {
                const greeting = "Thanks for calling RSE Energy. This is Zelda. How can I help today?";
                
                // Add greeting to conversation history
                openaiWs.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "text", text: greeting }]
                  }
                }));
                
                // Trigger audio generation
                openaiWs.send(JSON.stringify({
                  type: "response.create",
                  response: {
                    modalities: ["audio"],
                    instructions: `Say exactly: "${greeting}"`
                  }
                }));
                console.log("👋 Sent initial greeting");
              }
            }, 250);
            break;
            
          case "conversation.item.created":
            console.log("💬 Conversation item created");
            break;
            
          case "response.audio.delta":
            // FIX 2 & 4: Stream audio with proper pacing
            if (event.delta) {
              const deltaSize = Buffer.from(event.delta, 'base64').length;
              console.log(`🔊 Received audio delta: ${deltaSize} bytes (base64 decoded)`);
              handleRealtimeDelta(event.delta);
            }
            break;
            
          case "response.audio.done":
            console.log("✅ Audio response complete");
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
              
              const verification = fieldValidator.handleVerificationResponse(transcript);
              
              if (verification.success) {
                console.log(`✅ Verified: ${verification.normalizedValue}`);
                awaitingVerification = false;
                
                // Inject verified value into conversation and trigger response
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  openaiWs.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "user",
                      content: [{ type: "input_text", text: verification.normalizedValue }]
                    }
                  }));
                  openaiWs.send(JSON.stringify({ 
                    type: "response.create",
                    response: { modalities: ["audio", "text"] }
                  }));
                }
              } else if (verification.prompt) {
                console.log(`🔄 Re-verification needed`);
                // Speak verification prompt using OpenAI TTS
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  openaiWs.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "text", text: verification.prompt }]
                    }
                  }));
                  openaiWs.send(JSON.stringify({
                    type: "response.create",
                    response: {
                      modalities: ["audio"],
                      instructions: `Say exactly: "${verification.prompt}"`
                    }
                  }));
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
            
            // CRITICAL: Validate BEFORE OpenAI processes it
            if (fieldContext !== 'general' && estimatedConfidence < 0.60 && transcript.trim().length > 0) {
              console.log(`⚠️  LOW CONFIDENCE - Intercepting before OpenAI processes`);
              
              // Store pending transcription
              pendingTranscription = { transcript, fieldContext, confidence: estimatedConfidence };
              
              // Get appropriate verification prompt
              const captureResult = fieldValidator.captureField(fieldContext, transcript, estimatedConfidence);
              
              if (captureResult.needsVerify && captureResult.prompt) {
                awaitingVerification = true;
                
                // Add verification prompt to conversation history immediately
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
                setTimeout(() => {
                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                    openaiWs.send(JSON.stringify({
                      type: "response.create",
                      response: {
                        modalities: ["audio"],
                        instructions: `Say exactly: "${captureResult.prompt}"`
                      }
                    }));
                  }
                }, 200);
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
                
                // Add verification prompt to conversation history immediately
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
                setTimeout(() => {
                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                    openaiWs.send(JSON.stringify({
                      type: "response.create",
                      response: {
                        modalities: ["audio"],
                        instructions: `Say exactly: "${captureResult.prompt}"`
                      }
                    }));
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
              
              activeResponseInProgress = true;
              openaiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: transcript }]
                }
              }));
              openaiWs.send(JSON.stringify({ 
                type: "response.create",
                response: { modalities: ["audio", "text"] }
              }));
            }
            
            pendingTranscription = null;
            break;
            
          case "response.done":
            // Response complete - mark as no longer active
            activeResponseInProgress = false;
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
