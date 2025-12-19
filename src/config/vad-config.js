/**
 * Voice Activity Detection (VAD) Configuration
 * Tuned for ChatGPT-style turn-taking
 */

const VAD_CONFIG = {
  // Default settings
  threshold: 0.6,
  prefix_padding_ms: 350,
  silence_duration_ms: 625,
  
  // Dynamic silence adjustments
  silence_short: 550,   // When caller clearly finishes a thought
  silence_long: 700,    // When caller pauses mid-thought
  silence_default: 625  // Reset value after turn completes
};

// Backchannel timing configuration
const BACKCHANNEL_CONFIG = {
  // Min delay before playing backchannel after speech ends (ms)
  min_delay_ms: 100,
  
  // Max delay before playing backchannel after speech ends (ms)  
  max_delay_ms: 200,
  
  // Whether backchanneling is enabled
  enabled: true
};

// Long-speech backchannel configuration (during caller speech)
const LONG_SPEECH_CONFIG = {
  // Inject backchannel after this many ms of continuous caller speech
  trigger_after_ms: 4500,  // 4.5 seconds
  
  // Max time before backchannel (won't trigger after this)
  max_trigger_ms: 6000,    // 6 seconds
  
  // Allowed backchannels during long speech
  phrases: ["mm hm", "okay", "got it"],
  
  // Whether long-speech backchanneling is enabled
  enabled: true
};

// Filler usage tracking
const FILLER_CONFIG = {
  // Only allow filler every N assistant turns
  min_turns_between_fillers: 3,
  
  // Allowed fillers
  allowed: ["okay", "mm hm", "one sec"]
};

// Silence detection for greeting fallback
const SILENCE_CONFIG = {
  // Time to wait after greeting before sending fallback prompt (ms)
  greeting_fallback_ms: 4000
};

module.exports = {
  VAD_CONFIG,
  BACKCHANNEL_CONFIG,
  LONG_SPEECH_CONFIG,
  FILLER_CONFIG,
  SILENCE_CONFIG
};

