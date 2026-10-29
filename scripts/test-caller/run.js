#!/usr/bin/env node
/**
 * Bot calls the bot: run one scripted caller against Ava and report.
 *
 *   node scripts/test-caller/run.js --scenario no-heat
 *   node scripts/test-caller/run.js --scenario no-heat --spawn          # start Ava itself
 *   node scripts/test-caller/run.js --scenario no-heat --host ws://localhost:3000
 *   node scripts/test-caller/run.js --scenario no-heat --mode phone     # real PSTN call
 *
 * Options
 *   --scenario <name>      file in scenarios/<name>.json (required)
 *   --mode local|phone     default local
 *   --host <ws url>        Ava's /stream (local mode), default ws://localhost:$PORT/stream
 *   --spawn                local mode: start `node src/server-rse.js` on a free port,
 *                          capture its log, stop it afterwards
 *   --keep-side-effects    with --spawn: keep Sheets/email/Twilio variables in Ava's env
 *                          (by default they are stripped so test calls stay out of the Sheet)
 *   --server-log <path>    read Ava's intake from this log file (when Ava runs elsewhere)
 *   --out <dir>            default scripts/test-caller/out
 *   --quiet                no live transcript on stdout
 *
 * Exit codes: 0 pass, 1 a required field was wrong or the expected outcome
 * was not reached, 2 the harness itself failed (no server, no key, ...).
 */

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const { Persona } = require('./persona');
const { FakeTwilioClient, fakeSid } = require('./fake-twilio');
const { FRAME_MS, SILENCE_FRAME, isDigitalSilence, isAudible, toFrames, TrackRecorder } = require('./audio');
const report = require('./report');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { mode: 'local', spawn: false, keepSideEffects: false, quiet: false, out: path.join(HERE, 'out') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--scenario') args.scenario = next();
    else if (a === '--mode') args.mode = next();
    else if (a === '--host') args.host = next();
    else if (a === '--spawn') args.spawn = true;
    else if (a === '--keep-side-effects') args.keepSideEffects = true;
    else if (a === '--server-log') args.serverLog = next();
    else if (a === '--out') args.out = next();
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function usage() {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 23).map((l) => l.replace(/^ \*\s?/, '')).join('\n'));
}

function loadScenario(name) {
  const file = name.endsWith('.json') ? path.resolve(name) : path.join(HERE, 'scenarios', `${name}.json`);
  if (!fs.existsSync(file)) {
    const have = fs.readdirSync(path.join(HERE, 'scenarios')).map((f) => f.replace(/\.json$/, '')).join(', ');
    throw new Error(`no scenario "${name}" (have: ${have})`);
  }
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.name = s.name || path.basename(file, '.json');
  s.persona = s.persona || {};
  s.interjections = s.interjections || [];
  s.expect = s.expect || {};
  return s;
}

// ---------------------------------------------------------------------------
// Spawning Ava (local mode convenience)
// ---------------------------------------------------------------------------

