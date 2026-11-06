// test-smoke-retry.js - The daily smoke check places a call that never
// connected once more (Nov 6 2026: a few seconds of Railway edge 404s made
// the morning call ring busy). No phone call is placed: the call-placing step
// is stubbed. Run: node src/test-smoke-retry.js

const smoke = require('./monitor/smoke-call');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    failures++;
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     actual:   ${JSON.stringify(actual)}`);
  }
}

const quiet = { log() {}, warn() {}, error() {} };
const config = { mode: 'full', problems: [], from: '+19735457975', to: '+18885842210' };

function attempts(list) {
  let i = 0;
  const calls = [];
  const place = async () => {
    const a = list[Math.min(i, list.length - 1)];
    i++;
    calls.push(a.name);
    return { result: { passed: a.passed, reason: a.reason || null, endedHow: a.endedHow || null, dialedAt: Date.now() }, detail: a.detail };
  };
  return { place, calls };
}

(async () => {
  console.log('\n🧪 A call that never connected is placed once more');
  {
    const busy = { name: 'busy', passed: false, endedHow: 'never connected', reason: 'the call never connected a media stream within 45 s (Twilio call status: busy)', detail: 'the call never connected a media stream within 45 s (Twilio call status: busy); call log #1' };
    const pass = { name: 'pass', passed: true, endedHow: 'hung up by Ava', detail: '7/7 fields, 3:10; call log #2' };
    const { place, calls } = attempts([busy, pass]);
    const r = await smoke.smokeCheck({ config, log: quiet, place, retryDelayMs: 0 });
    check('two calls placed', calls.join(','), 'busy,pass');
    check('check passes on the second call', r.status, 'pass');
    check('detail is the second call', r.detail.startsWith('7/7 fields, 3:10; call log #2'), true);
    check('detail names the first try', r.detail.includes('(first try: the call never connected a media stream within 45 s (Twilio call status: busy); placed again after 0 s)'), true);
    check('/health shows the pass', smoke.healthSummary(config).last.passed, true);
  }

  console.log('\n🧪 A second failure still fails');
  {
    // The run above recorded a pass for today, so start from a fresh module.
    delete require.cache[require.resolve('./monitor/smoke-call')];
    const fresh = require('./monitor/smoke-call');
    const busy = { name: 'busy', passed: false, endedHow: 'never connected (Twilio status busy)', reason: 'never connected (Twilio status busy)', detail: 'never connected (Twilio status busy); not stored: no DATABASE_URL' };
    const { place, calls } = attempts([busy, busy]);
    const r = await fresh.smokeCheck({ config: { ...config, mode: 'greeting' }, log: quiet, place, retryDelayMs: 0 });
    check('two calls placed', calls.length, 2);
    check('check fails', r.status, 'fail');
    check('detail says it was tried twice', r.detail.includes('placed again after 0 s'), true);
    check('/health shows the fail', fresh.healthSummary({ ...config, enabled: true }).last.passed, false);
  }

  console.log('\n🧪 Any other failure is not retried');
  {
    delete require.cache[require.resolve('./monitor/smoke-call')];
    const fresh = require('./monitor/smoke-call');
    const silent = { name: 'silent', passed: false, endedHow: 'hung up by the smoke test after 10 s of silence', reason: 'no audio from Ava within 10 s of the stream starting', detail: 'no audio from Ava within 10 s of the stream starting; call log #3' };
    const { place, calls } = attempts([silent, silent]);
    const r = await fresh.smokeCheck({ config, log: quiet, place, retryDelayMs: 0 });
    check('one call placed', calls.length, 1);
    check('check fails with the original reason', r.detail, silent.detail);
  }

  console.log('\n🧪 A passing first call is placed once');
  {
    delete require.cache[require.resolve('./monitor/smoke-call')];
    const fresh = require('./monitor/smoke-call');
    const pass = { name: 'pass', passed: true, endedHow: 'hung up by Ava', detail: '7/7 fields; call log #4' };
    const { place, calls } = attempts([pass]);
    const r = await fresh.smokeCheck({ config, log: quiet, place, retryDelayMs: 0 });
    check('one call placed', calls.length, 1);
    check('check passes', r.status, 'pass');
    const again = await fresh.smokeCheck({ config, log: quiet, place, retryDelayMs: 0 });
    check('same day: no second call', calls.length, 1);
    check('same day: reports the earlier pass', again.detail.includes('one call a day'), true);
  }

  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All smoke retry checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
