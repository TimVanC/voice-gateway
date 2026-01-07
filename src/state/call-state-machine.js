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
        
        // Check if user gave an address instead of a name (cross-state detection)
        const addressParts = extractAddress(transcript);
        if (addressParts.zip || (addressParts.address && /\b(road|rd|street|st|avenue|ave|drive|dr|lane|ln|way|court|ct|boulevard|blvd)\b/i.test(addressParts.address))) {
          console.log(`📋 Address detected in NAME state: ${addressParts.address}`);
          // Store address and move to phone (skip name for now, will come back)
          data.address = addressParts.address;
          data.city = addressParts.city;
          data.state = addressParts.state;
          data.zip = addressParts.zip;
          return {
            nextState: transitionTo(STATES.PHONE),
            prompt: "Got the address. What's the best phone number to reach you?",
            action: 'ask'
          };
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
          } else if (isCorrection(lowerTranscript)) {
            // User said it's wrong - check if they're giving a letter correction
            const letterCorrectionMatch = lowerTranscript.match(/\bit'?s\s+(?:the\s+)?letter\s+([a-z])\b/i);
            if (letterCorrectionMatch && data.email) {
              const correctLetter = letterCorrectionMatch[1].toLowerCase();
              // Try to fix the email - look for common misheard letters at the end
              let correctedEmail = data.email;
              const localPart = correctedEmail.split('@')[0];
              const domain = correctedEmail.split('@')[1];
              
              // If user says "it's the letter C", replace last letter(s) with C
              // Common: "si" -> "c", "see" -> "c", etc.
              if (localPart.endsWith('si') || localPart.endsWith('see') || localPart.endsWith('sea')) {
                correctedEmail = localPart.slice(0, -2) + correctLetter + '@' + domain;
              } else if (localPart.endsWith('i') || localPart.endsWith('y') || localPart.endsWith('e')) {
                correctedEmail = localPart.slice(0, -1) + correctLetter + '@' + domain;
              } else {
                // Just append or replace last character
                correctedEmail = localPart.slice(0, -1) + correctLetter + '@' + domain;
              }
              
              data.email = correctedEmail;
              pendingClarification.value = correctedEmail;
              const formatted = formatEmailForConfirmation(correctedEmail);
              return {
                nextState: currentState,
                prompt: `Got it. So the email is ${formatted}. Is that correct?`,
                action: 'ask'
              };
            }
            
            clearPendingClarification();
            // Ask them to spell it
            return {
              nextState: currentState,
              prompt: "Could you spell out the email address for me?",
              action: 'ask'
            };
          } else {
            // Not a clear yes/no - might be new email input
            clearPendingClarification();
          }
        }
        
        // IMPORTANT: If user confirms and we already have an email, move on
        if (data.email && isConfirmation(lowerTranscript)) {
          console.log(`✅ Email already confirmed: ${data.email} - advancing`);
          return {
            nextState: transitionTo(STATES.DETAILS_BRANCH),
            prompt: getDetailsPrompt(),
            action: 'ask'
          };
        }
        
        // Handle "we already did that" / "you already have it" type responses
        if (data.email && isAlreadyProvidedResponse(lowerTranscript)) {
          console.log(`✅ Email already provided: ${data.email} - advancing`);
          return {
            nextState: transitionTo(STATES.DETAILS_BRANCH),
            prompt: getDetailsPrompt(),
            action: 'ask'
          };
        }
        
        // Handle "what email do you have?" - read back the stored email
        if (data.email && isAskingForReadback(lowerTranscript)) {
          const formatted = formatEmailForConfirmation(data.email);
          console.log(`📋 Reading back stored email: ${data.email}`);
          return {
            nextState: currentState,
            prompt: `I have ${formatted}. Is that correct?`,
            action: 'ask'
          };
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
          
          // Check for spelling instructions (e.g., "with two m's")
          const hasSpellingInstruction = /\b(with\s+)?(two|2|double)\s+[a-z]'?s?\b/i.test(transcript);
          
          const email = extractEmail(transcript);
          
          // If email extraction failed, ask to spell it
          if (!email || !email.includes('@')) {
            return {
              nextState: currentState,
              prompt: "I'm having trouble catching that. Could you spell out the email address for me?",
              action: 'ask'
            };
          }
          
          const emailConf = estimateEmailConfidence(email);
          
          console.log(`📋 Email: ${email} (confidence: ${emailConf.level})`);
          
          // If spelling instruction detected, always confirm with spelling
          if (hasSpellingInstruction) {
            const formatted = formatEmailForConfirmation(email);
            data.email = email;
            pendingClarification = {
              field: 'email',
              value: email,
              confidence: { level: CONFIDENCE.MEDIUM },
              awaitingConfirmation: true
            };
            // Spell it out letter by letter for confirmation
            const localPart = email.split('@')[0];
            const spelledOut = localPart.split('').join('-').toUpperCase();
            const domain = email.split('@')[1];
            return {
              nextState: currentState,
              prompt: `I have ${formatted}. Just to confirm, that's spelled ${spelledOut} at ${domain}. Is that correct?`,
              action: 'ask'
            };
          }
          
          if (emailConf.level === CONFIDENCE.LOW) {
            return {
              nextState: currentState,
              prompt: "Could you spell out the email address for me?",
              action: 'ask'
            };
          } else if (emailConf.level === CONFIDENCE.MEDIUM) {
            const formatted = formatEmailForConfirmation(email);
            // Store email now so confirmation will work even if AI goes off-script
            data.email = email;
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
            if (zipConf.level === CONFIDENCE.LOW && addressParts.zip) {
              return {
                nextState: currentState,
                prompt: "Could you repeat the zip code slowly?",
                action: 'ask'
              };
            }
            if (!addressParts.city && addressConf.level === CONFIDENCE.LOW) {
              return {
                nextState: currentState,
                prompt: "I didn't catch the city clearly. Could you repeat the city name?",
                action: 'ask'
              };
            }
            if (addressConf.level === CONFIDENCE.LOW) {
              // Check if we have street name indicators
              const hasStreetName = /\b(road|rd|street|st|avenue|ave|drive|dr|lane|ln|way|court|ct|boulevard|blvd)\b/i.test(addressParts.address);
              if (hasStreetName) {
                return {
                  nextState: currentState,
                  prompt: "I want to make sure I have the street name right. Could you spell the street name for me?",
                  action: 'ask'
                };
              }
              return {
                nextState: currentState,
                prompt: "I didn't catch that clearly. Could you repeat the street address, including the house number and street name?",
                action: 'ask'
              };
            }
          } else if (overallConf.level === CONFIDENCE.MEDIUM) {
            // For medium confidence, ask for clarification on specific parts
            let clarificationNeeded = [];
            
            if (addressConf.level === CONFIDENCE.MEDIUM) {
              const hasStreetName = /\b(road|rd|street|st|avenue|ave|drive|dr|lane|ln|way|court|ct|boulevard|blvd)\b/i.test(addressParts.address);
              if (hasStreetName) {
                clarificationNeeded.push('street name');
              } else {
                clarificationNeeded.push('street address');
              }
            }
            if (!addressParts.city || (cityConf && cityConf.level === CONFIDENCE.MEDIUM)) {
              clarificationNeeded.push('city');
            }
            if (zipConf.level === CONFIDENCE.MEDIUM) {
              clarificationNeeded.push('zip code');
            }
            
            // If we need clarification on specific parts, ask for them
            if (clarificationNeeded.length > 0) {
              if (clarificationNeeded.includes('street name')) {
                return {
                  nextState: currentState,
                  prompt: "I want to make sure I have the street name right. Could you spell the street name for me?",
                  action: 'ask'
                };
              }
              if (clarificationNeeded.includes('city')) {
                return {
                  nextState: currentState,
                  prompt: "Could you repeat the city name?",
                  action: 'ask'
                };
              }
            }
            
            // Otherwise, confirm what we heard
            pendingClarification = {
              field: 'address',
              value: addressParts,
              confidence: overallConf,
              awaitingConfirmation: true
            };
            let confirmPrompt = `I heard ${addressParts.address}`;
            if (addressParts.city) confirmPrompt += `, ${addressParts.city}`;
            if (addressParts.state) confirmPrompt += `, ${addressParts.state}`;
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
          data.state = addressParts.state;
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
    
    // Reject if it contains symptom/problem descriptions
    const symptomPatterns = [
      /\b(blowing|heating|cooling|not working|broken|issue|problem|symptom|error|fault)\b/i,
      /\b(lukewarm|warm|cold|hot|air|unit|system|hvac|furnace|boiler)\b/i,
      /\b(just|only|really|very|quite|pretty)\s+(blowing|heating|cooling|working)/i,
      /\b(pushing|pushing out|blowing out)\s+(lukewarm|warm|cold|hot|air)/i,
      /\b(only|just)\s+(pushing|blowing)/i,
      /\bthat'?s\s+it\b/i  // "that's it" at the end is usually not a name
    ];
    
    if (symptomPatterns.some(pattern => pattern.test(text))) {
      return false;
    }
    
    // Reject if it contains "only" or "just" followed by action words (symptom descriptions)
    if (/\b(only|just)\s+\w+\s+(out|air|working|heating|cooling)/i.test(text)) {
      return false;
    }
    
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
      // Remove "that would be", "it's", "this is", "my name is", etc.
      .replace(/^(that\s+would\s+be|it'?s|it\s+is|this\s+is|i'?m|i\s+am|my\s+name\s+is|the\s+name\s+is|name'?s)\s*/gi, '')
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
    // First, extract spelling instructions BEFORE processing the email
    const spellingInstructions = [];
    const twoMsPattern = /\b(with\s+)?(two|2)\s+m'?s?\b/i;
    const doubleMPattern = /\b(double|two)\s+m\b/i;
    
    if (twoMsPattern.test(text) || doubleMPattern.test(text)) {
      spellingInstructions.push({ letter: 'm', count: 2 });
    }
    
    // Extract other spelling patterns
    const letterCountPattern = /\b(with\s+)?(two|2|double)\s+([a-z])'?s?\b/gi;
    let match;
    while ((match = letterCountPattern.exec(text)) !== null) {
      const letter = match[3].toLowerCase();
      if (!spellingInstructions.some(inst => inst.letter === letter)) {
        spellingInstructions.push({ letter, count: 2 });
      }
    }
    
    // Remove common prefixes and extract email portion
    // Handle "that would be", "yeah that would be", etc. - be aggressive about removing these
    let email = text
      .replace(/^(yeah\s*,?\s*)?(so\s+the\s+|that\s+would\s+be|that's|it's|it\s+is|my\s+email\s+is|email\s+is|you\s+can\s+reach\s+me\s+at|reach\s+me\s+at|the\s+email\s+is)\s*/gi, '')
      .trim();
    
    // Remove spelling instructions and trailing clarifications
    email = email
      .replace(/\b(with\s+)?(two|2|double)\s+[a-z]'?s?\b/gi, '')
      .replace(/\band\s+that'?s\s+[^.]*$/i, '')  // Remove "and that's Tim with two M's" type endings
      .replace(/\b(and\s+)?(that'?s|it'?s)\s+[^.]*$/i, '')  // Remove trailing "and that's..." phrases
      .trim();
    
    // Extract just the email part (look for name pattern + "at" + domain)
    // Pattern: "TimVanC at gmail.com" or "timvanc at gmail dot com" or "timvansi at gmail.com"
    // Make sure we don't match "would be" as part of the email - look for actual email patterns
    const emailMatch = email.match(/([a-z0-9]+(?:\s*[a-z0-9]+)*?)\s+(?:at|@)\s+([a-z0-9\s]+(?:\s+dot\s+[a-z]+)+)/i);
    if (emailMatch) {
      // Clean up the name part - remove spaces to make "Tim Van C" -> "timvanc"
      let namePart = emailMatch[1].replace(/\s+/g, '').toLowerCase();
      let domainPart = emailMatch[2];
      
      // Fix common ASR errors: "si" -> "c", "see" -> "c", "sea" -> "c" at the end
      // This handles "timvansi" -> "timvanc" when user says "Tim Van C"
      if (namePart.endsWith('si') && namePart.length > 2) {
        namePart = namePart.slice(0, -2) + 'c';
      } else if (namePart.endsWith('see') && namePart.length > 3) {
        namePart = namePart.slice(0, -3) + 'c';
      } else if (namePart.endsWith('sea') && namePart.length > 3) {
        namePart = namePart.slice(0, -3) + 'c';
      }
      
      email = `${namePart}@${domainPart}`;
    } else {
      // Try simpler pattern if first didn't match
      const simpleMatch = email.match(/([a-z0-9\s]+)\s+(?:at|@)\s+([a-z0-9.]+)/i);
      if (simpleMatch) {
        let namePart = simpleMatch[1].replace(/\s+/g, '').toLowerCase();
        let domainPart = simpleMatch[2];
        
        // Fix common ASR errors
        if (namePart.endsWith('si') && namePart.length > 2) {
          namePart = namePart.slice(0, -2) + 'c';
        } else if (namePart.endsWith('see') && namePart.length > 3) {
          namePart = namePart.slice(0, -3) + 'c';
        } else if (namePart.endsWith('sea') && namePart.length > 3) {
          namePart = namePart.slice(0, -3) + 'c';
        }
        
        email = `${namePart}@${domainPart}`;
      }
    }
    
    // Convert spoken "at" and "dot" to symbols
    email = email
      .replace(/\s+at\s+/gi, '@')
      .replace(/\s+dot\s+/gi, '.')
      .replace(/\s*@\s*/g, '@')
      .replace(/\s*\.\s*/g, '.')
      .replace(/\s+/g, '')  // Remove all spaces
      .toLowerCase()
      .trim();
    
    // Clean up common artifacts - remove prefixes that might be stuck
    // Remove "wouldbe", "would", "that", "so", "the" if they appear at the start
    // Also remove "wouldbe" if it appears anywhere (from "would be" being concatenated)
    email = email.replace(/^(wouldbe|would|that|so|the|yeah)/, '');
    email = email.replace(/wouldbe/g, '');  // Remove "wouldbe" anywhere in the email
    
    // Apply spelling instructions
    if (spellingInstructions.length > 0) {
      const atIndex = email.indexOf('@');
      if (atIndex > 0) {
        let localPart = email.substring(0, atIndex);
        const domain = email.substring(atIndex);
        
        for (const instruction of spellingInstructions) {
          const { letter, count } = instruction;
          const letterIndex = localPart.indexOf(letter);
          if (letterIndex >= 0) {
            const charAt = localPart[letterIndex];
            const nextChar = localPart[letterIndex + 1];
            // If not already doubled, double it
            if (nextChar !== charAt) {
              localPart = localPart.substring(0, letterIndex + 1) + 
                         charAt.repeat(count - 1) + 
                         localPart.substring(letterIndex + 1);
            }
          }
        }
        
        email = localPart + domain;
      }
    }
    
    // Final cleanup - remove any non-email characters
    email = email.replace(/[^a-z0-9@._-]/g, '').toLowerCase();
    
    // Validate it looks like an email
    if (!email.includes('@') || !email.includes('.')) {
      return null; // Invalid email format
    }
    
    return email;
  }
  
  /**
   * Detect if caller says they already provided the info
   */
  function isAlreadyProvidedResponse(text) {
    const alreadyProvidedPatterns = [
      'we just went over', 'already gave', 'already provided', 'already told you',
      'you already have', 'we just did', 'you have it', 'just went over that',
      'we covered that', 'i just gave you', 'i already said', 'already confirmed',
      'we already did'
    ];
    return alreadyProvidedPatterns.some(p => text.includes(p));
  }
  
  /**
   * Detect if caller is asking for a read-back of stored info
   */
  function isAskingForReadback(text) {
    const readbackPatterns = [
      'what do you have', 'what email do you have', 'read it back', 
      'spell it for me', 'say it back', 'repeat it', 'what did you get',
      'tell me what you have', 'read back', 'what you have'
    ];
    return readbackPatterns.some(p => text.includes(p));
  }
  
  function extractAddress(text) {
    // Remove common prefixes
    let address = text
      .replace(/^(that would be|that's|it's|it is|the address is|address is|my address is)\s*/gi, '')
      .trim();
    
    // Extract zip code (5 digits, optionally with -4 extension)
    const zipMatch = address.match(/\b(\d{5}(-\d{4})?)\b/);
    const zip = zipMatch ? zipMatch[1] : null;
    
    // Remove zip from text for further parsing
    if (zip) {
      address = address.replace(zipMatch[0], '').trim();
    }
    
    // Extract state (common state abbreviations and full names)
    const statePattern = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New\s+Hampshire|New\s+Jersey|New\s+Mexico|New\s+York|North\s+Carolina|North\s+Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode\s+Island|South\s+Carolina|South\s+Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West\s+Virginia|Wisconsin|Wyoming)\b/i;
    const stateMatch = address.match(statePattern);
    const state = stateMatch ? stateMatch[1] : null;
    
    // Remove state from text
    if (state) {
      address = address.replace(stateMatch[0], '').trim();
    }
    
    // Extract city (usually before state, often capitalized or has comma)
    let city = null;
    if (state) {
      // Look for city before state (often ends with comma or is last word before state)
      const beforeState = address.substring(0, address.indexOf(stateMatch[0])).trim();
      // Split by comma or take last significant word/phrase
      const cityParts = beforeState.split(',').map(s => s.trim()).filter(s => s.length > 0);
      if (cityParts.length > 0) {
        city = cityParts[cityParts.length - 1]; // Take last part before state
      }
    }
    
    // Remove city from address text
    if (city) {
      address = address.replace(city, '').trim();
    }
    
    // Clean up address (remove extra commas, spaces)
    address = address.replace(/^[,.\s]+|[,.\s]+$/g, '').trim();
    
    // If address is empty but we have other parts, reconstruct
    if (!address && (city || state || zip)) {
      address = text.replace(/\b\d{5}(-\d{4})?\b/, '').trim();
      if (state) address = address.replace(statePattern, '').trim();
      if (city) address = address.replace(city, '').trim();
      address = address.replace(/^[,.\s]+|[,.\s]+$/g, '').trim();
    }
    
    return {
      address: address || text,  // Fallback to full text if parsing fails
      city: city,
      state: state,
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
