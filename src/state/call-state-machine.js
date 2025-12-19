/**
 * RSE Call State Machine
 * 
 * INTAKE-ONLY: Collects info and situation details. No scheduling.
 * States: greeting → intent → safety_check → name → phone → email → details_branch → address → availability → confirmation → close
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
  AVAILABILITY,
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
  
  // Collected caller data - REQUIRED FIELDS
  const data = {
    intent: null,           // hvac_service, generator, membership, existing_project, other
    isSafetyRisk: false,    // If emergency detected
    firstName: null,        // Required
    lastName: null,         // Required
    phone: null,            // Required
    email: null,            // Optional
    address: null,          // Required
    city: null,             // If provided
    zip: null,              // If provided
    availability: null,     // Required - availability window
    situationSummary: null, // One-line issue summary
    
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
        
      case STATES.AVAILABILITY:
        return AVAILABILITY.ask;
        
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
    return null;
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
   * Generate confirmation prompt with spelled-out fields
   */
  function getConfirmationPrompt() {
    const intro = confirmationAttempts > 0 
      ? CONFIRMATION.correction_reread 
      : CONFIRMATION.intro;
    
    // Build the read-back with spelling
    let parts = [intro];
    
    // First name spelled
    if (data.firstName) {
      parts.push(`First name, ${spellOut(data.firstName)}.`);
    }
    
    // Last name spelled
    if (data.lastName) {
      parts.push(`Last name, ${spellOut(data.lastName)}.`);
    }
    
    // Phone spelled digit by digit
    if (data.phone) {
      parts.push(`Phone number, ${spellPhoneNumber(data.phone)}.`);
    }
    
    // Email spelled
    if (data.email) {
      parts.push(`Email, ${spellEmail(data.email)}.`);
    }
    
    // Address
    if (data.address) {
      let addressPart = `Service address, ${data.address}`;
      if (data.city) addressPart += `, ${data.city}`;
      if (data.zip) addressPart += `, ${data.zip}`;
      parts.push(addressPart + '.');
    }
    
    // Availability
    if (data.availability) {
      parts.push(`Best availability, ${data.availability}.`);
    }
    
    // Issue summary
    parts.push(getIssueSummary());
    
    parts.push(CONFIRMATION.verify);
    
    return parts.join(' ');
  }
  
  /**
   * Spell out a word letter by letter with spaces
   */
  function spellOut(text) {
    if (!text) return '';
    return text.toUpperCase().split('').join(' ');
  }
  
  /**
   * Spell phone number digit by digit with grouping
   */
  function spellPhoneNumber(phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 10) {
      const area = digits.slice(-10, -7).split('').join(' ');
      const prefix = digits.slice(-7, -4).split('').join(' ');
      const line = digits.slice(-4).split('').join(' ');
      return `${area}, ${prefix}, ${line}`;
    }
    return digits.split('').join(' ');
  }
  
  /**
   * Spell email with "at" and "dot" wording
   */
  function spellEmail(email) {
    if (!email) return '';
    return email.toLowerCase()
      .replace(/@/g, ', at, ')
      .replace(/\./g, ', dot, ')
      .split('')
      .map(char => {
        if (char === ',' || char === ' ') return char;
        return char;
      })
      .join('')
      .replace(/([a-z0-9])/gi, '$1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  /**
   * Get one-line issue summary
   */
  function getIssueSummary() {
    // Store as situationSummary
    let summary = '';
    
    switch (data.intent) {
      case INTENT_TYPES.HVAC_SERVICE:
        const symptom = data.details.symptoms || 'HVAC issue';
        summary = `Calling about ${symptom}.`;
        break;
        
      case INTENT_TYPES.GENERATOR:
        if (data.details.generatorType === 'new') {
          summary = 'Looking for a new generator installation.';
        } else {
          summary = 'Generator service needed.';
        }
        break;
        
      case INTENT_TYPES.MEMBERSHIP:
        summary = 'Interested in maintenance membership.';
        break;
        
      case INTENT_TYPES.EXISTING_PROJECT:
        summary = 'Following up on an existing project.';
        break;
        
      default:
        summary = data.details.issueDescription || 'General inquiry.';
    }
    
    data.situationSummary = summary;
    return summary;
  }
  
  /**
   * Transition to next state
   */
  function transitionTo(newState) {
    const oldState = currentState;
    currentState = newState;
    console.log(`📍 State: ${oldState} → ${newState}`);
    
    if (newState === STATES.DETAILS_BRANCH) {
      detailsQuestionIndex = 0;
    }
    
    return newState;
  }
  
  /**
   * Process user input and determine next state
   */
  function processInput(transcript, analysis = {}) {
    const lowerTranscript = transcript.toLowerCase();
    
    switch (currentState) {
      case STATES.GREETING:
        return { 
          nextState: transitionTo(STATES.INTENT),
          prompt: null,
          action: 'classify_intent'
        };
        
      case STATES.INTENT:
        if (analysis.intent) {
          data.intent = analysis.intent;
          console.log(`📋 Intent: ${data.intent}`);
          
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
        
        return {
          nextState: currentState,
          prompt: INTENT_PROMPTS.unclear,
          action: 'ask'
        };
        
      case STATES.SAFETY_CHECK:
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
          const { firstName, lastName } = extractName(transcript);
          data.firstName = firstName;
          data.lastName = lastName;
          console.log(`📋 Name: ${data.firstName} ${data.lastName}`);
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
        
        return {
          nextState: transitionTo(STATES.ADDRESS),
          prompt: ADDRESS.ask,
          action: 'ask'
        };
        
      case STATES.ADDRESS:
        if (transcript.length > 2) {
          const addressParts = extractAddress(transcript);
          data.address = addressParts.address;
          data.city = addressParts.city;
          data.zip = addressParts.zip;
          console.log(`📋 Address: ${data.address}`);
          return {
            nextState: transitionTo(STATES.AVAILABILITY),
            prompt: AVAILABILITY.ask,
            action: 'ask'
          };
        }
        return {
          nextState: currentState,
          prompt: ADDRESS.ask,
          action: 'ask'
        };
        
      case STATES.AVAILABILITY:
        if (transcript.length > 2) {
          data.availability = extractAvailability(transcript);
          console.log(`📋 Availability: ${data.availability}`);
          return {
            nextState: transitionTo(STATES.CONFIRMATION),
            prompt: getConfirmationPrompt(),
            action: 'confirm'
          };
        }
        // If vague, ask follow-up
        if (isVagueAvailability(lowerTranscript)) {
          return {
            nextState: currentState,
            prompt: AVAILABILITY.clarify_time,
            action: 'ask'
          };
        }
        return {
          nextState: currentState,
          prompt: AVAILABILITY.ask,
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
    
    // Split into first and last name
    const parts = name.split(/\s+/);
    if (parts.length >= 2) {
      return {
        firstName: parts[0],
        lastName: parts.slice(1).join(' ')
      };
    }
    return {
      firstName: name,
      lastName: ''
    };
  }
  
  function hasPhoneNumber(text) {
    return /\d{3}.*\d{3}.*\d{4}/.test(text) || /\d{10}/.test(text.replace(/\D/g, ''));
  }
  
  function extractPhone(text) {
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
      'phone is fine', 'just phone', 'prefer not', 'rather not',
      'don\'t have one', 'no i don\'t'
    ];
    return declinePatterns.some(p => text.includes(p));
  }
  
  function extractEmail(text) {
    return text.replace(/\s+at\s+/gi, '@').replace(/\s+dot\s+/gi, '.').trim();
  }
  
  function extractAddress(text) {
    // Basic address extraction - look for zip and city patterns
    const zipMatch = text.match(/\b\d{5}(-\d{4})?\b/);
    const zip = zipMatch ? zipMatch[0] : null;
    
    // Very basic - in production would use a geocoding API
    return {
      address: text,
      city: null,  // Would need NLP to extract
      zip: zip
    };
  }
  
  function extractAvailability(text) {
    // Clean up and normalize availability
    return text
      .replace(/^(i'm available|i can do|works for me|best for me is)\s*/gi, '')
      .trim();
  }
  
  function isVagueAvailability(text) {
    const vaguePatterns = ['anytime', 'whenever', 'flexible', 'any day', 'any time'];
    return vaguePatterns.some(p => text.includes(p)) && 
           !text.includes('morning') && 
           !text.includes('afternoon') && 
           !text.includes('evening');
  }
  
  function storeDetailAnswer(text, analysis) {
    const questions = getDetailQuestions();
    const currentQuestion = questions[detailsQuestionIndex];
    
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
      'sounds good', 'looks good', 'perfect', 'all good', 'good',
      'that\'s correct', 'yes it is', 'yup'
    ];
    return confirmPatterns.some(p => text.includes(p));
  }
  
  function isCorrection(text) {
    const correctionPatterns = [
      'no', 'not quite', 'actually', 'wait', 'change', 'wrong',
      'incorrect', 'that\'s not', 'fix', 'update', 'correction',
      'let me correct', 'that\'s wrong'
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
    getState: () => currentState,
    getData: () => ({ ...data, details: { ...data.details } }),
    getNextPrompt,
    
    processInput,
    transitionTo,
    
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
    
    setSilenceAfterGreeting: () => { silenceAfterGreeting = true; },
    incrementConfirmationAttempts: () => { confirmationAttempts++; },
    getConfirmationPrompt,
    
    STATES,
    INTENT_TYPES
  };
}

module.exports = {
  createCallStateMachine,
  STATES,
  INTENT_TYPES
};
