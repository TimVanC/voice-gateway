/**
 * Turn the two stored mu-law tracks of a call into a stereo 16-bit WAV
 * (caller left, Ava right) that any browser's <audio> element plays.
 * G.711 mu-law decode, same table the voice server uses (src/g711.js).
 */

const BIAS = 0x84;

function muLawToLinear(mulaw: number): number {
  mulaw = ~mulaw;
  const sign = mulaw & 0x80 ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << (exponent === 0 ? 0 : exponent + 2);
  sample -= BIAS;
  return sign * sample;
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
