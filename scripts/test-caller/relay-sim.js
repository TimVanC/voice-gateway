#!/usr/bin/env node
/**
 * Text-level simulator for the ConversationRelay path (src/relay.js).
 *
 * On a relay call Twilio does the audio; Ava's side only ever sees finished
 * caller turns as text and answers with text. This script plays Twilio: it
 * drives a RelaySession over a fake socket (or a real one, --remote) with a
 * caller played by a small language model, so a whole intake call runs in a
 * few seconds with no phone, no speech-to-text and no voice. It finds logic
 * bugs (loops, dead air, wrong fields, questions asked twice); it cannot hear
 * the voice. Phone mode of run.js is still the test for that.
 *
 *   node scripts/test-caller/relay-sim.js --scenario no-heat-basic
 *   node scripts/test-caller/relay-sim.js --all [--concurrency 6] [--only a,b] [--repeat 2]
 *   node scripts/test-caller/relay-sim.js --scenario solar --remote wss://host/relay
 *
 * Scenarios: scripts/test-caller/sim-scenarios.json (see the header there).
 * Output:    scripts/test-caller/out/sim-<stamp>/<id>.json|.txt|.log + summary.md
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

require('dotenv').config({ quiet: true, path: path.join(__dirname, '..', '..', '.env') });

const HERE = __dirname;
const SCENARIO_FILE = path.join(HERE, 'sim-scenarios.json');
const CALLER_MODEL = process.env.SIM_CALLER_MODEL || 'gpt-4o-mini';
const NO_REPLY_MS = Number(process.env.SIM_NO_REPLY_MS || 8000); // Ava silent this long after a caller turn = dead air
const SETTLE_MS = 350; // after Ava's last token, wait for a second utterance before the caller answers
const MAX_CALLER_TURNS = 45;

function parseArgs(argv) {
  const a = { concurrency: 6, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--scenario') a.scenario = next();
    else if (k === '--all') a.all = true;
    else if (k === '--only') a.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--concurrency') a.concurrency = Number(next());
    else if (k === '--repeat') a.repeat = Number(next());
    else if (k === '--out') a.out = next();
    else if (k === '--remote') a.remote = next();
    else if (k === '--file') a.file = next();
    else if (k === '--tag') a.tag = next();
    else throw new Error(`Unknown argument ${k}`);
  }
  return a;
}

function loadScenarios(file) {
  const doc = JSON.parse(fs.readFileSync(file || SCENARIO_FILE, 'utf8'));
  return { rules: doc.callerRules, scenarios: doc.scenarios };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// What a bad line, an accent or a television does to a transcript
// ---------------------------------------------------------------------------
function seededRandom(seedText) {
  let h = 1779033703;
  for (const c of String(seedText)) { h = Math.imul(h ^ c.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}
const MISHEARD = {
  furnace: 'furnish', boiler: 'boyler', heat: 'heap', heating: 'eating', thermostat: 'thermal stat', generator: 'general later',
  montclair: 'mont clair', madison: 'medicine', morristown: 'morris town', street: 'treat', avenue: 'have a new', email: 'e male',
  gmail: 'g mail', cooling: 'calling', leaking: 'licking', air: 'err', unit: 'you knit', pump: 'bump', yesterday: 'yes today',
  weekday: 'week day', mornings: 'morning', furnaces: 'furnishes', central: 'sentral', split: 'spit', working: 'walking', noise: 'nose',
};
const BACKGROUND = [
  'and now back to the game with two minutes left', 'mom where are my shoes', 'turn left in five hundred feet',
  'tonight at eleven a look at the weekend weather', 'no put that down I said put it down', 'your order number forty two is ready',
];
const NOISE_LEVELS = {
  light: { mishear: 0.3, drop: 0.04, background: 0, flatten: false },
  heavy: { mishear: 0.6, drop: 0.14, background: 0.15, flatten: true },
  tv: { mishear: 0.1, drop: 0.03, background: 0.55, flatten: false },
};
/** The caller's words as a struggling transcriber would hand them over. */
function degrade(text, level, rnd) {
  const cfg = NOISE_LEVELS[level];
  if (!cfg) return text;
  let words = text.split(/\s+/).filter(Boolean);
  words = words.map((w) => {
    const key = w.toLowerCase().replace(/[^a-z]/g, '');
    return MISHEARD[key] && rnd() < cfg.mishear ? MISHEARD[key] + w.replace(/^[A-Za-z']+/, '') : w;
  });
  if (words.length > 4) words = words.filter((w) => /\d/.test(w) || rnd() >= cfg.drop);
  let out = words.join(' ');
  if (cfg.flatten) out = out.toLowerCase().replace(/[.,!?;:]/g, '');
  if (rnd() < cfg.background) out = `${out} ${BACKGROUND[Math.floor(rnd() * BACKGROUND.length)]}`;
  return out;
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

// ---------------------------------------------------------------------------
// The caller: a small model with a persona
// ---------------------------------------------------------------------------
class Caller {
  constructor({ rules, scenario }) {
    const OpenAI = require('openai');
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 2 });
    this.system = `${rules}\n\nWHO YOU ARE ON THIS CALL:\n${scenario.persona}`;
    this.history = [];
    this.usage = { input: 0, output: 0 };
  }
  heard(text) { this.history.push({ role: 'user', content: text }); }
  said(text) { this.history.push({ role: 'assistant', content: text }); }
  async reply() {
    const res = await this.client.chat.completions.create({
      model: CALLER_MODEL, temperature: 0.6, max_tokens: 120,
      messages: [{ role: 'system', content: this.system }, ...this.history],
    });
    if (res.usage) { this.usage.input += res.usage.prompt_tokens || 0; this.usage.output += res.usage.completion_tokens || 0; }
    let text = (res.choices[0].message.content || '').trim();
    text = text.replace(/^["'“]+|["'”]+$/g, '').replace(/\*[^*]*\*/g, '').replace(/\s+/g, ' ').trim();
    return text;
  }
}

// ---------------------------------------------------------------------------
// The line to Ava: an in-process RelaySession, or a real socket to a server
// ---------------------------------------------------------------------------
function openLocal() {
  // Simulated calls never touch Neon or the Sheet.
  delete process.env.DATABASE_URL;
  // Nothing is actually spoken here, so the relay must not wait for speech to finish before timing silence.
  process.env.RELAY_SPEECH_MS_PER_CHAR = '0';
  if (!process.env.RELAY_SILENCE_MS) process.env.RELAY_SILENCE_MS = '7000';
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  const { WebSocket } = require('ws');
  const { RelaySession } = require('../../src/relay');
  const { createLlm } = require('../../src/pipeline/llm');
  const { createExtractor } = require('../../src/pipeline/extractor');
  let llm = null;
  try { llm = createLlm(); } catch (e) { console.error(`LLM unavailable: ${e.message}`); }
  let extractor = null;
  try { extractor = createExtractor(); } catch (e) { console.error(`Turn reader unavailable: ${e.message}`); }
  const ws = new EventEmitter();
  ws.readyState = WebSocket.OPEN;
  const out = new EventEmitter();
  ws.send = (raw) => { try { out.emit('msg', JSON.parse(raw)); } catch (_) { /* ignore */ } };
  const session = new RelaySession(ws, { llm, extractor, transferNumber: '+15550000000' });
  return {
    llmName: session.brain ? `brain, turn reader ${extractor.name}` : `rules (free-form ${llm ? llm.name : 'none'})`,
    toAva: (obj) => ws.emit('message', Buffer.from(JSON.stringify(obj))),
    fromAva: out,
    snapshot: () => ({ state: session.sm.getState(), data: session.sm.getData() }),
    close: () => { ws.readyState = WebSocket.CLOSED; },
  };
}

function openRemote(url) {
  const { WebSocket } = require('ws');
  const ws = new WebSocket(url);
  const out = new EventEmitter();
  ws.on('message', (raw) => { try { out.emit('msg', JSON.parse(raw.toString())); } catch (_) { /* ignore */ } });
  ws.on('close', () => out.emit('closed'));
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => resolve({
      llmName: `remote ${url}`,
      toAva: (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
      fromAva: out,
      snapshot: () => null,
      close: () => ws.close(),
    }));
  });
}

// ---------------------------------------------------------------------------
// One simulated call
// ---------------------------------------------------------------------------
async function runCall({ scenario, rules, remote }) {
  const line = remote ? await openRemote(remote) : openLocal();
  const { GREETING } = require('../../src/scripts/rse-script');
  const caller = new Caller({ rules, scenario });
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const turns = []; // { who, text, t, latencyMs? }
  const events = [];
  const result = { id: scenario.id, llm: line.llmName, remote: remote || null, endedBy: null, handoff: null, deadAir: 0, callerTurns: 0 };

  // Collect Ava's speech: tokens until last:true make one utterance.
  let partial = '';
  let pendingUtterances = [];
  let wake = null;
  let ended = false;
  let lastCallerSentAt = null;
  line.fromAva.on('msg', (m) => {
    if (m.type === 'text') {
      if (lastCallerSentAt != null && !partial) { events.push({ t: at(), event: 'first_token', latencyMs: Date.now() - lastCallerSentAt }); }
      partial += m.token || '';
      if (m.last) {
        const text = partial.trim(); partial = '';
        pendingUtterances.push({ text, t: at(), latencyMs: lastCallerSentAt != null ? Date.now() - lastCallerSentAt : null, uninterruptible: m.interruptible === false });
        lastCallerSentAt = null;
        if (wake) wake();
      }
    } else if (m.type === 'end') {
      ended = true;
      result.endedBy = 'ava';
      if (m.handoffData) { try { result.handoff = JSON.parse(m.handoffData); } catch (_) { result.handoff = m.handoffData; } }
      events.push({ t: at(), event: 'end', handoff: result.handoff });
      if (wake) wake();
    }
  });
  line.fromAva.on('closed', () => { if (!ended) { ended = true; result.endedBy = result.endedBy || 'socket_closed'; if (wake) wake(); } });

  /** Wait for Ava to say something (or end); returns the utterances, [] on silence. */
  async function avaSpeaks(maxMs) {
    const deadline = Date.now() + maxMs;
    while (!ended && pendingUtterances.length === 0 && Date.now() < deadline) {
      await new Promise((r) => { wake = r; setTimeout(r, Math.max(10, Math.min(200, deadline - Date.now()))); });
    }
    wake = null;
    if (pendingUtterances.length) {
      // A second utterance can follow at once (a repeated goodbye, an LLM tail).
      let n;
      do { n = pendingUtterances.length; await sleep(SETTLE_MS); } while (pendingUtterances.length !== n || partial);
    }
    const got = pendingUtterances; pendingUtterances = [];
    return got;
  }

  const callSid = `CAsim${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  line.toAva({ type: 'setup', callSid, sessionId: `VXsim${Date.now()}`, from: scenario.callerNumber || '+19735550100', to: '+19735457975', customParameters: { callerNumber: scenario.callerNumber || '+19735550100' } });

  // Twilio speaks the greeting itself.
  turns.push({ who: 'ava', text: GREETING.primary, t: at() });
  caller.heard(GREETING.primary);

  const sendPrompt = (text) => { lastCallerSentAt = Date.now(); line.toAva({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true }); };
  const rnd = seededRandom(scenario.id);
  async function callerSays(said, { split = false, gapMs = 450 } = {}) {
    // What the caller said and what the transcriber made of it are not always the same thing.
    const text = scenario.noise ? degrade(said, scenario.noise, rnd) : said;
    turns.push(text === said ? { who: 'caller', text, t: at() } : { who: 'caller', text, said, t: at() });
    caller.said(said);
    result.callerTurns++;
    // A pause mid-answer reaches Ava as two finished turns.
    const cut = split ? text.search(/[,.;?!]\s+\S/) : -1;
    if (cut > 0 && cut < text.length - 3) {
      sendPrompt(text.slice(0, cut + 1).trim());
      await sleep(gapMs);
      sendPrompt(text.slice(cut + 1).trim());
    } else {
      sendPrompt(text);
    }
  }

  if (scenario.silentFirstMs) {
    // The caller says nothing at first: does Ava do anything?
    const got = await avaSpeaks(scenario.silentFirstMs);
    events.push({ t: at(), event: 'caller_silent', ms: scenario.silentFirstMs, avaSpoke: got.length > 0 });
    for (const u of got) { turns.push({ who: 'ava', text: u.text, t: u.t }); caller.heard(u.text); }
    if (!got.length) caller.heard('(You said nothing for a while and the line stayed silent.)');
  }

  if (scenario.neverSpeaks) {
    // A pocket dial: nobody ever says a word. Ava should nudge, then hang up on her own.
    const stopAt = Date.now() + 60000;
    while (!ended && Date.now() < stopAt) {
      const got = await avaSpeaks(Math.max(100, stopAt - Date.now()));
      for (const u of got) turns.push({ who: 'ava', text: u.text, t: u.t });
    }
    if (!ended) { result.endedBy = 'never_ended_on_silent_line'; }
  }

  let silences = 0;
  let recapInterrupted = false;
  let wentQuiet = false;
  let safety = 0;
  while (!ended && !scenario.neverSpeaks && result.callerTurns < MAX_CALLER_TURNS && safety++ < 120) {
    const n = result.callerTurns + 1; // 1-based index of the caller turn about to happen
    let text;
    if (scenario.silentAt && scenario.silentAt.turn === n && !wentQuiet) {
      // The caller puts the phone down for a while in the middle of the call.
      wentQuiet = true;
      const got = await avaSpeaks(scenario.silentAt.ms);
      events.push({ t: at(), event: 'caller_silent_mid_call', ms: scenario.silentAt.ms, avaSpoke: got.length });
      turns.push({ who: 'caller', text: `[silent for ${Math.round(scenario.silentAt.ms / 1000)} s]`, t: at() });
      for (const u of got) { turns.push({ who: 'ava', text: u.text, t: u.t }); caller.heard(u.text); }
      if (!got.length) caller.heard('(You were away from the phone for a while. Ava said nothing in that time.)');
      if (ended) break;
    }
    if (n === 1 && scenario.opening) text = scenario.opening;
    else if (scenario.dtmfAt === n) {
      turns.push({ who: 'caller', text: '[presses 0]', t: at() }); result.callerTurns++; caller.said('(you pressed 0)');
      lastCallerSentAt = Date.now(); line.toAva({ type: 'dtmf', digit: '0' });
      text = null;
    } else if (scenario.hangupAt === n) {
      turns.push({ who: 'caller', text: '[hangs up]', t: at() });
      result.endedBy = 'caller_hangup'; break;
    } else {
      text = await caller.reply();
      if (/^\[?hang ?up\]?\.?$/i.test(text) || !text) { turns.push({ who: 'caller', text: '[hangs up]', t: at() }); result.endedBy = 'caller'; break; }
      // "Okay, bye. [hangup]": the last words, then the line drops.
      if (/\[hang ?up\]/i.test(text)) {
        const last = text.replace(/\[hang ?up\]/ig, '').trim();
        if (last && !ended) await callerSays(last);
        turns.push({ who: 'caller', text: '[hangs up]', t: at() });
        result.endedBy = ended ? 'ava' : 'caller';
        break;
      }
    }
    if (ended) break; // Ava ended while the caller was thinking
    if (text != null) await callerSays(text, { split: Boolean(scenario.split) && (scenario.split === 'all' || n % 2 === 0), gapMs: scenario.splitGapMs || 450 });

    let got = await avaSpeaks(NO_REPLY_MS);

    // Interrupt the recap part-way with a correction (Twilio sends 'interrupt', then the caller's words).
    if (!recapInterrupted && scenario.interruptRecap && got.some((u) => /make sure I have this right|Here's what I have now/i.test(u.text))) {
      recapInterrupted = true;
      for (const u of got) { turns.push({ who: 'ava', text: `${u.text.slice(0, 90)}... [interrupted by the caller]`, t: u.t, latencyMs: u.latencyMs }); }
      caller.heard(`${got.map((u) => u.text.slice(0, 90)).join(' ')}... (you interrupted her here)`);
      line.toAva({ type: 'interrupt', utteranceUntilInterrupt: got[0].text.slice(0, 90), durationUntilInterruptMs: 4200 });
      events.push({ t: at(), event: 'interrupt_recap' });
      await callerSays(scenario.interruptRecap);
      got = await avaSpeaks(NO_REPLY_MS);
    }

    if (!got.length && !ended) {
      silences++; result.deadAir++;
      events.push({ t: at(), event: 'dead_air', afterCallerTurn: result.callerTurns, ms: NO_REPLY_MS });
      turns.push({ who: 'ava', text: `[SILENCE: Ava said nothing for ${NO_REPLY_MS / 1000} s]`, t: at() });
      caller.heard(`(The line is silent. ${NO_REPLY_MS / 1000} seconds pass and Ava says nothing.)`);
      if (silences >= 3) { result.endedBy = 'caller_gave_up_on_silence'; turns.push({ who: 'caller', text: '[hangs up after three silences]', t: at() }); break; }
      continue;
    }
    silences = 0;
    for (const u of got) { turns.push({ who: 'ava', text: u.text, t: u.t, latencyMs: u.latencyMs, uninterruptible: u.uninterruptible || undefined }); caller.heard(u.text); }
    // A closing line (goodbye, 911, transfer) cannot be interrupted: nothing the caller says now is answered.
    if (got.some((u) => u.uninterruptible) && !ended) {
      const until = Date.now() + 20000;
      while (!ended && Date.now() < until) await sleep(200);
      if (ended) break;
    }
  }
  if (!result.endedBy) result.endedBy = ended ? 'ava' : (result.callerTurns >= MAX_CALLER_TURNS ? 'max_turns' : 'unknown');

  // After Ava ends, a real caller might still say bye; nothing more to simulate.
  const snap = line.snapshot();
  result.durationMs = at();
  result.finalState = snap ? snap.state : null;
  result.data = snap ? snap.data : null;
  result.turns = turns;
  result.events = events;
  result.callerUsage = caller.usage;
  if (snap) {
    try {
      const { buildCallRow } = require('../../src/utils/call-db');
      const row = buildCallRow(snap.data, snap.state, { callId: callSid, twilioCallSid: callSid, callerNumber: scenario.callerNumber || '+19735550100', wasTransferred: Boolean(result.handoff && result.handoff.reason === 'transfer'), startedAt: t0, endedAt: Date.now(), environment: 'local' });
      result.row = { first_name: row.first_name, last_name: row.last_name, phone_number: row.phone_number, email: row.email, primary_intent: row.primary_intent, service_address: row.service_address, availability_notes: row.availability_notes, call_summary: row.call_summary, call_status: row.call_status, is_safety_risk: row.is_safety_risk };
    } catch (e) { result.rowError = e.message; }
  }
  line.close();
  return result;
}

// ---------------------------------------------------------------------------
// Checks a machine can make; the rest is for a reader
// ---------------------------------------------------------------------------
const digits = (s) => String(s || '').replace(/\D/g, '');
function check(scenario, r) {
  const flags = [];
  const ava = r.turns.filter((t) => t.who === 'ava');
  const exp = scenario.expect || {};
  if (r.deadAir) flags.push(`dead air x${r.deadAir}`);
  if (r.endedBy === 'max_turns') flags.push('never ended (max turns)');
  if (r.endedBy === 'caller_gave_up_on_silence') flags.push('caller gave up on silence');
  if (r.endedBy === 'never_ended_on_silent_line') flags.push('silent line was never hung up');
  // The same line said three times or more (the greeting excluded).
  const counts = new Map();
  for (const t of ava.slice(1)) { const k = t.text.replace(/^(Got it|Okay|Thanks|Thank you|Sorry to hear that|Oh no, sorry to hear that)[.,]\s*/i, '').toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1); }
  for (const [k, c] of counts) if (c >= 3 && !k.startsWith('[silence')) flags.push(`asked ${c}x: "${k.slice(0, 60)}"`);
  for (const t of ava) {
    if (/\b(technician|tech|appointment|booked|next week|this week)\b/i.test(t.text)) flags.push(`forbidden word: "${t.text.slice(0, 80)}"`);
    if (/[*#_`]|\n- /.test(t.text)) flags.push(`markup in speech: "${t.text.slice(0, 60)}"`);
    if (t.latencyMs != null && t.latencyMs > 4000) flags.push(`slow reply ${t.latencyMs} ms: "${t.text.slice(0, 40)}"`);
  }
  if (exp.outcome) {
    const transfer = Boolean(r.handoff && r.handoff.reason === 'transfer');
    // The simulated caller often hangs up right after the goodbye, before Ava's own hang-up lands: still a completed call.
    const got = transfer ? 'transfer' : (r.finalState === 'ended' && (r.endedBy === 'ava' || r.endedBy === 'caller') ? 'completed' : (r.endedBy === 'ava' ? `ava_ended_in_${r.finalState}` : r.endedBy));
    r.outcome = got;
    const ok = exp.outcome === got || exp.outcome === 'any';
    if (!ok) flags.push(`outcome ${got}, expected ${exp.outcome}`);
  }
  if (r.data && exp.fields) {
    for (const [k, want] of Object.entries(exp.fields)) {
      const have = k.includes('.') ? k.split('.').reduce((o, p) => (o ? o[p] : undefined), r.data) : r.data[k];
      const ok = want === null ? !have
        : (k === 'phone' ? digits(have).endsWith(digits(want)) : String(have || '').toLowerCase().includes(String(want).toLowerCase()));
      if (!ok) flags.push(`field ${k}: got ${JSON.stringify(have)}, expected ${JSON.stringify(want)}`);
    }
  }
  return flags;
}

