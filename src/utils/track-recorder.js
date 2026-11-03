/**
 * TrackRecorder: the two sides of a call as time-aligned 8 kHz mu-law
 * tracks, exactly the bytes that travelled on the Twilio media stream.
 *
 * Used by src/server-rse.js (CALL_RECORDING=on) for every call it answers,
 * and by the test caller (scripts/test-caller) for the calls it places.
 * Frames are kept as they arrive and laid onto a fixed 50 frames/s grid at
 * render time, so the caller and Ava line up the way they happened on the
 * wire. Memory is about 16 KB per second of call for both sides.
 */

const fs = require('fs');
const path = require('path');
const { muLawToPcm16 } = require('../g711');

const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const SILENCE_BYTE = 0xff; // mu-law digital silence, same value Ava pads with
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, SILENCE_BYTE);
const RESYNC_MS = 200; // stream-vs-clock disagreement that counts as a real gap

/**
 * Lays timestamped mu-law frames onto fixed 8 kHz tracks so the two sides of
 * the call line up in time the way they happened on the wire.
 */
class TrackRecorder {
  constructor() {
    this.sides = { caller: [], ava: [] }; // { atMs, frame }
    this.next = { caller: null, ava: null }; // next slot (ms) for a contiguous stream
  }

  /**
   * Each side is a continuous 50 frames/s stream, so consecutive frames go
   * into consecutive slots regardless of timer jitter on arrival; only when
   * the clock and the stream disagree by more than RESYNC_MS (a real gap,
   * or frames that were cleared) does placement jump back to the clock.
   * The frame is stored by reference: pass a buffer nobody will reuse.
   */
  add(side, atMs, frame) {
    const expected = this.next[side];
    const slot = expected != null && Math.abs(atMs - expected) <= RESYNC_MS ? expected : Math.round(atMs / FRAME_MS) * FRAME_MS;
    this.sides[side].push({ atMs: slot, frame });
    this.next[side] = slot + FRAME_MS;
  }

  durationMs() {
    let max = 0;
    for (const side of Object.values(this.sides)) {
      for (const f of side) max = Math.max(max, f.atMs + FRAME_MS);
    }
    return max;
  }

  /** Frames stored on one side (for logs and size estimates). */
  frameCount(side) {
    return this.sides[side].length;
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
  SILENCE_BYTE,
  SILENCE_FRAME,
  RESYNC_MS,
  TrackRecorder,
  clamp16,
  wavBuffer,
};
