#!/usr/bin/env node
/**
 * Run the daily full smoke call (src/monitor/smoke-full-call.js) against a
 * local Ava, with no phone call: a fake Twilio client stands in for
 * calls.create() and joins Ava's /stream to the smoke /smoke/stream, the
 * way Twilio bridges the two legs of the real call.
 *
 *   node scripts/test-caller/smoke-full-local.js [--scenario no-heat] [--store]
 *
 * Ava (src/server-rse.js) is loaded into this process, as in production, so
 * the check that keeps smoke calls out of the Sheet and the email runs for
 * real; the Sheets, SendGrid, Twilio and daily-check variables are removed
 * first anyway. Ava's log goes to scripts/test-caller/out/smoke-full-local.log.
 * --store writes the run to Neon (mode "local", so /health ignores it).
 */

require('./precise-timers'); // Windows: real 20 ms pacing
require('dotenv').config({ quiet: true });

const fs = require('fs');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');
const { FakeTwilioClient, fakeSid } = require('./fake-twilio');
const { FRAME_MS, SILENCE_FRAME } = require('./audio');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const scenarioName = argv.includes('--scenario') ? argv[argv.indexOf('--scenario') + 1] : 'no-heat';
const store = argv.includes('--store');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

/** Just enough of the Twilio client: calls.create() bridges the two legs. */
function fakeTwilioClient(avaUrl) {
  const live = new Map();
  const calls = (sid) => ({
    update: async () => { const c = live.get(sid); if (c) c.end('caller'); return { sid, status: 'completed' }; },
    fetch: async () => ({ sid, status: live.has(sid) ? 'in-progress' : 'completed' }),
  });
  calls.create = async ({ from, twiml }) => {
    const url = /<Stream url="([^"]+)"/.exec(twiml)[1].replace(/&amp;/g, '&');
    const params = {};
    for (const m of twiml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"/g)) params[m[1]] = m[2];
    const sid = fakeSid('CA');
    const streamSid = fakeSid('MZ');
    const ava = new FakeTwilioClient({ url: avaUrl, callerNumber: from, callSid: sid });
    const caller = new WebSocket(url);
    const toAva = [];
    let pump = null;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      live.delete(sid);
      clearInterval(pump);
      try { caller.send(JSON.stringify({ event: 'stop', streamSid })); } catch (_) { /* closed */ }
      try { caller.close(); } catch (_) { /* closed */ }
      try { ava.ws.close(); } catch (_) { /* closed */ }
    };
    live.set(sid, { end });
    caller.on('open', async () => {
      caller.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
      caller.send(JSON.stringify({ event: 'start', streamSid, start: { streamSid, callSid: sid, customParameters: params } }));
      await ava.connect();
      ava.on('heard', (frame) => {
        if (frame && caller.readyState === WebSocket.OPEN) caller.send(JSON.stringify({ event: 'media', streamSid, media: { payload: frame.toString('base64') } }));
      });
      ava.on('close', end);
      // The carrier streams the caller's line continuously, silence included.
      pump = setInterval(() => ava.sendAudio(toAva.shift() || SILENCE_FRAME), FRAME_MS);
    });
    caller.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.event === 'media') toAva.push(Buffer.from(m.media.payload, 'base64'));
    });
    caller.on('close', end);
    return { sid };
  };
  return { calls };
}

async function main() {
  const port = await freePort();
  // Blank, not deleted: server-rse.js loads .env again on require, and dotenv
  // only fills variables that are not set at all.
  const fs0 = require('fs');
  const envFile = path.join(REPO, '.env');
  const fromFile = fs0.existsSync(envFile) ? Object.keys(require('dotenv').parse(fs0.readFileSync(envFile))) : [];
  for (const k of new Set([...Object.keys(process.env), ...fromFile])) {
    if (/^(GOOGLE_|SENDGRID_|EMAIL_|TWILIO_|TRANSFER_|DAILY_|SMOKE_|MONITOR_|SPREADSHEET)/.test(k)) process.env[k] = '';
  }
  process.env.PORT = String(port);
  delete process.env.NODE_ENV;

  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(outDir, 'smoke-full-local.log');
  const logStream = fs.createWriteStream(logFile);
  const write = (...a) => logStream.write(`${a.map(String).join(' ')}\n`);
  console.log = write; console.info = write; console.warn = write; console.error = write;
  const out = (line) => process.stdout.write(`${line}\n`);

  require(path.join(REPO, 'src', 'server-rse.js')); // listens on PORT
  await new Promise((r) => setTimeout(r, 1500));

  const { runFullSmokeCall, storeFullRun, describeFull } = require(path.join(REPO, 'src', 'monitor', 'smoke-full-call'));
  const config = {
    enabled: true, mode: 'full', scenario: scenarioName, problems: [],
    from: '+15555550100', to: '+15555550199',
    streamUrl: `ws://127.0.0.1:${port}/smoke/stream`,
  };
  out(`Full smoke call against local Ava on port ${port} (scenario ${scenarioName}); Ava's log: ${logFile}`);
  const log = { log: (l) => { write(l); out(l); }, warn: (l) => { write(l); out(l); }, error: (l) => { write(l); out(l); } };
  const result = await runFullSmokeCall({ twilioClient: fakeTwilioClient(`ws://127.0.0.1:${port}/stream`), config, log });
  result.mode = 'local';
  const stored = store ? await storeFullRun(result, { log }) : { stored: false, reason: 'not stored (pass --store)' };
  await new Promise((r) => setTimeout(r, 3000)); // Ava's cleanup logs
  out(`\n${result.passed ? 'PASS' : 'FAIL'}: ${describeFull(result, stored)}`);
  const skipped = fs.readFileSync(logFile, 'utf8').includes('skipping the Google Sheets row and the summary email');
  out(`Sheets/email skipped for the smoke call: ${skipped ? 'yes' : 'NO'}`);
  logStream.end();
  process.exit(result.passed && skipped ? 0 : 1);
}

main().catch((err) => { process.stdout.write(`harness error: ${err.stack || err.message}\n`); process.exit(2); });
