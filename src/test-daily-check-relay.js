// test-daily-check-relay.js - The GitHub Actions backup of the daily check
// relays the server's smoke-call result from /health. A failure the server
// already emailed must come through as a NOTE, never as a second ATTENTION
// NEEDED email hours later (Nov 6 2026). Run: node src/test-daily-check-relay.js

const { smokeCallRelayCheck, isAllGood, statusLabel } = require('./monitor/daily-check');

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

// Nov 6 2026 is EST (UTC-5). 13:30Z = 8:30 AM, 20:02Z = 3:02 PM.
const health = (last) => ({ smoke_call: { enabled: true, last, server_started_at: '2026-11-05T17:43:41.353Z' } });
const morningFail = { at: '2026-11-06T13:30:04.133Z', passed: false, summary: 'the call never connected a media stream within 45 s (Twilio call status: busy)' };
const morningPass = { at: '2026-11-06T13:30:04.133Z', passed: true, summary: 'full no-heat call passed: 7/7 fields, 3:05' };
const yesterdayPass = { at: '2026-11-05T21:00:04.000Z', passed: true, summary: 'full no-heat call passed: 7/7 fields, 3:10' };
const otherPass = [{ name: 'Railway server health', status: 'pass', detail: 'HTTP 200' }];

console.log('\n🧪 A failure the server already emailed is relayed as a note');
{
  const r = smokeCallRelayCheck(health(morningFail), new Date('2026-11-06T20:02:23.981Z'));
  check('status is info', r.status, 'info');
  check('label is NOTE', statusLabel(r.status), 'NOTE');
  check('detail says the server emailed it', r.detail, 'Nov 6, 8:30 AM call FAILED, reported and emailed by the server at the time: the call never connected a media stream within 45 s (Twilio call status: busy)');
  check('the day stays all good (no backup email)', isAllGood([...otherPass, r]), true);
}

console.log('\n🧪 A pass today is a pass');
{
  const r = smokeCallRelayCheck(health(morningPass), new Date('2026-11-06T20:02:23.981Z'));
  check('status is pass', r.status, 'pass');
  check('detail', r.detail, 'Nov 6, 8:30 AM call, reported by the server: full no-heat call passed: 7/7 fields, 3:05');
}

console.log('\n🧪 No call today after 8:45 AM is the failure the backup exists for');
{
  const r = smokeCallRelayCheck(health(yesterdayPass), new Date('2026-11-06T20:02:23.981Z'));
  check('status is fail', r.status, 'fail');
  check('detail names the last call', r.detail.startsWith('no smoke call today; the last one, Nov 5, 4:00 PM, was a PASS'), true);
  check('the day needs attention', isAllGood([...otherPass, r]), false);
}

console.log('\n🧪 Before 8:45 AM the morning call may still be running');
{
  const r = smokeCallRelayCheck(health(yesterdayPass), new Date('2026-11-06T13:34:00.000Z')); // 8:34 AM
  check('status is info', r.status, 'info');
  check('detail says not finished yet', r.detail.startsWith("today's 8:30 AM call is not finished yet"), true);
  const later = smokeCallRelayCheck(health(yesterdayPass), new Date('2026-11-06T13:46:00.000Z')); // 8:46 AM
  check('8:46 AM with no call: fail', later.status, 'fail');
}

console.log('\n🧪 Warnings and failures still count against the day');
{
  check('warning is not all good', isAllGood([{ status: 'pass' }, { status: 'warning' }]), false);
  check('fail is not all good', isAllGood([{ status: 'pass' }, { status: 'fail' }]), false);
  check('smoke call off is a warning', smokeCallRelayCheck({ smoke_call: { enabled: false } }).status, 'warning');
}

console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All daily-check relay checks passed');
process.exit(failures ? 1 : 0);
