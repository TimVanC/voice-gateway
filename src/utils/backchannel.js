/**
 * Backchannel / Micro-response Logic
 * 
 * When user stops speaking, start a short timer (150-250ms).
 * If OpenAI audio hasn't started streaming, play a micro-response.
 * Stop micro-response as soon as OpenAI audio begins.
 */

const { MICRO_RESPONSES } = require('../scripts/rse-script');
const { BACKCHANNEL_CONFIG } = require('../config/vad-config');

/**
 * Get a random delay between min and max
 */
function getRandomDelay() {
  const { min_delay_ms, max_delay_ms } = BACKCHANNEL_CONFIG;
  return Math.floor(Math.random() * (max_delay_ms - min_delay_ms + 1)) + min_delay_ms;
}

/**
 * Select a micro-response based on context
 * @param {string} context - 'general', 'after_capture', or 'before_confirmation'
 * @returns {string} A random micro-response phrase
 */
function selectMicroResponse(context = 'general') {
  let pool;
  
  switch (context) {
    case 'after_capture':
      pool = MICRO_RESPONSES.after_capture;
      break;
    case 'before_confirmation':
      pool = MICRO_RESPONSES.before_confirmation;
      break;
    default:
      pool = MICRO_RESPONSES.general;
  }
  
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Create a backchannel manager for a call session
 * @returns {Object} Backchannel manager with start/stop/cancel methods
 */
function createBackchannelManager() {
  let timer = null;
  let isActive = false;
  let onTrigger = null;
  
  return {
    /**
     * Start the backchannel timer
     * @param {Function} callback - Called with micro-response if timer expires
     * @param {string} context - Context for response selection
     */
    start(callback, context = 'general') {
      if (!BACKCHANNEL_CONFIG.enabled) return;
      
      this.cancel(); // Clear any existing timer
      
      const delay = getRandomDelay();
      onTrigger = callback;
      
      timer = setTimeout(() => {
        if (onTrigger) {
          const response = selectMicroResponse(context);
          isActive = true;
          onTrigger(response);
        }
      }, delay);
    },
    
    /**
     * Cancel the backchannel timer (OpenAI started streaming)
     */
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      onTrigger = null;
    },
    
    /**
     * Stop active backchannel audio (OpenAI audio began)
     * @returns {boolean} Whether a backchannel was active
     */
    stop() {
      const wasActive = isActive;
      isActive = false;
      this.cancel();
      return wasActive;
    },
    
    /**
     * Check if backchannel is currently playing
     */
    isPlaying() {
      return isActive;
    },
    
    /**
     * Mark backchannel as finished playing
     */
    finished() {
      isActive = false;
    }
  };
}

/**
 * Pre-generate G.711 μ-law audio for micro-responses
 * These are generated via OpenAI TTS at startup for instant playback
 * 
 * Note: For true instant playback, you'd pre-generate these as static files.
 * For now, we'll use OpenAI to generate them on-demand with minimal text.
 */
const MICRO_AUDIO_CACHE = new Map();

/**
 * Generate the prompt for a quick TTS micro-response
 * @param {string} phrase - The micro-response text
 * @returns {Object} OpenAI response.create payload
 */
function createMicroResponsePayload(phrase) {
  return {
    type: "response.create",
    response: {
      modalities: ["audio", "text"],
      instructions: `Say exactly this, naturally and briefly: "${phrase}"`,
      max_output_tokens: 50
    }
  };
}

module.exports = {
  createBackchannelManager,
  selectMicroResponse,
  getRandomDelay,
  createMicroResponsePayload,
  MICRO_AUDIO_CACHE
};