const SIDE_EFFECT_VARS = [
  'GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_SHEETS_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS',
  'SENDGRID_API_KEY', 'EMAIL_FROM', 'EMAIL_TO',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TRANSFER_PHONE_NUMBER',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function spawnAva({ logPath, keepSideEffects }) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.NODE_ENV; // local URL config, never the production one
  if (!keepSideEffects) for (const k of SIDE_EFFECT_VARS) delete env[k];
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'server-rse.js')], {
    cwd: REPO,
    env,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.on('exit', (code) => { child.exitCode = code; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Ava exited with code ${child.exitCode}; see ${logPath}`);
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return { child, port, url: `ws://127.0.0.1:${port}/stream` };
    await report.sleep(300);
  }
  child.kill();
  throw new Error(`Ava did not answer /health on port ${port} within 20 s; see ${logPath}`);
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

async function runCall({ args, scenario, leg, persona, clips, outDir, log }) {
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const events = [];
  const turns = []; // transcript rows { t, speaker, text }
  const callerUtts = []; // { start, end, tag, text }
  const avaUtts = []; // { start, end, firstAudible, text }
  const recorder = new TrackRecorder();
  const queue = []; // outgoing { frame, tag }
  const activeResponses = new Set();
  const responseFirstSend = new Map(); // responseId -> ms
  const speechStartedAt = new Map(); // persona item_id -> ms (Ava speech detected)
  let clears = 0; // barge-in clears
  let routineClears = 0; // clear-before-speaking, Ava's normal behaviour
  let interjectionsFired = 0;
  let callerSpeaking = false;
  let callerLastSendAt = 0;
  let avaSpeaking = false;
  let avaLastAudioAt = 0;
  let endInfo = null;
  let hangupTimer = null;

  const event = (type, extra = {}) => {
    const e = { t: now(), type, ...extra };
    events.push(e);
    return e;
  };
  const say = (line) => { if (!args.quiet) console.log(line); };
  const note = (text) => {
    turns.push({ t: now(), speaker: 'event', text });
    say(`  [${report.fmtTime(now())}] -- ${text}`);
  };

  // Ava -> caller --------------------------------------------------------
  leg.on('audio', (frame) => {
    const t = now();
    recorder.add('ava', t, frame);
    if (!isDigitalSilence(frame)) {
      if (!avaSpeaking) {
        avaSpeaking = true;
        avaUtts.push({ start: t, end: null, firstAudible: null, text: '' });
        event('ava_audio_start', { utterance: avaUtts.length });
      }
      avaLastAudioAt = t;
      const u = avaUtts[avaUtts.length - 1];
      if (u.firstAudible == null && isAudible(frame)) u.firstAudible = t;
    }
  });
  leg.on('heard', (frame) => { if (frame) persona.feedAudio(frame); });
  // Ava sends `clear` before every response she starts (routine). It is a
  // barge-in only when she was talking and the caller was talking too.
  leg.on('clear', ({ droppedFrames }) => {
    const bargeIn = avaSpeaking && callerSpeaking;
    if (bargeIn) clears++; else routineClears++;
    event('ava_clear', { droppedFrames, bargeIn });
    if (bargeIn) note(`Ava stopped talking because the caller spoke (barge-in), ${droppedFrames} frames dropped`);
  });
  leg.on('protocol-error', (m) => { event('protocol_error', { message: m }); say(`  !! ${m}`); });
  leg.on('error', (err) => { event('leg_error', { message: err.message }); say(`  !! leg error: ${err.message}`); });

  // Persona -> wire -------------------------------------------------------
  persona.on('response_started', (id) => activeResponses.add(id));
  persona.on('response_done', (id, status) => {
    activeResponses.delete(id);
    event('caller_response_done', { responseId: id, status });
  });
  // Once the caller has said goodbye they stop talking, like a person who is
  // lowering the phone; if Ava has not ended the call shortly after, they hang up.
  let goodbyeAt = null;
  let goodbyeResponseId = null;
  const hangupAfterGoodbyeMs = scenario.hangupAfterGoodbyeMs || 15000;
  persona.on('audio', (buf, responseId) => {
    if (endInfo) return;
    if (goodbyeAt != null && responseId !== goodbyeResponseId) return; // said goodbye already
    for (const frame of toFrames(buf)) queue.push({ frame, tag: responseId });
  });
  persona.on('caller_transcript', (text, responseId) => {
    const utt = callerUtts.find((u) => u.tag === responseId);
    const t = utt ? utt.start : (responseFirstSend.get(responseId) ?? now());
    if (utt) utt.text = text;
    turns.push({ t, speaker: 'caller', text });
    say(`  [${report.fmtTime(t)}] CALLER: ${text}`);
    if (goodbyeAt == null && /\b(bye|goodbye)\b/i.test(text)) {
      goodbyeAt = now();
      goodbyeResponseId = responseId;
      event('caller_goodbye', { responseId });
      setTimeout(() => {
        if (endInfo) return;
        note(`caller hung up ${Math.round(hangupAfterGoodbyeMs / 1000)} s after saying goodbye; Ava had not ended the call`);
        event('caller_hangup_after_goodbye');
        leg.hangup();
      }, hangupAfterGoodbyeMs);
    }
  });
  persona.on('ava_speech_started', (itemId) => { speechStartedAt.set(itemId, now()); event('persona_vad_start', { itemId }); });
  persona.on('ava_speech_stopped', (itemId) => event('persona_vad_stop', { itemId }));
  persona.on('ava_transcript', (text, itemId) => {
    const t = speechStartedAt.get(itemId) ?? now();
    turns.push({ t, speaker: 'ava', text });
    // Attach to the Ava utterance that was running at that moment (or the last one).
    const u = [...avaUtts].reverse().find((x) => x.start <= t + 400) || avaUtts[avaUtts.length - 1];
    if (u) u.text = u.text ? `${u.text} ${text}` : text;
    say(`  [${report.fmtTime(t)}] AVA:    ${text}`);
  });
  persona.on('error', (err) => { event('persona_error', { message: err.message }); say(`  !! persona: ${err.message}`); });

  // 20 ms pacer: one frame out per tick, utterance bookkeeping ------------
  const pending = scenario.interjections.map((i) => ({ ...i, fired: false }));
  const tick = setInterval(() => {
    if (endInfo) return;
    const t = now();

    // Interjections: the caller says something while Ava is mid-sentence.
    if (avaSpeaking) {
      const u = avaUtts[avaUtts.length - 1];
      for (const i of pending) {
        if (!i.fired && avaUtts.length === i.onAvaUtterance && t - u.start >= (i.afterMs || 1000)) {
          i.fired = true;
          interjectionsFired++;
          const clip = clips[i.text];
          if (clip) {
            const frames = toFrames(clip).map((frame) => ({ frame, tag: `clip:${i.text}` }));
            queue.unshift(...frames);
            event('interjection', { text: i.text, onAvaUtterance: i.onAvaUtterance });
            note(`caller interjects "${i.text}" while Ava is talking`);
          }
        }
      }
    }

    // Outgoing audio.
    if (queue.length) {
      const { frame, tag } = queue.shift();
      leg.sendAudio(frame);
      recorder.add('caller', t, frame);
      callerLastSendAt = t;
      if (!callerSpeaking) {
        callerSpeaking = true;
        callerUtts.push({ start: t, end: null, tag, text: tag.startsWith('clip:') ? `(${tag.slice(5)})` : '' });
        event('caller_speech_start', { tag });
      }
      if (!tag.startsWith('clip:') && !responseFirstSend.has(tag)) responseFirstSend.set(tag, t);
    } else {
      if (leg.needsSilenceFrames) leg.sendAudio(SILENCE_FRAME);
      if (callerSpeaking && t - callerLastSendAt > 400 && activeResponses.size === 0) {
        callerSpeaking = false;
        const u = callerUtts[callerUtts.length - 1];
        u.end = callerLastSendAt + FRAME_MS;
        event('caller_speech_end', { tag: u.tag });
      }
    }

    // Ava utterance end: 600 ms with nothing but silence frames.
    if (avaSpeaking && t - avaLastAudioAt > 600) {
      avaSpeaking = false;
      const u = avaUtts[avaUtts.length - 1];
      u.end = avaLastAudioAt + FRAME_MS;
      event('ava_audio_end', { utterance: avaUtts.length });
    }
  }, FRAME_MS);

  // Call end ----------------------------------------------------------------
  const ended = new Promise((resolve) => {
    leg.on('close', (info) => {
      if (endInfo) return;
      endInfo = { ...info, t: now() };
      event('call_end', endInfo);
      resolve();
    });
  });
  const maxMs = (scenario.maxCallSeconds || 240) * 1000;
  hangupTimer = setTimeout(() => {
    if (endInfo) return;
    note(`max call length ${scenario.maxCallSeconds || 240}s reached, caller hangs up`);
    event('timeout');
    leg.hangup();
  }, maxMs);

  await ended;
  clearTimeout(hangupTimer);
  if (callerSpeaking) callerUtts[callerUtts.length - 1].end = callerLastSendAt + FRAME_MS;
  if (avaSpeaking) avaUtts[avaUtts.length - 1].end = avaLastAudioAt + FRAME_MS;
  say(`  call ended by ${endInfo.by} after ${report.fmtTime(endInfo.t)} (code ${endInfo.code}${endInfo.reason ? ', ' + endInfo.reason : ''})`);

  // Late transcripts still arrive for a moment.
  await report.sleep(2500);
  clearInterval(tick);
  persona.close();

  const endedHow = endInfo.by === 'ava'
    ? 'Ava ended the call'
    : events.some((e) => e.type === 'caller_hangup_after_goodbye')
      ? `caller hung up ${Math.round(hangupAfterGoodbyeMs / 1000)} s after saying goodbye (Ava never hung up)`
      : events.some((e) => e.type === 'timeout')
        ? `caller gave up at the ${scenario.maxCallSeconds || 240} s limit (Ava never hung up)`
        : 'caller hung up';
  return { t0, events, turns, callerUtts, avaUtts, recorder, clears, routineClears, interjectionsFired, endInfo, endedHow };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cleanupOnExit = []; // things to stop whatever happens (spawned Ava, open legs)

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scenario) {
    usage();
    process.exit(args.help ? 0 : 2);
  }
  const scenario = loadScenario(args.scenario);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set (put it in .env)');

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const outDir = path.join(args.out, `${stamp}-${scenario.name}`);
  fs.mkdirSync(outDir, { recursive: true });
  const log = (line) => console.log(line);
  log(`Scenario: ${scenario.name} (${scenario.description || 'no description'})`);
  log(`Mode: ${args.mode}; output: ${path.relative(process.cwd(), outDir)}`);

  // Ava -------------------------------------------------------------------
  let ava = null;
  let serverLogPath = args.serverLog || null;
  let legUrl = null;
  if (args.mode === 'local') {
    if (args.spawn) {
      serverLogPath = path.join(outDir, 'server.log');
      ava = await spawnAva({ logPath: serverLogPath, keepSideEffects: args.keepSideEffects });
      cleanupOnExit.push(() => ava.child.kill());
      legUrl = ava.url;
      log(`Ava started on port ${ava.port}${args.keepSideEffects ? '' : ' (Sheets, email and Twilio variables stripped)'}`);
    } else {
      legUrl = args.host || `ws://localhost:${process.env.PORT || 8080}`;
      if (!/\/stream$/.test(legUrl)) legUrl = legUrl.replace(/\/+$/, '') + '/stream';
    }
  } else if (args.mode !== 'phone') {
    throw new Error(`--mode must be local or phone, not ${args.mode}`);
  }

  // Persona ----------------------------------------------------------------
  const persona = new Persona({
    apiKey,
    instructions: scenario.persona.instructions || `You are a caller named ${scenario.name}. Answer briefly.`,
    voice: scenario.persona.voice,
    model: scenario.persona.model || process.env.TEST_CALLER_MODEL,
    silenceMs: scenario.persona.silenceMs,
    threshold: scenario.persona.threshold,
    interruptible: scenario.persona.interruptible,
  });
  cleanupOnExit.push(() => persona.close());
  await persona.connect();
  log(`Persona ready (voice ${persona.voice}, VAD silence ${persona.silenceMs} ms)`);
  const clips = {};
  for (const i of scenario.interjections) {
    if (!clips[i.text]) {
      clips[i.text] = await persona.synthesize(i.text);
      log(`Clip "${i.text}": ${(clips[i.text].length / 8000).toFixed(1)} s`);
    }
  }

  // Leg --------------------------------------------------------------------
  let leg;
  if (args.mode === 'local') {
    leg = new FakeTwilioClient({ url: legUrl, callerNumber: scenario.callerNumber || '+15555550100' });
    log(`Connecting to Ava at ${legUrl} as ${scenario.callerNumber} (streamSid ${leg.streamSid})`);
    await leg.connect();
  } else {
    const { TwilioPhoneLeg } = require('./phone-leg');
    const from = process.env.TEST_CALLER_FROM || String(process.env.TEST_CALLER_NUMBERS || '').split(',')[0].trim();
    const to = process.env.TEST_CALLER_TO || process.env.TWILIO_NUMBER;
    const publicUrl = process.env.TEST_CALLER_PUBLIC_URL;
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) throw new Error('phone mode needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    if (!from) throw new Error('phone mode needs a from number: TEST_CALLER_FROM or the first entry of TEST_CALLER_NUMBERS (a Twilio number on the account)');
    if (!to) throw new Error('phone mode needs Ava\'s number in TWILIO_NUMBER (or TEST_CALLER_TO)');
    if (!publicUrl) throw new Error('phone mode needs TEST_CALLER_PUBLIC_URL (e.g. an ngrok https URL forwarding to TEST_CALLER_PORT)');
    leg = new TwilioPhoneLeg({
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      from,
      to,
      publicUrl,
      port: Number(process.env.TEST_CALLER_PORT || 3100),
      scenario: scenario.name,
    });
    leg.on('dialing', ({ callSid }) => log(`Dialing ${to} from ${from} (call ${callSid}); waiting for Twilio to connect the stream...`));
    await leg.connect();
    log(`Stream connected (streamSid ${leg.streamSid})`);
  }

  cleanupOnExit.push(() => leg.hangup());

  // Call -------------------------------------------------------------------
  const call = await runCall({ args, scenario, leg, persona, clips, outDir, log });

  // Outputs ----------------------------------------------------------------
  const wav = call.recorder.writeWavs(outDir);
  fs.writeFileSync(path.join(outDir, 'transcript.txt'), report.renderTranscript(call.turns));
  fs.writeFileSync(path.join(outDir, 'transcript.json'), JSON.stringify(call.turns.sort((a, b) => a.t - b.t), null, 2));
  fs.writeFileSync(path.join(outDir, 'events.jsonl'), call.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const latency = report.computeLatency(call.callerUtts, call.avaUtts);
  const dead = report.deadAir(call.callerUtts, call.avaUtts, call.endInfo.t, 3000);
  fs.writeFileSync(path.join(outDir, 'latency.md'), report.renderLatency(latency, dead, { clears: call.clears, routineClears: call.routineClears, interjections: call.interjectionsFired }));

  // Intake -----------------------------------------------------------------
  let result = null;
  const callId = leg.streamSid;
  if (serverLogPath) {
    log(`Waiting for Ava's call summary in ${path.relative(process.cwd(), serverLogPath)}...`);
    result = await report.waitForServerLog(() => report.readFileSafe(serverLogPath), callId, 45000);
    if (!result) log(`  stream ${callId} not found in that log`);
    else if (!result.complete) log('  call summary line never appeared; using what is there');
  }
  if (!result && process.env.DATABASE_URL) {
    log('Looking for the Neon row...');
    const r = await report.waitForNeonRow(process.env.DATABASE_URL, callId, 45000);
    if (r.row) result = report.intakeFromNeonRow(r.row);
    else log(`  ${r.error}`);
  }
  if (!result) {
    log('No server log and no Neon row: inferring the outcome from what the caller heard (field checks skipped).');
    result = report.inferFromTranscript(call.turns);
  }
  if (ava) ava.child.kill();

  const check = report.checkExpectations(scenario.expect, result);
  const summary = {
    scenario: scenario.name,
    mode: args.mode,
    startedAt: new Date(call.t0).toISOString(),
    callId,
    callSid: leg.callSid,
    durationMs: call.endInfo.t,
    endedBy: call.endInfo.by,
    endedHow: call.endedHow,
    outcome: check.outcome,
    fields: check.fields,
    pass: check.pass,
    intakeSource: result.source,
    finalState: result.finalState,
    intake: result.intake,
    latency: latency.stats,
    deadAir: { maxGapMs: dead.maxGapMs, gapsOver3s: dead.gapsOver.length },
    clears: call.clears,
    routineClears: call.routineClears,
    interjections: call.interjectionsFired,
    personaUsage: persona.usage,
    files: { outDir, wav: wav.mixPath, stereo: wav.stereoPath, serverLog: serverLogPath },
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(summary, null, 2));

  log('');
  log(report.renderLatency(latency, dead, { clears: call.clears, routineClears: call.routineClears, interjections: call.interjectionsFired }));
  log(report.renderChecks(check, result, { endedHow: call.endedHow, durationMs: call.endInfo.t }));
  log(`Audio: ${path.relative(process.cwd(), wav.mixPath)} (${wav.seconds.toFixed(1)} s), transcript: ${path.relative(process.cwd(), path.join(outDir, 'transcript.txt'))}`);
  const u = persona.usage;
  log(`Persona tokens: ${u.inputAudioTokens} audio in, ${u.outputAudioTokens} audio out (${u.inputTokens} in / ${u.outputTokens} out total)`);
  process.exitCode = check.pass ? 0 : 1;
}

main().catch((err) => {
  console.error(`test-caller: ${err.message}`);
  if (process.env.TEST_CALLER_DEBUG) console.error(err.stack);
  process.exit(2);
}).finally(() => {
  // Timers in ws/pg can keep the loop alive; the run is over.
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
});
