/**
 * Backchannel / Micro-response Logic
 * 
 * When user stops speaking, start a short timer (150-250ms).
 * If OpenAI audio hasn't started streaming, play a micro-response.
 * Stop micro-response as soon as OpenAI audio begins.
 * 
 * ACKNOWLEDGEMENT VARIATION:
 * - Never use the same acknowledgement twice in a row
 * - Max one acknowledgement per user turn
 */

const { MICRO_RESPONSES, ACKNOWLEDGEMENTS } = require('../scripts/rse-script');
const { BACKCHANNEL_CONFIG } = require('../config/vad-config');

/**
 * Get a random delay between min and max
 */
function getRandomDelay() {
  const { min_delay_ms, max_delay_ms } = BACKCHANNEL_CONFIG;
  return Math.floor(Math.random() * (max_delay_ms - min_delay_ms + 1)) + min_delay_ms;
}

/**
 * Create an acknowledgement manager that prevents repetition
 */
function createAcknowledgementManager() {
  let lastUsed = null;
  let usedThisTurn = false;
  
  return {
    /**
     * Get next acknowledgement (never repeats last one)
     * @returns {string|null} An acknowledgement or null if already used this turn
     */
    getNext() {
      if (usedThisTurn) {
        return null; // Max one per turn
      }
      
      // Filter out the last used acknowledgement
      const available = ACKNOWLEDGEMENTS.filter(ack => ack !== lastUsed);
      
      // Pick random from available
      const selected = available[Math.floor(Math.random() * available.length)];
      
      lastUsed = selected;
      usedThisTurn = true;
      
      return selected;
    },
    
    /**
     * Reset for new turn (called when user starts speaking)
     */
    resetTurn() {
      usedThisTurn = false;
    },
    
    /**
     * Check if acknowledgement was already used this turn
     */
    wasUsedThisTurn() {
      return usedThisTurn;
    },
    
    /**
     * Get the last used acknowledgement (for logging/debugging)
     */
    getLastUsed() {
      return lastUsed;
    }
  };
}

/**
 * Select a micro-response based on context
 * @param {string} context - 'general', 'after_capture', or 'before_confirmation'
 * @param {string|null} lastUsed - Last used phrase to avoid repeating
 * @returns {string} A random micro-response phrase
 */
function selectMicroResponse(context = 'general', lastUsed = null) {
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
  
  // Filter out last used to prevent repetition
  const available = lastUsed ? pool.filter(r => r !== lastUsed) : pool;
  
  return available[Math.floor(Math.random() * available.length)] || pool[0];
}

/**
 * Create a backchannel manager for a call session
 * @returns {Object} Backchannel manager with start/stop/cancel methods
 */
function createBackchannelManager() {
  let timer = null;
  let isActive = false;
  let onTrigger = null;
  let lastMicroResponse = null;
  
  // Acknowledgement manager for variation
  const ackManager = createAcknowledgementManager();
  
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
          const response = selectMicroResponse(context, lastMicroResponse);
          lastMicroResponse = response;
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
    },
    
    /**
     * Get acknowledgement manager for this session
     */
    getAckManager() {
      return ackManager;
    },
    
    /**
     * Reset acknowledgement tracking for new user turn
     */
    resetTurn() {
      ackManager.resetTurn();
    }
  };
}

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
  createAcknowledgementManager,
  selectMicroResponse,
  getRandomDelay,
  createMicroResponsePayload
};
