/**
 * RSE Energy Group - AI Receptionist, pipeline prototype
 *
 * Side-by-side alternative to server-rse.js (which is untouched): the same
 * Twilio webhook and /stream media-stream contract, the same state machine,
 * script, intent classifier and hang-up logging (Sheets, Neon, email), but
 * instead of one OpenAI Realtime speech-to-speech session the call runs
 * through a Sierra-style pipeline:
 *
 *   caller audio -> streaming STT with end-of-speech detection (src/pipeline/stt.js)
 *                -> state machine (scripted prompt) or LLM for the free-form parts (src/pipeline/llm.js)
 *                -> streaming TTS, sentence by sentence (src/pipeline/tts.js)
 *                -> 8 kHz mu-law frames paced to Twilio, optional room tone under them
 *
 * Latency tricks from sierra.ai/blog/voice-latency that are implemented here:
 *   - the greeting and every fixed script line are synthesised at start-up
 *     and play with no synthesis delay (src/pipeline/prompt-cache.js)
 *   - one TTS socket per call, utterances multiplexed on it: no connection
 *     setup inside a turn
 *   - LLM replies are streamed and handed to TTS one sentence at a time
 *   - barge-in with a short grace so "mm-hm" does not cancel a question
 *   - the measured number is time-to-first-audio after the caller stops
 *
 * Configuration (all in .env / Railway, never in the repo):
 *   STT_PROVIDER=deepgram|openai   TTS_PROVIDER=elevenlabs|cartesia   LLM_PROVIDER=anthropic|openai
 *   DEEPGRAM_API_KEY, ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, CARTESIA_API_KEY + CARTESIA_VOICE_ID,
 *   ANTHROPIC_API_KEY or OPENAI_API_KEY (the OpenAI key alone is enough: STT falls back to a
 *   Realtime transcription session and the LLM to chat completions)
 *   AMBIENCE=office  AMBIENCE_LEVEL_DB=-50
 *
 * Start: node src/server-pipeline.js   (npm run pipeline)
 */

require('dotenv').config();

const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');
const twilio = require('twilio');
const { BASE_URL } = require('./config/baseUrl');

const { SYSTEM_PROMPT, GREETING, STATES, CLOSE, SAFETY, OUT_OF_SCOPE } = require('./scripts/rse-script');
const { createCallStateMachine, detectSafetyEmergency } = require('./state/call-state-machine');
const { classifyIntent, detectRealPersonRequest } = require('./utils/intent-classifier');
const { isLikelySilenceHallucination, isClearYesOrNo } = require('./utils/transcript-filters');
const { createTwilioSignatureValidator } = require('./utils/twilio-security');
const { logCallIntake } = require('./utils/google-sheets-logger');
const { sendCallSummaryEmail } = require('./utils/email-sender');
const { cleanCallData } = require('./utils/data-cleanup');
const { saveCall: saveCallToDb, saveRecording, pruneOldRecordings, createTranscriptRecorder } = require('./utils/call-db');
const { TrackRecorder } = require('./utils/track-recorder');

const { createStt, resolveSttProvider } = require('./pipeline/stt');
const { createTts, resolveTtsProvider } = require('./pipeline/tts');
const { createLlm, resolveLlmProvider } = require('./pipeline/llm');
const { PromptCache, collectFixedPrompts } = require('./pipeline/prompt-cache');
const { RoomTone } = require('./pipeline/ambience');
const { normalizeSpokenNumbers } = require('./pipeline/numbers');
const relay = require('./relay');
const { ingestTwilioRecording } = require('./utils/twilio-recording');

// ============================================================================
// CONFIGURATION
// ============================================================================
const PORT = process.env.PORT || 8080;
const VERBOSE_DEBUG = process.env.VERBOSE_DEBUG === 'true';
const STT_PROVIDER = resolveSttProvider();
const TTS_PROVIDER = resolveTtsProvider();
const LLM_PROVIDER = resolveLlmProvider();
const AMBIENCE = (process.env.AMBIENCE || '').trim().toLowerCase(); // 'office' enables the room-tone bed
// Second TTS for when the first returns no audio (ElevenLabs answers an
// exhausted quota with an empty context, which was 30 s of dead air). Off with TTS_FALLBACK=off.
const TTS_FALLBACK = (() => {
  const v = (process.env.TTS_FALLBACK || '').trim().toLowerCase();
  if (v === 'off' || v === 'none') return null;
  if (v) return v;
  return process.env.OPENAI_API_KEY ? 'openai' : null;
})();
const AMBIENCE_LEVEL_DB = Number(process.env.AMBIENCE_LEVEL_DB || -50);
// RELAY=on: calls go through Twilio ConversationRelay (src/relay.js) instead
// of the media stream below: Twilio does STT, turn-taking and ElevenLabs TTS,
// we exchange text. Staging trial, Nov 2026.
const RELAY = (process.env.RELAY || '').toLowerCase() === 'on';
// Bump to throw away every stored render (v2: Nov 3 2026, a stretched take of the availability question was on staging's volume).
const PROMPT_CACHE_VERSION = 2;
// Call recording (CALL_RECORDING=on), as in server-rse.js: both sides of every
// call, as the bytes travelled on the Twilio stream, stored in Neon at hang-up
// and played back in the web app. Pruned at boot after CALL_RECORDING_KEEP_DAYS.
const CALL_RECORDING = (process.env.CALL_RECORDING || '').toLowerCase() === 'on';
const CALL_RECORDING_KEEP_DAYS = Number(process.env.CALL_RECORDING_KEEP_DAYS || 30);
// A reply never starts sooner than this after the caller stopped. Cached
// prompts come back in 10-30 ms, so Ava was answering about 0.8 s after the
// STT's end of turn, on top of the caller's last word (Tim's staging call,
// Nov 3 2026: "almost answering too quick"). A person leaves about a second.
const REPLY_MIN_GAP_MS = Number(process.env.REPLY_MIN_GAP_MS ?? 1000);

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TRANSFER_PHONE_NUMBER = process.env.TRANSFER_PHONE_NUMBER;
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// Turn-taking timings (ms)
const FRAME_MS = 20;
const FRAME_BYTES = 160;
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff);
const BARGE_GRACE_MS = Number(process.env.BARGE_GRACE_MS || 900);   // caller must keep talking this long to cut Ava off
const BARGE_GRACE_CONFIRM_MS = Number(process.env.BARGE_GRACE_CONFIRM_MS || 2000); // the recap has pauses; "yes" during one must not cut it
const BARGE_WORDS = 3;                 // or say this many words (Deepgram interim) within the grace
const GREETING_GUARD_MS = 5000;        // no barge-in during the first seconds of the greeting (line noise, "hello?")
const WATCHDOG_MS = 3000;              // caller stopped, no transcript yet: re-prompt after this
const REPROMPT_MS = Number(process.env.REPROMPT_MS || 10000); // Ava asked, caller silent: re-ask once
const MAX_REPROMPTS = 2;               // per state, then offer a live agent
const GOODBYE_BUFFER_MS = 1200;        // after the goodbye has fully played
const CLOSING_FAILSAFE_MS = 15000;
const TRANSFER_OFFER_PROMPT = "I'm sorry, it sounds like we're having a communication issue. I can transfer you to a live agent if you'd like. Would you like me to transfer you now?";
const BACKCHANNEL = /^(mm+-?hm+|mhm+|uh-?huh|yeah|yep|ok(ay)?|right|sure|got it|i see|alright|hm+)[.!?,]*$/i;
const BARE_HELLO = /^(hi|hello|hey|hiya|good (morning|afternoon|evening))( there| ava)?[.!,?]*$/i;
const HELLO_WAIT_MS = 2500;            // caller said only "hi": give them a moment to say why they called
const SAME_PROMPT_LIMIT = 3;           // same prompt this many times in one state = stuck; break out
// Speech that starts this soon after Ava begins a new question cannot be an
// answer to it (the caller has not heard it yet): it is the rest of their
// previous answer, split off by the end-of-turn detector. Seen: "No. ...
// Nothing like that." -> the safety check took "No." and the name step took
// "Nothing like that" as the caller's name.
const CONTINUATION_WINDOW_MS = Number(process.env.CONTINUATION_WINDOW_MS || 1200);
// Commit late: after the STT says the turn is over, hold the reply this long
// and merge if the caller's voice comes back (people pause 0.5-1 s between
// sentences; Flux ends a turn after ~0.5 s, so without this every sentence
// became its own turn and Ava answered the first while the caller went on).
// Realtime in server-rse.js waits 1.2 s of silence for the same reason.
const TURN_HOLD_MS = Number(process.env.TURN_HOLD_MS ?? 450);
const TURN_RESUME_MAX_MS = 4000;       // caller resumed but no transcript came: answer what we have

