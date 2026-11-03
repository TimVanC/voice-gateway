/**
 * Room tone: a continuous, very quiet bed under everything Ava sends, so the
 * line never goes digitally silent between her sentences (the "is anyone
 * there?" feeling of a dead line). Enabled with AMBIENCE=office.
 *
 * The bed is generated, not a recording: pink noise (Paul Kellet's filter)
 * through a one-pole low-pass, with a slow level drift so it does not sound
 * like a constant hiss. Level is RMS in dBFS of the 16-bit signal
 * (AMBIENCE_LEVEL_DB, default -50 dBFS, which is just audible on a handset;
 * TTS speech sits around -20 dBFS).
 */

const { muLawToPcm16, pcm16ToMuLaw } = require('../g711');

const FRAME_SAMPLES = 160; // 20 ms at 8 kHz

class RoomTone {
  constructor({ levelDb = -50, sampleRate = 8000 } = {}) {
    this.target = 32768 * Math.pow(10, levelDb / 20); // RMS target
    this.sampleRate = sampleRate;
    this.b0 = this.b1 = this.b2 = this.b3 = this.b4 = this.b5 = this.b6 = 0;
    this.lp = 0;
    this.lfoPhase = Math.random() * Math.PI * 2;
    this.gainTrim = 1; // adapts so the running RMS matches the target
  }

  /** One frame of bed as Int16Array. */
  nextPcm(n = FRAME_SAMPLES) {
    const out = new Int16Array(n);
    // Slow drift: +/- 1.5 dB over ~12 s.
    const lfoStep = (2 * Math.PI * (1 / 12)) / this.sampleRate;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      // Pink noise, Paul Kellet's refined method.
      this.b0 = 0.99886 * this.b0 + white * 0.0555179;
      this.b1 = 0.99332 * this.b1 + white * 0.0750759;
      this.b2 = 0.96900 * this.b2 + white * 0.1538520;
      this.b3 = 0.86650 * this.b3 + white * 0.3104856;
      this.b4 = 0.55000 * this.b4 + white * 0.5329522;
      this.b5 = -0.7616 * this.b5 - white * 0.0168980;
      let pink = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362;
      this.b6 = white * 0.115926;
      pink *= 0.11; // roughly unit RMS
      // One-pole low-pass (~1.2 kHz) so it reads as room, not tape hiss.
      this.lp += 0.6 * (pink - this.lp);
      this.lfoPhase += lfoStep;
      const drift = Math.pow(10, (1.5 * Math.sin(this.lfoPhase)) / 20);
      const s = this.lp * this.target * this.gainTrim * drift;
      sum += s * s;
      out[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : Math.round(s);
    }
    // Keep the measured RMS at the target (the filter chain's gain is approximate).
    const rms = Math.sqrt(sum / n);
    if (rms > 1) this.gainTrim *= Math.min(1.05, Math.max(0.95, this.target / rms));
    return out;
  }

  /** Mix the bed under one 20 ms mu-law frame (speech or silence). */
  mixFrame(mulawFrame) {
    const bed = this.nextPcm(mulawFrame.length);
    const pcm = muLawToPcm16(mulawFrame);
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] + bed[i];
      pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return pcm16ToMuLaw(pcm);
  }
}

module.exports = { RoomTone, FRAME_SAMPLES };
