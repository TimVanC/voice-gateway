// server-realtime.js - Twilio → OpenAI Realtime API relay (FIXED)
require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { pcm16ToMuLaw, muLawToPcm16, pcm16leBufferToInt16, int16ToPcm16leBuffer } = require("./g711");

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
      
      // FIX 1: Configure session FIRST and WAIT for confirmation
      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: "You are a polite and efficient HVAC receptionist. Your job is to collect the following information from callers: 1) Full name, 2) Phone number, 3) Service address (including city and zip), 4) Type of system (furnace, AC, heat pump, etc), 5) Brief description of the issue. Always confirm details back to the caller clearly. Be warm but concise. If the caller mentions an emergency (gas smell, no heat in winter, water leak), prioritize accordingly and let them know help is coming soon.",
          voice: "alloy",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
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

    // FIX 2 & 4: Handle audio deltas with proper pacing
    function handleRealtimeDelta(b64Pcm) {
      const pcmBuf = Buffer.from(b64Pcm, 'base64');           // PCM16LE bytes
      console.log(`   → PCM16 buffer: ${pcmBuf.length} bytes (${pcmBuf.length/2} samples)`);
      
      const pcmInt16 = pcm16leBufferToInt16(pcmBuf);          // Int16Array
      console.log(`   → First few samples: [${Array.from(pcmInt16.slice(0, 8)).join(', ')}]`);
      
      const mulaw = pcm16ToMuLaw(pcmInt16);                   // μ-law bytes
      console.log(`   → μ-law buffer: ${mulaw.length} bytes`);
      
      playBuffer = Buffer.concat([playBuffer, mulaw]);
      console.log(`   → Total playback buffer: ${playBuffer.length} bytes`);
      pumpFrames();
    }
    
    function pumpFrames() {
      // Start pacing loop if not already running
      if (paceTimer) return;
      
      paceTimer = setInterval(() => {
        // Send exactly 160 bytes per 20ms
        if (playBuffer.length >= 160) {
          const chunk = playBuffer.subarray(0, 160);
          playBuffer = playBuffer.subarray(160);
          
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: chunk.toString('base64') }
            }));
          }
        } else if (playBuffer.length === 0) {
          // Nothing left, stop pacing
          clearInterval(paceTimer);
          paceTimer = null;
        }
      }, 20); // Exactly 20ms per frame
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
            console.log("✅ Session updated and ready");
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
            // Clear playback buffer on barge-in
            playBuffer = Buffer.alloc(0);
            if (paceTimer) {
              clearInterval(paceTimer);
              paceTimer = null;
            }
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
        clearInterval(paceTimer);
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
          break;
          
        case "media":
          // FIX 3 & 5: Properly decode μ-law to PCM16LE for OpenAI
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN && sessionReady) {
            const mulawBuf = Buffer.from(msg.media.payload, 'base64');
            const pcmInt16 = muLawToPcm16(mulawBuf);              // Int16Array
            const pcmLE = int16ToPcm16leBuffer(pcmInt16);         // Buffer (LE)
            
            const audioAppend = {
              type: "input_audio_buffer.append",
              audio: pcmLE.toString('base64')
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
            clearInterval(paceTimer);
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
      clearInterval(paceTimer);
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