// Published list prices, for the per-call estimate printed at hang-up. Override in env.
const PRICE = {
  deepgramPerMin: Number(process.env.PRICE_DEEPGRAM_PER_MIN || 0.0048),
  openaiSttPerMin: Number(process.env.PRICE_OPENAI_STT_PER_MIN || 0.006),   // gpt-4o-mini-transcribe via Realtime, audio in
  openaiTtsPerMin: Number(process.env.PRICE_OPENAI_TTS_PER_MIN || 0.015),   // gpt-4o-mini-tts audio out
  elevenlabsPer1kChars: Number(process.env.PRICE_ELEVENLABS_PER_1K || 0.05), // Flash v2.5, API pricing
  cartesiaPer1kChars: Number(process.env.PRICE_CARTESIA_PER_1K || 0.039),
  llmInPerM: Number(process.env.PRICE_LLM_IN_PER_M || (LLM_PROVIDER === 'anthropic' ? 2 : 0.15)),
  llmOutPerM: Number(process.env.PRICE_LLM_OUT_PER_M || (LLM_PROVIDER === 'anthropic' ? 10 : 0.6)),
};

// ============================================================================
// SHARED RESOURCES
// ============================================================================
let cacheTts = null;        // one TTS socket for the prompt cache (cache is shared by all calls)
// Set when the primary TTS could not render most of the script at start-up
// (quota used up, outage): the cache is then rendered with the fallback voice
// and every call uses the fallback from the start, so the voice is consistent.
let processTtsDegraded = false;
const promptCache = new PromptCache({ tts: null });
let llm = null;
try { llm = createLlm(); } catch (err) { console.error(`⚠️ LLM unavailable (${err.message}); free-form replies will use scripted fallbacks`); }
const activeCalls = new Set();

async function warmPromptCache() {
  try {
    cacheTts = createTts();
    promptCache.tts = cacheTts;
    promptCache.diskKey = `${cacheTts.cacheKey}:v${PROMPT_CACHE_VERSION}`;
    await cacheTts.open();
    const prompts = collectFixedPrompts([TRANSFER_OFFER_PROMPT]);
    const concurrency = Number(process.env.PROMPT_CACHE_CONCURRENCY || 2);
    await promptCache.warm(prompts, { concurrency });
    if (promptCache.failed > prompts.length / 2 && TTS_FALLBACK) {
      console.warn(`⚠️ Primary TTS ${cacheTts.name} could not render ${promptCache.failed}/${prompts.length} prompts; this process now speaks with the fallback ${TTS_FALLBACK}`);
      processTtsDegraded = true;
      const fb = createTts({ provider: TTS_FALLBACK });
      await fb.open();
      promptCache.reset();
      promptCache.tts = fb;
      promptCache.diskKey = fb.cacheKey;
      await promptCache.warm(prompts, { concurrency });
    }
  } catch (err) {
    console.error(`⚠️ Prompt cache warm-up failed: ${err.message} (prompts will be synthesised live)`);
  }
}

// ============================================================================
// SERVER
// ============================================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'RSE Voice Gateway (pipeline prototype)',
    pipeline: {
      stt: STT_PROVIDER, tts: TTS_PROVIDER, llm: llm ? llm.name : 'none',
      ambience: AMBIENCE || 'off',
      tts_fallback: TTS_FALLBACK || 'off',
      tts_degraded: processTtsDegraded,
      prompt_cache: promptCache.summary(),
      active_calls: activeCalls.size,
    },
  });
});

const twilioWebhookGuard = createTwilioSignatureValidator({ authToken: TWILIO_AUTH_TOKEN, baseUrl: BASE_URL });

