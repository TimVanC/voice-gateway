// g711.js - G.711 mu-law (PCMU) encoding/decoding, the codec Twilio media
// streams carry: 8 kHz, one byte per sample, 0xFF = digital silence.
//
// Both directions are table-driven and are exact inverses of each other for
// every one of the 256 codes. Until Nov 2026 the decoder shifted by two bits
// too many (4x too loud, wrapping at Int16 on anything above about -12 dBFS),
// which garbled every recording played back through it; src/server-rse.js
// hands mu-law straight to OpenAI and never decodes, so calls were unaffected.
const BIAS = 0x84; // 132
const CLIP = 32635;

/**
 * Convert a single PCM16 sample to a mu-law byte
 */
function linearToMuLawSample(sample) {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

/**
 * Convert a mu-law byte to a PCM16 sample
 */
function muLawToLinearSample(mulaw) {
  const u = ~mulaw & 0xFF;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0F;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return (u & 0x80) ? -magnitude : magnitude;
}

const DECODE_TABLE = new Int16Array(256);
for (let byte = 0; byte < 256; byte++) DECODE_TABLE[byte] = muLawToLinearSample(byte);

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
  muLawToLinearSample,
  DECODE_TABLE,
};
