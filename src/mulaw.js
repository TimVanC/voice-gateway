// mulaw.js - μ-law <-> PCM16 conversion for Twilio <-> OpenAI Realtime

/**
 * μ-law byte to PCM16 sample (linear 16-bit signed integer)
 */
function mulawToLinear16(mulaw) {
  mulaw = ~mulaw & 0xFF;
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let magnitude = ((mantissa << 3) + 132) << exponent;
  magnitude = magnitude - 132;
  return sign * magnitude;
}

/**
 * PCM16 sample to μ-law byte
 */
function linear16ToMulaw(sample) {
  const BIAS = 132;
  const CLIP = 32635;
  
  // Get sign and magnitude
  let sign = (sample < 0) ? 0x80 : 0x00;
  let magnitude = Math.abs(sample);
  
  // Clip the magnitude
  if (magnitude > CLIP) magnitude = CLIP;
  
  // Add bias
  magnitude = magnitude + BIAS;
  
  // Find exponent
  let exponent = 7;
  for (let exp_mask = 0x4000; exp_mask != 0; exp_mask >>= 1) {
    if (magnitude & exp_mask) break;
    exponent--;
  }
  
  const mantissa = (magnitude >> (exponent + 3)) & 0x0F;
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  
  return mulaw;
}

/**
 * Decode μ-law buffer to PCM16 buffer (Int16 Little Endian)
 * @param {Buffer} mulawBuffer - μ-law encoded audio
 * @returns {Buffer} PCM16 buffer (2 bytes per sample)
 */
function decodeMulaw(mulawBuffer) {
  const pcm16 = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    const sample = mulawToLinear16(mulawBuffer[i]);
    pcm16.writeInt16LE(sample, i * 2);
  }
  return pcm16;
}

/**
 * Encode PCM16 buffer to μ-law buffer
 * @param {Buffer} pcm16Buffer - PCM16 buffer (2 bytes per sample, little endian)
 * @returns {Buffer} μ-law encoded buffer (1 byte per sample)
 */
function encodeMulaw(pcm16Buffer) {
  const sampleCount = pcm16Buffer.length / 2;
  const mulaw = Buffer.alloc(sampleCount);
  
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm16Buffer.readInt16LE(i * 2);
    mulaw[i] = linear16ToMulaw(sample);
  }
  
  return mulaw;
}

module.exports = {
  decodeMulaw,
  encodeMulaw,
  mulawToLinear16,
  linear16ToMulaw
};

