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
 *               model ELEVENLABS_MODEL_ID (default eleven_turbo_v2_5; v4 turbo and v3 are
 *               refused on this socket: "use the text-to-dialogue websocket endpoint").
 *   cartesia    /tts/websocket, output raw pcm_mulaw 8000, model CARTESIA_MODEL_ID
 *               (default sonic-3), voice CARTESIA_VOICE_ID.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { pcm16ToMuLaw } = require('../g711');

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
  constructor({ apiKey, voiceId, modelId = 'eleven_turbo_v2_5', stability = 0.65, similarityBoost = 0.75, speed = 0.92 } = {}) {
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
          if (u.bytes === 0 && !u.cancelled) u._error(new Error(`ElevenLabs returned no audio for voice ${this.voiceId} (monthly character quota used up, or a library voice on the free plan)`));
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
// OpenAI (gpt-4o-mini-tts over HTTP, one request per sentence)
// ---------------------------------------------------------------------------
//
// Not a streaming-input socket like the two above, so each appended sentence
// is its own request, run in order. It returns 24 kHz PCM16, which is low-pass
// filtered and decimated to 8 kHz here and mu-law encoded. Useful as a
// fallback that needs no extra account (OPENAI_API_KEY), and its "sage" voice
// is the one production Ava uses on Realtime, which makes a fair A/B of the
// pipeline itself.

// 31-tap windowed-sinc low-pass at 3.4 kHz for 24 kHz input (Hamming window).
const FIR_24K = (() => {
  const N = 31;
  const fc = 3400 / 24000;
  const h = [];
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const m = n - (N - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
    h.push(sinc * w);
    sum += sinc * w;
  }
  return h.map((x) => x / sum);
})();

class Downsampler24to8 {
  constructor() {
    this.hist = new Float32Array(FIR_24K.length - 1);
    this.phase = 0;
    this.carry = Buffer.alloc(0);
  }
  /** PCM16LE bytes at 24 kHz in, Int16Array at 8 kHz out. */
  push(chunk) {
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const n = Math.floor(buf.length / 2);
    this.carry = Buffer.from(buf.subarray(n * 2));
    const h = this.hist.length;
    const x = new Float32Array(h + n);
    x.set(this.hist, 0);
    for (let i = 0; i < n; i++) x[h + i] = buf.readInt16LE(i * 2);
    const out = [];
    for (let i = h; i < x.length; i++) {
      if (this.phase === 0) {
        let acc = 0;
        for (let k = 0; k < FIR_24K.length; k++) acc += FIR_24K[k] * x[i - k];
        out.push(acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc));
      }
      this.phase = (this.phase + 1) % 3;
    }
    this.hist = x.slice(x.length - h);
    return Int16Array.from(out);
  }
}

class OpenAiTts extends EventEmitter {
  constructor({ apiKey, model = 'gpt-4o-mini-tts', voice = 'sage', instructions } = {}) {
    super();
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.instructions = instructions;
    this.utterances = new Set();
    this.seq = 0;
  }

  get name() { return `openai:${this.model}:${this.voice}`; }
  get cacheKey() { return `openai:${this.model}:${this.voice}:${this.instructions || ''}`; }

  open() { return Promise.resolve(); }

  speak() {
    const u = new Utterance(`o${++this.seq}`);
    u.controllers = [];
    this.utterances.add(u);
    u.done.then(() => this.utterances.delete(u));
    const queue = [];
    let running = false;
    let endRequested = false;
    const pump = async () => {
      if (running) return;
      running = true;
      try {
        while (queue.length && !u.cancelled) await this._synth(u, queue.shift());
      } catch (err) {
        running = false;
        if (!u.cancelled) u._error(err);
        return;
      }
      running = false;
      if (u.cancelled) return;
      if (queue.length) { pump(); return; }
      if (endRequested) {
        if (u.bytes === 0) u._error(new Error('OpenAI TTS returned no audio'));
        else u._end();
      }
    };
    u.append = (text) => {
      const t = String(text || '');
      if (!t.trim() || u.cancelled) return;
      u.chars += t.length;
      queue.push(t.trim());
      pump();
    };
    u.end = () => { endRequested = true; pump(); };
    u.cancel = () => {
      if (u.cancelled) return;
      u.cancelled = true;
      for (const c of u.controllers) { try { c.abort(); } catch (_) { /* done */ } }
      u._end();
    };
    return u;
  }

  async _synth(u, text) {
    const ctrl = new AbortController();
    u.controllers.push(ctrl);
    const body = { model: this.model, voice: this.voice, input: text, response_format: 'pcm' };
    if (this.instructions) body.instructions = this.instructions;
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const ds = new Downsampler24to8();
    for await (const chunk of res.body) {
      if (u.cancelled) break;
      const pcm = ds.push(Buffer.from(chunk));
      if (pcm.length) u._audio(pcm16ToMuLaw(pcm));
    }
  }

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
    for (const u of this.utterances) u.cancel();
  }
}

// ---------------------------------------------------------------------------

function resolveTtsProvider(env = process.env) {
  const want = (env.TTS_PROVIDER || '').trim().toLowerCase();
  if (want === 'openai') return 'openai';
  if (want === 'cartesia' || (!want && !env.ELEVENLABS_API_KEY && env.CARTESIA_API_KEY)) return 'cartesia';
  if (want === 'elevenlabs' || !want) return 'elevenlabs';
  throw new Error(`Unknown TTS_PROVIDER "${want}" (elevenlabs | cartesia | openai)`);
}

// No default style instructions: with them gpt-4o-mini-tts took ~1.1 s to the
// first byte instead of ~0.6 s, and spoke no faster.
function createTts({ provider, env = process.env } = {}) {
  const p = provider || resolveTtsProvider(env);
  if (p === 'openai') {
    return new OpenAiTts({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      voice: env.OPENAI_TTS_VOICE || 'sage',
      instructions: env.OPENAI_TTS_INSTRUCTIONS || undefined,
    });
  }
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
    // Ava's voice (Tim, Nov 3 2026: the most human-sounding approachable
    // female voice): "Eryn - Hyper Real, Conversation, Natural", a library
    // voice trained from a real conversation, on turbo v2.5 (first audio
    // byte 150-250 ms over this socket; flash is no faster here, and v4
    // turbo is not accepted on it). Library voices need a paid plan; on the
    // free plan use a premade one such as Sarah EXAVITQu4vr4xnSDxMaL.
    voiceId: env.ELEVENLABS_VOICE_ID || 'kdnRe2koJdOK4Ovxn2DI',
    modelId: env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5',
    // Calmer and a touch slower than the defaults (0.5 / 0.8 / 1.0): on Tim's
    // first Eryn call (Nov 3 2026) she spoke a bit fast and came across as
    // curt, most of all in the recap. Speed 0.92 is about 9 % longer.
    stability: env.ELEVENLABS_STABILITY ? Number(env.ELEVENLABS_STABILITY) : 0.65,
    similarityBoost: env.ELEVENLABS_SIMILARITY ? Number(env.ELEVENLABS_SIMILARITY) : 0.75,
    speed: env.ELEVENLABS_SPEED ? Number(env.ELEVENLABS_SPEED) : 0.92,
  });
}

module.exports = { createTts, resolveTtsProvider, ElevenLabsTts, CartesiaTts, OpenAiTts, Downsampler24to8 };
