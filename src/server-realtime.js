// server-realtime.js - Twilio → OpenAI Realtime API relay (FIXED)
require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { pcm16ToMuLaw, muLawToPcm16, pcm16leBufferToInt16, int16ToPcm16leBuffer } = require("./g711");
const { downsampleTo8k, upsample8kTo24k } = require("./resample");

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
  
  // Playback state for pacing
  let playBuffer = Buffer.alloc(0);
  let paceTimer = null;
  
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
          instructions: "You are a polite and efficient HVAC receptionist. Your job is to collect the following information from callers: 1) Full name, 2) Phone number, 3) Service address (including city and zip), 4) Type of system (furnace, AC, heat pump, etc), 5) Brief description of the issue. Always confirm details back to the caller clearly. Be warm but concise. If the caller mentions an emergency (gas smell, no heat in winter, water leak), prioritize accordingly and let them know help is coming soon.",
          voice: "alloy",
          input_audio_format: "g711_ulaw",   // Native 8kHz μ-law support!
          output_audio_format: "g711_ulaw",  // Native 8kHz μ-law support!
          input_audio_transcription: {
            model: "whisper-1"
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          },
          temperature: 0.7,
          max_response_output_tokens: 4096
        }
      };
      
      openaiWs.send(JSON.stringify(sessionConfig));
      console.log("📤 Sent session configuration, waiting for confirmation...");
    });

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
            console.log("✅ Session updated - formats:", 
              `input=${inRate}Hz`, `output=${outRate}Hz`);
            
            if (outRate) realtimeOutputRate = outRate;
            sessionReady = true;
            
            // NOW it's safe to request greeting
            setTimeout(() => {
              if (openaiWs.readyState === WebSocket.OPEN) {
                const greeting = {
                  type: "response.create",
                  response: {
                    modalities: ["audio", "text"],
                    instructions: "Greet the caller warmly and ask for their name. Keep it brief: 'Hi! Thanks for calling. I can help schedule a service appointment. What's your name?'"
                  }
                };
                openaiWs.send(JSON.stringify(greeting));
                console.log("👋 Sent initial greeting request");
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
            }
            break;
            
          case "input_audio_buffer.speech_started":
            console.log("🎤 User started speaking");
            // Clear playback buffer on barge-in (but keep pacing running for silence)
            playBuffer = Buffer.alloc(0);
            break;
            
          case "input_audio_buffer.speech_stopped":
            console.log("🔇 User stopped speaking");
            break;
            
          case "conversation.item.input_audio_transcription.completed":
            console.log("📝 Transcription:", event.transcript);
            break;
            
          case "response.done":
            console.log("✅ Response complete");
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
          // Pass μ-law directly to OpenAI (no conversion needed!)
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN && sessionReady) {
            const audioAppend = {
              type: "input_audio_buffer.append",
              audio: msg.media.payload  // Already base64 μ-law from Twilio!
            };
            openaiWs.send(JSON.stringify(audioAppend));
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
