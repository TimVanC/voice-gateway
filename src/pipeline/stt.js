/**
 * Streaming speech-to-text with end-of-speech detection, behind one interface.
 *
 *   const stt = createStt({ provider: 'deepgram' | 'openai' });
 *   stt.on('speech_started', () => ...)
 *   stt.on('interim', ({ text }) => ...)            // partial transcript of the current turn (Deepgram only)
 *   stt.on('speech_stopped', ({ durationMs, endedAt }) => ...)
 *   stt.on('transcript', ({ text, durationMs, endedAt }) => ...)  // one final transcript per caller turn
 *
 * `endedAt` is the wall-clock time of the caller's last voiced 20 ms frame,
 * measured here from the audio itself (same for every provider), so
 * "caller stopped -> Ava's first audio" means the same thing whichever STT
 * decided the turn was over and however long it took to say so.
 *   stt.on('error', err => ...)
 *   await stt.start();  stt.sendAudio(mulaw160);  stt.close();
 *
 * Input is always 8 kHz mu-law (what Twilio sends), 20 ms frames.
 *
 * Providers:
 *   deepgram  Nova-3 on /v1/listen with endpointing + utterance_end_ms, or
 *             Flux (DEEPGRAM_MODEL=flux-general-en) on /v2/listen with its own
 *             end-of-turn model. Needs DEEPGRAM_API_KEY.
 *   openai    A gpt-realtime session used only for its server VAD and
 *             gpt-4o-mini-transcribe transcription (create_response: false, so
 *             the model never speaks). Works with the OPENAI_API_KEY already
 *             on the account; the fallback when no Deepgram key is set.
 */

const { EventEmitter } = require('events');

// Words a heating-and-cooling caller says that a general model mishears
// ("mini split" came through as "when you split", staging call Nov 3 2026).
// Deepgram keyterm prompting (Nova-3 and Flux) boosts them; up to 100 terms.
const DEFAULT_KEYTERMS = [
  'Ava', 'RSE Energy', 'HVAC', 'mini split', 'mini-split', 'ductless', 'heat pump', 'furnace', 'boiler',
  'air handler', 'condenser', 'compressor', 'thermostat', 'central air', 'AC unit', 'air conditioner',
  'humidifier', 'water heater', 'oil burner', 'gas furnace', 'ductwork', 'zone', 'blower', 'pilot light',
  'Generac', 'Cummins', 'Kohler', 'generator', 'transfer switch', 'propane', 'natural gas',
  'Mitsubishi', 'Daikin', 'Fujitsu', 'Carrier', 'Trane', 'Lennox', 'Rheem', 'Goodman', 'Bryant', 'Navien',
  'maintenance plan', 'membership', 'tune-up', 'zip code', 'New Jersey', 'Montclair', 'Madison', 'Morristown',
];
const WebSocket = require('ws');
const { muLawToPcm16 } = require('../g711');

const PREROLL_FRAMES = 150; // audio kept while the socket is still connecting (3 s)
const VOICE_RMS_MIN = 300;  // decoded PCM16 RMS; speech on a phone line is 1000+

function frameRms(mulaw) {
  const pcm = muLawToPcm16(mulaw);
  let acc = 0;
  for (let i = 0; i < pcm.length; i++) acc += pcm[i] * pcm[i];
  return Math.sqrt(acc / (pcm.length || 1));
}

class BaseStt extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.preroll = [];
    this.speaking = false;
    this.speechStartAt = 0;
    this.connectedAt = 0;
    this.noiseFloor = 0;    // slow-moving RMS of non-speech frames
    this.lastVoiceAt = 0;   // wall clock of the last voiced frame
  }

  sendAudio(frame) {
    if (this.closed) return;
    // Track the caller's last voiced frame from the audio itself.
    const rms = frameRms(frame);
    const threshold = Math.max(VOICE_RMS_MIN, this.noiseFloor * 3);
    if (rms > threshold) this.lastVoiceAt = Date.now();
    else this.noiseFloor = this.noiseFloor ? this.noiseFloor * 0.98 + rms * 0.02 : rms;
    if (!this.ready) {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      return;
    }
    this._send(frame);
  }

  _flushPreroll() {
    for (const f of this.preroll) this._send(f);
    this.preroll = [];
  }

  _speechStarted() {
    if (this.speaking) return;
    this.speaking = true;
    this.speechStartAt = Date.now();
    this.emit('speech_started');
  }

  /** When the caller actually stopped: last voiced frame if it is recent, else now. */
  speechEndedAt() {
    const now = Date.now();
    return this.lastVoiceAt && now - this.lastVoiceAt < 10000 ? this.lastVoiceAt : now;
  }

  _speechStopped() {
    if (!this.speaking) return 0;
    this.speaking = false;
    const endedAt = this.speechEndedAt();
    const durationMs = Math.max(0, endedAt - this.speechStartAt);
    this.emit('speech_stopped', { durationMs, endedAt });
    return durationMs;
  }

  close() {
    this.closed = true;
    try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this._sendClose(); } catch (_) { /* gone */ }
    try { if (this.ws) this.ws.close(); } catch (_) { /* gone */ }
  }

  _sendClose() {}
}

