/**
 * RSE Call State Machine
 * 
 * Deterministic state machine for call intake flow.
 * States: greeting → intent → safety_check → name → phone → email → details_branch → address → confirmation → close
 */

const { 
  STATES, 
  INTENT_TYPES,
  GREETING,
  INTENT_PROMPTS,
  SAFETY,
  CALLER_INFO,
  DETAILS,
  ADDRESS,
  CONFIRMATION,
  CLOSE,
  NEUTRAL
} = require('../scripts/rse-script');

/**
 * Create a new call state manager
 * @returns {Object} State manager with methods to get/set state and data
 */
function createCallStateMachine() {
  // Current state
  let currentState = STATES.GREETING;
  
  // Collected caller data
  const data = {
    intent: null,           // hvac_service, generator, membership, existing_project, other
    isSafetyRisk: false,    // If emergency detected
    name: null,
    phone: null,
    email: null,
    address: null,
    
    // Details based on intent
    details: {
      // HVAC service
      systemType: null,
      systemAge: null,
      symptoms: null,
      startTime: null,
      severity: null,
      
      // Generator
      generatorType: null,    // existing or new
      generatorIssue: null,
      propertyType: null,     // residential or commercial
      brandPreference: null,
      
      // Membership
      coverageType: null,     // monthly or yearly
      systemCount: null,
      
      // Existing project
      site: null,
      rseContact: null,
      helpNeeded: null,
      
      // Other
      issueDescription: null
    }
  };
  
  // Track which detail questions have been asked
  let detailsQuestionIndex = 0;
  let silenceAfterGreeting = false;
  let confirmationAttempts = 0;
  
  /**
   * Get the next prompt based on current state and data
   */
  function getNextPrompt() {
    switch (currentState) {
      case STATES.GREETING:
        return silenceAfterGreeting ? GREETING.silence_fallback : GREETING.primary;
        
      case STATES.INTENT:
        return getIntentPrompt();
        
      case STATES.SAFETY_CHECK:
        return SAFETY.check;
        
      case STATES.NAME:
        return CALLER_INFO.name;
        
      case STATES.PHONE:
        return CALLER_INFO.phone;
        
      case STATES.EMAIL:
        return CALLER_INFO.email.primary;
        
      case STATES.DETAILS_BRANCH:
        return getDetailsPrompt();
        
      case STATES.ADDRESS:
        return ADDRESS.ask;
        
      case STATES.CONFIRMATION:
        return getConfirmationPrompt();
        
      case STATES.CLOSE:
        return CLOSE.anything_else;
        
      case STATES.ENDED:
        return CLOSE.goodbye;
        
      default:
        return null;
    }
  }
  
  /**
   * Get intent classification prompt based on what we know
   */
  function getIntentPrompt() {
    // We don't know intent yet, need model to classify
    return INTENT_PROMPTS.unclear;
  }
  
  /**
   * Get the next detail question based on intent
   */
  function getDetailsPrompt() {
    const questions = getDetailQuestions();
    if (detailsQuestionIndex < questions.length) {
      return questions[detailsQuestionIndex];
    }
    return null; // Move to next state
  }
  
  /**
   * Get all detail questions for current intent
   */
  function getDetailQuestions() {
    switch (data.intent) {
      case INTENT_TYPES.HVAC_SERVICE:
        return [
          DETAILS.hvac_service.system_type,
          DETAILS.hvac_service.symptoms,
          DETAILS.hvac_service.start_time,
          DETAILS.hvac_service.severity
        ];
        
      case INTENT_TYPES.GENERATOR:
        if (data.details.generatorType === 'existing') {
          return [DETAILS.generator.existing_issue];
        } else if (data.details.generatorType === 'new') {
          return [
            DETAILS.generator.new_type,
            DETAILS.generator.new_brand
          ];
        }
        return [DETAILS.generator.existing_or_new];
        
      case INTENT_TYPES.MEMBERSHIP:
        return [
          DETAILS.membership.frequency,
          DETAILS.membership.systems
        ];
        
      case INTENT_TYPES.EXISTING_PROJECT:
        return [
          DETAILS.existing_project.site,
          DETAILS.existing_project.contact,
          DETAILS.existing_project.help
        ];
        
      case INTENT_TYPES.OTHER:
        return [DETAILS.other.clarify];
        
      default:
        return [];
    }
  }
  
  /**
   * Generate confirmation summary
   */
  function getConfirmationPrompt() {
    const intro = confirmationAttempts > 0 
      ? CONFIRMATION.updated 
      : CONFIRMATION.intro;
    
    let summary = `${intro} I have `;
    
    // Name
    if (data.name) {
      summary += `${data.name}`;
    }
    
    // Phone
    if (data.phone) {
      summary += `, phone number ${formatPhoneForSpeech(data.phone)}`;
    }
    
    // Email
    if (data.email) {
      summary += `, email ${data.email}`;
    }
    
    // Address
    if (data.address) {
      summary += `, at ${data.address}`;
    }
    
    // Intent/Issue summary
    summary += `. ${getIssueSummary()}`;
    
    summary += ` ${CONFIRMATION.verify}`;
    
    return summary;
  }
  
  /**
   * Format phone number for speech (spell out)
   */
  function formatPhoneForSpeech(phone) {
    // Just return as-is, the model will speak it naturally
    return phone;
  }
  
  /**
   * Get one-line issue summary
   */
  function getIssueSummary() {
    switch (data.intent) {
      case INTENT_TYPES.HVAC_SERVICE:
        const symptom = data.details.symptoms || 'HVAC issue';
        return `Calling about ${symptom}.`;
        
      case INTENT_TYPES.GENERATOR:
        if (data.details.generatorType === 'new') {
          return `Looking for a new generator installation.`;
        }
        return `Generator service needed.`;
        
      case INTENT_TYPES.MEMBERSHIP:
        return `Interested in maintenance membership.`;
        
      case INTENT_TYPES.EXISTING_PROJECT:
        return `Following up on an existing project.`;
        
      default:
        return `General inquiry.`;
    }
  }
  
  /**
   * Transition to next state
   */
  function transitionTo(newState) {
    const oldState = currentState;
    currentState = newState;
    console.log(`📍 State: ${oldState} → ${newState}`);
    
    // Reset detail question index when entering details branch
    if (newState === STATES.DETAILS_BRANCH) {
      detailsQuestionIndex = 0;
    }
    
    return newState;
  }
  
  /**
   * Process user input and determine next state
   * @param {string} transcript - User's spoken input
   * @param {Object} analysis - Optional model analysis of intent/entities
   * @returns {Object} { nextState, prompt, action }
   */
  function processInput(transcript, analysis = {}) {
    const lowerTranscript = transcript.toLowerCase();
    
    switch (currentState) {
      case STATES.GREETING:
        // Move to intent classification
        return { 
          nextState: transitionTo(STATES.INTENT),
          prompt: null, // Let model classify
          action: 'classify_intent'
        };
        
      case STATES.INTENT:
        // Intent should be classified by model
        if (analysis.intent) {
          data.intent = analysis.intent;
          console.log(`📋 Intent: ${data.intent}`);
          
          // Check if safety check needed
          if (needsSafetyCheck()) {
            return {
              nextState: transitionTo(STATES.SAFETY_CHECK),
              prompt: SAFETY.check,
              action: 'ask'
            };
          }
          
          return {
            nextState: transitionTo(STATES.NAME),
            prompt: CALLER_INFO.name,
            action: 'ask'
          };
        }
        
        // Need more info to classify
        return {
          nextState: currentState,
          prompt: INTENT_PROMPTS.unclear,
          action: 'ask'
        };
        
      case STATES.SAFETY_CHECK:
        // Check for safety concerns
        if (detectSafetyEmergency(lowerTranscript)) {
          data.isSafetyRisk = true;
          return {
            nextState: transitionTo(STATES.ENDED),
            prompt: SAFETY.emergency_response,
            action: 'end_call'
          };
        }
        
        return {
          nextState: transitionTo(STATES.NAME),
          prompt: `${SAFETY.all_clear} ${CALLER_INFO.name}`,
          action: 'ask'
        };
        
      case STATES.NAME:
        if (transcript.length > 0) {
          data.name = extractName(transcript);
          console.log(`📋 Name: ${data.name}`);
          return {
            nextState: transitionTo(STATES.PHONE),
            prompt: CALLER_INFO.phone,
            action: 'ask'
          };
        }
        return {
          nextState: currentState,
          prompt: CALLER_INFO.name,
          action: 'ask'
        };
        
      case STATES.PHONE:
        if (hasPhoneNumber(lowerTranscript)) {
          data.phone = extractPhone(transcript);
          console.log(`📋 Phone: ${data.phone}`);
          return {
            nextState: transitionTo(STATES.EMAIL),
            prompt: CALLER_INFO.email.primary,
            action: 'ask'
          };
        }
        return {
          nextState: currentState,
          prompt: CALLER_INFO.phone,
          action: 'ask'
        };
        
      case STATES.EMAIL:
        if (hasEmail(lowerTranscript) || isEmailDeclined(lowerTranscript)) {
          if (!isEmailDeclined(lowerTranscript)) {
            data.email = extractEmail(transcript);
            console.log(`📋 Email: ${data.email}`);
          } else {
            console.log(`📋 Email: declined`);
          }
          return {
            nextState: transitionTo(STATES.DETAILS_BRANCH),
            prompt: getDetailsPrompt(),
            action: 'ask'
          };
        }
        return {
          nextState: currentState,
          prompt: CALLER_INFO.email.primary,
          action: 'ask'
        };
        
      case STATES.DETAILS_BRANCH:
        // Store detail answer and move to next question or state
        storeDetailAnswer(transcript, analysis);
        detailsQuestionIndex++;
        
        const nextDetailPrompt = getDetailsPrompt();
        if (nextDetailPrompt) {
          return {
            nextState: currentState,
            prompt: nextDetailPrompt,
            action: 'ask'
          };
        }
        
        // Done with details, get address
        return {
          nextState: transitionTo(STATES.ADDRESS),
          prompt: ADDRESS.ask,
          action: 'ask'
        };
        
      case STATES.ADDRESS:
        if (transcript.length > 2) {
          data.address = transcript;
          console.log(`📋 Address: ${data.address}`);
          return {
            nextState: transitionTo(STATES.CONFIRMATION),
            prompt: getConfirmationPrompt(),
            action: 'confirm'
          };
        }
        return {
          nextState: currentState,
          prompt: ADDRESS.ask,
          action: 'ask'
        };
        
      case STATES.CONFIRMATION:
        if (isConfirmation(lowerTranscript)) {
          return {
            nextState: transitionTo(STATES.CLOSE),
            prompt: CLOSE.anything_else,
            action: 'ask'
          };
        }
        if (isCorrection(lowerTranscript)) {
          confirmationAttempts++;
          // Let model handle the correction
          return {
            nextState: currentState,
            prompt: null,
            action: 'handle_correction'
          };
        }
        return {
          nextState: currentState,
          prompt: CONFIRMATION.verify,
          action: 'ask'
        };
        
      case STATES.CLOSE:
        if (hasMoreQuestions(lowerTranscript)) {
          return {
            nextState: currentState,
            prompt: null,
            action: 'answer_question'
          };
        }
        return {
          nextState: transitionTo(STATES.ENDED),
          prompt: CLOSE.goodbye,
          action: 'end_call'
        };
        
      default:
        return {
          nextState: currentState,
          prompt: null,
          action: null
        };
    }
  }
  
  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================
  
  function needsSafetyCheck() {
    return data.intent === INTENT_TYPES.HVAC_SERVICE || 
           data.intent === INTENT_TYPES.GENERATOR;
  }
  
  function detectSafetyEmergency(text) {
    const emergencyKeywords = [
      'smoke', 'fire', 'gas smell', 'smells like gas', 'sparks', 
      'sparking', 'burning', 'flames', 'carbon monoxide', 'co detector',
      'total shutdown', 'completely out', 'emergency', 'dangerous'
    ];
    return emergencyKeywords.some(kw => text.includes(kw));
  }
  
  function extractName(text) {
    // Remove common prefixes
    let name = text
      .replace(/^(this is|i'm|i am|my name is|it's|hey|hi|hello|yeah|oh yeah)\s*/gi, '')
      .replace(/[.,!?]$/g, '')
      .trim();
    return name || text;
  }
  
  function hasPhoneNumber(text) {
    return /\d{3}.*\d{3}.*\d{4}/.test(text) || /\d{10}/.test(text.replace(/\D/g, ''));
  }
  
  function extractPhone(text) {
    // Extract digits
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 10) {
      const last10 = digits.slice(-10);
      return `${last10.slice(0,3)}-${last10.slice(3,6)}-${last10.slice(6)}`;
    }
    return text;
  }
  
  function hasEmail(text) {
    return text.includes('@') || /\bat\b/i.test(text);
  }
  
  function isEmailDeclined(text) {
    const declinePatterns = [
      'no email', 'don\'t have email', 'no thanks', 'skip', 
      'phone is fine', 'just phone', 'prefer not', 'rather not'
    ];
    return declinePatterns.some(p => text.includes(p));
  }
  
  function extractEmail(text) {
    // Normalize "at" to "@"
    return text.replace(/\s+at\s+/gi, '@').replace(/\s+dot\s+/gi, '.').trim();
  }
  
  function storeDetailAnswer(text, analysis) {
    const questions = getDetailQuestions();
    const currentQuestion = questions[detailsQuestionIndex];
    
    // Store based on which question was asked
    if (data.intent === INTENT_TYPES.HVAC_SERVICE) {
      if (currentQuestion === DETAILS.hvac_service.system_type) {
        data.details.systemType = text;
      } else if (currentQuestion === DETAILS.hvac_service.symptoms) {
        data.details.symptoms = text;
      } else if (currentQuestion === DETAILS.hvac_service.start_time) {
        data.details.startTime = text;
      } else if (currentQuestion === DETAILS.hvac_service.severity) {
        data.details.severity = text;
      }
    } else if (data.intent === INTENT_TYPES.GENERATOR) {
      if (currentQuestion === DETAILS.generator.existing_or_new) {
        data.details.generatorType = text.toLowerCase().includes('new') ? 'new' : 'existing';
      } else if (currentQuestion === DETAILS.generator.existing_issue) {
        data.details.generatorIssue = text;
      } else if (currentQuestion === DETAILS.generator.new_type) {
        data.details.propertyType = text;
      } else if (currentQuestion === DETAILS.generator.new_brand) {
        data.details.brandPreference = text;
      }
    } else if (data.intent === INTENT_TYPES.MEMBERSHIP) {
      if (currentQuestion === DETAILS.membership.frequency) {
        data.details.coverageType = text;
      } else if (currentQuestion === DETAILS.membership.systems) {
        data.details.systemCount = text;
      }
    } else if (data.intent === INTENT_TYPES.EXISTING_PROJECT) {
      if (currentQuestion === DETAILS.existing_project.site) {
        data.details.site = text;
      } else if (currentQuestion === DETAILS.existing_project.contact) {
        data.details.rseContact = text;
      } else if (currentQuestion === DETAILS.existing_project.help) {
        data.details.helpNeeded = text;
      }
    } else {
      data.details.issueDescription = text;
    }
    
    console.log(`📋 Detail stored: ${text.substring(0, 50)}...`);
  }
  
  function isConfirmation(text) {
    const confirmPatterns = [
      'yes', 'yep', 'yeah', 'correct', 'right', 'that\'s right', 
      'sounds good', 'looks good', 'perfect', 'all good', 'good'
    ];
    return confirmPatterns.some(p => text.includes(p));
  }
  
  function isCorrection(text) {
    const correctionPatterns = [
      'no', 'not quite', 'actually', 'wait', 'change', 'wrong',
      'incorrect', 'that\'s not', 'fix', 'update', 'correction'
    ];
    return correctionPatterns.some(p => text.includes(p));
  }
  
  function hasMoreQuestions(text) {
    const questionPatterns = [
      'question', 'actually', 'what about', 'how about', 'can you',
      'one more', 'also', 'wait', 'before you go', 'hold on'
    ];
    return questionPatterns.some(p => text.includes(p)) || 
           text.includes('?') ||
           (text.includes('yes') && text.length > 10);
  }
  
  // ============================================================================
  // PUBLIC API
  // ============================================================================
  
  return {
    // State getters
    getState: () => currentState,
    getData: () => ({ ...data }),
    getNextPrompt,
    
    // State transitions
    processInput,
    transitionTo,
    
    // Data setters
    setIntent: (intent) => { 
      data.intent = intent; 
      console.log(`📋 Intent set: ${intent}`);
    },
    updateData: (key, value) => {
      if (data.hasOwnProperty(key)) {
        data[key] = value;
        console.log(`📋 ${key}: ${value}`);
      }
    },
    updateDetail: (key, value) => {
      data.details[key] = value;
      console.log(`📋 Detail ${key}: ${value}`);
    },
    
    // Flags
    setSilenceAfterGreeting: () => { silenceAfterGreeting = true; },
    incrementConfirmationAttempts: () => { confirmationAttempts++; },
    
    // Constants for external use
    STATES,
    INTENT_TYPES
  };
}

module.exports = {
  createCallStateMachine,
  STATES,
  INTENT_TYPES
};