app.post('/twilio/voice', twilioWebhookGuard, (req, res) => {
  console.log('\n📞 Incoming call');
  console.log(`From: ${req.body.From?.replace(/(\d{3})\d{4}(\d{4})/, '$1***$2') || 'Unknown'}`);
  const host = req.headers.host;
  if (RELAY) {
    console.log('🔀 ConversationRelay call');
    return res.type('text/xml').send(relay.relayTwiml({ host, callerNumber: req.body.From || '' }));
  }
  const protocol = host?.includes('localhost') ? 'ws' : 'wss';
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${protocol}://${host}/stream">
      <Parameter name="callerNumber" value="${req.body.From || ''}" />
    </Stream>
  </Connect>
</Response>`);
});

// ConversationRelay hands the call back here when the relay ends (transfer or hang-up).
app.post('/twilio/relay-ended', twilioWebhookGuard, (req, res) => {
  console.log(`🔀 Relay ended (HandoffData: ${(req.body.HandoffData || '').slice(0, 80) || 'none'})`);
  res.type('text/xml').send(relay.relayEndedTwiml({ handoffData: req.body.HandoffData, callerNumber: req.body.From, transferNumber: TRANSFER_PHONE_NUMBER }));
});

// Twilio's recording of a ConversationRelay call is ready: pull it into Neon.
app.post('/twilio/recording-status', twilioWebhookGuard, (req, res) => {
  res.status(204).end();
  const { RecordingStatus, RecordingUrl, CallSid, RecordingSid } = req.body || {};
  if (RecordingStatus !== 'completed') return;
  console.log(`🎙️ Twilio recording ${RecordingSid} completed for ${CallSid} - fetching`);
  ingestTwilioRecording({ recordingUrl: RecordingUrl, callSid: CallSid, accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN })
    .then((r) => console.log(r.ok ? `🎙️ Twilio recording stored for call ${r.callRowId} (${r.seconds} s)` : `⚠️ Twilio recording not stored: ${r.reason || JSON.stringify(r.saved)}`))
    .catch((err) => console.error(`❌ Twilio recording ingest failed: ${err.message}`));
});

app.post('/twilio/transfer', twilioWebhookGuard, (req, res) => {
  console.log('🔄 Transfer endpoint called');
  const response = new twilio.twiml.VoiceResponse();
  response.say('Transferring you to a real person now.');
  if (TRANSFER_PHONE_NUMBER) {
    const callerNum = req.query.callerNumber || req.body.callerNumber;
    response.dial(callerNum ? { callerId: callerNum } : {}, TRANSFER_PHONE_NUMBER);
  } else {
    response.say("I'm sorry, the transfer service is not configured. Please call back during business hours.");
  }
  res.type('text/xml').send(response.toString());
});

// ============================================================================
// ONE CALL
// ============================================================================
class CallSession {
  constructor(twilioWs, req) {
    this.twilioWs = twilioWs;
    this.streamSid = null;
    this.callSid = null;
    this.callerNumber = null;
    this.baseUrl = BASE_URL || (req?.headers?.host ? `${req.headers.host.includes('localhost') ? 'http' : 'https'}://${req.headers.host}` : null);
    this.stateMachine = createCallStateMachine();
    this.transcriptRecorder = createTranscriptRecorder();
    this.recorder = CALL_RECORDING && process.env.DATABASE_URL ? new TrackRecorder() : null; // both sides' audio, stored at hang-up
    this.recordingStartedAt = null; // time base for the recording (the stream's start event)
    this.stt = null;
    this.tts = null;
    this.ambience = AMBIENCE === 'office' ? new RoomTone({ levelDb: AMBIENCE_LEVEL_DB }) : null;

    // Outbound audio
    this.playBuffer = Buffer.alloc(0);
    this.paceTimer = null;
    this.current = null;        // the utterance being played: { id, text, kind, utt, synthDone, startedAt, firstFrameAt }
    this.utteranceSeq = 0;

    // Turn state
    this.callStartAt = null;
    this.greetingStartedAt = null;
    this.callerSpeaking = false;
    this.callerSpeechStartAt = 0;
    this.bargeTimer = null;
    this.bargedIn = false;
    this.lastCallerStopAt = 0;  // for time-to-first-audio
    this.greetingPlayed = false;
    this.helloTimer = null;
    this.promptCounts = { state: null, counts: new Map() }; // loop detection
    this.pendingInput = null;
    this.lastProcessedTranscript = null;
    this.currentPromptText = null;
    this.transferRequested = false;
    this.transferOfferPending = false;
    this.callCompleted = false;
    this.cleanedUp = false;
    this.dbSaveStarted = false;
    this.watchdogTimer = null;
    this.repromptTimer = null;
    this.repromptsInState = { state: null, count: 0 };
    this.failsafeTimer = null;
    this.disconnectTimer = null;
    this.deadAirRecoveries = 0;

    // Measurements
    this.stats = { turns: 0, firstAudioMs: [], ttsLiveChars: 0, ttsCachedChars: 0, cacheHits: 0, bargeIns: 0, ignoredBackchannels: 0, ttsFallbacks: 0, fallbackSeconds: 0, liveSeconds: 0 };
    this.fallbackTts = null;   // used when the primary TTS returns no audio (quota, outage)
    this.ttsDegraded = processTtsDegraded;  // once the primary has failed, the rest of the call stays on the fallback

    twilioWs.on('message', (data) => this.onTwilioMessage(data));
    twilioWs.on('close', (code) => { console.log(`🔌 Twilio disconnected (code: ${code})`); this.cleanup().catch((e) => console.error('❌ Cleanup error:', e)); });
    twilioWs.on('error', (err) => console.error('❌ Twilio WebSocket error:', err.message));
  }

  // ---------------------------------------------------------------- Twilio in
  onTwilioMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (err) { console.error('❌ Bad Twilio message:', err.message); return; }
    switch (msg.event) {
      case 'connected':
        console.log('📨 Twilio event: connected');
        break;
      case 'start':
        this.onStart(msg.start);
        break;
      case 'media': {
        const frame = Buffer.from(msg.media.payload, 'base64');
        if (this.recorder && this.recordingStartedAt) this.recorder.add('caller', Date.now() - this.recordingStartedAt, frame);
        if (this.stt) this.stt.sendAudio(frame);
        break;
      }
      case 'dtmf': {
        const digit = msg.dtmf?.digit;
        console.log(`🔢 DTMF digit pressed: ${digit}`);
        if (digit === '0' && !this.transferRequested && !this.callCompleted) {
          console.log('📞 DTMF 0 pressed - transferring to team member');
          this.transferToRealPerson();
        }
        break;
      }
      case 'stop':
        console.log('📞 Stream stopped');
        this.cleanup().catch((e) => console.error('❌ Cleanup error:', e));
        break;
      default:
        break;
    }
  }

  onStart(start) {
    this.streamSid = start.streamSid;
    this.callSid = start.callSid;
    this.callStartAt = Date.now();
    this.recordingStartedAt = this.callStartAt;
    activeCalls.add(this);
    console.log(`📞 Stream started: ${this.streamSid}`);
    console.log(`📞 Call SID: ${this.callSid}`);
    console.log(`📞 Stream config received - caller: ${start.customParameters?.callerNumber || 'unknown'}`);
    if (start.customParameters?.callerNumber) {
      this.callerNumber = start.customParameters.callerNumber;
      this.stateMachine.updateData('phone', this.callerNumber);
    }

    this.startPacer();

    // STT and TTS connect in parallel with the greeting, which plays from the cache.
    this.stt = createStt();
    this.stt.on('speech_started', () => this.onCallerSpeechStarted());
    this.stt.on('interim', (e) => this.onCallerInterim(e));
    this.stt.on('speech_stopped', (e) => this.onCallerSpeechStopped(e));
    this.stt.on('transcript', (e) => this.onCallerTranscript(e));
    this.stt.on('error', (err) => console.error(`❌ STT (${this.stt.name}): ${err.message}`));
    const t0 = Date.now();
    this.stt.start().then(() => console.log(`🎧 STT ready: ${this.stt.name} (${Date.now() - t0} ms)`)).catch((err) => console.error(`❌ STT failed to start: ${err.message}`));

    this.tts = createTts();
    this.tts.on('error', (err) => console.error(`❌ TTS (${this.tts.name}): ${err.message}`));
    if (TTS_FALLBACK && TTS_FALLBACK !== TTS_PROVIDER) {
      try { this.fallbackTts = createTts({ provider: TTS_FALLBACK }); } catch (err) { console.error(`⚠️ TTS fallback unavailable: ${err.message}`); }
    }
    this.tts.open().then(() => console.log(`🗣️ TTS ready: ${this.tts.name} (${Date.now() - t0} ms)`)).catch((err) => console.error(`❌ TTS failed to open: ${err.message}`));

    console.log('👋 Sending greeting');
    this.greetingStartedAt = Date.now();
    this.currentPromptText = GREETING.primary;
    this.speak(GREETING.primary, { kind: 'greeting' });
  }

  // ---------------------------------------------------------------- Audio out
  startPacer() {
    if (this.paceTimer) clearInterval(this.paceTimer);
    this.paceTimer = setInterval(() => this.pump(), FRAME_MS);
  }

  pump() {
    if (!this.streamSid || this.twilioWs.readyState !== WebSocket.OPEN) return;
    let frame;
    let audible = false;
    // Hold a reply that would start sooner than REPLY_MIN_GAP_MS after the
    // caller stopped (not the greeting: nobody spoke before it).
    const holdReply = this.current && this.current.firstFrameAt == null && this.current.kind !== 'greeting'
      && this.lastCallerStopAt && Date.now() - this.lastCallerStopAt < REPLY_MIN_GAP_MS;
    if (!holdReply && this.playBuffer.length >= FRAME_BYTES) {
      frame = this.playBuffer.subarray(0, FRAME_BYTES);
      this.playBuffer = this.playBuffer.subarray(FRAME_BYTES);
      audible = true;
    } else if (!holdReply && this.playBuffer.length > 0) {
      frame = Buffer.concat([this.playBuffer, SILENCE_FRAME.subarray(this.playBuffer.length)]);
      this.playBuffer = Buffer.alloc(0);
      audible = true;
    } else {
      frame = SILENCE_FRAME;
    }
    if (audible && this.current && this.current.firstFrameAt == null) {
      this.current.firstFrameAt = Date.now();
      const sinceCaller = this.lastCallerStopAt ? this.current.firstFrameAt - this.lastCallerStopAt : null;
      const sinceStart = this.current.firstFrameAt - this.current.startedAt;
      if (sinceCaller != null && this.current.kind !== 'greeting') this.stats.firstAudioMs.push(sinceCaller);
      console.log(`🔊 First audio for "${this.current.text.slice(0, 40)}..." ${sinceStart} ms after request${sinceCaller != null ? `, ${sinceCaller} ms after the caller stopped` : ''}${this.current.cached ? ' (cached)' : ''}`);
    }
    if (this.ambience) frame = this.ambience.mixFrame(frame);
    if (this.recorder && this.recordingStartedAt) this.recorder.add('ava', Date.now() - this.recordingStartedAt, Buffer.from(frame));
    try {
      this.twilioWs.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: frame.toString('base64') } }));
    } catch (err) {
      console.error('❌ Error sending audio frame to Twilio:', err.message);
    }
    if (this.current && this.current.synthDone && this.playBuffer.length === 0) this.onPlaybackDone();
  }

  isSpeaking() {
    return Boolean(this.current) || this.playBuffer.length > 0;
  }

  /**
   * Say something. Cached prompts are queued at once; everything else streams
   * from TTS. `text` may be a string, or a function (utterance) => Promise that
   * feeds the utterance itself (LLM streaming). Returns the utterance record.
   */
  speak(text, { kind = 'prompt', allowDuringCompleted = false, feed = null } = {}) {
    if (this.callCompleted && !allowDuringCompleted) return null;
    if (this.twilioWs.readyState !== WebSocket.OPEN) return null;
    if (this.current && this.current.kind === 'goodbye') return null; // never talk over the goodbye
    if (this.current) this.stopPlayback('superseded');               // the newer prompt wins
    this.clearReprompt();
    this.clearWatchdog();

    const id = ++this.utteranceSeq;
    const rec = { id, text: typeof text === 'string' ? text : '', kind, utt: null, synthDone: false, startedAt: Date.now(), firstFrameAt: null, cached: false };
    this.current = rec;
    this.stats.turns++;

    const cached = typeof text === 'string' ? promptCache.get(text) : null;
    if (cached) {
      rec.cached = true;
      this.stats.cacheHits++;
      this.stats.ttsCachedChars += text.length;
      this.playBuffer = Buffer.concat([this.playBuffer, cached]);
      rec.synthDone = true;
      this.transcriptRecorder.add('ava', text);
      if (VERBOSE_DEBUG) console.log(`🗂️ Cached prompt (${(cached.length / 8000).toFixed(1)} s): "${text.slice(0, 60)}"`);
      return rec;
    }

    const engine = this.ttsDegraded && this.fallbackTts ? this.fallbackTts : this.tts;
    if (!engine) return null;
    const utt = this.startLive(rec, engine, typeof text === 'string' ? text : null);
    if (typeof text === 'string') {
      this.stats.ttsLiveChars += text.length;
      this.transcriptRecorder.add('ava', text);
      utt.append(text);
      utt.end();
    } else if (feed) {
      feed(rec, utt).catch((err) => {
        console.error(`❌ Reply generation failed: ${err.message}`);
        if (this.current !== rec) return;
        // The LLM is a convenience, not a dependency: fall back to the script
        // so the caller never sits in silence because a model call failed.
        utt.cancel();
        this.current = null;
        const fallback = this.stateMachine.getNextPrompt() || CLOSE.anything_else;
        this.speakPrompt(fallback);
      });
    }
    return rec;
  }

  /** One live utterance on `engine`, wired to `rec`; a string prompt that gets no audio is retried on the fallback. */
  startLive(rec, engine, text) {
    const utt = engine.speak();
    rec.utt = utt;
    const chunks = [];
    utt.on('audio', (buf) => {
      if (this.current !== rec) return;
      chunks.push(buf);
      this.playBuffer = Buffer.concat([this.playBuffer, buf]);
    });
    utt.on('end', () => {
      if (this.current !== rec) return;
      rec.synthDone = true;
      const seconds = utt.bytes / 8000;
      if (engine === this.fallbackTts) this.stats.fallbackSeconds += seconds; else this.stats.liveSeconds += seconds;
      if (utt.firstAudioAt) console.log(`🗣️ TTS ${engine.name} first byte ${utt.firstAudioAt - utt.startedAt} ms, ${seconds.toFixed(1)} s for ${utt.chars} chars`);
      if (text && !utt.cancelled && rec.kind === 'prompt' && engine === this.tts) promptCache.remember(text, Buffer.concat(chunks));
    });
    utt.on('error', (err) => {
      console.error(`❌ TTS utterance failed (${engine.name}): ${err.message}`);
      if (this.current !== rec) return;
      if (text && utt.bytes === 0 && engine !== this.fallbackTts && this.fallbackTts) {
        this.ttsDegraded = true;
        this.stats.ttsFallbacks++;
        console.warn(`🔁 Re-speaking on fallback TTS ${this.fallbackTts.name} (primary stays off for the rest of the call)`);
        const retry = this.startLive(rec, this.fallbackTts, text);
        retry.append(text);
        retry.end();
        return;
      }
      rec.synthDone = true;
    });
    return utt;
  }

  onPlaybackDone() {
    const done = this.current;
    this.current = null;
    if (!done) return;
    if (VERBOSE_DEBUG) console.log(`✅ Playback done: "${done.text.slice(0, 40)}..."`);
    if (done.kind === 'greeting') this.greetingPlayed = true;
    if (done.kind === 'goodbye') {
      this.scheduleDisconnect('goodbye_played', GOODBYE_BUFFER_MS);
      return;
    }
    if (done.kind === 'transfer_then') {
      this.transferToRealPerson();
      return;
    }
    if (this.pendingInput && !this.callCompleted) {
      const input = this.pendingInput;
      this.pendingInput = null;
      console.log(`📤 Processing queued input after playback: "${input.slice(0, 50)}..."`);
      setTimeout(() => this.processUserInput(input), 0);
      return;
    }
    if (!this.callCompleted && !this.callerSpeaking) this.armReprompt();
  }

  stopPlayback(reason) {
    const dropped = this.playBuffer.length;
    this.playBuffer = Buffer.alloc(0);
    if (this.current && this.current.utt) this.current.utt.cancel();
    this.current = null;
    if (this.twilioWs.readyState === WebSocket.OPEN && this.streamSid) {
      this.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    }
    if (dropped > 0 || reason === 'barge_in') console.log(`🛑 Playback stopped (${reason}), ${(dropped / 8000).toFixed(1)} s dropped`);
  }

  // ---------------------------------------------------------------- Caller in
  inGreetingGuard() {
    return this.greetingStartedAt != null && this.stateMachine.getState() === STATES.GREETING && Date.now() - this.greetingStartedAt < GREETING_GUARD_MS;
  }

  onCallerSpeechStarted() {
    if (!this.callerSpeaking) this.turnStartAt = Date.now();
    this.callerSpeaking = true;
    this.callerSpeechStartAt = Date.now();
    this.bargedIn = false;
    this.clearReprompt();
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (VERBOSE_DEBUG) console.log('🎤 User speaking...');
    if (!this.isSpeaking()) return;
    if (this.inGreetingGuard() || (this.current && this.current.kind === 'goodbye') || this.callCompleted) return;
    // Grace: a backchannel is over before this fires; a real interruption is not.
    const grace = this.stateMachine.getState() === STATES.CONFIRMATION ? BARGE_GRACE_CONFIRM_MS : BARGE_GRACE_MS;
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    this.bargeTimer = setTimeout(() => {
      this.bargeTimer = null;
      if (this.callerSpeaking && this.isSpeaking()) this.bargeIn(`kept talking for ${grace} ms`);
    }, grace);
  }

  onCallerInterim({ text }) {
    if (!this.bargeTimer || !this.isSpeaking()) return;
    const words = text.trim().split(/\s+/).filter(Boolean);
    const needed = this.stateMachine.getState() === STATES.CONFIRMATION ? BARGE_WORDS + 3 : BARGE_WORDS;
    if (words.length >= needed && !BACKCHANNEL.test(text.trim())) this.bargeIn(`"${text.slice(0, 30)}"`);
  }

  bargeIn(why) {
    if (this.bargeTimer) { clearTimeout(this.bargeTimer); this.bargeTimer = null; }
    if (!this.isSpeaking()) return;
    this.bargedIn = true;
    this.stats.bargeIns++;
    console.log(`🛑 Barge-in: caller ${why} - stopping Ava`);
    this.stopPlayback('barge_in');
  }

  onCallerSpeechStopped({ durationMs, endedAt }) {
    this.callerSpeaking = false;
    this.lastCallerStopAt = endedAt || Date.now();
    if (this.bargeTimer) { clearTimeout(this.bargeTimer); this.bargeTimer = null; }
    console.log(`🔇 User stopped speaking (${durationMs}ms)`);
    this.stateMachine.intakeLog('speech_end', { duration_ms: durationMs });
    if (!this.callCompleted && !this.isSpeaking()) this.armWatchdog();
  }

  onCallerTranscript({ text, durationMs, endedAt }) {
    const piece = String(text || '').trim();
    if (!piece) return;
    this.clearWatchdog();
    this.callerSpeaking = false;
    // No hold while Ava is talking (the caller is talking over her: handled
    // downstream), once the call is closing, or when disabled.
    if (!TURN_HOLD_MS || this.callCompleted || this.isSpeaking()) {
      const held = this.takeHeld();
      return this.handleTurn(held ? { text: `${held.text} ${piece}`, durationMs: held.durationMs + (durationMs || 0), endedAt } : { text: piece, durationMs, endedAt });
    }
    if (this.held) {
      this.held.text = `${this.held.text} ${piece}`;
      this.held.durationMs += durationMs || 0;
      this.held.endedAt = endedAt;
      console.log(`🧷 Caller kept going - merged: "${this.held.text.slice(0, 70)}"`);
    } else {
      this.held = { text: piece, durationMs: durationMs || 0, endedAt };
    }
    this.held.eotAt = Date.now();
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.checkHold(), TURN_HOLD_MS);
  }

  takeHeld() {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    const h = this.held;
    this.held = null;
    return h;
  }

  checkHold() {
    this.holdTimer = null;
    const h = this.held;
    if (!h) return;
    const voiceSince = this.stt && this.stt.lastVoiceAt > h.eotAt;
    if ((this.callerSpeaking || voiceSince) && Date.now() - h.eotAt < TURN_RESUME_MAX_MS) {
      // The caller is still talking: wait for the next transcript (it merges),
      // but never longer than TURN_RESUME_MAX_MS.
      this.holdTimer = setTimeout(() => this.checkHold(), 250);
      return;
    }
    this.takeHeld();
    this.handleTurn({ text: h.text, durationMs: h.durationMs, endedAt: h.endedAt });
  }

  handleTurn({ text, durationMs, endedAt }) {
    let transcript = String(text || '').trim();
    this.clearWatchdog();
    this.callerSpeaking = false;
    this.lastCallerStopAt = endedAt || Date.now();
    if (this.bargeTimer) { clearTimeout(this.bargeTimer); this.bargeTimer = null; }
    console.log(`📝 User said: "${transcript}"`);
    this.stateMachine.intakeLog('transcript', { transcript: transcript.substring(0, 100) });

    if (isLikelySilenceHallucination(transcript, durationMs)) {
      console.log(`🔇 Dropping likely ASR silence-hallucination: "${transcript}" (speech ${durationMs}ms)`);
      return;
    }
    this.transcriptRecorder.add('caller', transcript);
    if (this.callCompleted) { console.log('⏭️ Call completed - ignoring input'); return; }

    // Spoken numbers to digits (Flux writes "nine seven three ..."); the
    // phone, address and zip parsers in the state machine read digits.
    const stateNow = this.stateMachine.getState();
    const normalized = normalizeSpokenNumbers(transcript, { cardinals: stateNow === STATES.PHONE || stateNow === STATES.ADDRESS });
    if (normalized !== transcript) {
      console.log(`🔢 Numbers normalised: "${normalized}"`);
      transcript = normalized;
    }

    // "mm-hm" / "uh-huh" on its own is listening, not an answer, unless Ava
    // just asked a yes/no question (a read-back), where it means yes.
    if (BACKCHANNEL.test(transcript) && !/\b(is that (right|correct)|is everything correct)\?\s*$/i.test(this.currentPromptText || '')) {
      this.stats.ignoredBackchannels++;
      console.log(`🤫 Backchannel ignored: "${transcript}"`);
      return;
    }

    // Tail of the previous answer (see CONTINUATION_WINDOW_MS)?
    // Only the first prompt spoken in reply to a processed answer opens the
    // window, and only once: a re-ask must never open another (that cascaded,
    // dropping the caller's real answers one after another).
    const prompt = this.lastPromptRec;
    if (prompt && prompt.answerSeq === this.answerSeq && !prompt.windowUsed && this.turnStartAt
        && this.turnStartAt >= prompt.startedAt - 100
        && this.turnStartAt - prompt.startedAt < CONTINUATION_WINDOW_MS && this.lastAnswerState) {
      prompt.windowUsed = true;
      const lowerT = transcript.toLowerCase();
      if (detectRealPersonRequest(transcript, this.stateMachine.getState())) {
        console.log('🚨 Real person requested (in a late fragment) - transferring');
        this.transferToRealPerson();
        return;
      }
      if (this.lastAnswerState === STATES.SAFETY_CHECK && detectSafetyEmergency(lowerT)) {
        console.log(`🚨 Late fragment of the safety answer reports danger: "${transcript}"`);
        this.processUserInputAsEmergency();
        return;
      }
      console.log(`🧩 "${transcript}" started ${this.turnStartAt - prompt.startedAt} ms into Ava's new question: rest of the previous answer, not an answer to it`);
      this.stateMachine.intakeLog('state_event', { event: 'late_fragment_ignored', transcript: transcript.substring(0, 60) });
      this.turnStartAt = 0;
      // Re-ask if the fragment cut the question off; otherwise let it play on.
      if (!this.isSpeaking() && this.currentPromptText && !this.callCompleted) this.speakPrompt(this.currentPromptText, { reask: true });
      return;
    }

    if (this.isSpeaking() && !this.bargedIn) {
      // Ava is still talking and the caller did not interrupt her for real.
      if (BACKCHANNEL.test(transcript) || transcript.split(/\s+/).length <= 2 && !isClearYesOrNo(transcript)) {
        this.stats.ignoredBackchannels++;
        console.log(`🤫 Backchannel while Ava is talking, ignored: "${transcript}"`);
        return;
      }
      if (this.inGreetingGuard() && detectRealPersonRequest(transcript, this.stateMachine.getState())) {
        console.log('🚨 Transfer request during greeting - honouring immediately');
        this.transferToRealPerson();
        return;
      }
      this.pendingInput = this.pendingInput ? `${this.pendingInput} ${transcript}` : transcript;
      console.log(`🎵 Ava is talking - queued input: "${transcript.slice(0, 40)}..."`);
      return;
    }
    this.bargedIn = false;
    if (this.pendingInput) {
      const merged = `${this.pendingInput} ${transcript}`;
      this.pendingInput = null;
      this.processUserInput(merged);
      return;
    }
    this.processUserInput(transcript);
  }

  // ---------------------------------------------------------------- Turn logic (mirrors server-rse.js)
  processUserInput(transcript) {
    if (this.callCompleted) return;
    const sm = this.stateMachine;
    if (sm.getState() === STATES.ENDED) { console.log('⏭️ In ENDED state - ignoring input'); return; }

    if (transcript === this.lastProcessedTranscript) {
      const state = sm.getState();
      const cleaned = transcript.trim().replace(/[.,!?]+$/, '');
      const isAffirmative = /^(sounds\s+good|all\s+good|good)$/i.test(cleaned) || isClearYesOrNo(transcript);
      if ((state === STATES.CONFIRMATION || state === STATES.CLOSE) && isAffirmative) {
        console.log(`✅ Accepting "${transcript}" in ${state} (not treating as duplicate)`);
      } else {
        console.log('⏭️ Skipping duplicate transcript - will re-prompt');
        const prompt = sm.getNextPrompt();
        if (prompt) this.speakPrompt(`Sorry, I didn't catch that. ${prompt}`);
        return;
      }
    }
    // "Hi there." on its own after the greeting has played is the caller's
    // own hello, not a request to hear the greeting again: wait a moment for
    // the reason they called, then prompt if nothing comes.
    if (sm.getState() === STATES.GREETING && this.greetingPlayed && BARE_HELLO.test(transcript.trim())) {
      console.log(`👋 Caller said "${transcript}" - waiting ${HELLO_WAIT_MS} ms for the rest`);
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = setTimeout(() => {
        this.helloTimer = null;
        if (!this.callerSpeaking && !this.isSpeaking() && !this.callCompleted && sm.getState() === STATES.GREETING) {
          this.speakPrompt(GREETING.silence_fallback);
        }
      }, HELLO_WAIT_MS);
      return;
    }
    this.lastProcessedTranscript = transcript;

    const currentState = sm.getState();
    this.lastAnswerState = currentState; // the state this answer was given in (for late fragments)
    this.answerSeq = (this.answerSeq || 0) + 1; // the next prompt is the reply to this answer
    const lower = transcript.toLowerCase().trim();
    const currentData = sm.getData();
    console.log(`🔄 Processing input in state ${currentState}: "${transcript.substring(0, 50)}..."`);

    if (this.transferOfferPending) {
      if (/\b(yes|yeah|yep|please do|do it|sure|okay|ok|go ahead|that works|transfer me)\b/i.test(lower)) {
        console.log('✅ Caller accepted live-agent transfer offer');
        this.transferOfferPending = false;
        this.transferToRealPerson();
        return;
      }
      if (/\b(no|nope|nah|not now|don't|do not|keep going|continue|that's okay|thats okay)\b/i.test(lower)) {
        console.log('↩️ Caller declined live-agent transfer offer, continuing intake');
        this.transferOfferPending = false;
        this.promptCounts = { state: null, counts: new Map() }; // they want to keep going: do not offer again at once
        const resume = sm.getNextPrompt();
        if (resume) this.speakPrompt(resume);
        return;
      }
      this.speakPrompt(TRANSFER_OFFER_PROMPT);
      return;
    }

    if (detectRealPersonRequest(transcript, currentState)) {
      console.log('🚨 Real person requested - stopping AI flow and transferring immediately');
      this.transferToRealPerson();
      return;
    }

    const shortUtterance = transcript.trim().length < 35;
    const explicitRepeat = /\b(repeat|say that again|say again|come again|didn'?t hear|can'?t hear|anybody there|anyone there)\b/i.test(lower);
    // Only a bare "hello?" / "hi, hello?" is a repeat request: "Hi. I'm having
    // HVAC issue." (staging call Nov 3 2026) got the whole greeting again.
    const bareHello = /^\W*(hello|hey|hi|hiya)(\W+(hello|hey|hi|there|ava|anybody|anyone))*\W*$/i.test(lower);
    const repeatRequest = (shortUtterance && bareHello) || explicitRepeat;
    if (repeatRequest && ![STATES.CONFIRMATION, STATES.CLOSE, STATES.ENDED].includes(currentState)) {
      const promptToRepeat = this.currentPromptText || sm.getNextPrompt();
      if (promptToRepeat) {
        console.log(`🔄 User said "${transcript}" - repeating last prompt`);
        this.speakPrompt(promptToRepeat);
        return;
      }
    }

    let analysis = {};
    if ((currentState === STATES.GREETING || currentState === STATES.INTENT) && !currentData.intent) {
      const intentResult = classifyIntent(lower);
      if (intentResult && typeof intentResult === 'object') {
        analysis.intent = intentResult.intent;
        analysis.isNewInstallation = intentResult.isNew;
        console.log(`📋 Detected intent: ${analysis.intent} (new installation: ${analysis.isNewInstallation})`);
      } else if (intentResult) {
        analysis.intent = intentResult;
        console.log(`📋 Detected intent: ${analysis.intent}`);
      }
    } else if (currentData.intent) {
      console.log(`📋 Intent already locked: ${currentData.intent} - skipping classification`);
    }

    const result = sm.processInput(transcript, analysis);
    console.log(`📍 State machine result: nextState=${result.nextState}, action=${result.action}`);

    if (result.action === 'end' || result.action === 'end_call') {
      if (this.callCompleted) return;
      console.log('👋 End of call - delivering goodbye (single run)');
      sm.intakeLog('state_event', { event: 'closing_started', state: 'ended' });
      sm.updateData('_closeStateReached', true);
      const goodbye = result.prompt || CLOSE.goodbye;
      this.pendingInput = null;
      this.callCompleted = true;
      console.log('🔒 _callCompleted = true (no further prompts allowed)');
      sm.intakeLog('prompt', { prompt: goodbye.substring(0, 120) });
      this.speak(goodbye, { kind: 'goodbye', allowDuringCompleted: true });
      if (goodbye === SAFETY.emergency_response) this.scheduleDisconnect('emergency', 0, true);
      this.failsafeTimer = setTimeout(() => {
        if (this.twilioWs.readyState === WebSocket.OPEN) {
          console.log(`📞 Closing fail-safe: forcing hangup after ${CLOSING_FAILSAFE_MS}ms`);
          sm.intakeLog('state_event', { event: 'failsafe_hangup', elapsed_ms: CLOSING_FAILSAFE_MS });
          this.twilioWs.close(1000, 'Call completed');
        }
      }, CLOSING_FAILSAFE_MS);
    } else if (result.action === 'wait') {
      console.log('⏳ Waiting for user to continue (incomplete utterance)');
    } else if (result.prompt) {
      this.speakPrompt(result.prompt);
    } else if (result.action === 'redirect_out_of_scope') {
      this.speakPrompt(OUT_OF_SCOPE.general);
    } else if (result.action === 'transfer_after_prompt') {
      if (result.prompt) this.speakPrompt(result.prompt, { kind: 'transfer_then' });
      else this.transferToRealPerson();
    } else if (result.action === 'classify_intent') {
      this.naturalReply(transcript, 'classify_intent');
    } else if (result.action === 'answer_question' || result.action === 'handle_correction') {
      if (result.action === 'handle_correction' && result.prompt) {
        this.speakPrompt(result.prompt);
      } else if (sm.getState() === STATES.CLOSE) {
        console.log(`💬 Answering follow-up question in CLOSE state: "${transcript.substring(0, 50)}"`);
        sm.updateData('_anythingElsePrompted', false);
        this.naturalReply(transcript, result.action);
      } else {
        const fallback = sm.getNextPrompt();
        if (fallback) this.speakPrompt(fallback);
        else this.naturalReply(transcript, result.action);
      }
    }
  }

  speakPrompt(prompt, opts = {}) {
    // Loop breaker: the same prompt again and again in one state means the
    // call is stuck (seen: the recap asking for a name the state machine
    // never accepts in CONFIRMATION). server-rse.js has the same escape after
    // repeated failed prompts: skip the recap to CLOSE, elsewhere offer a person.
    const st = this.stateMachine.getState();
    if (this.promptCounts.state !== st) this.promptCounts = { state: st, counts: new Map() };
    const seen = (this.promptCounts.counts.get(prompt) || 0) + 1;
    this.promptCounts.counts.set(prompt, seen);
    if (seen > SAME_PROMPT_LIMIT && !opts.loopBreak && prompt !== TRANSFER_OFFER_PROMPT) {
      console.warn(`🔁 Loop detected: "${prompt.slice(0, 50)}" asked ${seen} times in ${st}`);
      this.stateMachine.intakeLog('state_event', { event: 'loop_break', state: st, prompt: prompt.substring(0, 80) });
      if (st === STATES.CONFIRMATION) {
        this.stateMachine.transitionTo(STATES.CLOSE);
        return this.speakPrompt(CLOSE.anything_else, { ...opts, loopBreak: true });
      }
      if (!this.transferOfferPending && !this.transferRequested) {
        this.transferOfferPending = true;
        return this.speakPrompt(TRANSFER_OFFER_PROMPT, { ...opts, loopBreak: true });
      }
    }
    this.currentPromptText = prompt;
    console.log(`🗣️ State prompt: "${prompt}"`);
    this.stateMachine.intakeLog('prompt', { prompt: prompt.substring(0, 120) });
    const state = this.stateMachine.getState();
    if (this.repromptsInState.state !== state) this.repromptsInState = { state, count: 0 };
    const rec = this.speak(prompt, { kind: 'prompt', ...opts });
    if (rec && !opts.reask && !opts.loopBreak) {
      // The first prompt after an answer is the reply that opens the late-fragment window.
      if (!this.lastPromptRec || this.lastPromptRec.answerSeq !== this.answerSeq) {
        rec.answerSeq = this.answerSeq;
        this.lastPromptRec = rec;
      }
    }
    return rec;
  }

  /** The caller reported danger after the safety question had already moved on. */
  processUserInputAsEmergency() {
    if (this.callCompleted) return;
    const sm = this.stateMachine;
    sm.updateData('isSafetyRisk', true);
    sm.transitionTo(STATES.ENDED);
    sm.intakeLog('state_event', { event: 'closing_started', state: 'ended', reason: 'safety_emergency_late' });
    this.pendingInput = null;
    this.callCompleted = true;
    this.speak(SAFETY.emergency_response, { kind: 'goodbye', allowDuringCompleted: true });
    this.scheduleDisconnect('emergency', CLOSING_FAILSAFE_MS, true);
  }

  /** Free-form reply: the LLM writes it, TTS speaks it a sentence at a time. */
  naturalReply(userInput, action) {
    if (!llm) {
      const fallback = this.stateMachine.getNextPrompt() || "I can take your information and have someone follow up. How can I help?";
      return this.speakPrompt(fallback);
    }
    const sm = this.stateMachine;
    const data = sm.getData();
    const forbidden = `FORBIDDEN - NEVER SAY: "next week" or "this week"; "lock in a time" or "get you scheduled"; any day confirmation; "we'll confirm everything"; "let me pull up available times"; any scheduling language; technician, tech, appointment. You do NOT schedule. You only collect information. Never quote prices. Plain spoken text only: no lists, no markdown, no emojis.`;
    let instruction;
    if (action === 'classify_intent') {
      instruction = `Caller said: "${userInput}"\n\nFigure out what they need. Allowed services only: HVAC (heating, AC, service, maintenance, installation, upgrades), generators, the Energy Efficiency Program, memberships (Home Comfort Plans), existing projects. If they mention something else (solar, electrical, plumbing), say: "We specialize in HVAC, generators, and the Energy Efficiency Program. I can help with that if you need."\n\nRespond with one brief acknowledgement and ONE clarifying question about their need. Two sentences max.\n${forbidden}`;
    } else if (action === 'answer_question') {
      instruction = `Caller asked: "${userInput}"\n\nAnswer briefly. You are intake only: do not schedule or promise times. If you don't know specifics, say "I can take your info and have someone follow up." Then ask: "${CLOSE.anything_else}" Two sentences plus that question, max.\n${forbidden}`;
    } else {
      instruction = `Caller is correcting something: "${userInput}"\n\nCurrent info: name ${data.firstName || ''} ${data.lastName || ''}; phone ${data.phone || 'not yet'}; email ${data.email || 'not yet'}; address ${data.address || 'not yet'}.\nAsk what needs fixing, confirm briefly, move on. Keep it short.\n${forbidden}`;
    }
    const history = this.transcriptRecorder.turns().slice(-8).map((t) => ({ role: t.speaker === 'ava' ? 'assistant' : 'user', content: t.text }));
    // The conversation must start with a user turn and the last turn must be the caller's.
    while (history.length && history[0].role !== 'user') history.shift();
    if (!history.length || history[history.length - 1].role !== 'user') history.push({ role: 'user', content: userInput });
    history.push({ role: 'user', content: instruction });
    console.log(`💬 Natural response via ${llm.name}: action=${action}, state=${sm.getState()}`);
    const t0 = Date.now();
    return this.speak(null, {
      kind: 'prompt',
      feed: async (rec, utt) => {
        let first = true;
        const full = await llm.reply({
          system: SYSTEM_PROMPT,
          messages: history,
          maxTokens: 160,
          onSentence: (s) => {
            if (this.current !== rec) return;
            if (first) { first = false; console.log(`💬 LLM first sentence ${Date.now() - t0} ms: "${s.slice(0, 60)}"`); }
            rec.text += (rec.text ? ' ' : '') + s;
            this.stats.ttsLiveChars += s.length;
            utt.append(s);
          },
        });
        if (this.current === rec) {
          this.currentPromptText = full;
          this.transcriptRecorder.add('ava', full);
          console.log(`📜 AI said: "${full}"`);
        }
        utt.end();
      },
    });
  }

  // ---------------------------------------------------------------- Safety nets
  armWatchdog() {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.callCompleted || this.isSpeaking() || this.callerSpeaking) return;
      this.deadAirRecoveries++;
      console.log(`⚠️ WATCHDOG: No response ${WATCHDOG_MS}ms after the caller stopped (recovery ${this.deadAirRecoveries})`);
      if (this.deadAirRecoveries > 3) { this.offerTransfer('watchdog'); return; }
      const prompt = this.stateMachine.getNextPrompt();
      if (prompt) this.speakPrompt(`Sorry, I didn't catch that. ${prompt}`);
    }, WATCHDOG_MS);
  }
  clearWatchdog() { if (this.watchdogTimer) { clearTimeout(this.watchdogTimer); this.watchdogTimer = null; } }

  armReprompt() {
    this.clearReprompt();
    const state = this.stateMachine.getState();
    if (state === STATES.ENDED) return;
    this.repromptTimer = setTimeout(() => {
      this.repromptTimer = null;
      if (this.callCompleted || this.isSpeaking() || this.callerSpeaking) return;
      if (this.repromptsInState.state !== state) this.repromptsInState = { state, count: 0 };
      this.repromptsInState.count++;
      if (this.repromptsInState.count > MAX_REPROMPTS) { this.offerTransfer('silence'); return; }
      const prompt = this.stateMachine.getNextPrompt();
      console.log(`🔁 Silence recovery (${this.repromptsInState.count}/${MAX_REPROMPTS}) in ${state}`);
      if (prompt) this.speakPrompt(state === STATES.GREETING ? GREETING.silence_fallback : `Are you still there? ${prompt}`);
    }, REPROMPT_MS);
  }
  clearReprompt() { if (this.repromptTimer) { clearTimeout(this.repromptTimer); this.repromptTimer = null; } }

  offerTransfer(reason) {
    if (this.transferRequested || this.callCompleted || this.transferOfferPending) return;
    this.transferOfferPending = true;
    console.warn(`⚠️ Offering live-agent transfer due to communication issue: ${reason}`);
    this.speakPrompt(TRANSFER_OFFER_PROMPT);
  }

  scheduleDisconnect(reason, delayMs, force = false) {
    if (this.disconnectTimer && !force) return;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      if (this.failsafeTimer) { clearTimeout(this.failsafeTimer); this.failsafeTimer = null; }
      console.log(`📞 Disconnecting call (${reason})`);
      this.stateMachine.intakeLog('state_event', { event: 'hangup_executed', reason });
      if (this.twilioWs.readyState === WebSocket.OPEN) this.twilioWs.close(1000, 'Call completed');
    }, delayMs);
  }

  async transferToRealPerson() {
    if (this.transferRequested) return;
    this.transferRequested = true;
    console.log('🔄 Transferring call to real person...');
    this.stopPlayback('transfer');
    if (this.stt) this.stt.close();
    if (this.callSid && TRANSFER_PHONE_NUMBER && twilioClient) {
      try {
        if (!this.baseUrl) throw new Error('BASE_URL not configured and cannot be determined from request');
        const transferUrl = `${this.baseUrl}/twilio/transfer?callerNumber=${encodeURIComponent(this.callerNumber || '')}`;
        console.log(`📞 Transferring call ${this.callSid} to ${TRANSFER_PHONE_NUMBER} via ${transferUrl}`);
        await twilioClient.calls(this.callSid).update({ url: transferUrl, method: 'POST' });
      } catch (error) {
        console.error('❌ Error transferring call:', error);
        if (this.twilioWs.readyState === WebSocket.OPEN) this.twilioWs.close();
      }
    } else {
      console.log('⚠️ Transfer not configured - callSid, transfer number, or Twilio client missing');
      if (this.twilioWs.readyState === WebSocket.OPEN) this.twilioWs.close();
    }
  }

  // ---------------------------------------------------------------- Hang-up
  async cleanup() {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    activeCalls.delete(this);
    if (this.paceTimer) clearInterval(this.paceTimer);
    for (const t of ['watchdogTimer', 'repromptTimer', 'bargeTimer', 'failsafeTimer', 'disconnectTimer', 'helloTimer', 'holdTimer']) {
      if (this[t]) { clearTimeout(this[t]); this[t] = null; }
    }
    if (this.stt) this.stt.close();
    if (this.tts) this.tts.close();

    let data = this.stateMachine.getData();
    const currentState = this.stateMachine.getState();
    data = await cleanCallData(data);
    console.log('📋 Call data collected:', JSON.stringify(data, null, 2));
    console.log(`📋 Final state: ${currentState}`);

    const callId = this.streamSid || `CALL-${Date.now()}`;
    logCallIntake(data, currentState, { callId, callerNumber: this.callerNumber, wasTransferred: this.transferRequested })
      .catch((err) => console.error('❌ Failed to log to Google Sheets:', err.message));

    if (!this.dbSaveStarted) {
      this.dbSaveStarted = true;
      const endedAt = Date.now();
      saveCallToDb(data, currentState, {
        callId,
        twilioCallSid: this.callSid,
        callerNumber: this.callerNumber,
        wasTransferred: this.transferRequested,
        startedAt: this.callStartAt || endedAt,
        endedAt,
        environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || 'local',
        transcript: this.transcriptRecorder.turns(),
      }).then(async (saved) => {
        if (saved && saved.id && this.recorder) await saveRecording(saved.id, this.recorder, 'server');
      }).catch((err) => console.error('❌ Call DB save rejected unexpectedly:', err.message));
    }

    try {
      await sendCallSummaryEmail(data, currentState, {
        callId,
        callerNumber: this.callerNumber,
        callDurationMs: this.callStartAt ? Date.now() - this.callStartAt : null,
        timestamp: new Date().toISOString(),
        wasTransferred: this.transferRequested,
      });
      console.log('📨 Email function completed');
    } catch (err) {
      console.error('❌ Email invocation error:', err);
    }

    const durationS = this.callStartAt ? Math.round((Date.now() - this.callStartAt) / 1000) : 0;
    console.log(`📊 Call summary | caller: ${this.callerNumber || 'unknown'} | state: ${currentState} | intent: ${data.intent || 'none'} | transferred: ${this.transferRequested ? 'yes' : 'no'} | duration: ${durationS}s`);
    this.logCost(durationS);
  }

  logCost(durationS) {
    const min = durationS / 60;
    const s = this.stats;
    const sttCost = STT_PROVIDER === 'deepgram' ? min * PRICE.deepgramPerMin : min * PRICE.openaiSttPerMin;
    const primaryCost = TTS_PROVIDER === 'openai'
      ? (s.liveSeconds / 60) * PRICE.openaiTtsPerMin
      : (s.ttsLiveChars / 1000) * (TTS_PROVIDER === 'cartesia' ? PRICE.cartesiaPer1kChars : PRICE.elevenlabsPer1kChars);
    const ttsCost = primaryCost + (s.fallbackSeconds / 60) * PRICE.openaiTtsPerMin;
    const u = llm ? llm.usage : { input: 0, output: 0, calls: 0 };
    const llmCost = (u.input / 1e6) * PRICE.llmInPerM + (u.output / 1e6) * PRICE.llmOutPerM;
    const total = sttCost + ttsCost + llmCost;
    const sorted = [...s.firstAudioMs].sort((a, b) => a - b);
    const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
    console.log(`⏱️ Turn latency (caller stopped -> first audio): n=${sorted.length} p50=${pct(0.5)} p90=${pct(0.9)} max=${sorted[sorted.length - 1] ?? null} ms | barge-ins ${s.bargeIns}, backchannels ignored ${s.ignoredBackchannels}`);
    console.log(`💵 Pipeline cost estimate | ${durationS}s | stt ${STT_PROVIDER} $${sttCost.toFixed(4)} | tts ${TTS_PROVIDER} ${s.ttsLiveChars} live chars $${ttsCost.toFixed(4)} (+${s.ttsCachedChars} chars from cache, ${s.cacheHits} hits, ${promptCache.composed} composed${s.ttsFallbacks ? `; fallback ${TTS_FALLBACK} ${s.fallbackSeconds.toFixed(0)} s` : ''}) | llm ${u.calls} calls ${u.input}/${u.output} tokens $${llmCost.toFixed(4)} | total $${total.toFixed(4)} = $${min > 0 ? (total / min).toFixed(4) : '0'}/min`);
  }
}

