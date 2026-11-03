/**
 * Daily full smoke call: a whole intake call to Ava over the real phone line.
 *
 * Same plumbing as the greeting check in smoke-call.js (an outbound Twilio
 * call from the test number to Ava's number whose TwiML streams the caller
 * leg back to /smoke/stream on this server), but instead of listening in
 * silence, the harness's scripted caller (scripts/test-caller/persona.js, an
 * OpenAI Realtime session) talks to Ava through it, using the scenario in
 * scripts/test-caller/scenarios/<SMOKE_CALL_SCENARIO>.json (default no-heat).
 * The conversation loop is the harness's own (scripts/test-caller/call-loop.js).
 *
 * Pass = all of:
 *   - Ava's first words match her greeting;
 *   - the intake Ava saved (her Neon calls row) has every required field of
 *     the scenario and reached the recap;
 *   - Ava ended the call herself;
 *   - no silence on the line longer than SMOKE_CALL_MAX_GAP_MS (default 8 s).
 * Reply time (median and 90th percentile) is reported but does not fail it.
 *
 * Ava's own Sheets row and summary email are skipped for this call
 * (smoke-call.js isSmokeCaller), so RSE never sees a fake lead. The run goes
 * to Neon like a harness run: the calls row marked is_test, a two-track
 * recording, and a test_runs row "daily-full-call" for the web app.
 *
 * Cost per call: about 3 to 4 minutes of two Twilio legs, Ava's Realtime
 * session and the caller's Realtime session, roughly $1. Never runs on
 * GitHub Actions.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { WebSocket } = require('ws');

const smoke = require('./smoke-call');
const callDb = require('../utils/call-db');
const { GREETING } = require('../scripts/rse-script');

const HARNESS = path.resolve(__dirname, '..', '..', 'scripts', 'test-caller');
const { Persona } = require(path.join(HARNESS, 'persona'));
const { runCall } = require(path.join(HARNESS, 'call-loop'));
const report = require(path.join(HARNESS, 'report'));
const { FRAME_BYTES } = require(path.join(HARNESS, 'audio'));

const TEST_REASON = 'daily full smoke call';
const MAX_GAP_MS = Number(process.env.SMOKE_CALL_MAX_GAP_MS || 8000);
const ROW_WAIT_MS = 45_000;

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

function clock(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function loadScenario(name) {
  const file = path.join(HARNESS, 'scenarios', `${path.basename(name, '.json')}.json`);
  if (!fs.existsSync(file)) throw new Error(`no test-caller scenario "${name}"`);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.name = s.name || path.basename(file, '.json');
  s.persona = s.persona || {};
  s.interjections = s.interjections || [];
  s.expect = s.expect || {};
  return s;
}

// ---------------------------------------------------------------------------
// The caller leg: /smoke/stream as the harness's `leg`
// ---------------------------------------------------------------------------

/**
 * Speaks the interface call-loop.js expects of a leg: emits 'audio' and
 * 'heard' for each frame from Ava (Twilio already played it in real time),
 * 'close' once; sendAudio(frame) sends the caller's voice; hangup() ends the
 * Twilio call.
 */
class SmokeStreamLeg extends EventEmitter {
  constructor({ client, config, scenarioName, log }) {
    super();
    this.client = client;
    this.config = config;
    this.scenarioName = scenarioName;
    this.log = log;
    this.needsSilenceFrames = false; // Twilio fills the gaps itself
    this.ws = null;
    this.callSid = null;
    this.streamSid = null;
    this.dialedAt = null;
    this.streamStartedAt = null;
    this.hungUpByUs = false;
    this.closed = false;
    this.session = null;
  }

