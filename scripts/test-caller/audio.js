/**
 * Audio helpers for the test caller: mu-law frame inspection and WAV output.
 *
 * All audio on the wire is 8 kHz mu-law (PCMU), 20 ms frames of 160 bytes,
 * exactly what Twilio media streams carry. Decoding uses the server's own
 * codec (src/g711.js) so the harness never disagrees with Ava about what a
 * byte means.
 */

const fs = require('fs');
const path = require('path');
const { muLawToPcm16 } = require('../../src/g711');

const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const SILENCE_BYTE = 0xff; // mu-law digital silence, same value Ava pads with
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, SILENCE_BYTE);

/** True when every byte is mu-law silence: the frame carries no audio at all. */
function isDigitalSilence(frame) {
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] !== SILENCE_BYTE) return false;
  }
  return true;
}

/** RMS of the decoded PCM16 samples (0..32767). */
function frameRms(frame) {
  const pcm = muLawToPcm16(frame);
  if (!pcm.length) return 0;
  let acc = 0;
  for (let i = 0; i < pcm.length; i++) acc += pcm[i] * pcm[i];
  return Math.sqrt(acc / pcm.length);
}

/** Audible by a generous threshold: anything a listener would notice as sound. */
const AUDIBLE_RMS = 200;
function isAudible(frame) {
  return frameRms(frame) > AUDIBLE_RMS;
}

/** Split a mu-law buffer into 20 ms frames; the tail is padded with silence. */
function toFrames(mulaw) {
  const frames = [];
  for (let off = 0; off < mulaw.length; off += FRAME_BYTES) {
    let frame = mulaw.subarray(off, off + FRAME_BYTES);
    if (frame.length < FRAME_BYTES) {
      frame = Buffer.concat([frame, SILENCE_FRAME.subarray(frame.length)]);
    }
    frames.push(Buffer.from(frame));
  }
  return frames;
}

/**
 * Lays timestamped mu-law frames onto fixed 8 kHz tracks so the two sides of
 * the call line up in time the way they happened on the wire.
 */
class TrackRecorder {
  constructor() {
    this.sides = { caller: [], ava: [] }; // { atMs, frame }
  }

  add(side, atMs, frame) {
    this.sides[side].push({ atMs, frame });
  }

  durationMs() {
    let max = 0;
    for (const side of Object.values(this.sides)) {
      for (const f of side) max = Math.max(max, f.atMs + FRAME_MS);
    }
    return max;
  }

  renderTrack(side, totalSamples) {
    const out = new Int16Array(totalSamples);
    for (const { atMs, frame } of this.sides[side]) {
      // Snap to the frame grid so jitter never leaves one-sample gaps.
      const start = Math.round(atMs / FRAME_MS) * FRAME_BYTES;
      if (start >= totalSamples) continue;
      const pcm = muLawToPcm16(frame);
      for (let i = 0; i < pcm.length && start + i < totalSamples; i++) {
        out[start + i] = pcm[i];
      }
    }
    return out;
  }

  /** One side as a continuous mu-law track (silence where nothing was said). */
  renderMulaw(side, totalSamples) {
    const out = Buffer.alloc(totalSamples, SILENCE_BYTE);
    for (const { atMs, frame } of this.sides[side]) {
      const start = Math.round(atMs / FRAME_MS) * FRAME_BYTES;
      if (start >= totalSamples) continue;
      frame.copy(out, start, 0, Math.min(frame.length, totalSamples - start));
    }
    return out;
  }

  /** Stereo WAV (caller left, Ava right) and a mono mix. */
  writeWavs(dir) {
    const totalSamples = Math.ceil((this.durationMs() / 1000) * SAMPLE_RATE);
    const caller = this.renderTrack('caller', totalSamples);
    const ava = this.renderTrack('ava', totalSamples);

    const stereo = new Int16Array(totalSamples * 2);
    const mono = new Int16Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      stereo[i * 2] = caller[i];
      stereo[i * 2 + 1] = ava[i];
      mono[i] = clamp16(caller[i] + ava[i]);
    }
    const mixPath = path.join(dir, 'call.wav');
    const stereoPath = path.join(dir, 'call-stereo.wav');
    fs.writeFileSync(mixPath, wavBuffer(mono, 1));
    fs.writeFileSync(stereoPath, wavBuffer(stereo, 2));
    return { mixPath, stereoPath, seconds: totalSamples / SAMPLE_RATE };
  }
}

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

function wavBuffer(int16, channels) {
  const dataBytes = int16.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  const data = Buffer.alloc(dataBytes);
  for (let i = 0; i < int16.length; i++) data.writeInt16LE(int16[i], i * 2);
  return Buffer.concat([header, data]);
}

module.exports = {
  SAMPLE_RATE,
  FRAME_MS,
  FRAME_BYTES,
  SILENCE_FRAME,
  isDigitalSilence,
  isAudible,
  frameRms,
  toFrames,
  TrackRecorder,
};
