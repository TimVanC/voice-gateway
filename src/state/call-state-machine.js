/**
 * RSE Call State Machine
 * 
 * INTAKE-ONLY: Collects info and situation details. No scheduling.
 * States: greeting → intent → safety_check → name → phone → email → details_branch → address → availability → confirmation → close
 * 
 * CONFIDENCE-BASED CLARIFICATION:
 * - High confidence: Accept silently
 * - Medium confidence: Confirm explicitly
 * - Low confidence: Ask to repeat or spell
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
  OUT_OF_SCOPE,
  NEUTRAL,
  ALLOWED_SERVICES,
  DISALLOWED_SERVICES
} = require('../scripts/rse-script');

const {
  CONFIDENCE,
  estimateFirstNameConfidence,
  estimateLastNameConfidence,
  estimatePhoneConfidence,
  estimateEmailConfidence,
  estimateAddressConfidence,
  estimateCityConfidence,
  estimateZipConfidence,
  getClarificationPrompt,
  cleanTranscript
} = require('../utils/confidence-estimator');

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
  
  // Confidence-based clarification tracking
  let pendingClarification = {
    field: null,           // Which field needs clarification
    value: null,           // The value we heard
    confidence: null,      // Confidence result
    awaitingConfirmation: false  // Are we waiting for yes/no?
  };
  
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
        
      case INTENT_TYPES.HVAC_INSTALLATION:
        return [
          DETAILS.hvac_installation.project_type,
          DETAILS.hvac_installation.system_type,
          DETAILS.hvac_installation.property_type
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
        
      case INTENT_TYPES.OUT_OF_SCOPE:
        // No detail questions for out-of-scope - will be handled specially
        return [];
        
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
        
      case INTENT_TYPES.HVAC_INSTALLATION:
        const projectType = data.details.projectType || 'HVAC installation';
        summary = `Looking for ${projectType}.`;
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
        
      case INTENT_TYPES.OUT_OF_SCOPE:
        summary = 'Out-of-scope request.';
        break;
        
      default:
        summary = 'General inquiry.';
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
        // If intent was detected from the greeting, lock it immediately
        if (analysis.intent) {
          data.intent = analysis.intent;
          console.log(`📋 Intent LOCKED from greeting: ${data.intent}`);
          
          // Handle out-of-scope immediately
          if (data.intent === INTENT_TYPES.OUT_OF_SCOPE) {
            console.log(`⚠️ Out-of-scope request detected`);
            return {
              nextState: transitionTo(STATES.CLOSE),
              prompt: OUT_OF_SCOPE.general,
              action: 'redirect_out_of_scope'
            };
          }
          
          // Advance directly to next state based on intent
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
        
        // No intent detected - go to INTENT state to ask
        return { 
          nextState: transitionTo(STATES.INTENT),
          prompt: null,
          action: 'classify_intent'
        };
        
      case STATES.INTENT:
        // GUARDRAIL: If intent is already locked, advance immediately
        if (data.intent) {
          console.log(`📋 Intent already locked: ${data.intent} - advancing`);
          
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
        
        // Try to classify intent from this turn
        if (analysis.intent) {
          data.intent = analysis.intent;
          console.log(`📋 Intent LOCKED: ${data.intent}`);
          
          // Handle out-of-scope requests (solar, electrical, plumbing, etc.)
          if (data.intent === INTENT_TYPES.OUT_OF_SCOPE) {
            console.log(`⚠️ Out-of-scope request detected`);
            return {
              nextState: transitionTo(STATES.CLOSE),
              prompt: OUT_OF_SCOPE.general,
              action: 'redirect_out_of_scope'
            };
          }
          
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
        
        // No intent detected yet - ask for clarification
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
        // Handle clarification confirmation
        if (pendingClarification.field === 'name' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            // User confirmed - accept the value
            data.firstName = pendingClarification.value.firstName;
            data.lastName = pendingClarification.value.lastName;
            console.log(`✅ Name confirmed: ${data.firstName} ${data.lastName}`);
            clearPendingClarification();
            return {
              nextState: transitionTo(STATES.PHONE),
              prompt: CALLER_INFO.phone,
              action: 'ask'
            };
          } else {
            // User said no or gave new name - treat as new input
            clearPendingClarification();
          }
        }
        
        // Check if caller is confused or asking for clarification (NOT a name)
        if (isConfusedOrAsking(lowerTranscript)) {
          console.log(`📋 Caller confused/asking - not a name: "${transcript}"`);
          return {
            nextState: currentState,
            prompt: CALLER_INFO.name,
            action: 'ask'
          };
        }
        
        // Check for backtracking request
        if (isBacktrackRequest(lowerTranscript)) {
          console.log(`📋 Backtrack request detected`);
          return handleBacktrackRequest(transcript);
        }
        
        if (transcript.length > 0) {
          const { firstName, lastName } = extractName(transcript);
          
          // Check if this looks like a name at all
          if (!looksLikeName(firstName)) {
            console.log(`📋 Doesn't look like a name: "${firstName}"`);
            return {
              nextState: currentState,
              prompt: CALLER_INFO.name,
              action: 'ask'
            };
          }
          
          // Check confidence for first name
          const firstNameConf = estimateFirstNameConfidence(firstName || transcript);
          const lastNameConf = lastName ? estimateLastNameConfidence(lastName) : { level: CONFIDENCE.HIGH };
          
          // Use the lower confidence level
          const overallConf = getLowestConfidence(firstNameConf, lastNameConf);
          
          console.log(`📋 Name: ${firstName} ${lastName} (confidence: ${overallConf.level})`);
          
          if (overallConf.level === CONFIDENCE.LOW) {
            // Ask to repeat
            return {
              nextState: currentState,
              prompt: "I didn't catch that clearly. Could you repeat your first and last name?",
              action: 'ask'
            };
          } else if (overallConf.level === CONFIDENCE.MEDIUM || (lastName && lastName.length > 8)) {
            // Store pending and ask for confirmation
            pendingClarification = {
              field: 'name',
              value: { firstName, lastName },
              confidence: overallConf,
              awaitingConfirmation: true
            };
            return {
              nextState: currentState,
              prompt: `I heard ${firstName} ${lastName}. Is that correct?`,
              action: 'ask'
            };
          }
          
          // High confidence - accept silently
          data.firstName = firstName;
          data.lastName = lastName;
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
        // Handle clarification confirmation
        if (pendingClarification.field === 'phone' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            data.phone = pendingClarification.value;
            console.log(`✅ Phone confirmed: ${data.phone}`);
            clearPendingClarification();
            return {
              nextState: transitionTo(STATES.EMAIL),
              prompt: CALLER_INFO.email.primary,
              action: 'ask'
            };
          } else {
            clearPendingClarification();
          }
        }
        
        // Check if caller is confused or asking for clarification
        if (isConfusedOrAsking(lowerTranscript)) {
          console.log(`📋 Caller confused/asking: "${transcript}"`);
          return {
            nextState: currentState,
            prompt: CALLER_INFO.phone,
            action: 'ask'
          };
        }
        
        // Check for backtracking request
        if (isBacktrackRequest(lowerTranscript)) {
          console.log(`📋 Backtrack request detected`);
          return handleBacktrackRequest(transcript);
        }
        
        if (hasPhoneNumber(lowerTranscript)) {
          const phone = extractPhone(transcript);
          const phoneConf = estimatePhoneConfidence(transcript);
          
          console.log(`📋 Phone: ${phone} (confidence: ${phoneConf.level})`);
          
          if (phoneConf.level === CONFIDENCE.LOW) {
            return {
              nextState: currentState,
              prompt: "I may have missed a digit. Could you repeat the phone number slowly?",
              action: 'ask'
            };
          } else if (phoneConf.level === CONFIDENCE.MEDIUM) {
            // Always read back phone numbers for confirmation
            const formatted = formatPhoneForConfirmation(phone);
            pendingClarification = {
              field: 'phone',
              value: phone,
              confidence: phoneConf,
              awaitingConfirmation: true
            };
            return {
              nextState: currentState,
              prompt: `I have ${formatted}. Is that correct?`,
              action: 'ask'
            };
          }
          
          // High confidence - still read back phone for verification
          const formatted = formatPhoneForConfirmation(phone);
          data.phone = phone;
          return {
            nextState: transitionTo(STATES.EMAIL),
            prompt: `Got it, ${formatted}. ${CALLER_INFO.email.primary}`,
            action: 'ask'
          };
        }
        return {
          nextState: currentState,
          prompt: CALLER_INFO.phone,
          action: 'ask'
        };
        
      case STATES.EMAIL:
        // Handle clarification confirmation
        if (pendingClarification.field === 'email' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            data.email = pendingClarification.value;
            console.log(`✅ Email confirmed: ${data.email}`);
            clearPendingClarification();
            return {
              nextState: transitionTo(STATES.DETAILS_BRANCH),
              prompt: getDetailsPrompt(),
              action: 'ask'
            };
          } else {
            clearPendingClarification();
            // Ask them to spell it
            return {
              nextState: currentState,
              prompt: "Could you spell out the email address for me?",
              action: 'ask'
            };
          }
        }
        
        if (hasEmail(lowerTranscript) || isEmailDeclined(lowerTranscript)) {
          if (isEmailDeclined(lowerTranscript)) {
            console.log(`📋 Email: declined`);
            return {
              nextState: transitionTo(STATES.DETAILS_BRANCH),
              prompt: getDetailsPrompt(),
              action: 'ask'
            };
          }
          
          const email = extractEmail(transcript);
          const emailConf = estimateEmailConfidence(transcript);
          
          console.log(`📋 Email: ${email} (confidence: ${emailConf.level})`);
          
          if (emailConf.level === CONFIDENCE.LOW) {
            return {
              nextState: currentState,
              prompt: "Could you spell out the email address for me?",
              action: 'ask'
            };
          } else if (emailConf.level === CONFIDENCE.MEDIUM) {
            const formatted = formatEmailForConfirmation(email);
            pendingClarification = {
              field: 'email',
              value: email,
              confidence: emailConf,
              awaitingConfirmation: true
            };
            return {
              nextState: currentState,
              prompt: `I have ${formatted}. Is that right?`,
              action: 'ask'
            };
          }
          
          // High confidence
          data.email = email;
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
        // Handle clarification confirmation
        if (pendingClarification.field === 'address' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            data.address = pendingClarification.value.address;
            data.city = pendingClarification.value.city;
            data.zip = pendingClarification.value.zip;
            console.log(`✅ Address confirmed: ${data.address}`);
            clearPendingClarification();
            return {
              nextState: transitionTo(STATES.AVAILABILITY),
              prompt: AVAILABILITY.ask,
              action: 'ask'
            };
          } else {
            clearPendingClarification();
          }
        }
        
        if (transcript.length > 2) {
          const addressParts = extractAddress(transcript);
          
          // Check confidence for each part
          const addressConf = estimateAddressConfidence(addressParts.address || transcript);
          const cityConf = addressParts.city ? estimateCityConfidence(addressParts.city) : { level: CONFIDENCE.HIGH };
          const zipConf = addressParts.zip ? estimateZipConfidence(addressParts.zip) : { level: CONFIDENCE.HIGH };
          
          const overallConf = getLowestConfidence(addressConf, cityConf, zipConf);
          
          console.log(`📋 Address: ${addressParts.address} (confidence: ${overallConf.level})`);
          
          if (overallConf.level === CONFIDENCE.LOW) {
            // Determine which part needs clarification
            if (zipConf.level === CONFIDENCE.LOW) {
              return {
                nextState: currentState,
                prompt: "Could you repeat the zip code?",
                action: 'ask'
              };
            }
            return {
              nextState: currentState,
              prompt: "I didn't catch that clearly. Could you repeat the street address?",
              action: 'ask'
            };
          } else if (overallConf.level === CONFIDENCE.MEDIUM) {
            pendingClarification = {
              field: 'address',
              value: addressParts,
              confidence: overallConf,
              awaitingConfirmation: true
            };
            let confirmPrompt = `I heard ${addressParts.address}`;
            if (addressParts.city) confirmPrompt += `, ${addressParts.city}`;
            if (addressParts.zip) confirmPrompt += `, ${addressParts.zip}`;
            confirmPrompt += `. Is that correct?`;
            return {
              nextState: currentState,
              prompt: confirmPrompt,
              action: 'ask'
            };
          }
          
          // High confidence
          data.address = addressParts.address;
          data.city = addressParts.city;
          data.zip = addressParts.zip;
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
    // Only service calls need safety check, NOT installations
    // Installations are for new equipment, not emergencies
    return data.intent === INTENT_TYPES.HVAC_SERVICE || 
           (data.intent === INTENT_TYPES.GENERATOR && !isGeneratorInstallation());
  }
  
  /**
   * Detect if caller is confused or asking for clarification (NOT giving their name)
   */
  function isConfusedOrAsking(text) {
    const confusedPatterns = [
      'excuse me', 'pardon', 'pardon me', 'what', 'huh', 'sorry',
      'what did you say', 'can you repeat', 'didn\'t catch', 'didn\'t hear',
      'come again', 'say that again', 'one more time', 'i missed that',
      'what was that', 'sorry what', 'excuse me what'
    ];
    return confusedPatterns.some(p => text.includes(p));
  }
  
  /**
   * Detect if caller wants to go back/backtrack
   */
  function isBacktrackRequest(text) {
    const backtrackPatterns = [
      'go back', 'wait', 'hold on', 'before that', 'previous question',
      'what did you ask', 'asked before', 'earlier question',
      'back up', 'start over', 'go back to'
    ];
    return backtrackPatterns.some(p => text.includes(p));
  }
  
  /**
   * Handle a backtrack request - explain what was asked and where we are
   */
  function handleBacktrackRequest(transcript) {
    // Explain the previous question based on current state
    let explanation = '';
    switch (currentState) {
      case STATES.NAME:
        explanation = "I just asked for your first and last name. What's your name?";
        break;
      case STATES.PHONE:
        explanation = "I was asking for the best phone number to reach you.";
        break;
      case STATES.EMAIL:
        explanation = "I was asking for your email address.";
        break;
      case STATES.DETAILS_BRANCH:
        explanation = "I was asking about the details of your issue.";
        break;
      case STATES.ADDRESS:
        explanation = "I was asking for the service address.";
        break;
      case STATES.AVAILABILITY:
        explanation = "I was asking about your availability.";
        break;
      default:
        explanation = "Let me help you. Can I get your first and last name?";
    }
    
    return {
      nextState: currentState,
      prompt: explanation,
      action: 'ask'
    };
  }
  
  /**
   * Check if text looks like an actual name (not a phrase/question/number)
   */
  function looksLikeName(text) {
    if (!text || text.length < 2) return false;
    
    const lowerText = text.toLowerCase().trim();
    
    // Reject if it's just punctuation or empty
    if (/^[,.\s!?]+$/.test(text)) return false;
    
    // Reject if it contains numbers (likely a phone, address, etc.)
    if (/\d{3,}/.test(text)) return false;
    
    // Reject if it looks like an address (has street indicators)
    if (/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd)\b/i.test(text)) return false;
    
    // Reject if it looks like a time/duration
    if (/\b(year|years|month|months|week|weeks|day|days|hour|hours|minute|minutes|second|seconds|ago|old)\b/i.test(text)) return false;
    
    // Things that are definitely NOT names
    const notNames = [
      'excuse', 'pardon', 'what', 'huh', 'wait', 'hold', 'sorry',
      'um', 'uh', 'hmm', 'okay', 'ok', 'yeah', 'yes', 'no', 'nope',
      'hello', 'hi', 'hey', 'bye', 'thanks', 'thank you',
      'the', 'this', 'that', 'is', 'are', 'was', 'were',
      'go', 'back', 'before', 'after', 'question', 'asked',
      'can', 'could', 'would', 'should', 'did', 'do', 'don\'t',
      'i', 'you', 'me', 'my', 'your', 'it', 'would', 'be', 'it\'s',
      'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'
    ];
    
    // Check if it's just one of these words
    if (notNames.includes(lowerText)) return false;
    
    // Check if it starts with one of these words (likely a phrase, not a name)
    const phraseStarters = ['excuse', 'what', 'wait', 'hold', 'can', 'could', 'did', 'go', 'sorry', 
                            'it would', 'that would', 'three', 'four', 'about', 'around', 'maybe',
                            'i think', 'i don\'t', 'i\'m not', 'no i', 'yes i'];
    for (const phrase of phraseStarters) {
      if (lowerText.startsWith(phrase + ' ') || lowerText === phrase) return false;
    }
    
    // Check if it's a question (ends with ?)
    if (text.endsWith('?')) return false;
    
    // Names usually start with uppercase and are relatively short
    // Reject very long phrases (likely not a name)
    if (text.length > 30) return false;
    
    return true;
  }
  
  function isGeneratorInstallation() {
    // Check if the generator intent is for installation (not service)
    const d = data.details;
    return d && d.generatorType === 'new';
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
    // Remove common prefixes and their punctuation variations
    let name = text
      // Remove leading filler words with optional punctuation
      .replace(/^(yeah,?\s*|yes,?\s*|oh,?\s*|um,?\s*|uh,?\s*|so,?\s*|well,?\s*)+/gi, '')
      // Remove "it's", "this is", "my name is", etc.
      .replace(/^(it's|it is|this is|i'm|i am|my name is|the name is|name's)\s*/gi, '')
      // Remove trailing punctuation
      .replace(/[.,!?]+$/g, '')
      // Remove leading/trailing punctuation and whitespace
      .replace(/^[,.\s]+|[,.\s]+$/g, '')
      .trim();
    
    // If we stripped everything, return empty
    if (!name || name.length < 2) {
      return { firstName: '', lastName: '' };
    }
    
    // Split into first and last name
    const parts = name.split(/\s+/).filter(p => p.length > 0);
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
  
  // ============================================================================
  // CONFIDENCE HELPERS
  // ============================================================================
  
  function clearPendingClarification() {
    pendingClarification = {
      field: null,
      value: null,
      confidence: null,
      awaitingConfirmation: false
    };
  }
  
  function getLowestConfidence(...confidences) {
    const levels = { low: 0, medium: 1, high: 2 };
    let lowest = { level: CONFIDENCE.HIGH };
    
    for (const conf of confidences) {
      if (conf && levels[conf.level] < levels[lowest.level]) {
        lowest = conf;
      }
    }
    return lowest;
  }
  
  function formatPhoneForConfirmation(phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 10) {
      const last10 = digits.slice(-10);
      return `${last10.slice(0,3)}, ${last10.slice(3,6)}, ${last10.slice(6)}`;
    }
    return phone;
  }
  
  function formatEmailForConfirmation(email) {
    return email
      .replace(/@/g, ' at ')
      .replace(/\./g, ' dot ');
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
    } else if (data.intent === INTENT_TYPES.HVAC_INSTALLATION) {
      if (currentQuestion === DETAILS.hvac_installation.project_type) {
        data.details.projectType = text;
      } else if (currentQuestion === DETAILS.hvac_installation.system_type) {
        data.details.systemType = text;
      } else if (currentQuestion === DETAILS.hvac_installation.property_type) {
        data.details.propertyType = text;
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