  /** Dial and wait for Twilio's stream. Rejects when the call never connects. */
  async connect() {
    const token = crypto.randomBytes(16).toString('hex');
    let onStarted;
    const started = new Promise((resolve) => { onStarted = resolve; });
    const session = {
      token,
      ws: null,
      onStart: (ws, start) => {
        session.ws = ws;
        this.ws = ws;
        this.streamSid = start.streamSid || null;
        this.streamStartedAt = Date.now();
        onStarted();
      },
      onMedia: (frame) => {
        if (this.closed) return;
        this.emit('audio', frame);
        this.emit('heard', frame);
      },
      onStop: (how) => this.finish(how),
      onError: (err) => this.emit('error', err),
    };
    if (!smoke.registerSession(session)) throw new Error('a smoke call is already in progress');
    this.session = session;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${smoke.escapeXml(this.config.streamUrl)}">
      <Parameter name="token" value="${token}" />
      <Parameter name="purpose" value="${smoke.FULL_SCENARIO}" />
      <Parameter name="scenario" value="${smoke.escapeXml(this.scenarioName)}" />
    </Stream>
  </Connect>
</Response>`;

    this.dialedAt = Date.now();
    this.log.log(`📞 Full smoke call: dialling ${this.config.to} from ${this.config.from} (scenario ${this.scenarioName})`);
    try {
      const call = await this.client.calls.create({ from: this.config.from, to: this.config.to, timeout: smoke.RING_TIMEOUT_S, twiml });
      this.callSid = call.sid;
    } catch (err) {
      smoke.releaseSession(session);
      throw new Error(`Twilio could not place the call: ${err.message}`);
    }

    let timer;
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), smoke.STREAM_START_TIMEOUT_MS); });
    const first = await Promise.race([started.then(() => 'started'), timedOut]);
    clearTimeout(timer);
    if (first !== 'started') {
      let status = 'unknown';
      try { status = (await this.client.calls(this.callSid).fetch()).status; } catch (_) { /* leave unknown */ }
      await this.endTwilioCall();
      smoke.releaseSession(session);
      throw new Error(`the call never connected a media stream within ${smoke.STREAM_START_TIMEOUT_MS / 1000} s (Twilio call status: ${status})`);
    }
    this.log.log(`📞 Full smoke call: stream ${this.streamSid} connected ${seconds(this.streamStartedAt - this.dialedAt)} after dialling`);
  }

  sendAudio(frame) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN || frame.length !== FRAME_BYTES) return;
    this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: frame.toString('base64') } }));
  }

  async endTwilioCall() {
    if (!this.callSid) return;
    try {
      await this.client.calls(this.callSid).update({ status: 'completed' });
    } catch (err) {
      if (!/not in-progress|20404|not found/i.test(err.message)) this.log.warn(`⚠️ Full smoke call: could not end call ${this.callSid}: ${err.message}`);
    }
  }

  async hangup() {
    if (this.closed) return;
    this.hungUpByUs = true;
    await this.endTwilioCall();
    this.finish('caller hung up');
  }

  finish(how) {
    if (this.closed) return;
    this.closed = true;
    smoke.releaseSession(this.session);
    try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'smoke call done'); } catch (_) { /* gone */ }
    this.emit('close', { code: 1000, reason: String(how || ''), by: this.hungUpByUs ? 'caller' : 'ava' });
  }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Place one full smoke call. Never throws for a failed call; the result says
 * what happened. Throws only on GitHub Actions.
 */
async function runFullSmokeCall({ twilioClient = null, config = smoke.smokeCallConfig(), log = console } = {}) {
  if (process.env.GITHUB_ACTIONS) {
    throw new Error('the smoke call never runs on GitHub Actions runners (Twilio account lock-outs)');
  }
  const result = {
    kind: 'full',
    scenario: smoke.FULL_SCENARIO,
    callerScenario: config.scenario,
    mode: 'phone',
    passed: false,
    problems: [],
    reason: null,
    from: config.from,
    to: config.to,
    callSid: null,
    streamSid: null,
    dialedAt: null,
    endedHow: null,
    durationMs: 0,
    greeting: null,
    check: null,
    intakeSource: null,
    latency: null,
    deadAir: null,
    turns: [],
    call: null,
  };
  const fail = (reason) => { result.reason = reason; result.problems = [reason]; return result; };

  if (config.problems.length) return fail(`not configured: ${config.problems.join('; ')}`);
  let scenario;
  try {
    scenario = loadScenario(config.scenario);
  } catch (err) {
    return fail(err.message);
  }

  const client = twilioClient || require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const persona = new Persona({
    apiKey: process.env.OPENAI_API_KEY,
    instructions: scenario.persona.instructions,
    voice: scenario.persona.voice,
    silenceMs: scenario.persona.silenceMs,
    interruptible: scenario.persona.interruptible,
  });
  const leg = new SmokeStreamLeg({ client, config, scenarioName: scenario.name, log });
  try {
    try {
      await persona.connect();
    } catch (err) {
      return fail(`the scripted caller could not start (OpenAI Realtime): ${err.message}`);
    }
    const clips = {};
    for (const i of scenario.interjections) {
      if (!clips[i.text]) {
        try { clips[i.text] = await persona.synthesize(i.text); } catch (_) { /* skip the interjection */ }
      }
    }

    smoke.markSmokeCall(config.from, ((scenario.maxCallSeconds || 360) + 120) * 1000);
    try {
      await leg.connect();
    } catch (err) {
      result.callSid = leg.callSid;
      result.dialedAt = leg.dialedAt;
      result.endedHow = 'never connected';
      return fail(err.message);
    }
    result.callSid = leg.callSid;
    result.streamSid = leg.streamSid;
    result.dialedAt = leg.dialedAt;

    const call = await runCall({ args: { quiet: true }, scenario, leg, persona, clips, log: (l) => log.log(l) });
    result.call = call;
    result.turns = call.turns;
    result.endedHow = call.endedHow;
    result.durationMs = call.endInfo ? call.endInfo.t : Date.now() - call.t0;
  } finally {
    persona.close();
    smoke.markSmokeCall(config.from, 2 * 60_000); // Ava writes her logs as her leg closes
  }

  const call = result.call;
  log.log(`📞 Full smoke call transcript (${call.endedHow}):\n${call.turns
    .filter((t) => t.speaker !== 'event' || /barge-in|hung up|limit/.test(t.text))
    .sort((a, b) => a.t - b.t)
    .map((t) => `  [${report.fmtTime(t.t)}] ${t.speaker === 'ava' ? 'AVA:   ' : t.speaker === 'caller' ? 'CALLER:' : '--'} ${t.text}`)
    .join('\n')}`);
  result.latency = report.computeLatency(call.callerUtts, call.avaUtts);
  // Silences up to the last word spoken; the quiet seconds between the
  // goodbyes and the hang-up are not dead air.
  const lastSpeechMs = Math.max(0, ...[...call.callerUtts, ...call.avaUtts].map((u) => (u.end == null ? 0 : u.end)));
  const dead = report.deadAir(call.callerUtts, call.avaUtts, lastSpeechMs || result.durationMs, 3000);
  result.deadAir = { maxGapMs: dead.maxGapMs, gapsOver3s: dead.gapsOver.length, gaps: dead.gapsOver.map((g) => ({ atMs: g.from, ms: g.ms })) };

  const firstAva = call.turns.find((t) => t.speaker === 'ava');
  result.greeting = smoke.greetingMatch(firstAva ? firstAva.text : '', GREETING.primary);

  // The intake Ava saved, from her Neon row; else what the caller heard.
  let intake = null;
  const pool = callDb.getPool();
  if (pool) {
    try {
      const found = await smoke.findAvaRow(pool, { from: config.from, dialedAt: result.dialedAt }, ROW_WAIT_MS, smoke.FULL_SCENARIO);
      if (found) {
        const row = (await pool.query('SELECT * FROM calls WHERE id = $1', [found.id])).rows[0];
        result.avaRowId = found.id;
        intake = report.intakeFromNeonRow(row);
      }
    } catch (err) {
      log.warn(`⚠️ Full smoke call: could not read Ava's calls row: ${err.message}`);
    }
  }
  if (!intake) intake = report.inferFromTranscript(call.turns);
  result.intakeSource = intake.source;
  result.check = report.checkExpectations(scenario.expect, intake);

  // Verdict.
  const problems = [];
  if (!result.greeting.ok) problems.push(`her first words were not the greeting ("${(firstAva && firstAva.text) || '(nothing)'}")`);
  if (intake.transferred && result.check.outcome.want !== 'transfer') problems.push('Ava tried to transfer the call to a live agent (stopped: smoke calls never ring the live line)');
  if (!result.check.outcome.ok) problems.push(`the call never reached ${result.check.outcome.want}`);
  const missed = result.check.fields.filter((f) => f.required && f.ok !== true);
  if (missed.length) {
    problems.push(`wrong or missing ${missed.map((f) => `${f.field} (expected "${f.expected}", got ${f.actual == null ? 'nothing' : `"${f.actual}"`})`).join(', ')}`);
  }
  if (!/^Ava ended the call/.test(result.endedHow || '')) problems.push(`Ava did not end the call (${result.endedHow})`);
  if (dead.maxGapMs > MAX_GAP_MS) problems.push(`${seconds(dead.maxGapMs)} of silence on the line (limit ${seconds(MAX_GAP_MS)})`);
  result.problems = problems;
  result.passed = problems.length === 0;
  result.reason = problems.length ? problems.join('; ') : null;

  const fieldsOk = result.check.fields.filter((f) => f.ok === true).length;
  const lat = result.latency.stats.firstFrame;
  const line = `${fieldsOk}/${result.check.fields.length} fields, ${clock(result.durationMs)}, reply median ${lat.p50 == null ? 'n/a' : seconds(lat.p50)} (90% under ${lat.p90 == null ? 'n/a' : seconds(lat.p90)}), longest silence ${seconds(dead.maxGapMs)}`;
  result.summaryLine = line;
  if (result.passed) log.log(`✅ Daily full smoke call PASS: ${line} (call ${result.callSid})`);
  else log.error(`❌ Daily full smoke call FAIL: ${result.reason}; ${line} (call ${result.callSid})`);
  return result;
}