// ---------------------------------------------------------------------------
// Deepgram
// ---------------------------------------------------------------------------

class DeepgramStt extends BaseStt {
  constructor({ apiKey, model = 'nova-3', endpointingMs = 800, utteranceEndMs = 1500, eotThreshold = 0.7, eagerEotThreshold = 0.5, eotTimeoutMs = 3000, keyterms = [] } = {}) {
    super();
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set');
    this.apiKey = apiKey;
    this.model = model;
    this.flux = /^flux/.test(model);
    this.endpointingMs = endpointingMs;
    this.utteranceEndMs = utteranceEndMs;
    this.eotThreshold = eotThreshold;
    this.eagerEotThreshold = eagerEotThreshold;
    this.eotTimeoutMs = eotTimeoutMs;
    this.keyterms = keyterms;
    this.finalParts = [];
    this.keepAlive = null;
    this.lastAudioAt = 0;
  }

  get name() { return `deepgram:${this.model}`; }

  url() {
    const q = new URLSearchParams();
    q.set('model', this.model);
    q.set('encoding', 'mulaw');
    q.set('sample_rate', '8000');
    if (this.flux) {
      q.set('eot_threshold', String(this.eotThreshold));
      q.set('eager_eot_threshold', String(this.eagerEotThreshold));
      q.set('eot_timeout_ms', String(this.eotTimeoutMs));
      return `wss://api.deepgram.com/v2/listen?${q.toString()}`;
    }
    q.set('channels', '1');
    q.set('interim_results', 'true');
    q.set('endpointing', String(this.endpointingMs));
    q.set('utterance_end_ms', String(this.utteranceEndMs));
    q.set('vad_events', 'true');
    q.set('smart_format', 'true');
    q.set('punctuate', 'true');
    q.set('language', 'en-US');
    for (const k of this.keyterms) q.append('keyterm', k);
    return `wss://api.deepgram.com/v1/listen?${q.toString()}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url(), { headers: { Authorization: `Token ${this.apiKey}` } });
      this.ws = ws;
      let settled = false;
      ws.on('open', () => {
        this.connectedAt = Date.now();
        this.ready = true;
        this._flushPreroll();
        this.keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && Date.now() - this.lastAudioAt > 4000) ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }, 5000);
        settled = true;
        resolve();
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        this._onMessage(msg);
      });
      ws.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
        else this.emit('error', err);
      });
      ws.on('close', (code, reason) => {
        if (this.keepAlive) clearInterval(this.keepAlive);
        this.ready = false;
        if (this.closed) return;
        // Unexpected close mid-call: reconnect, buffering audio meanwhile
        // (sendAudio keeps up to 3 s while not ready), at most once a second.
        this.emit('error', new Error(`Deepgram socket closed (${code} ${String(reason || '')}); reconnecting`));
        const wait = Math.max(0, 1000 - (Date.now() - (this.lastReconnectAt || 0)));
        setTimeout(() => {
          if (this.closed) return;
          this.lastReconnectAt = Date.now();
          this.finalParts = [];
          this.start().catch((err) => this.emit('error', new Error(`Deepgram reconnect failed: ${err.message}`)));
        }, wait);
      });
    });
  }

  _send(frame) {
    this.lastAudioAt = Date.now();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  _sendClose() {
    this.ws.send(JSON.stringify({ type: 'CloseStream' }));
  }

  _emitTranscript(text) {
    const clean = String(text || '').trim();
    const durationMs = this._speechStopped();
    if (!clean) return;
    this.emit('transcript', { text: clean, durationMs, endedAt: this.speechEndedAt() });
  }

  _onMessage(msg) {
    if (this.flux) {
      if (msg.type !== 'TurnInfo') return;
      const text = msg.transcript || '';
      switch (msg.event) {
        case 'StartOfTurn':
          this._speechStarted();
          break;
        case 'Update':
        case 'EagerEndOfTurn':
        case 'TurnResumed':
          if (text.trim()) {
            this._speechStarted();
            this.emit('interim', { text: text.trim(), eager: msg.event === 'EagerEndOfTurn' });
          }
          break;
        case 'EndOfTurn':
          this._emitTranscript(text);
          break;
        default:
          break;
      }
      return;
    }
    switch (msg.type) {
      case 'SpeechStarted':
        this._speechStarted();
        break;
      case 'Results': {
        const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
        const text = (alt && alt.transcript) || '';
        if (text.trim()) this._speechStarted();
        if (msg.is_final) {
          if (text.trim()) this.finalParts.push(text.trim());
          if (msg.speech_final) {
            const joined = this.finalParts.join(' ');
            this.finalParts = [];
            this._emitTranscript(joined);
          }
        } else if (text.trim()) {
          this.emit('interim', { text: [...this.finalParts, text.trim()].join(' ') });
        }
        break;
      }
      case 'UtteranceEnd':
        if (this.finalParts.length) {
          const joined = this.finalParts.join(' ');
          this.finalParts = [];
          this._emitTranscript(joined);
        } else if (this.speaking) {
          this._speechStopped();
        }
        break;
      case 'Error':
        this.emit('error', new Error(`Deepgram: ${msg.description || msg.message || JSON.stringify(msg)}`));
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI (Realtime session used for VAD + transcription only)
// ---------------------------------------------------------------------------

class OpenAiStt extends BaseStt {
  constructor({ apiKey, transcriptionModel = 'gpt-4o-mini-transcribe', threshold = 0.5, prefixPaddingMs = 300, silenceDurationMs = 600 } = {}) {
    super();
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    this.apiKey = apiKey;
    this.transcriptionModel = transcriptionModel;
    this.threshold = threshold;
    this.prefixPaddingMs = prefixPaddingMs;
    this.silenceDurationMs = silenceDurationMs;
    this.lastDurationMs = 0;
  }

  get name() { return `openai:${this.transcriptionModel}`; }

  start() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.ws = ws;
      let settled = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model: 'gpt-realtime',
            output_modalities: ['text'],
            instructions: 'You are a transcription relay. Never respond.',
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                transcription: { model: this.transcriptionModel },
                turn_detection: {
                  type: 'server_vad',
                  threshold: this.threshold,
                  prefix_padding_ms: this.prefixPaddingMs,
                  silence_duration_ms: this.silenceDurationMs,
                  create_response: false,
                  interrupt_response: false,
                },
              },
            },
          },
        }));
      });
      ws.on('message', (data) => {
        let ev;
        try { ev = JSON.parse(data.toString()); } catch (_) { return; }
        switch (ev.type) {
          case 'session.updated':
            if (!settled) {
              settled = true;
              this.connectedAt = Date.now();
              this.ready = true;
              this._flushPreroll();
              resolve();
            }
            break;
          case 'input_audio_buffer.speech_started':
            this._speechStarted();
            break;
          case 'input_audio_buffer.speech_stopped':
            this.lastDurationMs = this._speechStopped();
            break;
          case 'conversation.item.input_audio_transcription.completed': {
            const text = String(ev.transcript || '').trim();
            if (text) this.emit('transcript', { text, durationMs: this.lastDurationMs, endedAt: this.speechEndedAt() });
            break;
          }
          case 'response.created':
            // Should never happen with create_response: false; make sure it never speaks.
            ws.send(JSON.stringify({ type: 'response.cancel' }));
            break;
          case 'error':
            this.emit('error', new Error(`OpenAI: ${(ev.error && ev.error.message) || JSON.stringify(ev.error)}`));
            break;
          default:
            break;
        }
      });
      ws.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
        else this.emit('error', err);
      });
      ws.on('close', (code, reason) => {
        this.ready = false;
        if (!this.closed) this.emit('error', new Error(`OpenAI socket closed (${code} ${String(reason || '')})`));
      });
    });
  }

  _send(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.toString('base64') }));
    }
  }
}

// ---------------------------------------------------------------------------

function resolveSttProvider(env = process.env) {
  const want = (env.STT_PROVIDER || '').trim().toLowerCase();
  if (want === 'deepgram' || (!want && env.DEEPGRAM_API_KEY)) return 'deepgram';
  if (want === 'openai' || !want) return 'openai';
  throw new Error(`Unknown STT_PROVIDER "${want}" (deepgram | openai)`);
}

function createStt({ provider, env = process.env } = {}) {
  const p = provider || resolveSttProvider(env);
  if (p === 'deepgram') {
    return new DeepgramStt({
      apiKey: env.DEEPGRAM_API_KEY,
      // Flux decides end of turn with a turn model instead of a fixed silence
      // window: on a clean test it ended the turn ~470 ms after the last word,
      // where Nova-3 needs its endpointing silence (800 ms here) plus
      // finalisation. DEEPGRAM_MODEL=nova-3 switches back.
      model: env.DEEPGRAM_MODEL || 'flux-general-en',
      // 800 ms of silence ends a turn: a caller pauses 300-600 ms between
      // clauses ("Hi there! ... My furnace stopped working, ... and I've had no
      // heat"), and at 300 ms each clause came through as its own turn.
      // Realtime's server VAD in server-rse.js waits 1200 ms.
      endpointingMs: Number(env.DEEPGRAM_ENDPOINTING_MS || 800),
      utteranceEndMs: Number(env.DEEPGRAM_UTTERANCE_END_MS || 1500),
      eotThreshold: Number(env.DEEPGRAM_EOT_THRESHOLD || 0.7),
      eagerEotThreshold: Number(env.DEEPGRAM_EAGER_EOT_THRESHOLD || 0.5),
      eotTimeoutMs: Number(env.DEEPGRAM_EOT_TIMEOUT_MS || 3000),
      keyterms: String(env.DEEPGRAM_KEYTERMS || DEFAULT_KEYTERMS.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return new OpenAiStt({
    apiKey: env.OPENAI_API_KEY,
    transcriptionModel: env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
    silenceDurationMs: Number(env.STT_SILENCE_MS || 600),
  });
}

module.exports = { createStt, resolveSttProvider, DeepgramStt, OpenAiStt };
