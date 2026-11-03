/**
 * Daily smoke call: proves Ava is answering the phone.
 *
 * Two modes (SMOKE_CALL_MODE). "full" (the default) runs a whole intake call
 * with the harness's scripted caller: see src/monitor/smoke-full-call.js.
 * "greeting" is the original check described below.
 *
 * Once a day the daily check (src/monitor/daily-check.js, started by
 * src/monitor/schedule.js inside the production server) places a real
 * phone call from a test number to Ava's own number. The outbound leg's
 * TwiML is a <Connect><Stream> back to this server at /smoke/stream, so
 * Twilio hands us what Ava says, 8 kHz mu-law, exactly as a caller hears
 * it. We never send audio back (the "caller" stays silent), collect about
 * 15 s after the first non-silent frame, hang up, transcribe the audio
 * once (OpenAI gpt-4o-mini-transcribe) and compare it with her opening
 * greeting (GREETING.primary in src/scripts/rse-script.js).
 *
 * Pass = audio arrived within 10 s of the stream starting AND the
 * transcript matches the greeting loosely (most of its words, in order).
 * Anything else is a FAIL with the reason: the call never connected, no
 * audio came through, or the transcript is something else (quoted).
 *
 * The result goes to Neon when DATABASE_URL is set: a test_runs row with
 * scenario "daily-greeting" (shown on the web app's Test calls tab), the
 * heard audio in recordings, attached to the calls row Ava herself writes
 * for the call (marked is_test so the main Calls list hides it) or, when
 * she wrote none, to a calls row of our own with source "smoke-test".
 *
 * Gated on DAILY_SMOKE_CALL=on. Never runs on GitHub Actions: Twilio has
 * locked the account twice for API calls from Actions runners.
 *
 * Cost per call: a Twilio outbound leg plus Ava's inbound leg for ~30 s,
 * two media streams, one 15 s transcription and Ava's own Realtime session
 * for the greeting: a few cents. No Realtime session on this side.
 */

const crypto = require('crypto');
const { WebSocket } = require('ws');
const { GREETING } = require('../scripts/rse-script');
const { int16ToPcm16leBuffer, muLawToPcm16 } = require('../g711');
const callDb = require('../utils/call-db');

const SCENARIO = 'daily-greeting';
const FULL_SCENARIO = 'daily-full-call';
const TEST_REASON = 'daily smoke call';
const STREAM_PATH = '/smoke/stream';
const TIME_ZONE = 'America/New_York';
const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

