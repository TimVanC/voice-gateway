/**
 * Audio helpers for the test caller: mu-law frame inspection and gain.
 *
 * All audio on the wire is 8 kHz mu-law (PCMU), 20 ms frames of 160 bytes,
 * exactly what Twilio media streams carry. Decoding uses the server's own
 * codec (src/g711.js) so the harness never disagrees with Ava about what a
 * byte means. The two-track recorder is shared with the server
 * (src/utils/track-recorder.js) and re-exported here.
 */

const { muLawToPcm16, pcm16ToMuLaw } = require('../../src/g711');
const {
  SAMPLE_RATE, FRAME_MS, FRAME_BYTES, SILENCE_BYTE, SILENCE_FRAME, TrackRecorder, clamp16,
} = require('../../src/utils/track-recorder');

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

/**
 * Audible by a generous threshold: anything a listener would notice as sound
 * (50 is about -56 dBFS; the value was 200 against the old 4x-hot decoder).
 */
const AUDIBLE_RMS = 50;
function isAudible(frame) {
  return frameRms(frame) > AUDIBLE_RMS;
}

/**
 * The same mu-law audio `db` decibels quieter (or louder, if positive):
 * decoded, scaled, re-encoded. Used to bring the persona's voice, which
 * OpenAI renders at full scale, down to the level of a real phone caller.
 */
function scaleMulaw(mulaw, db) {
  if (!db) return mulaw;
  const factor = Math.pow(10, db / 20);
  const pcm = muLawToPcm16(mulaw);
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = clamp16(Math.round(pcm[i] * factor));
  return pcm16ToMuLaw(out);
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

module.exports = {
  SAMPLE_RATE,
  FRAME_MS,
  FRAME_BYTES,
  SILENCE_FRAME,
  isDigitalSilence,
  isAudible,
  frameRms,
  toFrames,
  scaleMulaw,
  TrackRecorder,
};
