/**
 * Turn the two stored mu-law tracks of a call into a stereo 16-bit WAV
 * (caller left, Ava right) that any browser's <audio> element plays.
 * Standard G.711 mu-law decode, the same table as src/g711.js. (Until Nov
 * 2026 both shifted two bits too far, which made loud passages wrap around
 * and crackle on playback.)
 */

const BIAS = 0x84;

function muLawToLinear(mulaw: number): number {
  const u = ~mulaw & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return u & 0x80 ? -magnitude : magnitude;
}

const TABLE: Int16Array = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) t[i] = muLawToLinear(i);
  return t;
})();

const SILENCE = 0xff;

export function stereoWav(left: Buffer, right: Buffer, sampleRate: number): Buffer {
  const samples = Math.max(left.length, right.length);
  const channels = 2;
  const dataBytes = samples * channels * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(TABLE[i < left.length ? left[i] : SILENCE], o);
    out.writeInt16LE(TABLE[i < right.length ? right[i] : SILENCE], o + 2);
    o += 4;
  }
  return out;
}
