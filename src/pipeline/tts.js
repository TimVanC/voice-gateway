/**
 * Streaming text-to-speech returning 8 kHz mu-law, behind one interface.
 *
 *   const tts = createTts({ provider: 'elevenlabs' | 'cartesia' });
 *   await tts.open();                      // one socket per call (or per process for the cache)
 *   const u = tts.speak();                 // one utterance = one provider context
 *   u.on('audio', (mulawBuffer) => ...);   // arrives as it is synthesised
 *   u.on('end', () => ...);                // synthesis finished (playback may still be queued)
 *   u.on('error', (err) => ...);
 *   u.append('First sentence. ');  u.append('Second one. ');  u.end();
 *   u.cancel();                            // barge-in: stop generating, drop what is in flight
 *   tts.close();
 *
 * Both providers keep one WebSocket open and multiplex utterances on it by
 * context id, so a sentence costs no connection setup; the first audio byte
 * is bounded by the model's own latency.
 *
 *   elevenlabs  /v1/text-to-speech/{voice}/multi-stream-input, output ulaw_8000,
 *               model ELEVENLABS_MODEL_ID (default eleven_flash_v2_5).
 *   cartesia    /tts/websocket, output raw pcm_mulaw 8000, model CARTESIA_MODEL_ID
 *               (default sonic-3), voice CARTESIA_VOICE_ID.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

class Utterance extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.chars = 0;
    this.bytes = 0;
    this.startedAt = Date.now();
    this.firstAudioAt = null;
    this.ended = false;
    this.cancelled = false;
    this.done = new Promise((resolve) => { this._resolve = resolve; });
  }
  _audio(buf) {
    if (this.cancelled || !buf.length) return;
    if (this.firstAudioAt == null) this.firstAudioAt = Date.now();
    this.bytes += buf.length;
    this.emit('audio', buf);
  }
  _end() {
    if (this.ended) return;
    this.ended = true;
    this.emit('end');
    this._resolve();
  }
  _error(err) {
    if (this.ended) return;
    this.ended = true;
    this.emit('error', err);
    this._resolve();
  }
}

class BaseTts extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.opening = null;
    this.utterances = new Map(); // contextId -> Utterance
    this.seq = 0;
    this.closed = false;
  }

  async ensureOpen() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (!this.opening) this.opening = this._connect().finally(() => { this.opening = null; });
    await this.opening;
  }

  open() { return this.ensureOpen(); }

  speak() {
    const id = `u${++this.seq}-${Math.random().toString(16).slice(2, 8)}`;
    const u = new Utterance(id);
    this.utterances.set(id, u);
    u.done.then(() => this.utterances.delete(id));
    const pendingText = [];
    let pendingEnd = false;
    let started = false;
    const flushPending = () => {
      if (u.cancelled) return;
      if (!started) { started = true; this._begin(u); }
      for (const t of pendingText) this._text(u, t);
      pendingText.length = 0;
      if (pendingEnd) { pendingEnd = false; this._finish(u); }
    };
    u.append = (text) => {
      const t = String(text || '');
      if (!t.trim() || u.cancelled) return;
      u.chars += t.length;
      pendingText.push(t);
      this.ensureOpen().then(flushPending).catch((err) => u._error(err));
    };
    u.end = () => {
      pendingEnd = true;
      this.ensureOpen().then(flushPending).catch((err) => u._error(err));
    };
    u.cancel = () => {
      if (u.cancelled) return;
      u.cancelled = true;
      try { if (started) this._cancel(u); } catch (_) { /* socket gone */ }
      u._end();
    };
    return u;
  }

  /** Convenience: say one fixed text, resolve with the whole mu-law buffer. */
  async render(text) {
    const u = this.speak();
    const chunks = [];
    u.on('audio', (b) => chunks.push(b));
    const failed = new Promise((_, reject) => u.on('error', reject));
    u.append(text);
    u.end();
    await Promise.race([u.done, failed]);
    return Buffer.concat(chunks);
  }

  close() {
    this.closed = true;
    for (const u of this.utterances.values()) u.cancel();
    try { if (this.ws) this.ws.close(); } catch (_) { /* gone */ }
    this.ws = null;
  }

  _sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _onSocketClosed(code, reason) {
    for (const u of this.utterances.values()) {
      if (!u.ended) u._error(new Error(`TTS socket closed (${code} ${String(reason || '')})`));
    }
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs (multi-context WebSocket)
// ---------------------------------------------------------------------------

class ElevenLabsTts extends BaseTts {
  constructor({ apiKey, voiceId, modelId = 'eleven_flash_v2_5', stability = 0.5, similarityBoost = 0.8, speed = 1.0 } = {}) {
    super();
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
    if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID is not set');
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.voiceSettings = { stability, similarity_boost: similarityBoost, speed, use_speaker_boost: false };
  }

  get name() { return `elevenlabs:${this.modelId}`; }
  get cacheKey() { return `elevenlabs:${this.modelId}:${this.voiceId}:${JSON.stringify(this.voiceSettings)}`; }

  _connect() {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ model_id: this.modelId, output_format: 'ulaw_8000', auto_mode: 'true', inactivity_timeout: '180' });
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/multi-stream-input?${q.toString()}`;
      const ws = new WebSocket(url, { headers: { 'xi-api-key': this.apiKey } });
      let settled = false;
      ws.on('open', () => { this.ws = ws; settled = true; resolve(); });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        const u = msg.contextId ? this.utterances.get(msg.contextId) : null;
        if (msg.error || (msg.message && msg.code)) {
          const err = new Error(`ElevenLabs: ${msg.error || msg.message}`);
          if (u) u._error(err); else this.emit('error', err);
          return;
        }
        if (!u) return;
        if (msg.audio) u._audio(Buffer.from(msg.audio, 'base64'));
        if (msg.isFinal) {
          // A context that ends with no audio at all is the free-tier "library
          // voice" case: ElevenLabs sends isFinal and nothing else.
          if (u.bytes === 0 && !u.cancelled) u._error(new Error(`ElevenLabs returned no audio for voice ${this.voiceId} (a library voice needs a paid plan; use a premade voice id such as Sarah EXAVITQu4vr4xnSDxMaL)`));
          else u._end();
        }
      });
      ws.on('error', (err) => { if (!settled) { settled = true; reject(err); } else this.emit('error', err); });
      ws.on('close', (code, reason) => this._onSocketClosed(code, reason));
    });
  }

  _begin(u) {
    this._sendJson({ text: ' ', context_id: u.id, voice_settings: this.voiceSettings });
  }
  _text(u, text) {
    this._sendJson({ text: text.endsWith(' ') ? text : `${text} `, context_id: u.id });
  }
  _finish(u) {
    // flush renders what is buffered; close_context makes the server send the
    // remaining audio and then isFinal (flush alone never signals the end).
    this._sendJson({ context_id: u.id, flush: true });
    this._sendJson({ context_id: u.id, close_context: true });
  }
  _cancel(u) {
    this._sendJson({ context_id: u.id, close_context: true });
  }
}

// ---------------------------------------------------------------------------
// Cartesia
// ---------------------------------------------------------------------------

class CartesiaTts extends BaseTts {
  constructor({ apiKey, voiceId, modelId = 'sonic-3', version = '2025-04-16', speed } = {}) {
    super();
    if (!apiKey) throw new Error('CARTESIA_API_KEY is not set');
    if (!voiceId) throw new Error('CARTESIA_VOICE_ID is not set');
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.version = version;
    this.speed = speed;
  }

  get name() { return `cartesia:${this.modelId}`; }
  get cacheKey() { return `cartesia:${this.modelId}:${this.voiceId}:${this.speed || 1}`; }

  _connect() {
    return new Promise((resolve, reject) => {
      const url = `wss://api.cartesia.ai/tts/websocket?api_key=${encodeURIComponent(this.apiKey)}&cartesia_version=${encodeURIComponent(this.version)}`;
      const ws = new WebSocket(url, { headers: { 'X-API-Key': this.apiKey, 'Cartesia-Version': this.version } });
      let settled = false;
      ws.on('open', () => { this.ws = ws; settled = true; resolve(); });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        const u = msg.context_id ? this.utterances.get(msg.context_id) : null;
        if (msg.type === 'error') {
          const err = new Error(`Cartesia: ${msg.title || ''} ${msg.message || msg.error || ''}`.trim());
          if (u) u._error(err); else this.emit('error', err);
          return;
        }
        if (!u) return;
        if (msg.type === 'chunk' && msg.data) u._audio(Buffer.from(msg.data, 'base64'));
        if (msg.type === 'done' || msg.done === true) u._end();
      });
      ws.on('error', (err) => { if (!settled) { settled = true; reject(err); } else this.emit('error', err); });
      ws.on('close', (code, reason) => this._onSocketClosed(code, reason));
    });
  }

  _request(u, transcript, cont) {
    const req = {
      model_id: this.modelId,
      transcript,
      voice: { mode: 'id', id: this.voiceId },
      language: 'en',
      context_id: u.id,
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
      continue: cont,
    };
    if (this.speed) req.generation_config = { speed: this.speed };
    this._sendJson(req);
  }
  _begin() {}
  _text(u, text) { this._request(u, text, true); }
  _finish(u) { this._request(u, '', false); }
  _cancel(u) { this._sendJson({ context_id: u.id, cancel: true }); }
}