// ---------------------------------------------------------------------------
// Neon
// ---------------------------------------------------------------------------

function intOrNull(v) {
  return v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v));
}

function buildFullReport(result) {
  const lat = result.latency ? result.latency.stats : null;
  return {
    kind: 'smoke-full',
    scenario: result.scenario,
    callerScenario: result.callerScenario,
    passed: result.passed,
    reason: result.reason,
    problems: result.problems,
    summary: result.passed ? `full call: ${result.summaryLine}` : `${result.reason}${result.summaryLine ? `; ${result.summaryLine}` : ''}`,
    endedHow: result.endedHow,
    durationMs: result.durationMs,
    greeting: result.greeting,
    outcome: result.check ? result.check.outcome : null,
    fields: result.check ? result.check.fields : null,
    intakeSource: result.intakeSource,
    latency: lat,
    deadAir: result.deadAir,
    clears: result.call ? result.call.clears : null,
    interjections: result.call ? result.call.interjectionsFired : null,
    callSid: result.callSid,
    streamSid: result.streamSid,
    from: result.from,
    to: result.to,
    dialedAt: result.dialedAt ? new Date(result.dialedAt).toISOString() : null,
  };
}

/** test_runs row + two-track recording on Ava's calls row. Never throws. */
async function storeFullRun(result, { log = console } = {}) {
  const pool = callDb.getPool();
  if (!pool) return { stored: false, reason: 'no DATABASE_URL' };
  const rep = buildFullReport(result);
  try {
    let rowId = result.avaRowId || null;
    const t0 = result.call ? result.call.t0 : result.dialedAt || Date.now();
    const turns = (result.turns || [])
      .filter((t) => t.speaker === 'caller' || t.speaker === 'ava')
      .sort((a, b) => a.t - b.t)
      .map((t, i) => ({ sequence: i + 1, speaker: t.speaker, text: t.text, at: new Date(t0 + t.t) }));

    if (rowId) {
      await pool.query('UPDATE calls SET is_test = TRUE, test_reason = $2 WHERE id = $1', [rowId, TEST_REASON]);
      const has = await pool.query('SELECT 1 FROM transcript_turns WHERE call_id = $1 LIMIT 1', [rowId]);
      if (!has.rows.length && turns.length) {
        await callDb.withTransaction(async (client) => {
          for (const t of turns) {
            await client.query('INSERT INTO transcript_turns (call_id, sequence, speaker, text, at) VALUES ($1,$2,$3,$4,$5)', [rowId, t.sequence, t.speaker, t.text, t.at]);
          }
        });
      }
    } else {
      const started = new Date(result.dialedAt || Date.now());
      const own = {
        call_id: result.streamSid || `smoke-full-${result.callSid || started.getTime()}`,
        twilio_call_sid: result.callSid, source: 'smoke-test',
        environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || 'local',
        sheet_row_number: null, is_test: true, test_reason: TEST_REASON, pre_caller_id_fix: false,
        direction: 'inbound', caller_number: result.from || null, started_at: started,
        ended_at: new Date(started.getTime() + (result.durationMs || 0)),
        duration_seconds: Math.round((result.durationMs || 0) / 1000),
        first_name: null, last_name: null, conf_name: null, phone_number: result.from || null, conf_pn: null,
        conf_mail: null, email: null, primary_intent: null, conf_add: null, service_address: null, conf_avail: null,
        availability_notes: null, call_summary: `Daily full smoke call: ${rep.summary}`,
        call_status: result.passed ? 'completed' : 'failed', final_state: null, was_transferred: false,
        is_safety_risk: false, intake_json: null,
      };
      const ins = await callDb.withTransaction((client) => callDb.insertCall(client, own, turns));
      rowId = ins.inserted ? ins.id : (await pool.query('SELECT id FROM calls WHERE call_id = $1', [own.call_id])).rows[0].id;
    }

    if (result.call && result.call.recorder) {
      const rec = result.call.recorder;
      const totalSamples = Math.ceil((rec.durationMs() / 1000) * 8000);
      if (totalSamples > 0) {
        await pool.query(
          `INSERT INTO recordings (call_id, source, codec, sample_rate, duration_seconds, caller_audio, ava_audio)
           VALUES ($1, 'smoke-test', 'pcmu', 8000, $2, $3, $4)
           ON CONFLICT (call_id) DO UPDATE SET source = EXCLUDED.source, duration_seconds = EXCLUDED.duration_seconds,
             caller_audio = EXCLUDED.caller_audio, ava_audio = EXCLUDED.ava_audio, created_at = now()`,
          [rowId, (totalSamples / 8000).toFixed(1), rec.renderMulaw('caller', totalSamples), rec.renderMulaw('ava', totalSamples)]
        );
      }
    }

    const lat = (rep.latency && rep.latency.firstFrame) || {};
    await pool.query(
      `INSERT INTO test_runs (call_id, scenario, mode, passed, outcome_expected, outcome_reached, ended_how,
         latency_p50_ms, latency_p90_ms, latency_max_ms, dead_air_max_ms, dead_air_gaps, barge_ins, interjections, report)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        rowId, smoke.FULL_SCENARIO, result.mode || 'phone', result.passed,
        rep.outcome ? rep.outcome.want : 'confirmation', rep.outcome ? Boolean(rep.outcome.ok) : false, result.endedHow || null,
        intOrNull(lat.p50), intOrNull(lat.p90), intOrNull(lat.max),
        intOrNull(rep.deadAir && rep.deadAir.maxGapMs), intOrNull(rep.deadAir && rep.deadAir.gapsOver3s),
        intOrNull(rep.clears), intOrNull(rep.interjections), JSON.stringify(rep),
      ]
    );
    log.log(`🗄️  Full smoke call: stored on call ${rowId}`);
    return { stored: true, callRowId: rowId };
  } catch (err) {
    log.error(`❌ Full smoke call: could not store the result in Neon: ${err.message}`);
    return { stored: false, reason: err.message };
  }
}

/** One line for the daily-check email. */
function describeFull(result, store) {
  const base = (process.env.TEST_CALLER_WEB_URL || 'https://rse-ava-calls.vercel.app').replace(/\/+$/, '');
  const where = store.stored ? `${base}/calls/${store.callRowId}` : `not stored: ${store.reason}`;
  if (result.passed) return `full ${result.callerScenario} call passed: ${result.summaryLine}; ${where}`;
  return `${result.reason}${result.summaryLine ? `; ${result.summaryLine}` : ''}; ${where}`;
}

module.exports = { runFullSmokeCall, storeFullRun, describeFull, buildFullReport, SmokeStreamLeg, loadScenario };
