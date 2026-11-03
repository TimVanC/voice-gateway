// test-g711.js - The mu-law codec must be the standard one, in both directions.
// Run: node src/test-g711.js
const g = require('./g711');
const { scaleMulaw } = require('../scripts/test-caller/audio');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

// Known codes from the G.711 tables.
check('0xFF decodes to 0 (digital silence)', g.muLawToLinearSample(0xff) === 0);
check('0x7F decodes to 0', g.muLawToLinearSample(0x7f) === 0);
check('0x80 decodes to +32124 (loudest positive)', g.muLawToLinearSample(0x80) === 32124, String(g.muLawToLinearSample(0x80)));
check('0x00 decodes to -32124 (loudest negative)', g.muLawToLinearSample(0x00) === -32124, String(g.muLawToLinearSample(0x00)));
check('0xC0 decodes to +1884', g.muLawToLinearSample(0xc0) === 1884, String(g.muLawToLinearSample(0xc0)));

// Every code survives decode -> encode unchanged.
let roundTrip = 0;
for (let b = 0; b < 256; b++) {
  const back = g.linearToMuLawSample(g.muLawToLinearSample(b));
  // 0x7F and 0xFF both mean zero; the encoder picks 0xFF.
  if (back !== b && !(b === 0x7f && back === 0xff)) roundTrip++;
}
check('decode -> encode returns the same byte for all 256 codes', roundTrip === 0, `${roundTrip} differ`);

// Encoding is monotonic and symmetric, never off by sign.
let bad = 0;
for (let s = -32768; s < 32768; s += 7) {
  const d = g.muLawToLinearSample(g.linearToMuLawSample(s));
  if (Math.sign(d) !== Math.sign(s) && Math.abs(s) > 4) bad++;
  if (Math.abs(d - s) > Math.max(8, Math.abs(s) / 8)) bad++;
}
check('encode -> decode keeps sign and is within mu-law precision', bad === 0, `${bad} samples off`);

// A test tone turned down 6 dB measures 6 dB quieter.
const n = 8000;
const pcm = new Int16Array(n);
for (let i = 0; i < n; i++) pcm[i] = Math.round(20000 * Math.sin((i / 8000) * 2 * Math.PI * 440));
const rmsDb = (x) => { let a = 0; for (const v of x) a += v * v; return 20 * Math.log10(Math.sqrt(a / x.length) / 32767); };
const before = rmsDb(g.muLawToPcm16(g.pcm16ToMuLaw(pcm)));
const after = rmsDb(g.muLawToPcm16(scaleMulaw(g.pcm16ToMuLaw(pcm), -6)));
check('scaleMulaw(-6 dB) lowers a tone by 6 dB', Math.abs(after - before + 6) < 0.3, `${(after - before).toFixed(2)} dB`);

console.log(failures === 0 ? '\n✅ All g711 checks passed' : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