wss.on('connection', (twilioWs, req) => {
  if ((req.url || '').startsWith('/relay')) {
    console.log('📞 New ConversationRelay connection');
    new relay.RelaySession(twilioWs, { llm, transferNumber: TRANSFER_PHONE_NUMBER, twilioClient, baseUrl: BASE_URL, record: CALL_RECORDING && Boolean(process.env.DATABASE_URL) }); // eslint-disable-line no-new
    return;
  }
  console.log('📞 New connection');
  new CallSession(twilioWs, req); // eslint-disable-line no-new
});

// ============================================================================
// START
// ============================================================================
server.listen(PORT, () => {
  console.log('🚀 RSE Voice Gateway (pipeline prototype) initializing...');
  console.log(`🎧 STT: ${STT_PROVIDER}${STT_PROVIDER === 'deepgram' ? ` (${process.env.DEEPGRAM_MODEL || 'nova-3'})` : ' (Realtime VAD + gpt-4o-mini-transcribe; set DEEPGRAM_API_KEY for Nova-3)'}`);
  console.log(`🔁 TTS fallback: ${TTS_FALLBACK || 'off'}`);
  const ttsDetail = {
    elevenlabs: `${process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5'}, voice ${process.env.ELEVENLABS_VOICE_ID || 'kdnRe2koJdOK4Ovxn2DI'}`,
    cartesia: `${process.env.CARTESIA_MODEL_ID || 'sonic-3'}, voice ${process.env.CARTESIA_VOICE_ID}`,
    openai: `${process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts'}, voice ${process.env.OPENAI_TTS_VOICE || 'sage'}`,
  }[TTS_PROVIDER];
  console.log(`🗣️ TTS: ${TTS_PROVIDER} (${ttsDetail})`);
  console.log(`💬 LLM: ${llm ? llm.name : 'none'} (free-form parts only)`);
  console.log(`🎚️ Ambience: ${AMBIENCE === 'office' ? `office room tone at ${AMBIENCE_LEVEL_DB} dBFS` : 'off (AMBIENCE=office to enable)'}`);
  console.log(`🧷 Turn hold ${TURN_HOLD_MS} ms after end of turn (merge if the caller keeps going); replies start no sooner than ${REPLY_MIN_GAP_MS} ms after the caller stops`);
  if (CALL_RECORDING && !process.env.DATABASE_URL) {
    console.warn('⚠️ CALL_RECORDING is on but DATABASE_URL is not set: nothing will be recorded');
  } else if (CALL_RECORDING) {
    console.log(`🎙️ Call recording on: both sides of every call are stored in Neon at hang-up and kept ${CALL_RECORDING_KEEP_DAYS} days`);
    pruneOldRecordings(CALL_RECORDING_KEEP_DAYS).catch((err) => console.error('❌ Recording prune failed:', err.message));
  } else {
    console.log('🎙️ Call recording off (set CALL_RECORDING=on to store both sides of every call in Neon)');
  }
  console.log(`⏱️ Barge-in grace ${BARGE_GRACE_MS} ms (${BARGE_GRACE_CONFIRM_MS} ms during the recap), watchdog ${WATCHDOG_MS} ms, re-prompt ${REPROMPT_MS} ms`);
  console.log(`📍 Webhook: https://<your-domain>/twilio/voice`);
  if (RELAY) console.log(`🔀 ConversationRelay ON: Twilio does STT (Flux) and TTS (ElevenLabs ${relay.RELAY_VOICE}); the media-stream path above is idle`);
  console.log('🎧 Waiting for calls...');
  warmPromptCache();
});

process.on('uncaughtException', (err) => console.error('❌ Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('❌ Unhandled rejection:', reason));