function renderTranscript(scenario, r, flags) {
  const lines = [];
  lines.push(`# ${scenario.id}: ${scenario.description || ''}`);
  lines.push(`Caller persona: ${scenario.persona}`);
  lines.push(`Ended by: ${r.endedBy}${r.handoff ? ` (handoff ${JSON.stringify(r.handoff)})` : ''}; final state: ${r.finalState}; caller turns: ${r.callerTurns}; dead air: ${r.deadAir}; Ava's free-form model: ${r.llm}`);
  lines.push(`Automatic flags: ${flags.length ? flags.join(' | ') : 'none'}`);
  lines.push('');
  for (const t of r.turns) {
    const mm = String(Math.floor(t.t / 60000)).padStart(2, '0'); const ss = String(Math.floor(t.t / 1000) % 60).padStart(2, '0');
    lines.push(`[${mm}:${ss}] ${t.who === 'ava' ? 'AVA   ' : 'CALLER'}: ${t.text}${t.latencyMs != null ? `   (${t.latencyMs} ms)` : ''}${t.said ? `\n          (what the caller actually said: ${t.said})` : ''}`);
  }
  lines.push('');
  if (r.data) {
    const d = r.data;
    lines.push('What Ava stored:');
    lines.push(JSON.stringify({ intent: d.intent, firstName: d.firstName, lastName: d.lastName, phone: d.phone, email: d.email, address: d.address, city: d.city, state: d.state, zip: d.zip, availability: d.availability, details: d.details }, null, 1));
  }
  if (r.row) { lines.push('Row the office would see:'); lines.push(JSON.stringify(r.row, null, 1)); }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { rules, scenarios } = loadScenarios(args.file);

  if (args.scenario) {
    const scenario = scenarios.find((s) => s.id === args.scenario);
    if (!scenario) throw new Error(`No scenario "${args.scenario}"`);
    const outDir = args.out || path.join(HERE, 'out', `sim-${stamp()}`);
    fs.mkdirSync(outDir, { recursive: true });
    const name = args.tag ? `${scenario.id}.${args.tag}` : scenario.id;
    let r;
    try { r = await runCall({ scenario, rules, remote: args.remote }); } catch (e) {
      r = { id: scenario.id, crashed: e.stack || String(e), turns: [], deadAir: 0, callerTurns: 0, endedBy: 'crash' };
    }
    const flags = r.crashed ? [`CRASH: ${String(r.crashed).split('\n')[0]}`] : check(scenario, r);
    r.flags = flags;
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(r, null, 1));
    fs.writeFileSync(path.join(outDir, `${name}.txt`), renderTranscript(scenario, r, flags) + (r.crashed ? `\n\nCRASH\n${r.crashed}` : ''));
    process.stderr.write(`SIM ${name}: ${r.endedBy}, ${r.callerTurns} caller turns, flags: ${flags.length ? flags.join(' | ') : 'none'}\n`);
    // Timers in the session (goodbye fail-safe) would keep the process alive.
    process.exit(0);
  }

  if (!args.all) throw new Error('Give --scenario <id> or --all');
  const outDir = args.out || path.join(HERE, 'out', `sim-${stamp()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const jobs = [];
  for (const s of scenarios) {
    if (args.only && !args.only.includes(s.id)) continue;
    for (let i = 1; i <= args.repeat; i++) jobs.push({ id: s.id, tag: args.repeat > 1 ? `r${i}` : null });
  }
  console.log(`Running ${jobs.length} simulated calls, ${args.concurrency} at a time -> ${outDir}`);
  let next = 0;
  async function worker() {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      const name = job.tag ? `${job.id}.${job.tag}` : job.id;
      const childArgs = [__filename, '--scenario', job.id, '--out', outDir];
      if (job.tag) childArgs.push('--tag', job.tag);
      if (args.remote) childArgs.push('--remote', args.remote);
      if (args.file) childArgs.push('--file', args.file);
      await new Promise((resolve) => {
        const log = fs.createWriteStream(path.join(outDir, `${name}.log`));
        const child = spawn(process.execPath, childArgs, { env: process.env });
        child.stdout.pipe(log); child.stderr.on('data', (d) => { log.write(d); const s = d.toString(); if (s.startsWith('SIM ')) process.stdout.write(s); });
        const kill = setTimeout(() => { child.kill(); }, 6 * 60 * 1000);
        child.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, worker));

  const rows = [];
  for (const job of jobs) {
    const name = job.tag ? `${job.id}.${job.tag}` : job.id;
    const f = path.join(outDir, `${name}.json`);
    if (!fs.existsSync(f)) { rows.push({ name, endedBy: 'NO RESULT', flags: ['no result file (crash or timeout)'] }); continue; }
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    rows.push({ name, endedBy: r.endedBy, outcome: r.outcome, finalState: r.finalState, callerTurns: r.callerTurns, flags: r.flags || [] });
  }
  const md = ['| call | ended by | final state | turns | flags |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.name} | ${r.endedBy} | ${r.finalState || ''} | ${r.callerTurns || ''} | ${(r.flags || []).join('; ').replace(/\|/g, '/') || 'none'} |`)].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), md);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(rows, null, 1));
  const flagged = rows.filter((r) => r.flags.length).length;
  console.log(`\n${rows.length} calls, ${flagged} with automatic flags. Summary: ${path.join(outDir, 'summary.md')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