// ---------------------------------------------------------------------------

function resolveTtsProvider(env = process.env) {
  const want = (env.TTS_PROVIDER || '').trim().toLowerCase();
  if (want === 'cartesia' || (!want && !env.ELEVENLABS_API_KEY && env.CARTESIA_API_KEY)) return 'cartesia';
  if (want === 'elevenlabs' || !want) return 'elevenlabs';
  throw new Error(`Unknown TTS_PROVIDER "${want}" (elevenlabs | cartesia)`);
}

function createTts({ provider, env = process.env } = {}) {
  const p = provider || resolveTtsProvider(env);
  if (p === 'cartesia') {
    return new CartesiaTts({
      apiKey: env.CARTESIA_API_KEY,
      voiceId: env.CARTESIA_VOICE_ID,
      modelId: env.CARTESIA_MODEL_ID || 'sonic-3',
      version: env.CARTESIA_VERSION || '2025-04-16',
      speed: env.CARTESIA_SPEED ? Number(env.CARTESIA_SPEED) : undefined,
    });
  }
  return new ElevenLabsTts({
    apiKey: env.ELEVENLABS_API_KEY,
    // Sarah (premade, "mature, reassuring, confident") by default: premade
    // voices work on every plan, library voices need a paid one.
    voiceId: env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
    modelId: env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5',
    stability: env.ELEVENLABS_STABILITY ? Number(env.ELEVENLABS_STABILITY) : 0.5,
    similarityBoost: env.ELEVENLABS_SIMILARITY ? Number(env.ELEVENLABS_SIMILARITY) : 0.8,
    speed: env.ELEVENLABS_SPEED ? Number(env.ELEVENLABS_SPEED) : 1.0,
  });
}

module.exports = { createTts, resolveTtsProvider, ElevenLabsTts, CartesiaTts };
