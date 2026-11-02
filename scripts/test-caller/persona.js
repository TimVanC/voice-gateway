/**
 * Persona: the caller side of a test call, an OpenAI Realtime session that
 * plays a scripted human (name, problem, address, mood) and talks to Ava
 * over 8 kHz mu-law in both directions, so no transcoding sits between the
 * two bots. Same API key and model family as Ava.
 *
 * Audio in:  Ava's frames, straight into input_audio_buffer (server VAD
 *            decides when Ava has finished a turn).
 * Audio out: response.output_audio.delta chunks, handed to the caller via
 *            the 'audio' event; run.js paces them onto the wire.
 *
 * Also used, out of band (conversation: "none"), to synthesise short clips
 * such as "mm-hm" that the harness injects while Ava is talking.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=';
const CLIP_PURPOSE = 'clip';

class Persona extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.instructions     who the caller is and how they behave
   * @param {string} [opts.voice]          Realtime voice, default "ash" (Ava uses sage)
   * @param {string} [opts.model]          default gpt-realtime
   * @param {number} [opts.silenceMs]      VAD silence before the caller answers, default 700
   * @param {number} [opts.threshold]      VAD threshold, default 0.5
   * @param {boolean} [opts.interruptible] cancel the caller mid-sentence when Ava talks over them
   */
  constructor(opts) {
    super();
    this.apiKey = opts.apiKey;
    this.instructions = opts.instructions;
    this.voice = opts.voice || 'ash';
    this.model = opts.model || 'gpt-realtime';
    this.silenceMs = opts.silenceMs || 700;
    this.threshold = opts.threshold || 0.5;
    this.interruptible = Boolean(opts.interruptible);
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.responses = new Map(); // responseId -> { purpose, chunks, transcript }
    this.clipWaiters = new Map(); // responseId -> resolve
    this.usage = { inputTokens: 0, outputTokens: 0, inputAudioTokens: 0, outputAudioTokens: 0 };
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(REALTIME_URL + encodeURIComponent(this.model), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const fail = (err) => {
        if (!this.ready) reject(err);
        else if (!this.closed) this.emit('error', err);
      };
      this.ws.once('open', () => {
        this.send({
          type: 'session.update',
          session: {
            type: 'realtime',
            model: this.model,
            output_modalities: ['audio'],
            instructions: this.instructions,
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                transcription: { model: 'gpt-4o-mini-transcribe' },
                turn_detection: {
                  type: 'server_vad',
                  threshold: this.threshold,
                  prefix_padding_ms: 300,
                  silence_duration_ms: this.silenceMs,
                  create_response: true,
                  interrupt_response: this.interruptible,
                },
              },
              output: { format: { type: 'audio/pcmu' }, voice: this.voice },
            },
            max_output_tokens: 400,
          },
        });
      });
      this.ws.on('message', (data) => {
        let event;
        try {
          event = JSON.parse(data.toString());
        } catch (e) {
          return;
        }
        if (event.type === 'session.updated' && !this.ready) {
          this.ready = true;
          resolve();
          return;
        }
        if (event.type === 'error' && !this.ready) {
          reject(new Error(`OpenAI session error: ${event.error && event.error.message}`));
          return;
        }
        this.handle(event);
      });
      this.ws.on('error', fail);
      this.ws.on('close', (code, reason) => {
        this.closed = true;
        this.emit('close', { code, reason: String(reason || '') });
      });
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Ava's audio, one mu-law frame. */
  feedAudio(frame) {
    this.send({ type: 'input_audio_buffer.append', audio: frame.toString('base64') });
  }

  handle(event) {
    switch (event.type) {
      case 'response.created': {
        const id = event.response && event.response.id;
        const purpose = (event.response && event.response.metadata && event.response.metadata.purpose) || 'talk';
        this.responses.set(id, { purpose, chunks: [], transcript: '' });
        if (purpose === CLIP_PURPOSE) this.emit('__clip_created', event);
        else this.emit('response_started', id);
        break;
      }
      case 'response.output_audio.delta': {
        const r = this.responses.get(event.response_id);
        const buf = Buffer.from(event.delta, 'base64');
        if (r && r.purpose === CLIP_PURPOSE) r.chunks.push(buf);
        else this.emit('audio', buf, event.response_id);
        break;
      }
      case 'response.output_audio_transcript.done': {
        const r = this.responses.get(event.response_id);
        if (r) r.transcript = event.transcript || '';
        if (!r || r.purpose !== CLIP_PURPOSE) this.emit('caller_transcript', event.transcript || '', event.response_id);
        break;
      }
      case 'response.done': {
        const id = event.response && event.response.id;
        const r = this.responses.get(id);
        const usage = event.response && event.response.usage;
        if (usage) {
          this.usage.inputTokens += usage.input_tokens || 0;
          this.usage.outputTokens += usage.output_tokens || 0;
          this.usage.inputAudioTokens += (usage.input_token_details && usage.input_token_details.audio_tokens) || 0;
          this.usage.outputAudioTokens += (usage.output_token_details && usage.output_token_details.audio_tokens) || 0;
        }
        if (r && r.purpose === CLIP_PURPOSE) {
          const waiter = this.clipWaiters.get(id);
          this.clipWaiters.delete(id);
          if (waiter) waiter(Buffer.concat(r.chunks));
        } else {
          this.emit('response_done', id, event.response && event.response.status);
        }
        this.responses.delete(id);
        break;
      }
      case 'input_audio_buffer.speech_started':
        this.emit('ava_speech_started', event.item_id);
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('ava_speech_stopped', event.item_id);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.emit('ava_transcript', event.transcript || '', event.item_id);
        break;
      case 'error':
        this.emit('error', new Error(`OpenAI: ${(event.error && event.error.message) || JSON.stringify(event.error)}`));
        break;
      default:
        break;
    }
  }

  /**
   * Synthesise a short clip in the caller's voice without touching the
   * conversation (so the persona does not remember having said it).
   * Resolves with raw mu-law bytes.
   */
  synthesize(text, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`clip "${text}" timed out`)), timeoutMs);
      // response.created arrives before any delta; we learn the id from
      // metadata echoed back on that event and register the waiter then.
      const onCreated = (event) => {
        const id = event.response && event.response.id;
        this.clipWaiters.set(id, (buf) => {
          clearTimeout(timer);
          resolve(buf);
        });
      };
      this.once('__clip_created', onCreated);
      this.send({
        type: 'response.create',
        response: {
          conversation: 'none',
          metadata: { purpose: CLIP_PURPOSE },
          output_modalities: ['audio'],
          instructions: `Say exactly this, nothing more, nothing less, no greeting: "${text}"`,
        },
      });
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'call over');
  }
}

module.exports = { Persona };
