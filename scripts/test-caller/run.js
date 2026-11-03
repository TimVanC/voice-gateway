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
 *   --spawn                local mode: start Ava (`node src/server-rse.js`) on a free port,
 *                          capture her log, stop her afterwards
 *   --server <path>        with --spawn: a different entry point, e.g. src/server-pipeline.js
 *   --server-env K=V       with --spawn: extra environment for the spawned server (repeatable),
 *                          e.g. --server-env TTS_PROVIDER=cartesia
 *   --keep-side-effects    with --spawn: keep Sheets/email/Twilio variables in Ava's env
 *                          (by default they are stripped so test calls stay out of the Sheet)
 *   --server-log <path>    read Ava's intake from this log file (when Ava runs elsewhere)
 *   --out <dir>            default scripts/test-caller/out
 *   --quiet                no live transcript on stdout
 *
 * Exit codes: 0 pass, 1 a required field was wrong or the expected outcome
 * was not reached, 2 the harness itself failed (no server, no key, ...).
 */

require('./precise-timers'); // Windows: make the 20 ms pacers really run at 50 frames/s
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const { Persona } = require('./persona');
const { FakeTwilioClient, fakeSid } = require('./fake-twilio');
const report = require('./report');
const { runCall } = require('./call-loop');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { mode: 'local', spawn: false, keepSideEffects: false, quiet: false, out: path.join(HERE, 'out'), server: 'src/server-rse.js', serverEnv: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--scenario') args.scenario = next();
    else if (a === '--mode') args.mode = next();
    else if (a === '--host') args.host = next();
    else if (a === '--spawn') args.spawn = true;
    else if (a === '--server') args.server = next();
    else if (a === '--server-env') {
      const kv = next();
      const eq = kv.indexOf('=');
      if (eq < 1) throw new Error(`--server-env expects KEY=VALUE, got ${kv}`);
      args.serverEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
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

async function spawnAva({ logPath, keepSideEffects, server = 'src/server-rse.js', serverEnv = {} }) {
  const port = await freePort();
  const env = { ...process.env, ...serverEnv, PORT: String(port) };
  delete env.NODE_ENV; // local URL config, never the production one
  if (!keepSideEffects) for (const k of SIDE_EFFECT_VARS) delete env[k];
  const log = fs.openSync(logPath, 'a');
  // Ava's own 20 ms audio pump suffers the same Windows timer coarseness, so
  // the shim is preloaded into her process too (no change to her code; Linux
  // ignores it). TEST_CALLER_NO_TIMER_SHIM=1 runs her untouched.
  const nodeArgs = process.env.TEST_CALLER_NO_TIMER_SHIM ? [] : ['--require', path.join(HERE, 'precise-timers.js')];
  const serverPath = path.isAbsolute(server) ? server : path.join(REPO, server);
  if (!fs.existsSync(serverPath)) throw new Error(`--server ${server} not found`);
  const child = spawn(process.execPath, [...nodeArgs, serverPath], {
    cwd: REPO,
    env,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.on('exit', (code) => { child.exitCode = code; });
  const deadline = Date.now() + 45000;
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
  throw new Error(`Ava did not answer /health on port ${port} within 45 s; see ${logPath}`);
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

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
      ava = await spawnAva({ logPath: serverLogPath, keepSideEffects: args.keepSideEffects, server: args.server, serverEnv: args.serverEnv });
      cleanupOnExit.push(() => ava.child.kill());
      legUrl = ava.url;
      log(`Ava (${args.server}) started on port ${ava.port}${args.keepSideEffects ? '' : ' (Sheets, email and Twilio variables stripped)'}`);
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
    if (from.replace(/\D/g, '').slice(-10) === to.replace(/\D/g, '').slice(-10)) {
      throw new Error(`from and to are the same number (${to}); set TEST_CALLER_TO to Ava's live number and TEST_CALLER_FROM to a different Twilio number on the account`);
    }
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
    server: args.spawn ? args.server : (args.host || 'external'),
    serverEnv: args.serverEnv,
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

  // Neon: the call, transcript, recording and this run, for the web app.
  if (process.env.DATABASE_URL) {
    const stored = await require('./store').storeRun({
      databaseUrl: process.env.DATABASE_URL,
      callId,
      callSid: leg.callSid,
      scenario,
      mode: args.mode,
      summary,
      result,
      turns: call.turns,
      recorder: call.recorder,
      t0: call.t0,
      callerNumber: args.mode === 'phone' ? (process.env.TEST_CALLER_FROM || '') : scenario.callerNumber,
      log,
    });
    if (stored) summary.web = stored;
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(summary, null, 2));
  }

  log('');
  log(report.renderLatency(latency, dead, { clears: call.clears, routineClears: call.routineClears, interjections: call.interjectionsFired }));
  log(report.renderChecks(check, result, { endedHow: call.endedHow, durationMs: call.endInfo.t }));
  log(`Audio: ${path.relative(process.cwd(), wav.mixPath)} (${wav.seconds.toFixed(1)} s), transcript: ${path.relative(process.cwd(), path.join(outDir, 'transcript.txt'))}`);
  const u = persona.usage;
  log(`Persona tokens: ${u.inputAudioTokens} audio in, ${u.outputAudioTokens} audio out (${u.inputTokens} in / ${u.outputTokens} out total)`);
  if (summary.web) log(`Web app: ${summary.web.url}`);
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
