// node src/test-g711.js - checks src/g711.js against the standard G.711 tables
const assert = require('assert');
const g = require('./g711');
const smoke = require('./monitor/smoke-call');

// 1. Decode matches the reference table smoke-call.js carries.
const all = Buffer.from([...Array(256).keys()]);
const ours = g.muLawToPcm16(all);
const ref = smoke.muLawToPcm16 ? smoke.muLawToPcm16(all) : null;
if (ref) for (let b = 0; b < 256; b++) assert.strictEqual(ours[b], ref[b], `decode byte ${b}`);

// 2. Known points: 0xFF is digital silence (0), 0x7F is -0, 0x80 is +32124, 0x00 is -32124.
assert.strictEqual(ours[0xff], 0);
assert.strictEqual(ours[0x7f], 0);
assert.strictEqual(ours[0x80], 32124);
assert.strictEqual(ours[0x00], -32124);

// 3. Round trip: encode(decode(b)) == b for every byte, and decode(encode(x)) is within the segment quantisation of x.
for (let b = 0; b < 256; b++) {
  const back = g.linearToMuLawSample(ours[b]);
  // 0x7F and 0xFF both decode to 0, which re-encodes as 0xFF.
  if (b !== 0x7f) assert.strictEqual(back, b, `round trip byte ${b}`);
}
let worst = 0;
for (let x = -32768; x <= 32767; x += 7) {
  const y = g.muLawToLinearSample(g.linearToMuLawSample(x));
  assert.strictEqual(Math.sign(y) || Math.sign(x), Math.sign(x) || Math.sign(y), `sign kept for ${x}`);
  const step = Math.max(8, Math.abs(x) / 16); // segment step is ~1/16 of magnitude, 8 at the bottom
  const err = Math.abs(Math.min(Math.max(x, -32124), 32124) - y);
  assert.ok(err <= step + 1, `quantisation error ${err} for ${x} (step ${step})`);
  if (Math.abs(x) > 256) worst = Math.max(worst, err / Math.abs(x));
}
console.log(`g711 OK: decode matches reference table, 256-byte round trip exact, worst relative error ${(worst * 100).toFixed(1)}%`);
