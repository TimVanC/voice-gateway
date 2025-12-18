/**
 * Voice Activity Detection (VAD) Configuration
 * Tune these settings to adjust speech detection sensitivity
 */

const VAD_CONFIG = {
  // How confident the system needs to be that speech is occurring
  // Higher = less sensitive to background noise (0.0 - 1.0)
  threshold: 0.6,
  
  // Milliseconds of audio to include before detected speech starts
  // Helps capture the beginning of words
  prefix_padding_ms: 350,
  
  // Milliseconds of silence before considering speech ended
  // Lower = faster turn-taking, but may cut off pauses
  silence_duration_ms: 625
};

// Backchannel timing configuration
const BACKCHANNEL_CONFIG = {
  // Min delay before playing backchannel (ms)
  min_delay_ms: 150,
  
  // Max delay before playing backchannel (ms)  
  max_delay_ms: 250,
  
  // Whether backchanneling is enabled
  enabled: true
};

// Silence detection for greeting fallback
const SILENCE_CONFIG = {
  // Seconds of silence after greeting before fallback
  greeting_fallback_seconds: 2
};

module.exports = {
  VAD_CONFIG,
  BACKCHANNEL_CONFIG,
  SILENCE_CONFIG
};

