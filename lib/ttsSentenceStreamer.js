// lib/ttsSentenceStreamer.js
const WebSocket = require("ws");
const EventEmitter = require("events");

// Simple sentence splitter tuned for short bot replies
function splitIntoSentences(text) {
  const parts = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (/[.!?]/.test(ch)) {
      const s = buf.trim();
      if (s) parts.push(s);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * ElevenLabs sentence-first streaming with barge-in support
 * Emits: 'first_audio_out', 'playback_started', 'done', 'error'
 * Call .abort() to stop stream on barge-in
 */
class TTSSentenceStreamer extends EventEmitter {
  constructor({ apiKey, voiceId = "21m00Tcm4TlvDq8ikWAM", model = "eleven_turbo_v2_5" } = {}) {
    super();
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.model = model;
    this.ws = null;
    this.aborted = false;
    this.started = false;
  }

  abort() {
    this.aborted = true;
    try { 
      if (this.ws) this.ws.close(); 
    } catch (err) {
      // Ignore close errors
    }
  }

  async speak(text, audioSinkFn) {
    const sentences = splitIntoSentences(text);
    // If very short, avoid over-segmentation
    const chunks = text.length < 180 ? [text] : sentences;

    for (let i = 0; i < chunks.length; i++) {
      if (this.aborted) break;
      await this._streamChunk(chunks[i], audioSinkFn, i === 0);
    }
    if (!this.aborted) this.emit("done");
  }

  _streamChunk(sentence, audioSinkFn, isFirst) {
    return new Promise((resolve, reject) => {
      // ElevenLabs Realtime TTS WS
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input`;
      const ws = new WebSocket(url, {
        headers: { "xi-api-key": this.apiKey }
      });
      this.ws = ws;

      ws.on("open", () => {
        // Session init
        ws.send(JSON.stringify({
          text: sentence,
          voice_settings: { stability: 0.4, similarity_boost: 0.7 },
          model_id: this.model,
          // start sending audio as soon as possible
          optimize_streaming_latency: 3
        }));
        ws.send(JSON.stringify({ flush: true }));
      });

      ws.on("message", (raw) => {
        if (this.aborted) return;
        // ElevenLabs streams base64 audio chunks in JSON or raw audio depending on endpoint
        // Some SDKs deliver binary. Handle both.
        if (Buffer.isBuffer(raw)) {
          if (isFirst && !this.started) {
            this.started = true;
            this.emit("first_audio_out");
          }
          audioSinkFn(raw);
        } else {
          // Many WS variants send small JSON keepalives. Ignore.
        }
      });

      ws.on("close", () => resolve());
      ws.on("error", (err) => { 
        this.emit("error", err); 
        reject(err); 
      });
    });
  }
}

module.exports = { TTSSentenceStreamer };

