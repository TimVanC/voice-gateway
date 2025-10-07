// g711.js - Proper G.711 μ-law encoding/decoding
const BIAS = 0x84; // 132
const CLIP = 32635;

/**
 * Convert a single PCM16 sample to μ-law byte
 */
function linearToMuLawSample(sample) {
  // Clamp to valid range
  if (sample > CLIP) sample = CLIP;
  else if (sample < -CLIP) sample = -CLIP;

  const sign = (sample < 0) ? 0x7F : 0xFF;
  if (sample < 0) sample = -sample;
  sample = sample + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  const mu = ~(sign & (exponent << 4 | mantissa));
  return mu & 0xFF;
}

/**
 * Convert μ-law byte to PCM16 sample
 */
function muLawToLinearSample(mulaw) {
  mulaw = ~mulaw;
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;
  let sample = ((mantissa << 3) + BIAS) << (exponent === 0 ? 0 : (exponent + 2));
  sample = sample - BIAS;
  return sign * sample;
}

/**
 * Convert PCM16 Int16Array to μ-law Buffer
 */
function pcm16ToMuLaw(pcmInt16) {
  const out = Buffer.allocUnsafe(pcmInt16.length);
  for (let i = 0; i < pcmInt16.length; i++) {
    out[i] = linearToMuLawSample(pcmInt16[i]);
  }
  return out;
}

/**
 * Convert μ-law Buffer to PCM16 Int16Array
 */
function muLawToPcm16(mulawBuf) {
  const out = new Int16Array(mulawBuf.length);
  for (let i = 0; i < mulawBuf.length; i++) {
    out[i] = muLawToLinearSample(mulawBuf[i]);
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

