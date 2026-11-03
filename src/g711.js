// g711.js - G.711 mu-law encoding/decoding (ITU-T G.711, as used by Twilio PCMU)
//
// History: the encoder used to drop the sign bit (~(sign & uval)) so every
// negative sample came out as a positive one, and the decoder shifted by
// exponent + 2 instead of exponent (4x too hot, wrapping above ~8000).
// server-rse.js never decodes (mu-law goes straight to OpenAI) so production
// calls were unaffected; the test-caller WAVs, RMS numbers and anything that
// mixes audio locally (server-pipeline.js) go through this file.
const BIAS = 0x84; // 132
const CLIP = 32635;

/**
 * Convert a single PCM16 sample to a mu-law byte.
 */
function linearToMuLawSample(sample) {
  // Clamp to valid range
  if (sample > CLIP) sample = CLIP;
  else if (sample < -CLIP) sample = -CLIP;

  // Negative samples invert the low seven bits only; positive ones all eight.
  const mask = (sample < 0) ? 0x7F : 0xFF;
  if (sample < 0) sample = -sample;
  sample = sample + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const uval = (exponent << 4) | mantissa;
  return (uval ^ mask) & 0xFF;
}

/**
 * Convert a mu-law byte to a PCM16 sample.
 */
function muLawToLinearSample(mulaw) {
  mulaw = ~mulaw & 0xFF;
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample = sample - BIAS;
  return sign * sample;
}

// Decode table: 256 entries, so hot paths (frame mixing, RMS) avoid the arithmetic.
const DECODE_TABLE = new Int16Array(256);
for (let b = 0; b < 256; b++) DECODE_TABLE[b] = muLawToLinearSample(b);

/**
 * Convert PCM16 Int16Array to mu-law Buffer
 */
function pcm16ToMuLaw(pcmInt16) {
  const out = Buffer.allocUnsafe(pcmInt16.length);
  for (let i = 0; i < pcmInt16.length; i++) {
    out[i] = linearToMuLawSample(pcmInt16[i]);
  }
  return out;
}

/**
 * Convert mu-law Buffer to PCM16 Int16Array
 */
function muLawToPcm16(mulawBuf) {
  const out = new Int16Array(mulawBuf.length);
  for (let i = 0; i < mulawBuf.length; i++) {
    out[i] = DECODE_TABLE[mulawBuf[i]];
  }
  return out;
}

/**
 * Convert PCM16 little-endian Buffer to Int16Array
 */
function pcm16leBufferToInt16(buf) {
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = buf.readInt16LE(i * 2);
  }
  return out;
}

/**
 * Convert Int16Array to PCM16 little-endian Buffer
 */
function int16ToPcm16leBuffer(int16arr) {
  const buf = Buffer.alloc(int16arr.length * 2);
  for (let i = 0; i < int16arr.length; i++) {
    buf.writeInt16LE(int16arr[i], i * 2);
  }
  return buf;
}

module.exports = {
  pcm16ToMuLaw,
  muLawToPcm16,
  pcm16leBufferToInt16,
  int16ToPcm16leBuffer,
  linearToMuLawSample,
  muLawToLinearSample
};