const RING_TIMEOUT_S = 30;              // Twilio stops ringing Ava's number after this
const STREAM_START_TIMEOUT_MS = 45_000; // dialling + answer + stream connect
const START_MSG_TIMEOUT_MS = 10_000;    // a socket on /smoke/stream must send "start" within this
const FIRST_AUDIO_TIMEOUT_MS = 10_000;  // Ava's first non-silent frame must arrive within this
const LISTEN_MS = 15_000;               // audio collected after the first non-silent frame
const SPEECH_RMS = 300;                 // decoded PCM16 RMS above this is "not silence" (speech is 1000+)
const GREETING_MATCH_MIN = 0.7;         // fraction of greeting words heard, in order
const ROW_WAIT_MS = 30_000;             // how long to wait for Ava's own calls row after hang-up
const MULAW_SILENCE = 0xff;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function lastTen(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Read the feature's settings from the environment. `enabled` is the
 * DAILY_SMOKE_CALL flag; `problems` lists what else is missing, so the
 * server can say at start-up why no call will be placed.
 */
function smokeCallConfig(env = process.env) {
  const flag = String(env.DAILY_SMOKE_CALL || '').trim().toLowerCase();
  const enabled = ['on', 'true', '1', 'yes'].includes(flag);
  const from = String(
    env.SMOKE_CALL_FROM
    || String(env.TEST_CALLER_NUMBERS || '').split(',')[0]
    || env.TEST_CALLER_FROM
    || ''
  ).trim();
  const to = String(env.TWILIO_NUMBER || '').trim();
  const base = env.PUBLIC_BASE_URL
    || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')
    || env.LOCAL_PUBLIC_BASE_URL
    || '';
  const streamUrl = base ? `${String(base).trim().replace(/^http/i, 'ws').replace(/\/+$/, '')}${STREAM_PATH}` : '';

  const problems = [];
  if (!from) problems.push('no SMOKE_CALL_FROM or TEST_CALLER_NUMBERS (the number to call from)');
  if (!to) problems.push('no TWILIO_NUMBER (the number to call)');
  if (from && to && lastTen(from) === lastTen(to)) problems.push('SMOKE_CALL_FROM is the same number as TWILIO_NUMBER');
  if (!streamUrl) problems.push('no PUBLIC_BASE_URL (Twilio must reach this server at wss://<host>/smoke/stream)');
  else if (!/^wss:\/\//i.test(streamUrl)) problems.push(`stream URL must be wss:// for Twilio to reach it (got ${streamUrl})`);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) problems.push('no TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN');
  if (!env.OPENAI_API_KEY) problems.push('no OPENAI_API_KEY (needed to transcribe what Ava said)');

  // "full": a whole intake call with the harness's scripted caller
  // (src/monitor/smoke-full-call.js). "greeting": listen to the greeting only.
  const mode = String(env.SMOKE_CALL_MODE || 'full').trim().toLowerCase() === 'greeting' ? 'greeting' : 'full';
  const scenario = String(env.SMOKE_CALL_SCENARIO || 'no-heat').trim() || 'no-heat';

  return { enabled, from, to, streamUrl, problems, mode, scenario };
}

// ---------------------------------------------------------------------------
// Keeping smoke calls out of the Sheet and the summary email
// ---------------------------------------------------------------------------

// While a smoke call is running (and briefly after, since Ava writes her logs
// once her leg closes), calls from its number are ours: server-rse.js skips
// the Google Sheets row and the summary email for them. Calls from that
// number at any other time are logged as usual.
let ourCall = null; // { ten, until }

function markSmokeCall(from, ms) {
  ourCall = { ten: lastTen(from), until: Date.now() + ms };
}

function isSmokeCaller(number) {
  return Boolean(ourCall && ourCall.ten && lastTen(number) === ourCall.ten && Date.now() < ourCall.until);
}

// ---------------------------------------------------------------------------
// The /smoke/stream WebSocket (served by src/server-rse.js next to /stream)
// ---------------------------------------------------------------------------

// The one call in flight, if any. Twilio's "start" message must carry the
// token this call put in its TwiML; anything else on /smoke/stream is closed.
let pending = null;

/** Claim /smoke/stream for one call; false when another is in flight. */
function registerSession(session) {
  if (pending) return false;
  pending = session;
  return true;
}

function releaseSession(session) {
  if (pending === session) pending = null;
}

function isSmokeStreamRequest(req) {
  const url = String((req && req.url) || '');
  return url === STREAM_PATH || url.startsWith(`${STREAM_PATH}?`);
}

function closeSocket(ws, code, reason) {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
  } catch (_) { /* already gone */ }
}

/**
 * Handle a Twilio media stream on /smoke/stream. Called by the server's
 * WebSocket connection handler before any of the normal call logic runs.
 */
function handleStream(ws, req) {
  let session = null;
  const startTimer = setTimeout(() => {
    if (!session) {
      console.warn(`⛔ ${STREAM_PATH}: no "start" message within ${START_MSG_TIMEOUT_MS / 1000} s; closing`);
      closeSocket(ws, 1008, 'no start');
    }
  }, START_MSG_TIMEOUT_MS);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (!session) {
      if (msg.event !== 'start') return;
      const token = msg.start && msg.start.customParameters && msg.start.customParameters.token;
      if (!pending || !token || token !== pending.token || pending.ws) {
        console.warn(`⛔ ${STREAM_PATH}: stream ${msg.start && msg.start.streamSid} is not the smoke call in progress; closing`);
        clearTimeout(startTimer);
        closeSocket(ws, 1008, 'unexpected smoke stream');
        return;
      }
      clearTimeout(startTimer);
      session = pending;
      session.onStart(ws, msg.start);
      return;
    }
    if (msg.event === 'media' && msg.media && msg.media.payload) {
      session.onMedia(Buffer.from(msg.media.payload, 'base64'));
    } else if (msg.event === 'stop') {
      session.onStop('stream_stopped');
    }
  });
  ws.on('close', () => {
    clearTimeout(startTimer);
    if (session) session.onStop('socket_closed');
  });
  ws.on('error', (err) => {
    if (session) session.onError(err);
    else console.warn(`⚠️ ${STREAM_PATH} socket error before start: ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** RMS of a mu-law frame after decoding to PCM16. */
function frameRms(mulaw) {
  const pcm = muLawToPcm16(mulaw);
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

function isSilentFrame(mulaw) {
  return frameRms(mulaw) < SPEECH_RMS;
}

/** 16-bit mono PCM WAV from a PCM16 little-endian buffer. */
function wavFromPcm16(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function mulawToWav(mulaw) {
  return wavFromPcm16(int16ToPcm16leBuffer(muLawToPcm16(mulaw)), 8000);
}

/** One transcription request for the whole clip. Node's own fetch/FormData. */
async function transcribe(mulaw, apiKey) {
  const form = new FormData();
  form.append('file', new Blob([mulawToWav(mulaw)], { type: 'audio/wav' }), 'ava.wav');
  form.append('model', TRANSCRIBE_MODEL);
  form.append('language', 'en');
  form.append('response_format', 'json');
  const res = await fetch(TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`transcription HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return String(json.text || '').trim();
}

// ---------------------------------------------------------------------------
// Greeting comparison
// ---------------------------------------------------------------------------

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Loose match: the longest run of greeting words that appear in the
 * transcript in the same order (longest common subsequence), as a fraction
 * of the greeting's words. Case and punctuation are ignored, so "R.S.E."
 * vs "RSE" or a dropped "an" do not matter; a different sentence does.
 */
function greetingMatch(transcript, greeting = GREETING.primary) {
  const want = words(greeting);
  const got = words(transcript);
  const m = want.length;
  const n = got.length;
  let prev = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const cur = new Uint16Array(n + 1);
    for (let j = 1; j <= n; j++) {
      cur[j] = want[i - 1] === got[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const matched = prev[n];
  const fraction = m ? matched / m : 0;
  return { matched, total: m, fraction: Number(fraction.toFixed(3)), ok: m > 0 && fraction >= GREETING_MATCH_MIN };
}

// ---------------------------------------------------------------------------
// The call itself
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Place one smoke call and listen to Ava's greeting. Never throws for a
 * failed call; the result says what happened. Throws only when invoked
 * somewhere it must not run (GitHub Actions).
 *
 * @param {object} [opts]
 * @param {object} [opts.twilioClient]  the server's Twilio client (else one is built from env)
 * @param {object} [opts.config]        smokeCallConfig() result
 * @param {object} [opts.log]           console-like
 * @returns {Promise<SmokeResult>}
 */
async function runSmokeCall({ twilioClient = null, config = smokeCallConfig(), log = console } = {}) {
  if (process.env.GITHUB_ACTIONS) {
    throw new Error('the smoke call never runs on GitHub Actions runners (Twilio account lock-outs)');
  }

  const result = {
    scenario: SCENARIO,
    mode: 'phone',
    passed: false,
    reason: null,
    transcript: null,
    greetingMatch: null,
    expectedGreeting: GREETING.primary,
    timings: {},
    callSid: null,
    streamSid: null,
    from: config.from,
    to: config.to,
    streamUrl: config.streamUrl,
    endedHow: null,
    dialedAt: null,
    hungUpAt: null,
    audio: null,
    audioMs: 0,
  };

  if (config.problems.length) {
    result.reason = `not configured: ${config.problems.join('; ')}`;
    result.endedHow = 'no call placed';
    return result;
  }
  if (pending) {
    result.reason = 'a smoke call is already in progress';
    result.endedHow = 'no call placed';
    return result;
  }

  const client = twilioClient || require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const token = crypto.randomBytes(16).toString('hex');
  const chunks = [];
  let bytes = 0;
  let streamStartedAt = null;
  let firstAudioAt = null;
  let outcome = null;
  let settle;
  const finished = new Promise((resolve) => { settle = resolve; });
  const timers = [];
  const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  const finish = (how) => {
    if (outcome) return;
    outcome = how;
    timers.forEach(clearTimeout);
    settle(how);
  };

  const session = {
    token,
    ws: null,
    onStart(ws, start) {
      session.ws = ws;
      streamStartedAt = Date.now();
      result.streamSid = start.streamSid || null;
      result.timings.ringMs = streamStartedAt - result.dialedAt;
      log.log(`📞 Smoke call: stream ${result.streamSid} connected ${seconds(result.timings.ringMs)} after dialling`);
      later(FIRST_AUDIO_TIMEOUT_MS, () => { if (!firstAudioAt) finish('no_audio'); });
    },
    onMedia(frame) {
      if (outcome) return;
      chunks.push(frame);
      bytes += frame.length;
      if (!firstAudioAt && !isSilentFrame(frame)) {
        firstAudioAt = Date.now();
        result.timings.firstAudioMs = firstAudioAt - streamStartedAt;
        log.log(`📞 Smoke call: first audio ${seconds(result.timings.firstAudioMs)} after the stream started; listening for ${LISTEN_MS / 1000} s`);
        later(LISTEN_MS, () => finish('listened'));
      }
    },
    onStop(how) { finish(how); },
    onError(err) { log.warn(`⚠️ Smoke call: stream error: ${err.message}`); },
  };

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(config.streamUrl)}">
      <Parameter name="token" value="${token}" />
      <Parameter name="purpose" value="${SCENARIO}" />
    </Stream>
  </Connect>
</Response>`;

  pending = session;
  markSmokeCall(config.from, 5 * 60_000);
  later(STREAM_START_TIMEOUT_MS, () => { if (!streamStartedAt) finish('no_stream'); });
  result.dialedAt = Date.now();
  log.log(`📞 Smoke call: dialling ${config.to} from ${config.from} (stream ${config.streamUrl})`);
  try {
    const call = await client.calls.create({ from: config.from, to: config.to, timeout: RING_TIMEOUT_S, twiml });
    result.callSid = call.sid;
    log.log(`📞 Smoke call: Twilio call ${call.sid} created`);
  } catch (err) {
    timers.forEach(clearTimeout);
    pending = null;
    result.reason = `Twilio could not place the call: ${err.message}`;
    result.endedHow = 'no call placed';
    return result;
  }

  await finished;
  if (pending === session) pending = null;
  markSmokeCall(config.from, 2 * 60_000);

  // Hang up (idempotent: a call that already ended makes Twilio reply 400/404).
  result.hungUpAt = Date.now();
  try {
    await client.calls(result.callSid).update({ status: 'completed' });
  } catch (err) {
    if (!/not in-progress|20404|not found/i.test(err.message)) log.warn(`⚠️ Smoke call: could not end call ${result.callSid}: ${err.message}`);
  }
  if (session.ws) closeSocket(session.ws, 1000, 'smoke call done');

  result.audio = Buffer.concat(chunks);
  result.audioMs = Math.round(bytes / 8);
  result.timings.callMs = result.hungUpAt - result.dialedAt;
  if (streamStartedAt) result.timings.streamMs = result.hungUpAt - streamStartedAt;

  // Verdict.
  if (outcome === 'no_stream') {
    let status = 'unknown';
    try {
      status = (await client.calls(result.callSid).fetch()).status;
    } catch (_) { /* leave unknown */ }
    result.reason = `the call never connected a media stream to ${STREAM_PATH} within ${STREAM_START_TIMEOUT_MS / 1000} s (Twilio call status: ${status})`;
    result.endedHow = `never connected (Twilio status ${status})`;
  } else if (!firstAudioAt) {
    result.reason = outcome === 'no_audio'
      ? `no audio from Ava within ${FIRST_AUDIO_TIMEOUT_MS / 1000} s of the stream starting`
      : `the call ended (${outcome.replace(/_/g, ' ')}) after ${seconds(result.timings.streamMs || 0)} without any audio from Ava`;
    result.endedHow = outcome === 'no_audio' ? `hung up by the smoke test after ${FIRST_AUDIO_TIMEOUT_MS / 1000} s of silence` : outcome.replace(/_/g, ' ');
  } else {
    result.endedHow = outcome === 'listened'
      ? `hung up by the smoke test after ${LISTEN_MS / 1000} s of audio`
      : `${outcome.replace(/_/g, ' ')} after ${seconds(result.hungUpAt - firstAudioAt)} of audio`;
    const t = Date.now();
    try {
      result.transcript = await transcribe(result.audio, process.env.OPENAI_API_KEY);
      result.timings.transcribeMs = Date.now() - t;
      result.greetingMatch = greetingMatch(result.transcript);
      if (result.greetingMatch.ok) {
        result.passed = true;
      } else {
        result.reason = `what Ava said does not match her greeting (${result.greetingMatch.matched} of ${result.greetingMatch.total} words in order): "${result.transcript || '(nothing transcribed)'}"`;
      }
    } catch (err) {
      result.timings.transcribeMs = Date.now() - t;
      result.reason = `audio arrived but could not be transcribed: ${err.message}`;
    }
  }

  if (result.passed) {
    log.log(`✅ Daily smoke call PASS: Ava answered ${seconds(result.timings.firstAudioMs)} after the stream started and said her greeting (call ${result.callSid}): "${result.transcript}"`);
  } else {
    log.error(`❌ Daily smoke call FAIL: ${result.reason} (call ${result.callSid || 'not placed'})`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Storing the result in Neon
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The report JSON kept on the test_runs row (what the web app shows). */
function buildReport(result) {
  return {
    kind: 'smoke',
    scenario: result.scenario,
    passed: result.passed,
    reason: result.reason,
    transcript: result.transcript,
    expectedGreeting: result.expectedGreeting,
    greetingMatch: result.greetingMatch,
    timings: result.timings,
    audioMs: result.audioMs,
    callSid: result.callSid,
    streamSid: result.streamSid,
    from: result.from,
    to: result.to,
    streamUrl: result.streamUrl,
    dialedAt: result.dialedAt ? new Date(result.dialedAt).toISOString() : null,
    hungUpAt: result.hungUpAt ? new Date(result.hungUpAt).toISOString() : null,
    endedHow: result.endedHow,
    transcribeModel: TRANSCRIBE_MODEL,
  };
}

/**
 * Ava writes her calls row a moment after hang-up (src/utils/call-db.js,
 * keyed by HER stream SID, which we never see). Find it by caller number
 * and time instead, retrying for a while.
 */
async function findAvaRow(pool, result, waitMs, scenario = SCENARIO) {
  const digits = lastTen(result.from);
  if (!digits || !result.dialedAt) return null;
  const since = new Date(result.dialedAt - 60_000);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const res = await pool.query(
      `SELECT id, call_id FROM calls
        WHERE source = 'server'
          AND regexp_replace(coalesce(caller_number, ''), '\\D', '', 'g') LIKE '%' || $1
          AND started_at >= $2
          AND NOT EXISTS (SELECT 1 FROM test_runs t WHERE t.call_id = calls.id AND t.scenario = $3)
        ORDER BY started_at DESC
        LIMIT 1`,
      [digits, since, scenario]
    );
    if (res.rows.length) return res.rows[0];
    if (Date.now() >= deadline) return null;
    await sleep(3000);
  }
}

function ownCallRow(result) {
  const startedAt = new Date(result.dialedAt || Date.now());
  const endedAt = new Date(result.hungUpAt || Date.now());
  const connected = Boolean(result.streamSid);
  return {
    call_id: result.streamSid || `smoke-${result.callSid || startedAt.getTime()}`,
    twilio_call_sid: result.callSid,
    source: 'smoke-test',
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || 'local',
    sheet_row_number: null,
    is_test: true,
    test_reason: TEST_REASON,
    pre_caller_id_fix: false,
    direction: 'inbound',
    caller_number: result.from || null,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
    first_name: null,
    last_name: null,
    conf_name: null,
    phone_number: result.from || null,
    conf_pn: null,
    conf_mail: null,
    email: null,
    primary_intent: null,
    conf_add: null,
    service_address: null,
    conf_avail: null,
    availability_notes: null,
    call_summary: `Daily smoke call: ${result.passed ? 'PASS, Ava said her greeting' : `FAIL, ${result.reason}`}`,
    call_status: connected ? (result.passed ? 'completed' : 'failed') : 'failed',
    final_state: 'greeting',
    was_transferred: false,
    is_safety_risk: false,
    intake_json: null,
  };
}

/**
 * Write the test_runs row (+ recording, + calls row when Ava wrote none).
 * Never throws; returns { stored, callRowId, attached, reason }.
 */
async function storeSmokeRun(result, { log = console } = {}) {
  const pool = callDb.getPool();
  if (!pool) return { stored: false, reason: 'no DATABASE_URL' };
  const report = buildReport(result);
  try {
    // Only wait for Ava's row when the call reached Twilio at all.
    let row = await findAvaRow(pool, result, result.callSid ? ROW_WAIT_MS : 0);
    let attached = Boolean(row);
    const turn = result.transcript ? [{ sequence: 1, speaker: 'ava', text: result.transcript, at: new Date(result.dialedAt + (result.timings.ringMs || 0) + (result.timings.firstAudioMs || 0)) }] : [];

    if (row) {
      await pool.query('UPDATE calls SET is_test = TRUE, test_reason = $2 WHERE id = $1', [row.id, TEST_REASON]);
      const has = await pool.query('SELECT 1 FROM transcript_turns WHERE call_id = $1 LIMIT 1', [row.id]);
      if (!has.rows.length && turn.length) {
        await pool.query('INSERT INTO transcript_turns (call_id, sequence, speaker, text, at) VALUES ($1,$2,$3,$4,$5)', [row.id, 1, 'ava', turn[0].text, turn[0].at]);
      }
      log.log(`🗄️  Smoke call: attached to Ava's calls row ${row.id} (${row.call_id})`);
    } else {
      const own = ownCallRow(result);
      const ins = await callDb.withTransaction((client) => callDb.insertCall(client, own, turn));
      if (!ins.inserted) {
        const existing = await pool.query('SELECT id FROM calls WHERE call_id = $1', [own.call_id]);
        row = existing.rows[0];
      } else {
        row = { id: ins.id };
      }
      attached = false;
      log.log(`🗄️  Smoke call: calls row ${row.id} written by the smoke test (Ava wrote none)`);
    }

    if (result.audio && result.audio.length) {
      await pool.query(
        `INSERT INTO recordings (call_id, source, codec, sample_rate, duration_seconds, caller_audio, ava_audio)
         VALUES ($1, 'smoke-test', 'pcmu', 8000, $2, $3, $4)
         ON CONFLICT (call_id) DO UPDATE SET source = EXCLUDED.source, duration_seconds = EXCLUDED.duration_seconds,
           caller_audio = EXCLUDED.caller_audio, ava_audio = EXCLUDED.ava_audio, created_at = now()`,
        [row.id, (result.audio.length / 8000).toFixed(1), Buffer.alloc(result.audio.length, MULAW_SILENCE), result.audio]
      );
    }

    await pool.query(
      `INSERT INTO test_runs (call_id, scenario, mode, passed, outcome_expected, outcome_reached, ended_how, report)
       VALUES ($1, $2, 'phone', $3, 'greeting', $4, $5, $6)`,
      [row.id, SCENARIO, result.passed, Boolean(result.greetingMatch && result.greetingMatch.ok), result.endedHow, JSON.stringify(report)]
    );
    log.log(`🗄️  Smoke call: test run stored on call ${row.id}${result.audio && result.audio.length ? ` with ${(result.audio.length / 8000).toFixed(0)} s of audio` : ''}`);
    return { stored: true, callRowId: row.id, attached };
  } catch (err) {
    log.error(`❌ Smoke call: could not store the result in Neon: ${err.message}`);
    return { stored: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// The daily-check line
// ---------------------------------------------------------------------------

function etDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function etTime(ms) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeStyle: 'short' }).format(new Date(ms));
}

function describe(result, store) {
  const where = store.stored
    ? `call log #${store.callRowId}${store.attached ? '' : ' (smoke-test row)'}`
    : `not stored: ${store.reason}`;
  if (result.passed) {
    const snippet = result.transcript.length > 70 ? `${result.transcript.slice(0, 69)}…` : result.transcript;
    return `answered ${seconds(result.timings.firstAudioMs)} after the stream started and said her greeting ("${snippet}"); ${where}`;
  }
  return `${result.reason}; ${where}`;
}

// The last pass, per Eastern calendar day: the daily check runs twice a day
// but a passing call is placed once. A failed morning call is tried again at
// the afternoon check.
let lastPass = null;

// The newest result, whatever it was, for /health. The GitHub Actions backup
// of the daily check reads it there and relays it in its email, since it
// must never place the call itself. Memory only; after a restart
// loadLastResultFromDb() takes the newest stored run from Neon.
const serverStartedAt = Date.now();
let lastResult = null; // { at: ISO string, passed, summary, source: 'live' | 'db' }

/** What /health reports: pass/fail, when, one line. No call SIDs or numbers. */
function healthSummary(config = smokeCallConfig()) {
  return {
    enabled: config.enabled && config.problems.length === 0,
    last: lastResult ? { at: lastResult.at, passed: lastResult.passed, summary: lastResult.summary } : null,
    server_started_at: new Date(serverStartedAt).toISOString(),
  };
}

function getLastResult() {
  return lastResult;
}

async function loadLastResultFromDb({ log = console } = {}) {
  const pool = callDb.getPool();
  if (!pool || lastResult) return lastResult;
  try {
    const res = await pool.query(
      `SELECT passed, created_at, report FROM test_runs
        WHERE scenario IN ($1, $2) AND mode = 'phone'
        ORDER BY created_at DESC LIMIT 1`,
      [SCENARIO, FULL_SCENARIO]
    );
    if (!res.rows.length || lastResult) return lastResult;
    const row = res.rows[0];
    const report = row.report || {};
    const summary = report.summary || (row.passed
      ? `answered ${seconds((report.timings && report.timings.firstAudioMs) || 0)} after the stream started and said her greeting`
      : (report.reason || 'failed'));
    lastResult = { at: new Date(report.dialedAt || row.created_at).toISOString(), passed: Boolean(row.passed), summary, source: 'db' };
    log.log(`📞 Daily smoke call: last stored result ${etDay(Date.parse(lastResult.at))} ${etTime(Date.parse(lastResult.at))}: ${lastResult.passed ? 'PASS' : 'FAIL'}`);
  } catch (err) {
    log.warn(`⚠️ Daily smoke call: could not read the last result from Neon: ${err.message}`);
  }
  return lastResult;
}

/**
 * The check the daily check runs: places the call (once a day when it
 * passes), stores the result, returns { name, status, detail }.
 */
async function smokeCheck({ twilioClient = null, log = console, config = smokeCallConfig() } = {}) {
  const full = config.mode === 'full';
  const name = full ? 'Ava handles a full call' : 'Ava answers the phone';
  const today = etDay(Date.now());
  if (lastPass && lastPass.day === today) {
    return { name, status: 'pass', detail: `${lastPass.detail} (from the ${lastPass.time} call; one call a day)` };
  }
  try {
    let result;
    let detail;
    if (full) {
      const fullCall = require('./smoke-full-call');
      result = await fullCall.runFullSmokeCall({ twilioClient, config, log });
      const store = await fullCall.storeFullRun(result, { log });
      detail = fullCall.describeFull(result, store);
    } else {
      result = await runSmokeCall({ twilioClient, config, log });
      const store = await storeSmokeRun(result, { log });
      detail = describe(result, store);
    }
    if (result.passed) lastPass = { day: today, time: etTime(result.dialedAt), detail };
    lastResult = { at: new Date(result.dialedAt || Date.now()).toISOString(), passed: result.passed, summary: detail, source: 'live' };
    return { name, status: result.passed ? 'pass' : 'fail', detail };
  } catch (err) {
    lastResult = { at: new Date().toISOString(), passed: false, summary: `smoke call error — ${err.message}`, source: 'live' };
    return { name, status: 'fail', detail: `smoke call error — ${err.message}` };
  }
}

module.exports = {
  SCENARIO,
  FULL_SCENARIO,
  RING_TIMEOUT_S,
  STREAM_START_TIMEOUT_MS,
  registerSession,
  releaseSession,
  markSmokeCall,
  isSmokeCaller,
  findAvaRow,
  escapeXml,
  lastTen,
  etDay,
  etTime,
  STREAM_PATH,
  TEST_REASON,
  smokeCallConfig,
  isSmokeStreamRequest,
  handleStream,
  runSmokeCall,
  storeSmokeRun,
  smokeCheck,
  healthSummary,
  getLastResult,
  loadLastResultFromDb,
  greetingMatch,
  isSilentFrame,
  frameRms,
  mulawToWav,
  buildReport,
};
