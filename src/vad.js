// vad.js - Adaptive Voice Activity Detection with calibration and hysteresis
const SAMPLE_RATE = 8000;           // Twilio 8 kHz
const FRAME_MS = 20;                // 160 samples per frame
const SILENCE_MS_REQUIRED = 500;    // 0.5 s of silence ends utterance
const HANGOVER_MS = 250;            // keep "speaking" briefly after last voiced frame
const CALIBRATION_MS = 800;         // learn noise floor at call start
const MAX_UTTER_MS = 6000;          // hard flush after 6 s

function rmsPcm16(frameInt16) {
  let sum = 0;
  for (let i = 0; i < frameInt16.length; i++) {
    const s = frameInt16[i] / 32768;
    sum += s * s;
  }
  const mean = sum / frameInt16.length;
  return Math.sqrt(mean);
}

class AdaptiveVAD {
  constructor() {
    this.frameMs = FRAME_MS;
    this.framesSeen = 0;
    this.noiseEma = 0.0;
    this.levelEma = 0.0;
    this.alphaLevel = 0.2;  // smoother speech level
    this.alphaNoise = 0.05; // slow noise floor update
    this.state = 'silence'; // 'speech' or 'silence'
    this.msSinceStateChange = 0;
    this.msSinceLastUtterStart = 0;
    this.msSinceLastVoice = 0;
    this.calibrating = true;
    this.calibrationMsLeft = CALIBRATION_MS;
    this.onUtteranceStart = null;
    this.onUtteranceEnd = null;
    this.hardFlushCb = null;
  }

  setCallbacks({ onUtteranceStart, onUtteranceEnd, onHardFlush }) {
    this.onUtteranceStart = onUtteranceStart;
    this.onUtteranceEnd = onUtteranceEnd;
    this.hardFlushCb = onHardFlush;
  }

  // Call this per 20 ms frame
  ingestFrame(int16Frame) {
    const rms = rmsPcm16(int16Frame);

    // smooth overall level
    this.levelEma = this.alphaLevel * rms + (1 - this.alphaLevel) * this.levelEma;

    // calibration phase to seed noise floor
    if (this.calibrating) {
      this.noiseEma = this.levelEma; // seed
      this.calibrationMsLeft -= this.frameMs;
      if (this.calibrationMsLeft <= 0) {
        this.calibrating = false;
        console.log(`📊 VAD calibration complete. Noise floor: ${this.noiseEma.toFixed(4)}`);
      }
    } else {
      // update noise floor only when below current speech threshold
      const speechThreshEnter = this.noiseEma * 2.5 + 0.003; // dynamic + floor
      if (this.levelEma < speechThreshEnter) {
        this.noiseEma = this.alphaNoise * this.levelEma + (1 - this.alphaNoise) * this.noiseEma;
      }
    }

    // hysteresis thresholds
    const enterThresh = this.noiseEma * 2.5 + 0.003; // enter speech
    const exitThresh  = this.noiseEma * 1.6 + 0.002; // exit speech

    const isVoiced = this.levelEma > enterThresh;
    const isQuiet  = this.levelEma < exitThresh;

    this.framesSeen += 1;
    this.msSinceStateChange += this.frameMs;
    this.msSinceLastUtterStart += this.frameMs;

    if (this.state === 'silence') {
      // start speech
      if (isVoiced) {
        this.state = 'speech';
        this.msSinceStateChange = 0;
        this.msSinceLastVoice = 0;
        console.log(`🎤 Speech started (level: ${this.levelEma.toFixed(4)}, thresh: ${enterThresh.toFixed(4)})`);
        if (this.onUtteranceStart) this.onUtteranceStart();
      }
    } else {
      // in speech
      if (!isQuiet) {
        this.msSinceLastVoice = 0;
      } else {
        this.msSinceLastVoice += this.frameMs;
      }
      // end speech if quiet for hangover + required silence
      if (this.msSinceLastVoice >= HANGOVER_MS && this.msSinceStateChange >= SILENCE_MS_REQUIRED) {
        this.state = 'silence';
        this.msSinceStateChange = 0;
        const dur = this.msSinceLastUtterStart;
        this.msSinceLastUtterStart = 0;
        this.msSinceLastVoice = 0;
        console.log(`🔇 Speech ended after ${dur}ms (reason: silence)`);
        if (this.onUtteranceEnd) this.onUtteranceEnd({ durationMs: dur, reason: 'silence' });
      }
    }

    // hard flush safeguard
    if (!this.calibrating && this.state === 'speech' && this.msSinceLastUtterStart >= MAX_UTTER_MS) {
      const dur = this.msSinceLastUtterStart;
      this.msSinceLastUtterStart = 0;
      console.log(`⏱️ Hard timeout after ${dur}ms (reason: timeout)`);
      if (this.onUtteranceEnd) this.onUtteranceEnd({ durationMs: dur, reason: 'timeout' });
      if (this.hardFlushCb) this.hardFlushCb();
      this.state = 'silence';
      this.msSinceStateChange = 0;
    }

    return { level: this.levelEma, noise: this.noiseEma, isVoiced: this.state === 'speech' };
  }

  reset() {
    this.state = 'silence';
    this.msSinceStateChange = 0;
    this.msSinceLastUtterStart = 0;
    this.msSinceLastVoice = 0;
  }
}

module.exports = { AdaptiveVAD };

