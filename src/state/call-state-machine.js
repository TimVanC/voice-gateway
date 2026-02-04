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
  cleanTranscript,
  confidenceToPercentage,
  adjustConfidence,
  formatPhoneForReadback,
  formatEmailForReadback
} = require('../utils/confidence-estimator');

/**
 * Create a new call state manager
 * @returns {Object} State manager with methods to get/set state and data
 */
function createCallStateMachine() {
  // Current state
  let currentState = STATES.GREETING;
  let previousState = null;  // Track previous state for backtracking
  
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
    
    // Confidence scores (0-100 percentage)
    name_confidence: null,
    phone_confidence: null,
    email_confidence: null,
    address_confidence: null,
    availability_confidence: null,
    
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
  
  // Confidence threshold: >= accept and move on; < confirm immediately (Phase 2)
  const CONFIDENCE_THRESHOLD = 85;  // 85% (0.85) - below: confirm right after answer; above: accept and move on
  
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
  /**
   * Spell out a word letter by letter (e.g., "Tim" → "T-I-M")
   */
  function spellOutWord(word) {
    if (!word) return '';
    return word.split('').filter(c => /[a-zA-Z0-9]/.test(c)).join('-').toUpperCase();
  }
  
  /** Spell word with spaces for immediate confirmation (e.g. "VAN" → "V A N"). Do not spell street types. */
  function spellWordWithSpaces(word) {
    if (!word) return '';
    return word.replace(/\s/g, '').split('').filter(c => /[a-zA-Z0-9]/.test(c)).map(c => c.toUpperCase()).join(' ');
  }
  
  /** Street type suffixes we do NOT spell (road, street, avenue, etc.) */
  const STREET_TYPE = /\b(road|rd|street|st|avenue|ave|drive|dr|lane|ln|way|court|ct|boulevard|blvd|circle|place|pl)\s*$/i;
  /** Return { namePart, type } e.g. "11 Elf Road" → { namePart: "11 Elf", type: "Road" }; namePart excludes type. */
  function parseStreetNameAndType(addr) {
    if (!addr || !addr.trim()) return { namePart: '', type: '' };
    const m = addr.trim().match(/^(.+?)\s+(road|rd|street|st|avenue|ave|drive|dr|lane|ln|way|court|ct|boulevard|blvd|circle|place|pl)\s*$/i);
    if (m) return { namePart: m[1].trim(), type: m[2] };
    return { namePart: addr.trim(), type: '' };
  }
  /** Word to spell for street: the main name, not number or type. e.g. "11 Elf" → "Elf", "Main" → "Main". */
  function getStreetNameToSpell(addr) {
    const { namePart } = parseStreetNameAndType(addr || '');
    const words = (namePart || '').split(/\s+/).filter(w => /[a-zA-Z]/.test(w) && !/^\d+$/.test(w));
    return words.length ? words[words.length - 1] : (namePart || '');
  }
  function getStreetType(addr) {
    return parseStreetNameAndType(addr || '').type;
  }
  
  /**
   * Spell out an address component
   */
  function spellOutAddress(address) {
    if (!address) return '';
    // Split by spaces and spell out each word
    const words = address.split(/\s+/);
    return words.map(w => spellOutWord(w)).join(' space ');
  }
  
  function getConfirmationPrompt() {
    const intro = confirmationAttempts > 0 
      ? CONFIRMATION.correction_reread 
      : CONFIRMATION.intro;
    
    // Build the read-back
    // RULES: NO SPELLING - just read everything back normally
    let parts = [intro];
    
    // Name - full name, spoken normally
    if (data.firstName && data.lastName) {
      parts.push(`${data.firstName} ${data.lastName}.`);
    } else if (data.firstName) {
      parts.push(`${data.firstName}.`);
    } else if (data.lastName) {
      parts.push(`${data.lastName}.`);
    }
    
    // Phone - speak normally (e.g., "973-885-2528")
    if (data.phone) {
      parts.push(`Phone, ${data.phone}.`);
    }
    
    // Email - speak normally (e.g., "mj23 at gmail dot com")
    if (data.email) {
      const emailSpoken = data.email
        .replace(/@/g, ' at ')
        .replace(/\./g, ' dot ');
      parts.push(`Email, ${emailSpoken}.`);
    }
    
    // Address - speak everything normally (NO spelling)
    if (data.address) {
      let addressPart = data.address;
      
      // Add city, state, zip
      if (data.city) {
        addressPart += `, ${data.city}`;
      }
      if (data.state) {
        addressPart += `, ${data.state}`;
      }
      if (data.zip) {
        addressPart += ` ${data.zip}`;
      }
      
      parts.push(`Address, ${addressPart}.`);
    }
    
    // NOTE: We do NOT include availability or issue details in the recap
    // The user already provided those and doesn't need them read back
    
    // Recap is read-only: one verify at the end, no new per-field confirmations
    parts.push(CONFIRMATION.verify);
    
    return parts.join(' ');
  }
  
  /**
   * Get very short issue summary for confirmation prompt
   */
  function getIssueSummaryShort() {
    const { details = {} } = data;
    
    // Try to get one key symptom or issue
    let issue = '';
    if (details.symptoms) {
      issue = details.symptoms.split(/[.!?]/)[0].trim(); // First sentence only
      // Remove filler words
      issue = issue.replace(/\b(yeah|uh|um|er|ah|oh|there's|there is)\b/gi, '').trim();
      if (issue.length > 50) issue = issue.substring(0, 50) + '...';
    } else if (details.issueDescription) {
      issue = details.issueDescription.split(/[.!?]/)[0].trim();
      if (issue.length > 50) issue = issue.substring(0, 50) + '...';
    } else if (details.generatorIssue) {
      issue = details.generatorIssue.split(/[.!?]/)[0].trim();
      if (issue.length > 50) issue = issue.substring(0, 50) + '...';
    }
    
    return issue || null;
  }
  
  /**
   * Clean availability notes: remove filler phrases
   */
  function cleanAvailabilityNotes(availability) {
    if (!availability) return '';
    
    return availability
      .replace(/^(i'?d\s+say|i\s+think|probably|maybe|uh|um|er|ah|oh)\s*,?\s*/gi, '')
      .replace(/\s+(i'?d\s+say|probably|maybe)\s+/gi, ' ')
      .trim();
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
    // Track previous state for backtracking (but don't track same state or greeting)
    if (oldState !== newState && oldState !== STATES.GREETING) {
      previousState = oldState;
    }
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
          
          // If it's a new installation (generator or HVAC), mark it
          if (analysis.isNewInstallation) {
            data.details.generatorType = 'new';
            console.log(`📋 Marked as NEW installation - will skip safety check`);
          }
          
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
          
          // If it's a new installation (generator or HVAC), mark it
          if (analysis.isNewInstallation) {
            data.details.generatorType = 'new';
            console.log(`📋 Marked as NEW installation - will skip safety check`);
          }
          
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
        // Immediate confirmation: we asked "Did I get your last name right. X Y Z." (Phase 2)
        if (pendingClarification.field === 'name' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            data.firstName = pendingClarification.value.firstName;
            data.lastName = pendingClarification.value.lastName;
            const baseConf = data.name_confidence != null ? data.name_confidence : confidenceToPercentage(pendingClarification.confidence);
            data.name_confidence = adjustConfidence(baseConf, 'confirmation');
            data._nameComplete = true;
            console.log(`✅ Name confirmed: ${data.firstName} ${data.lastName} (confidence: ${data.name_confidence}%)`);
            clearPendingClarification();
            return { nextState: transitionTo(STATES.PHONE), prompt: CALLER_INFO.phone, action: 'ask' };
          }
          // No or correction: handle spelled corrections
          // Patterns: "No. It's spelled V-A-N...", "And not fully, it's V-A-N space C-A-U...", "it's V-A-N-C-A-U..."
          // Look for any sequence of spelled letters (single letters separated by dashes, spaces, or dots)
          const hasSpelledLetters = /([A-Z])[-.\s]+([A-Z])[-.\s]+([A-Z])/i.test(transcript);
          if (hasSpelledLetters) {
            // Extract all spelled letter sequences, handling "space" as word separator
            let spelledPart = transcript;
            // Remove common prefixes (order matters!)
            spelledPart = spelledPart.replace(/^(and\s+)?not\s+fully[,.]?\s*/i, '');
            spelledPart = spelledPart.replace(/^no[,.]?\s*/i, '');
            // Handle both "it is" (two words) and "it's" (contraction)
            spelledPart = spelledPart.replace(/^(it\s+is|it'?s|that\s+is|that'?s)\s*/i, '');
            spelledPart = spelledPart.replace(/^spelled?\s*/i, '');
            
            // Handle "space" as word separator in names like "V-A-N space C-A-U-W-E-N-B-E-R-G-E"
            const hasSpace = /\bspace\b/i.test(spelledPart);
            let correctedLastName = '';
            
            if (hasSpace) {
              // Split by "space" and extract letters from each part
              const parts = spelledPart.split(/\s+space\s+/i);
              const nameParts = parts.map(part => {
                const letters = part.match(/[A-Z]/gi) || [];
                if (letters.length >= 1) {
                  return letters.join('').charAt(0).toUpperCase() + letters.join('').slice(1).toLowerCase();
                }
                return '';
              }).filter(p => p.length > 0);
              correctedLastName = nameParts.join(' ');
            } else {
              // Single word - extract all letters
              const letters = spelledPart.match(/[A-Z]/gi) || [];
              if (letters.length >= 2) {
                correctedLastName = letters.join('').charAt(0).toUpperCase() + letters.join('').slice(1).toLowerCase();
              }
            }
            
            if (correctedLastName.length >= 2) {
              data.firstName = pendingClarification.value.firstName;  // Keep original first name
              data.lastName = correctedLastName;
              data.name_confidence = adjustConfidence(confidenceToPercentage(pendingClarification.confidence), 'correction');
              data._nameComplete = true;
              console.log(`✅ Last name corrected via spelling: ${data.lastName} (was: ${pendingClarification.value.lastName})`);
              clearPendingClarification();
              return { nextState: transitionTo(STATES.PHONE), prompt: CALLER_INFO.phone, action: 'ask' };
            }
          }
          
          // Standard correction: take correction and lock
          const corr = extractName(transcript);
          if (corr.firstName || corr.lastName) {
            data.firstName = corr.firstName || pendingClarification.value.firstName;
            data.lastName = corr.lastName || pendingClarification.value.lastName;
            data.name_confidence = adjustConfidence(confidenceToPercentage(pendingClarification.confidence), 'correction');
          } else {
            // No name extracted - keep pending values
            data.firstName = pendingClarification.value.firstName;
            data.lastName = pendingClarification.value.lastName;
          }
          data._nameComplete = true;
          clearPendingClarification();
          return { nextState: transitionTo(STATES.PHONE), prompt: CALLER_INFO.phone, action: 'ask' };
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
          // Extract name FIRST
          const extracted = extractName(transcript);
          const { firstName, lastName } = extracted;
          
          // Log extraction result immediately (for debugging)
          console.log(`📋 Name extraction: firstName="${firstName}", lastName="${lastName}", raw="${transcript.substring(0, 50)}"`);
          
          // Check confidence BEFORE validation (so we always log it)
          const firstNameConf = firstName ? estimateFirstNameConfidence(firstName) : { level: CONFIDENCE.LOW, reason: 'firstName empty after extraction' };
          const lastNameConf = lastName ? estimateLastNameConfidence(lastName) : (firstName ? { level: CONFIDENCE.HIGH } : { level: CONFIDENCE.LOW, reason: 'lastName missing' });
          const overallConf = getLowestConfidence(firstNameConf, lastNameConf);
          
          // Calculate base confidence percentage
          let nameConfidencePercent = confidenceToPercentage(overallConf);
          
          // Check for hesitation markers (um, uh, etc.)
          const lowerTranscript = transcript.toLowerCase();
          if (/\b(um|uh|er|hmm|like|maybe|i think|i guess)\b/.test(lowerTranscript)) {
            nameConfidencePercent = adjustConfidence(nameConfidencePercent, 'hesitation');
            console.log(`📉 Name confidence reduced due to hesitation: ${nameConfidencePercent}%`);
          }
          
          // Log confidence IMMEDIATELY (before any validation)
          console.log(`📋 Name confidence: firstName="${firstName}" (${firstNameConf.level}, ${firstNameConf.reason || 'N/A'}), lastName="${lastName}" (${lastNameConf.level}, ${lastNameConf.reason || 'N/A'}), overall=${overallConf.level}, percentage=${nameConfidencePercent}%`);
          
          // If extraction failed completely, check raw transcript
          if (!firstName && !lastName) {
            console.log(`⚠️  Name extraction failed completely for: "${transcript}"`);
            // Try to extract from raw transcript (maybe it's a single word name or has unusual format)
            const rawParts = transcript.split(/\s+/).filter(p => p.length > 1 && !/\b(yeah|yes|it'?s|that'?s|would|be)\b/i.test(p));
            if (rawParts.length >= 2) {
              // Try again with cleaned parts
              const cleanedName = rawParts.join(' ');
              const retryExtract = extractName(cleanedName);
              if (retryExtract.firstName) {
                console.log(`🔄 Retry extraction succeeded: ${retryExtract.firstName} ${retryExtract.lastName}`);
                // Continue with retry extraction
                return {
                  nextState: currentState,
                  prompt: `Got it. Just to confirm, is that ${retryExtract.firstName} ${retryExtract.lastName || '(last name)'}?`,
                  action: 'ask'
                };
              }
            }
            return {
              nextState: currentState,
              prompt: "I didn't catch that clearly. Could you say your first and last name again?",
              action: 'ask'
            };
          }
          
          // Check if extracted firstName looks valid
          if (!firstName || !looksLikeName(firstName)) {
            console.log(`⚠️  firstName validation failed: "${firstName}" (from "${transcript}")`);
            // CRITICAL: Don't treat lastName as full name if it contains a known prefix (Van, De, etc.)
            // This prevents "Van Kallenberg" from being split incorrectly
            const prefixes = ['van', 'de', 'la', 'le', 'du', 'von', 'der', 'da', 'di', 'del', 'della', 'dos', 'das', 'do', 'mac', 'mc', 'o\'', 'o'];
            const lastNameHasPrefix = lastName && lastName.split(/\s+/).some(word => prefixes.includes(word.toLowerCase()));
            
            // If we have lastName but no firstName, and lastName doesn't have a prefix, maybe it's reversed or single name
            if (lastName && looksLikeName(lastName) && !lastNameHasPrefix) {
              // Maybe they gave last name first, or it's just one name
              console.log(`🔄 lastName looks valid, treating as full name: "${lastName}"`);
              const lastNameParts = lastName.split(' ');
              data.firstName = lastNameParts[0] || lastName;
              data.lastName = lastNameParts.slice(1).join(' ') || '';
              return {
                nextState: transitionTo(STATES.PHONE),
                prompt: CALLER_INFO.phone,
                action: 'ask'
              };
            }
            // If lastName has a prefix, it's likely part of a multi-part name - ask to repeat
            if (lastNameHasPrefix) {
              console.log(`⚠️  lastName "${lastName}" contains prefix - likely multi-part name, asking to repeat`);
              return {
                nextState: currentState,
                prompt: "I want to make sure I have that right. Could you say your first and last name again?",
                action: 'ask'
              };
            }
            return {
              nextState: currentState,
              prompt: "I want to make sure I have that right. Could you spell your first and last name for me?",
              action: 'ask'
            };
          }
          
          // Log final extracted name
          console.log(`📋 Name extracted: ${firstName} ${lastName} (confidence: ${overallConf.level}, reason: ${overallConf.reason || 'N/A'}, percentage=${nameConfidencePercent}%)`);
          
          // Phase 2: >= threshold accept and move on; < threshold confirm immediately (spell last name).
          if (nameConfidencePercent >= CONFIDENCE_THRESHOLD) {
            data.firstName = firstName;
            data.lastName = lastName;
            data.name_confidence = nameConfidencePercent;
            data._nameComplete = true;
            console.log(`✅ Name stored: ${firstName} ${lastName} (confidence: ${nameConfidencePercent}%)`);
            return { nextState: transitionTo(STATES.PHONE), prompt: CALLER_INFO.phone, action: 'ask' };
          }
          // Below threshold: confirm immediately with last name spelled. One confirmation only.
          data.name_confidence = nameConfidencePercent;
          pendingClarification = { field: 'name', value: { firstName, lastName }, confidence: overallConf, awaitingConfirmation: true };
          const lastSpelled = (lastName && spellWordWithSpaces(lastName)) ? ` ${spellWordWithSpaces(lastName)}.` : ` ${firstName} ${lastName || ''}.`;
          return {
            nextState: currentState,
            prompt: `${CONFIRMATION.immediate_name}${lastSpelled}`.trim(),
            action: 'ask'
          };
        }
        return { nextState: currentState, prompt: CALLER_INFO.name, action: 'ask' };
        
      case STATES.PHONE:
        // Immediate confirmation (Phase 2): we asked "I have X. Is that right?"
        if (pendingClarification.field === 'phone' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            data.phone = pendingClarification.value;
            data.phone_confidence = adjustConfidence(data.phone_confidence != null ? data.phone_confidence : confidenceToPercentage(pendingClarification.confidence), 'confirmation');
            data._phoneComplete = true;
            clearPendingClarification();
            return { nextState: transitionTo(STATES.EMAIL), prompt: CALLER_INFO.email.primary, action: 'ask' };
          }
          const corr = extractPhone(transcript);
          if (corr && (corr.replace(/\D/g, '').length >= 10)) {
            data.phone = corr;
            data.phone_confidence = adjustConfidence(confidenceToPercentage(pendingClarification.confidence), 'correction');
          } else {
            data.phone = pendingClarification.value;
          }
          data._phoneComplete = true;
          clearPendingClarification();
          return { nextState: transitionTo(STATES.EMAIL), prompt: CALLER_INFO.email.primary, action: 'ask' };
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
        
        // CRITICAL: Check if this is city/state being provided to complete an address
        // User might say "Orange, New Jersey" to complete "11 Elf Road"
        if (data.address && !data.city) {
          const addressParts = extractAddress(transcript);
          if (addressParts.city || addressParts.state) {
            console.log(`📋 City/State detected in PHONE state: city="${addressParts.city}", state="${addressParts.state}"`);
            // Update address with city/state
            data.city = addressParts.city || data.city;
            data.state = addressParts.state || data.state;
            data.zip = addressParts.zip || data.zip;
            // If phone is already set, move to email/availability
            if (data.phone || metadata?.callerNumber) {
              // Check if we still need email
              if (!data.email) {
                return {
                  nextState: transitionTo(STATES.EMAIL),
                  prompt: CALLER_INFO.email.primary,
                  action: 'ask'
                };
              }
              // If we have everything, check what's next
              if (!data.availability) {
                return {
                  nextState: transitionTo(STATES.AVAILABILITY),
                  prompt: AVAILABILITY.ask,
                  action: 'ask'
                };
              }
              // If we have everything, go to confirmation
              return {
                nextState: transitionTo(STATES.CONFIRMATION),
                prompt: getConfirmationPrompt(),
                action: 'confirm'
              };
            }
            // Otherwise, still need phone
            return {
              nextState: currentState,
              prompt: CALLER_INFO.phone,
              action: 'ask'
            };
          }
        }
        
        // CRITICAL: Check if user said they already provided the phone (e.g., "we already went over that")
        // Or if they gave availability instead of phone
        if (isAlreadyProvidedResponse(lowerTranscript) || lowerTranscript.includes('already') || lowerTranscript.includes('went over')) {
          // They already gave phone or are providing availability/other info
          // If phone is already set, move to email
          if (data.phone || metadata?.callerNumber) {
            console.log(`✅ Phone already collected, moving to email`);
            return {
              nextState: transitionTo(STATES.EMAIL),
              prompt: CALLER_INFO.email.primary,
              action: 'ask'
            };
          }
          // Otherwise, remind them we need phone
          return {
            nextState: currentState,
            prompt: "I still need your phone number. What's the best number to reach you?",
            action: 'ask'
          };
        }
        
        // Check if this looks like availability instead of phone (cross-state detection)
        if (looksLikeAvailability(lowerTranscript)) {
          console.log(`📋 Availability detected in PHONE state: "${transcript}"`);
          // If phone is already collected, treat as availability and move forward
          if (data.phone || metadata?.callerNumber) {
            data.availability = extractAvailability(transcript);
            console.log(`📋 Availability: ${data.availability}`);
            // Check what we still need
            if (!data.email) {
              return {
                nextState: transitionTo(STATES.EMAIL),
                prompt: CALLER_INFO.email.primary,
                action: 'ask'
              };
            }
            if (!data.address || !data.city) {
              return {
                nextState: transitionTo(STATES.ADDRESS),
                prompt: ADDRESS.ask,
                action: 'ask'
              };
            }
            // If we have everything, go to confirmation
            return {
              nextState: transitionTo(STATES.CONFIRMATION),
              prompt: getConfirmationPrompt(),
              action: 'confirm'
            };
          }
          // Otherwise, ask for phone first
          return {
            nextState: currentState,
            prompt: "I still need your phone number first. What's the best number to reach you?",
            action: 'ask'
          };
        }
        
        if (hasPhoneNumber(lowerTranscript)) {
          const phone = extractPhone(transcript);
          const phoneConf = estimatePhoneConfidence(transcript);
          
          // Calculate base confidence percentage
          let phoneConfidencePercent = confidenceToPercentage(phoneConf);
          
          // Check for hesitation markers
          if (/\b(um|uh|er|hmm|like|maybe|i think|i guess)\b/.test(lowerTranscript)) {
            phoneConfidencePercent = adjustConfidence(phoneConfidencePercent, 'hesitation');
            console.log(`📉 Phone confidence reduced due to hesitation: ${phoneConfidencePercent}%`);
          }
          
          // Strict validation: must be exactly 10 digits
          const digits = phone.replace(/\D/g, '');
          const isValidPhone = digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
          
          if (!isValidPhone) {
            console.log(`⚠️  Invalid phone number: "${phone}" (${digits.length} digits)`);
            return {
              nextState: currentState,
              prompt: "I need a complete 10-digit phone number. Could you repeat it?",
              action: 'ask'
            };
          }
          
          // Normalize to 10 digits
          const normalizedPhone = digits.length === 11 ? digits.slice(1) : digits;
          const formattedPhone = `${normalizedPhone.slice(0,3)}-${normalizedPhone.slice(3,6)}-${normalizedPhone.slice(6)}`;
          
          console.log(`📋 Phone: ${formattedPhone} (confidence: ${phoneConf.level}, reason: ${phoneConf.reason || 'N/A'}, percentage=${phoneConfidencePercent}%)`);
          
          // Phase 2: >=85 accept; <85 confirm immediately (read back normally, no spelling).
          if (phoneConfidencePercent >= CONFIDENCE_THRESHOLD) {
            data.phone = formattedPhone;
            data.phone_confidence = phoneConfidencePercent;
            data._phoneComplete = true;
            console.log(`✅ Phone stored: ${formattedPhone} (confidence: ${phoneConfidencePercent}%)`);
            return { nextState: transitionTo(STATES.EMAIL), prompt: `Got it. ${CALLER_INFO.email.primary}`, action: 'ask' };
          }
          data.phone_confidence = phoneConfidencePercent;
          pendingClarification = { field: 'phone', value: formattedPhone, confidence: phoneConf, awaitingConfirmation: true };
          const phoneReadback = formatPhoneForReadback(formattedPhone);
          return { nextState: currentState, prompt: `${CONFIRMATION.immediate_phone} ${phoneReadback}. Is that right?`, action: 'ask' };
        }
        return {
          nextState: currentState,
          prompt: CALLER_INFO.phone,
          action: 'ask'
        };
        
      case STATES.EMAIL:
        // Immediate confirmation (Phase 2): we asked "I have X. Is that right?" Read-back only.
        if (pendingClarification.field === 'email' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            data.email = pendingClarification.value;
            data.email_confidence = adjustConfidence(data.email_confidence != null ? data.email_confidence : confidenceToPercentage(pendingClarification.confidence), 'confirmation');
            data._emailComplete = true;
            clearPendingClarification();
            return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: getDetailsPrompt(), action: 'ask' };
          }
          const corr = extractEmail(transcript);
          if (corr && corr.includes('@') && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(corr)) {
            data.email = corr;
            data.email_confidence = adjustConfidence(confidenceToPercentage(pendingClarification.confidence), 'correction');
          } else {
            data.email = pendingClarification.value;
          }
          data._emailComplete = true;
          clearPendingClarification();
          return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: getDetailsPrompt(), action: 'ask' };
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
          
          const email = extractEmail(transcript);
          const emailConf = estimateEmailConfidence(transcript);
          let emailConfidencePercent = confidenceToPercentage(emailConf);
          if (/\b(um|uh|er|hmm|like|maybe|i think|i guess)\b/.test(lowerTranscript)) {
            emailConfidencePercent = adjustConfidence(emailConfidencePercent, 'hesitation');
          }
          if (!email || !email.includes('@')) {
            return { nextState: currentState, prompt: "I'm having trouble catching that. Could you spell out the email address for me?", action: 'ask' };
          }
          if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) {
            if (!data._emailAttempts) data._emailAttempts = 0;
            data._emailAttempts++;
            if (data._emailAttempts >= 2) {
              return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: getDetailsPrompt(), action: 'ask' };
            }
            return { nextState: currentState, prompt: "I'm having trouble with that email format. Could you spell it again?", action: 'ask' };
          }
          data._emailAttempts = 0;
          console.log(`📋 Email: ${email} (confidence: ${emailConfidencePercent}%)`);
          // Phase 2: >=85 accept; <85 confirm immediately (read back normally, no spelling).
          if (emailConfidencePercent >= CONFIDENCE_THRESHOLD) {
            data.email = email;
            data.email_confidence = emailConfidencePercent;
            data._emailComplete = true;
            return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: getDetailsPrompt(), action: 'ask' };
          }
          data.email = email;
          data.email_confidence = emailConfidencePercent;
          pendingClarification = { field: 'email', value: email, confidence: emailConf, awaitingConfirmation: true };
          return { nextState: currentState, prompt: `${CONFIRMATION.immediate_email} ${formatEmailForReadback(email)}. Is that right?`, action: 'ask' };
        }
        return {
          nextState: currentState,
          prompt: CALLER_INFO.email.primary,
          action: 'ask'
        };
        
      case STATES.DETAILS_BRANCH:
        // CRITICAL: Check if user gave an address instead of details
        // "11 Elf Road, West Orange, New Jersey" should be stored as address, not systemType
        if (looksLikeAddress(transcript)) {
          console.log(`📋 Address detected in DETAILS_BRANCH state: "${transcript.substring(0, 50)}..."`);
          const addressParts = extractAddress(transcript);
          if (addressParts.address) {
            data.address = addressParts.address;
            data.city = addressParts.city;
            data.state = addressParts.state;
            data.zip = addressParts.zip;
            console.log(`📋 Address stored: ${data.address}, ${data.city || 'N/A'}, ${data.state || 'N/A'} ${data.zip || 'N/A'}`);
            // Continue with remaining detail questions if any
            detailsQuestionIndex++;
            const nextDetailPrompt = getDetailsPrompt();
            if (nextDetailPrompt) {
              return {
                nextState: currentState,
                prompt: nextDetailPrompt,
                action: 'ask'
              };
            }
            // If no more detail questions, skip to availability since we have address
            return {
              nextState: transitionTo(STATES.AVAILABILITY),
              prompt: AVAILABILITY.ask,
              action: 'ask'
            };
          }
        }
        
        // Normal flow: store the detail answer
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
        // Immediate confirmation (Phase 2): we asked "Did you say the street name was X? Did you say the town was Y?"
        if (pendingClarification.field === 'address' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            const v = pendingClarification.value;
            data.address = v.address; data.city = v.city; data.state = v.state; data.zip = v.zip;
            data.address_confidence = adjustConfidence(data.address_confidence != null ? data.address_confidence : confidenceToPercentage(pendingClarification.confidence), 'confirmation');
            data._addressComplete = true;
            clearPendingClarification();
            return { nextState: transitionTo(STATES.AVAILABILITY), prompt: AVAILABILITY.ask, action: 'ask' };
          }
          
          // User provided a correction - extract what they said
          // Handle patterns like "No, no, it is Sherman" or "No, it's Sherman" or "Sherman"
          let correctedValue = transcript
            .replace(/^(no[,.]?\s*)+(it\s+is|it's|that's|that\s+is)?\s*/gi, '')
            .trim();
          
          // If user gave a simple correction (single word or short phrase), it's likely the street name
          // Apply it to the pending address
          const pendingAddr = pendingClarification.value;
          if (correctedValue && correctedValue.length > 1 && correctedValue.length < 30) {
            // Check if this looks like a street name correction (no numbers, no common city words)
            const looksLikeStreetName = /^[a-zA-Z\s]+$/.test(correctedValue) && 
              !/\b(street|st|road|rd|avenue|ave|drive|dr|boulevard|blvd|lane|ln)\b/i.test(correctedValue);
            
            if (looksLikeStreetName && pendingAddr.address) {
              // Replace the street name in the address while keeping number and type
              const streetMatch = pendingAddr.address.match(/^(\d+\s+)?(.*?)\s*(street|st|road|rd|avenue|ave|drive|dr|boulevard|blvd|lane|ln|way|court|ct|circle|cir|place|pl)?$/i);
              if (streetMatch) {
                const number = streetMatch[1] || '';
                const type = streetMatch[3] || '';
                data.address = `${number}${correctedValue}${type ? ' ' + type : ''}`.trim();
                console.log(`📋 Street name corrected: "${correctedValue}" → address: "${data.address}"`);
              } else {
                data.address = correctedValue;
              }
            } else {
              // Try full address extraction
              const ap = extractAddress(transcript);
              data.address = ap.address || pendingAddr.address;
              data.city = ap.city || pendingAddr.city;
            }
          } else {
            // Try full address extraction for longer responses
            const ap = extractAddress(transcript);
            if (ap.address && ap.address.length > 3 && !/^no[,.]?\s/i.test(ap.address)) {
              data.address = ap.address;
              data.city = ap.city || pendingAddr.city;
            } else {
              data.address = pendingAddr.address;
              data.city = pendingAddr.city;
            }
          }
          
          data.state = pendingAddr.state;
          data.zip = pendingAddr.zip;
          data.address_confidence = adjustConfidence(confidenceToPercentage(pendingClarification.confidence), 'correction');
          data._addressComplete = true;
          clearPendingClarification();
          return { nextState: transitionTo(STATES.AVAILABILITY), prompt: AVAILABILITY.ask, action: 'ask' };
        }
        
        if (transcript.length > 2) {
          // CRITICAL: Check if we already have the street address but need state/zip
          // If we asked "Could you provide state and zip?" - capture that response
          if (data.address && (!data.state || !data.zip)) {
            // Try to extract state and zip from response
            const stateZipResult = extractStateAndZip(transcript);
            if (stateZipResult.state || stateZipResult.zip) {
              // Merge with existing data
              if (stateZipResult.state) data.state = stateZipResult.state;
              if (stateZipResult.zip) data.zip = stateZipResult.zip;
              console.log(`✅ State/Zip merged: state="${data.state || 'N/A'}", zip="${data.zip || 'N/A'}"`);
              
              // Now check if we have everything
              if (!data.state) {
                return {
                  nextState: currentState,
                  prompt: "Could you also provide the state?",
                  action: 'ask'
                };
              } else if (!data.zip) {
                return {
                  nextState: currentState,
                  prompt: "Could you also provide the zip code?",
                  action: 'ask'
                };
              }
              
              // We have everything - move to availability
              return {
                nextState: transitionTo(STATES.AVAILABILITY),
                prompt: AVAILABILITY.ask,
                action: 'ask'
              };
            }
          }
          
          // First check if this actually looks like an address
          if (!looksLikeAddress(transcript)) {
            // If user says goodbye or thanks, transition to close
            if (/\b(bye|goodbye|good one|take care|thanks|thank you)\b/i.test(lowerTranscript)) {
              console.log(`📋 User indicating end of call in ADDRESS state`);
              return {
                nextState: transitionTo(STATES.CLOSE),
                prompt: CLOSE.goodbye,
                action: 'end'
              };
            }
            console.log(`📋 Response doesn't look like an address: "${transcript}" - re-asking`);
            return {
              nextState: currentState,
              prompt: ADDRESS.ask,
              action: 'ask'
            };
          }
          
          const addressParts = extractAddress(transcript);
          
          // LENGTH CHECK: If extracted address is too long (likely parsing error), ask user to repeat
          if (addressParts.address && addressParts.address.length > 60) {
            console.log(`📋 Address too long (${addressParts.address.length} chars) - asking user to repeat simply`);
            return {
              nextState: currentState,
              prompt: "I didn't quite catch that. Can you give me just the street address and city?",
              action: 'ask'
            };
          }
          
          // Check confidence for each part
          const addressConf = estimateAddressConfidence(addressParts.address || transcript);
          const cityConf = addressParts.city ? estimateCityConfidence(addressParts.city) : { level: CONFIDENCE.HIGH };
          const stateConf = addressParts.state ? { level: CONFIDENCE.HIGH } : { level: CONFIDENCE.HIGH };
          const zipConf = addressParts.zip ? estimateZipConfidence(addressParts.zip) : { level: CONFIDENCE.HIGH };
          
          const overallConf = getLowestConfidence(addressConf, cityConf, zipConf);
          
          // Calculate base confidence percentage
          let addressConfidencePercent = confidenceToPercentage(overallConf);
          
          // Check for hesitation markers
          if (/\b(um|uh|er|hmm|like|maybe|i think|i guess)\b/.test(lowerTranscript)) {
            addressConfidencePercent = adjustConfidence(addressConfidencePercent, 'hesitation');
            console.log(`📉 Address confidence reduced due to hesitation: ${addressConfidencePercent}%`);
          }
          
          console.log(`📋 Address: ${addressParts.address || 'N/A'} (confidence: ${addressConf.level}, reason: ${addressConf.reason || 'N/A'}, percentage=${addressConfidencePercent}%)`);
          if (addressParts.city) console.log(`📋 City: ${addressParts.city} (confidence: ${cityConf.level}, reason: ${cityConf.reason || 'N/A'})`);
          if (addressParts.state) console.log(`📋 State: ${addressParts.state} (confidence: ${stateConf.level})`);
          if (addressParts.zip) console.log(`📋 Zip: ${addressParts.zip} (confidence: ${zipConf.level}, reason: ${zipConf.reason || 'N/A'})`);
          console.log(`📋 Overall Address Confidence: ${overallConf.level}, reason: ${overallConf.reason || 'N/A'}, percentage=${addressConfidencePercent}%`);
          
          // Swap check
          let finalAddress = addressParts.address;
          let finalCity = addressParts.city;
          if (finalAddress && finalCity && !/^\d/.test(finalAddress) && /^\d/.test(finalCity)) {
            const temp = finalAddress; finalAddress = finalCity; finalCity = temp;
          }
          // Phase 2: >=85 accept; <85 confirm immediately (spell street name and town, not street type).
          if (addressConfidencePercent >= CONFIDENCE_THRESHOLD) {
            data.address = finalAddress;
            data.city = finalCity;
            data.state = addressParts.state;
            data.zip = addressParts.zip;
            data.address_confidence = addressConfidencePercent;
            data._addressComplete = true;
            console.log(`✅ Address stored: ${finalAddress} (confidence: ${addressConfidencePercent}%)`);
            if (!addressParts.state && !addressParts.zip) {
              return { nextState: currentState, prompt: "Could you also provide the state and zip code?", action: 'ask' };
            }
            if (!addressParts.state) {
              return { nextState: currentState, prompt: "Could you also provide the state?", action: 'ask' };
            }
            if (!addressParts.zip) {
              return { nextState: currentState, prompt: "Could you also provide the zip code?", action: 'ask' };
            }
            return { nextState: transitionTo(STATES.AVAILABILITY), prompt: AVAILABILITY.ask, action: 'ask' };
          }
          // Below threshold: confirm with street name and/or town spelled (do not spell street type).
          const confirmParts = [];
          if (confidenceToPercentage(addressConf) < CONFIDENCE_THRESHOLD && finalAddress) {
            const st = getStreetNameToSpell(finalAddress);
            const ty = getStreetType(finalAddress);
            confirmParts.push(`${CONFIRMATION.immediate_address_street} ${spellWordWithSpaces(st)}${ty ? ' ' + ty : ''}?`);
          }
          // Only confirm city if it's a valid city name (at least 2 chars, not just punctuation)
          const validCity = finalCity && finalCity.length >= 2 && /[a-zA-Z]/.test(finalCity);
          if (validCity && confidenceToPercentage(cityConf) < CONFIDENCE_THRESHOLD) {
            confirmParts.push(`${CONFIRMATION.immediate_address_town} ${spellWordWithSpaces(finalCity)}?`);
          }
          if (confirmParts.length === 0) {
            data.address = finalAddress;
            data.city = finalCity;
            data.state = addressParts.state;
            data.zip = addressParts.zip;
            data.address_confidence = addressConfidencePercent;
            data._addressComplete = true;
            return { nextState: transitionTo(STATES.AVAILABILITY), prompt: AVAILABILITY.ask, action: 'ask' };
          }
          data.address_confidence = addressConfidencePercent;
          pendingClarification = { field: 'address', value: { address: finalAddress, city: finalCity, state: addressParts.state, zip: addressParts.zip }, confidence: overallConf, awaitingConfirmation: true };
          return { nextState: currentState, prompt: confirmParts.join(' '), action: 'ask' };
        }
        // state/zip follow-up (when we had address+city from earlier turn)
        if (data.address && (!data.state || !data.zip)) {
          const stateZipResult = extractStateAndZip(transcript);
          if (stateZipResult.state || stateZipResult.zip) {
            if (stateZipResult.state) data.state = stateZipResult.state;
            if (stateZipResult.zip) data.zip = stateZipResult.zip;
            if (!data.state) {
              return { nextState: currentState, prompt: "Could you also provide the state?", action: 'ask' };
            }
            if (!data.zip) {
              return { nextState: currentState, prompt: "Could you also provide the zip code?", action: 'ask' };
            }
            data._addressComplete = true;
            return { nextState: transitionTo(STATES.AVAILABILITY), prompt: AVAILABILITY.ask, action: 'ask' };
          }
        }
        return {
          nextState: currentState,
          prompt: ADDRESS.ask,
          action: 'ask'
        };
        
      case STATES.AVAILABILITY:
        // Immediate confirmation (Phase 2): we asked "I have {availability}. Is that right?"
        if (pendingClarification.field === 'availability' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            data.availability = pendingClarification.value;
            data._availabilityComplete = true;
            clearPendingClarification();
            return { nextState: transitionTo(STATES.CONFIRMATION), prompt: getConfirmationPrompt(), action: 'confirm' };
          }
          const corr = extractAvailability(transcript);
          data.availability = (corr && corr.trim()) ? corr : pendingClarification.value;
          data._availabilityComplete = true;
          clearPendingClarification();
          return { nextState: transitionTo(STATES.CONFIRMATION), prompt: getConfirmationPrompt(), action: 'confirm' };
        }
        // CRITICAL: Check if this is actually an address correction, not availability
        // User might say "No, no, 11 Elf Road, ELF" which is correcting the address
        if (looksLikeAddress(transcript) || (transcript.toLowerCase().includes('no') && /\b(road|street|avenue|drive|address|elf|elk)\b/i.test(transcript))) {
          console.log(`📋 Address correction detected in AVAILABILITY state: "${transcript}"`);
          // This is an address correction, not availability
          const addressParts = extractAddress(transcript);
          // Update address with corrected info
          if (addressParts.address) {
            // If address starts with number, it's likely the street
            if (/^\d/.test(addressParts.address)) {
              data.address = addressParts.address;
              data.city = addressParts.city || data.city;
              data.state = addressParts.state || data.state;
              data.zip = addressParts.zip || data.zip;
              console.log(`✅ Address updated: ${data.address}, ${data.city}`);
              // Ask for availability again
              return {
                nextState: currentState,
                prompt: "Got it. What days and times usually work best for you?",
                action: 'ask'
              };
            } else {
              // Might be just the street name correction (e.g., "Elf" instead of "Elk")
              // Update just the street name part
              const existingAddress = data.address || '';
              const existingCity = data.city || '';
              // If we have existing address, try to replace street name
              if (existingAddress.includes('Elk') && addressParts.address.toLowerCase().includes('elf')) {
                data.address = existingAddress.replace(/Elk/gi, 'Elf');
                console.log(`✅ Street name corrected: ${data.address}`);
                return {
                  nextState: currentState,
                  prompt: "Got it, Elf Road. What days and times usually work best for you?",
                  action: 'ask'
                };
              }
            }
          }
        }
        
        if (transcript.length > 2 && looksLikeAvailability(lowerTranscript)) {
          const extracted = extractAvailability(transcript);
          let availabilityConfidencePercent = 80; // Default; reduce for hesitation
          if (/\b(um|uh|er|hmm|like|maybe|i think|i guess)\b/.test(lowerTranscript)) {
            availabilityConfidencePercent = adjustConfidence(availabilityConfidencePercent, 'hesitation');
            console.log(`📉 Availability confidence reduced due to hesitation: ${availabilityConfidencePercent}%`);
          }
          data.availability_confidence = availabilityConfidencePercent;
          console.log(`📋 Availability: ${extracted} (confidence: ${availabilityConfidencePercent}%)`);

          if (availabilityConfidencePercent >= CONFIDENCE_THRESHOLD) {
            data.availability = extracted;
            data._availabilityComplete = true;
            return { nextState: transitionTo(STATES.CONFIRMATION), prompt: getConfirmationPrompt(), action: 'confirm' };
          }
          // Below threshold: immediate confirmation, read-back only (no spelling)
          pendingClarification = { field: 'availability', value: extracted, confidence: availabilityConfidencePercent, awaitingConfirmation: true };
          return { nextState: currentState, prompt: `I have ${extracted}. Is that right?`, action: 'ask' };
        }
        // If vague, ask follow-up
        if (isVagueAvailability(lowerTranscript)) {
          return {
            nextState: currentState,
            prompt: AVAILABILITY.clarify_time,
            action: 'ask'
          };
        }
        // If doesn't look like availability, ask again
        if (!looksLikeAvailability(lowerTranscript)) {
          return {
            nextState: currentState,
            prompt: "I didn't catch that. What days and times usually work best for you?",
            action: 'ask'
          };
        }
        return {
          nextState: currentState,
          prompt: AVAILABILITY.ask,
          action: 'ask'
        };
        
      case STATES.CONFIRMATION:
        // Mark that confirmation prompt was delivered (for completion tracking)
        data._confirmationDelivered = true;
        
        // CRITICAL: Handle corrections more intelligently
        // Check for "My first name is X, last name is Y" pattern first
        if (/my\s+first\s+name\s+is/i.test(transcript) || /first\s+name\s+is/i.test(transcript)) {
          const nameExtract = extractName(transcript);
          if (nameExtract.firstName) {
            data.firstName = nameExtract.firstName;
            console.log(`✅ First name corrected to: ${data.firstName}`);
          }
          if (nameExtract.lastName) {
            data.lastName = nameExtract.lastName;
            console.log(`✅ Last name corrected to: ${data.lastName}`);
          }
          if (nameExtract.firstName || nameExtract.lastName) {
            return {
              nextState: currentState,
              prompt: getConfirmationPrompt(),
              action: 'confirm'
            };
          }
        }
        
        // Handle "last name is X" separately
        if ((lowerTranscript.includes('last name') || lowerTranscript.includes('lastname')) && 
            !lowerTranscript.includes('first name')) {
          // Extract just the last name part
          const lastNameMatch = transcript.match(/(?:last\s+name\s+is|lastname\s+is)\s+([^,]+)/i);
          if (lastNameMatch) {
            const lastNameText = lastNameMatch[1].trim().replace(/[.,!?]+$/, '');
            // If it contains "and my address", split it
            if (lastNameText.includes(' and ')) {
              const parts = lastNameText.split(/\s+and\s+/i);
              data.lastName = parts[0].trim();
              // Check if second part is address
              if (parts[1] && (parts[1].includes('address') || parts[1].includes('road') || parts[1].includes('street'))) {
                const addressParts = extractAddress(parts[1]);
                if (addressParts.address) {
                  data.address = addressParts.address;
                  data.city = addressParts.city || data.city;
                }
              }
            } else {
              data.lastName = lastNameText;
            }
            console.log(`✅ Last name corrected to: ${data.lastName}`);
            return {
              nextState: currentState,
              prompt: getConfirmationPrompt(),
              action: 'confirm'
            };
          }
        }
        
        // Handle address corrections
        if (lowerTranscript.includes('address') || lowerTranscript.includes('street') || lowerTranscript.includes('road')) {
          // Extract address from transcript, but be careful not to extract name parts
          const addressMatch = transcript.match(/(?:address\s+is|street\s+is|road\s+is|my\s+address\s+is)\s+([^,]+)/i);
          if (addressMatch) {
            const addressParts = extractAddress(addressMatch[1]);
            if (addressParts.address) {
              data.address = addressParts.address;
              data.city = addressParts.city || data.city;
              data.state = addressParts.state || data.state;
              data.zip = addressParts.zip || data.zip;
              console.log(`✅ Address corrected: ${data.address}, ${data.city}`);
              return {
                nextState: currentState,
                prompt: getConfirmationPrompt(),
                action: 'confirm'
              };
            }
          }
        }
        
        if (isConfirmation(lowerTranscript)) {
          // User confirmed - immediately proceed to CLOSE
          return {
            nextState: transitionTo(STATES.CLOSE),
            prompt: CLOSE.anything_else,
            action: 'ask'
          };
        }
        if (isCorrection(lowerTranscript)) {
          confirmationAttempts++;
          // Return a prompt asking what needs to be corrected
          return {
            nextState: currentState,
            prompt: "What needs to be corrected?",
            action: 'ask'
          };
        }
        // If user says "no" or gives a partial response, re-ask verification
        if (lowerTranscript.includes('no') || lowerTranscript.includes('not') || lowerTranscript.length < 3) {
          return {
            nextState: currentState,
            prompt: CONFIRMATION.verify,
            action: 'ask'
          };
        }
        // Default: wait for clearer confirmation
        return {
          nextState: currentState,
          prompt: CONFIRMATION.verify,
          action: 'ask'
        };
        
      case STATES.CLOSE:
        // Mark that close state was reached
        data._closeStateReached = true;
        
        if (hasMoreQuestions(lowerTranscript)) {
          return {
            nextState: currentState,
            prompt: null,
            action: 'answer_question'
          };
        }
        // If user says no, nothing else, or gives a short response, deliver goodbye immediately
        if (lowerTranscript.includes('no') || lowerTranscript.includes('nothing') || 
            lowerTranscript === 'no thanks' || lowerTranscript === 'no thank you' ||
            lowerTranscript.length < 3) {
          return {
            nextState: transitionTo(STATES.ENDED),
            prompt: CLOSE.goodbye,
            action: 'end_call'
          };
        }
        // If user says yes, wait to see what they need, otherwise deliver goodbye after a pause
        // For now, default to goodbye after asking once
        if (lowerTranscript.length > 3) {
          // User has more questions - answer it (handled by answer_question action)
          return {
            nextState: currentState,
            prompt: null,
            action: 'answer_question'
          };
        }
        // Default: deliver goodbye
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
    // Skip safety for: HVAC_INSTALLATION, MEMBERSHIP, EXISTING_PROJECT, OTHER
    // and for new generator installations
    if (data.intent === INTENT_TYPES.HVAC_INSTALLATION) return false;
    if (data.intent === INTENT_TYPES.MEMBERSHIP) return false;
    if (data.intent === INTENT_TYPES.EXISTING_PROJECT) return false;
    if (data.intent === INTENT_TYPES.OTHER) return false;
    
    // For generators, only need safety check if it's for service (not new installation)
    if (data.intent === INTENT_TYPES.GENERATOR) {
      return !isGeneratorInstallation();
    }
    
    // HVAC_SERVICE always needs safety check
    return data.intent === INTENT_TYPES.HVAC_SERVICE;
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
    // Check if user is asking for "the question before that" (wants to go back)
    const wantsToGoBack = /before that|previous|go back|last question|other question/i.test(transcript);
    
    if (wantsToGoBack && previousState) {
      console.log(`📋 Going back to previous state: ${previousState}`);
      // Actually go back to the previous state
      const targetState = previousState;
      previousState = null; // Clear so we don't keep going back
      currentState = targetState;
      
      // Get the prompt for that state
      let prompt = '';
      switch (targetState) {
        case STATES.SAFETY_CHECK:
          prompt = SAFETY.check;
          break;
        case STATES.NAME:
          prompt = CALLER_INFO.name;
          break;
        case STATES.PHONE:
          prompt = CALLER_INFO.phone;
          break;
        case STATES.EMAIL:
          prompt = CALLER_INFO.email;
          break;
        case STATES.DETAILS_BRANCH:
          prompt = "Can you tell me more about the issue?";
          break;
        case STATES.ADDRESS:
          prompt = ADDRESS.ask;
          break;
        case STATES.AVAILABILITY:
          prompt = AVAILABILITY.ask;
          break;
        default:
          prompt = "How can I help you?";
      }
      
      return {
        nextState: targetState,
        prompt: prompt,
        action: 'ask'
      };
    }
    
    // Just repeat the current question
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
  
  /**
   * Check if text looks like an actual address (not symptoms, troubleshooting answers, etc.)
   */
  function looksLikeAddress(text) {
    if (!text || text.length < 5) return false;
    
    // Remove filler phrases first (like "That would be", "yeah it's", etc.)
    let cleaned = text
      .replace(/^(yeah\s*,?\s*)?(that\s+would\s+be|that'?s|it'?s|it\s+is|so\s+the|the)\s+/gi, '')
      .trim();
    
    if (cleaned.length < 5) return false;
    
    const lowerText = cleaned.toLowerCase();
    
    // Must have a street number (1-6 digits at start, or after filler removal)
    const hasNumber = /\d{1,6}\s+/.test(cleaned);
    if (!hasNumber) return false;
    
    // Must have a street type indicator
    const hasStreetType = /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd|circle|place|pl|terrace|terr)\b/i.test(cleaned);
    if (!hasStreetType) return false;
    
    // Reject if it contains symptom/problem descriptions
    const symptomPatterns = [
      /\b(blowing|heating|cooling|not working|broken|issue|problem|symptom|error|fault)\b/i,
      /\b(lukewarm|warm|cold|hot|air|unit|system|hvac|furnace|boiler|running|still)\b/i,
      /\b(just|only|really|very|quite|pretty)\s+(blowing|heating|cooling|working|running)\b/i,
      /\b(pushing|pushing out|blowing out)\s+(lukewarm|warm|cold|hot|air)\b/i,
      /\b(no|not)\s+(hot|cold|warm|air|heat|cooling)\s+(coming|blowing|out)\b/i,
      /\b(has|have|had)\s+(not|no)\b/i,
      /\b(send|sending|technician|someone|person)\b/i,
      /\b(troubleshooting|thermostat|filter|filters)\b/i
    ];
    
    if (symptomPatterns.some(pattern => pattern.test(text))) {
      return false;
    }
    
    // Reject if it's a short answer like "I have not" or "You can send someone"
    const shortAnswers = ['i have not', 'i have', 'you can', 'send someone', 'send', 'someone else'];
    if (shortAnswers.some(answer => lowerText.includes(answer) && text.length < 30)) {
      return false;
    }
    
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
  
  /**
   * Normalize spelled name: convert "V-A-N space C-A-U-W-E-N-B-E-R-G-E" to "Van Cauwenberge"
   */
  function normalizeSpelledName(text) {
    if (!text) return '';
    
    // Remove filler phrases first
    let cleaned = text
      .replace(/^(yeah\s*,?\s*)?(that\s+would\s+be|that'?s|it'?s|it\s+is|this\s+is|my\s+name\s+is|the\s+name\s+is|name'?s)\s*/gi, '')
      .trim();
    
    // Check if this contains spelled letters (pattern: single letters separated by spaces, dashes, or periods)
    // Also handle "space" as a word separator
    const hasSpelledPattern = /([A-Z])(?:\s*[-.\s]+\s*([A-Z]))+/i.test(cleaned) || 
                               /\b([A-Z])\s+([A-Z])\s+([A-Z])\b/i.test(cleaned);
    
    if (hasSpelledPattern) {
      // CRITICAL: Handle "space" as word separator
      // "V-A-N space C-A-U-W-E-N-B-E-R-G-E" should become lastName: "Van Cauwenberge" (two words)
      const spaceIndex = cleaned.toLowerCase().indexOf(' space ');
      if (spaceIndex > 0) {
        // Split at "space"
        const firstPart = cleaned.substring(0, spaceIndex);
        const lastPart = cleaned.substring(spaceIndex + 7); // " space " is 7 chars
        
        // Extract letters from first part (if provided, usually empty if user already gave first name)
        const firstNameLetters = firstPart.match(/[A-Z]/gi) || [];
        
        // Extract letters from last part - handle spaces within last name (e.g., "C-A-U W-E-N B-E-R-G-E")
        // Split last part by spaces to preserve word boundaries
        const lastPartWords = lastPart.split(/\s+/).filter(w => w.trim().length > 0);
        const lastNameParts = [];
        
        for (const word of lastPartWords) {
          // Extract letters from this word segment
          const letters = word.match(/[A-Z]/gi) || [];
          if (letters.length > 0) {
            const combined = letters.join('');
            const formatted = combined.charAt(0).toUpperCase() + combined.slice(1).toLowerCase();
            lastNameParts.push(formatted);
          }
        }
        
        const formattedFirstName = firstNameLetters.length > 0
          ? firstNameLetters.join('').charAt(0).toUpperCase() + firstNameLetters.join('').slice(1).toLowerCase()
          : '';
        const formattedLastName = lastNameParts.join(' ');
        
        if (formattedFirstName && formattedLastName) {
          return {
            firstName: formattedFirstName,
            lastName: formattedLastName
          };
        } else if (formattedLastName) {
          // Only last name (first name was already provided)
          return {
            firstName: '',
            lastName: formattedLastName
          };
        }
      }
      
      // No "space" separator - extract all letters as one name
      // But check for natural word boundaries (spaces within the spelled portion)
      const words = cleaned.split(/\s+/).filter(w => w.trim().length > 0);
      if (words.length > 1) {
        // Multiple words detected - last word is likely the last name
        const allLetters = words.flatMap(w => w.match(/[A-Z]/gi) || []);
        const lastWord = words[words.length - 1];
        const lastWordLetters = lastWord.match(/[A-Z]/gi) || [];
        
        if (lastWordLetters.length > 0) {
          const formattedLastName = lastWordLetters.join('').charAt(0).toUpperCase() + 
                                    lastWordLetters.join('').slice(1).toLowerCase();
          return {
            firstName: '',
            lastName: formattedLastName
          };
        }
      }
      
      // Single word - extract all letters
      const allLetters = cleaned.match(/[A-Z]/gi) || [];
      if (allLetters.length >= 2) {
        const combined = allLetters.join('');
        return {
          firstName: '',
          lastName: combined.charAt(0).toUpperCase() + combined.slice(1).toLowerCase()
        };
      }
    }
    
    return null; // Not a spelled name
  }
  
  function extractName(text) {
    if (!text || text.trim().length < 2) {
      return { firstName: '', lastName: '' };
    }
    
    let name = text.trim();
    
    // STEP 1: Remove ALL filler phrases FIRST (combined pass)
    // This handles: "Yeah, that would be Jimmy Crickets"
    // Pattern: optional fillers, then optional phrases like "that would be"
    const fillerPatterns = [
      /^(yeah|yes|yep|yup|oh|um|uh|so|well|okay|ok|alright|sure)[,.]?\s*/gi,
      /^(that\s+would\s+be|that'?s|it'?s|it\s+is|this\s+is|i'?m|i\s+am|my\s+name\s+is|the\s+name\s+is|name'?s)\s*/gi
    ];
    
    // Apply filler removal multiple times to handle stacked patterns
    for (let i = 0; i < 3; i++) {
      for (const pattern of fillerPatterns) {
        name = name.replace(pattern, '');
      }
    }
    
    // STEP 2: Check for "My first name is X, last name is Y" pattern
    if (/first\s+name\s+is/i.test(name) && /last\s+name\s+is/i.test(name)) {
      const firstNameMatch = name.match(/first\s+name\s+is\s+([^,]+)/i);
      const lastNameMatch = name.match(/last\s+name\s+is\s+([^,.\s]+)/i);
      if (firstNameMatch && lastNameMatch) {
        return {
          firstName: firstNameMatch[1].trim().replace(/[.,!?]+$/g, ''),
          lastName: lastNameMatch[1].trim().replace(/[.,!?]+$/g, '')
        };
      }
    }
    
    // STEP 3: Check if it's a spelled name (only if it looks like spelled letters)
    // Pattern: individual letters separated by dashes, spaces, or dots
    const looksSpelled = /^([A-Z][-.\s]+){2,}/i.test(name) || /\bspace\b/i.test(name);
    if (looksSpelled) {
      const spelledResult = normalizeSpelledName(text);
      if (spelledResult && (spelledResult.firstName || spelledResult.lastName)) {
        return spelledResult;
      }
    }
    
    // STEP 4: Clean up remaining artifacts
    name = name.replace(/\b(space|dash|hyphen)\b/gi, ''); // Remove spelling tokens
    name = name.replace(/[.,!?]+$/g, '');                 // Remove trailing punctuation
    name = name.replace(/^[,.\s]+|[,.\s]+$/g, '').trim(); // Clean edges
    
    // If we stripped everything, return empty
    if (!name || name.length < 2) {
      return { firstName: '', lastName: '' };
    }
    
    // STEP 5: Split into first and last name
    const parts = name.split(/\s+/).filter(p => p.length > 0);
    
    if (parts.length >= 2) {
      // Check if second part is a common name prefix (Van, De, La, etc.)
      const prefixes = ['van', 'de', 'la', 'le', 'du', 'von', 'der', 'da', 'di', 'del', 'della', 'dos', 'das', 'do', 'mac', 'mc', 'o\'', 'o'];
      const secondWord = parts[1].toLowerCase().replace(/[.,!?]+$/, '');
      
      if (prefixes.includes(secondWord) && parts.length >= 3) {
        // Multi-part last name with prefix: "Tim Van Kallenberg"
        return {
          firstName: parts[0],
          lastName: parts.slice(1).join(' ')
        };
      }
      
      // Check for hyphenated last names or O'Brien style
      if (parts.length === 2 && (parts[1].includes('-') || parts[1].includes('\''))) {
        return {
          firstName: parts[0],
          lastName: parts[1]
        };
      }
      
      // Normal case: "Jimmy Crickets" → firstName: "Jimmy", lastName: "Crickets"
      return {
        firstName: parts[0],
        lastName: parts.slice(1).join(' ')
      };
    }
    
    // Single word: treat as first name
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
      // CRITICAL: Format to avoid mishearing "973" as "793"
      // Use clear digit separation: "nine seven three" not "nine hundred seventy three"
      const area = last10.slice(0,3);
      const exchange = last10.slice(3,6);
      const number = last10.slice(6);
      
      // Spell out digits individually for clarity, especially for area code
      const digitNames = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
      
      // Format area code: "nine seven three" (not "nine seventy three")
      const formatAreaCode = (code) => {
        return code.split('').map(d => digitNames[parseInt(d)]).join(' ');
      };
      
      // Format exchange and number: "eight eight five" and "two five two eight"
      const formatNumber = (num) => {
        return num.split('').map(d => digitNames[parseInt(d)]).join(' ');
      };
      
      return `${formatAreaCode(area)}, ${formatNumber(exchange)}, ${formatNumber(number)}`;
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
    
    // Trim trailing punctuation (periods, commas, etc.)
    email = email.replace(/[.,;:!?]+$/, '');
    
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
  
  /**
   * Normalize spelled words in address text (e.g., "E L F" → "Elf", "ELF" → "Elf")
   */
  function normalizeSpelledWordsInAddress(text) {
    if (!text) return text;
    
    // Pattern: Match sequences of single uppercase letters separated by spaces, dashes, or periods
    // Examples: "E L F", "E-L-F", "E. L. F.", "ELF" (all caps)
    const pattern = /\b([A-Z])(?:\s*[-.\s]+\s*([A-Z]))(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?\b/g;
    
    let result = text;
    
    // First, handle all-caps words that might be spelled (like "ELF")
    result = result.replace(/\b([A-Z]{2,15})\b/g, (match) => {
      // If it's a short all-caps word (likely spelled), normalize it
      if (match.length >= 2 && match.length <= 15) {
        return match.charAt(0) + match.slice(1).toLowerCase();
      }
      return match;
    });
    
    // Then handle spaced/dashed spelled words
    result = result.replace(pattern, (match) => {
      const letters = match.match(/\b([A-Z])\b/g);
      if (letters && letters.length >= 2 && letters.length <= 15) {
        const word = letters.join('').toLowerCase();
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return match;
    });
    
    return result;
  }
  
  /**
   * Extract state and zip code from a response
   * Used when we already have the street address and asked for state/zip
   */
  function extractStateAndZip(text) {
    const result = { state: null, zip: null };
    
    // Remove filler phrases
    let cleaned = text
      .replace(/^(yeah\s*,?\s*)?(sure\s*,?\s*)?(no\s+problem\s*,?\s*)?(that'?s|it'?s|that\s+would\s+be)\s*/gi, '')
      .trim();
    
    // Extract zip code (5 digits)
    const zipMatch = cleaned.match(/\b(\d{5})(?:-?\d{4})?\b/);
    if (zipMatch) {
      result.zip = zipMatch[1];
    }
    
    // Extract state - check for full names and abbreviations
    const stateMap = {
      'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
      'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
      'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
      'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
      'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO',
      'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
      'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
      'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
      'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
      'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY'
    };
    
    const lowerText = cleaned.toLowerCase();
    
    // Check for full state names
    for (const [fullName, abbrev] of Object.entries(stateMap)) {
      if (lowerText.includes(fullName)) {
        result.state = abbrev;
        break;
      }
    }
    
    // Check for state abbreviations (2 uppercase letters)
    if (!result.state) {
      const abbrevMatch = cleaned.match(/\b([A-Z]{2})\b/);
      if (abbrevMatch && Object.values(stateMap).includes(abbrevMatch[1])) {
        result.state = abbrevMatch[1];
      }
    }
    
    return result;
  }
  
  function extractAddress(text) {
    // =========================================================================
    // PRE-CLEANING: Remove filler phrases and duplicates FIRST
    // =========================================================================
    let address = text;
    
    // Remove common filler phrases that appear in the middle of addresses
    const fillerPhrases = [
      /\.\s*yeah[,.]?\s*(i'm|im|i am)?\s*(just)?\s*(saying|telling|giving)\s*(it|that|you)?\s*(right)?\s*now\s*\.?\s*/gi,
      /\.\s*let me (say|give|tell)\s*(it|that|you)?\s*(again)?\s*\.?\s*/gi,
      /\.\s*it\s*(would|will)\s+be\s*/gi,
      /\.\s*that\s+(would|will)\s+be\s*/gi,
      /\.\s*so\s+(it's|its|that's|thats)\s*/gi,
    ];
    
    for (const filler of fillerPhrases) {
      address = address.replace(filler, '. ');
    }
    
    // If address contains multiple sentences with similar street numbers, take the last/cleanest one
    // Split by period and look for duplicate address patterns
    const sentences = address.split(/\.\s+/).filter(s => s.trim().length > 3);
    if (sentences.length > 1) {
      // Look for sentences that start with a number (likely addresses)
      const addressSentences = sentences.filter(s => /^\d+\s+\w/.test(s.trim()));
      if (addressSentences.length > 0) {
        // Take the last address-like sentence (usually the cleaner/repeated one)
        address = addressSentences[addressSentences.length - 1];
      }
    }
    
    // Remove common prefixes and filler phrases
    address = address
      .replace(/^(yeah|yes|oh|um|uh|so|well|okay|ok)[,.]?\s*/gi, '')
      .replace(/^(it would be|that would be|it'?d be|that'?d be)\s*/gi, '')
      .replace(/^(that'?s|it'?s|it\s+is|the\s+address\s+is|address\s+is|my\s+address\s+is)\s*/gi, '')
      .trim();
    
    // Remove "as in" and similar phrases (e.g., "1111, as in 1111 Elf")
    address = address.replace(/\s*,\s*as\s+in\s+/gi, ', ');
    address = address.replace(/\s+as\s+in\s+/gi, ' ');
    
    // Normalize spelled words in address (e.g., "E L F" → "Elf")
    // This handles cases like "11 Elf ELF Road" where "ELF" is spelled out
    address = normalizeSpelledWordsInAddress(address);
    
    // Remove duplicate words (e.g., "1111, as  1111 Elf, Elf, Road" → "1111 Elf Road")
    const words = address.split(/\s+/);
    const cleanedWords = [];
    let lastWord = '';
    for (const word of words) {
      const normalizedWord = word.toLowerCase().replace(/[.,!?]+$/, '');
      if (normalizedWord !== lastWord.toLowerCase() || !lastWord) {
        cleanedWords.push(word);
        lastWord = word;
      }
    }
    address = cleanedWords.join(' ');
    
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
    
    // CRITICAL: Clean trailing punctuation BEFORE splitting
    // This prevents "." or "," from becoming its own part
    address = address.replace(/[.,!?]+$/g, '').trim();
    
    // Extract city (usually after street address, separated by comma)
    // Format: "[Street Address], [City] [, State] [, Zip]"
    let city = null;
    // Split by comma first, filter out empty parts AND punctuation-only parts
    const parts = address.split(',').map(s => s.trim()).filter(s => s.length > 0 && !/^[.,!?]+$/.test(s));
    
    if (parts.length >= 2) {
      // If we have multiple parts, the pattern is: [street], [city], [state], [zip]
      if (state) {
        // State is present - find which part contains it
        const stateIndex = parts.findIndex(p => statePattern.test(p));
        if (stateIndex > 0) {
          // City is the part immediately before state
          city = parts[stateIndex - 1];
        } else if (parts.length >= 2) {
          // State not found in parts but we know it exists, take last non-state part as city
          // If state was removed earlier, last part should be city
          city = parts[parts.length - 1];
        }
      } else {
        // No state found - assume last part is city if we have 2+ parts
        // "11 Elk Road, West Orange" → street: "11 Elk Road", city: "West Orange"
        if (parts.length >= 2) {
          city = parts[parts.length - 1]; // Last part is city
        }
      }
    }
    
    // If no city found via comma split, try to extract it from before state
    if (!city && state) {
      const beforeState = address.substring(0, address.indexOf(stateMatch[0])).trim();
      const beforeParts = beforeState.split(',').map(s => s.trim()).filter(s => s.length > 0);
      if (beforeParts.length > 0) {
        city = beforeParts[beforeParts.length - 1];
      }
    }
    
    // Remove city from address text
    // CRITICAL: Use case-insensitive replacement and handle punctuation
    if (city) {
      // Remove city (case-insensitive) and any surrounding punctuation
      const cityRegex = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      address = address.replace(cityRegex, '').trim();
      // Also remove comma if it's still there
      address = address.replace(/^,\s*|,\s*$/g, '').trim();
    }
    
    // Clean up address (remove extra commas, spaces, trailing punctuation)
    address = address.replace(/^[,.\s]+|[,.\s]+$/g, '').trim();
    
    // CRITICAL: If address and city seem swapped (address has city name, city has street), swap them back
    // Pattern: if address looks like a city name (no numbers, common city words) and city has numbers (street)
    if (address && city) {
      const addressHasStreetNumber = /^\d/.test(address);
      const cityHasStreetNumber = /^\d/.test(city);
      
      if (!addressHasStreetNumber && cityHasStreetNumber) {
        // Address doesn't have number but city does - they're swapped!
        console.log(`⚠️  Address and city appear swapped: address="${address}", city="${city}" - swapping`);
        const temp = address;
        address = city;
        city = temp;
      }
    }
    
    // If address is empty but we have other parts, reconstruct from original text
    if (!address && (city || state || zip)) {
      // Reconstruct: remove city, state, zip from original
      let reconstructed = text
        .replace(/^(yeah\s*,?\s*)?(that\s+would\s+be|that'?s|it'?s|it\s+is|the\s+address\s+is|address\s+is|my\s+address\s+is)\s*/gi, '')
        .trim();
      if (zip) reconstructed = reconstructed.replace(zipMatch[0], '').trim();
      if (state) reconstructed = reconstructed.replace(statePattern, '').trim();
      if (city) {
        reconstructed = reconstructed.replace(new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim();
        reconstructed = reconstructed.replace(/^,\s*|,\s*$/g, '').trim();
      }
      address = reconstructed.replace(/^[,.\s]+|[,.\s]+$/g, '').trim();
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
    // Remove filler phrases like "I would say", "that would be", etc.
    let cleaned = text
      .replace(/^(yeah|yes|oh|um|uh|so|well|okay|ok)[,.]?\s*/gi, '')
      .replace(/^(i would say|i'd say|that would be|it would be|probably|maybe)\s*/gi, '')
      .replace(/^(i'm available|i can do|works for me|best for me is)\s*/gi, '')
      .trim();
    
    return cleaned;
  }
  
  function looksLikeAvailability(text) {
    if (!text || text.length < 3) return false;
    
    const lower = text.toLowerCase();
    
    // Patterns that indicate availability
    const availabilityPatterns = [
      /\b(weekday|weekdays|monday|tuesday|wednesday|thursday|friday|weekend|saturday|sunday)\b/i,
      /\b(morning|afternoon|evening|morning|pm|am)\b/i,
      /\b(after|before|between)\s+\d/i,
      /\b(available|availability|best time|work|convenient)\b/i,
      /\b\d+\s*(pm|am|o'clock|oclock)\b/i,
      /\bnext\s+(week|month)\b/i,
      /\b(specific time|prefer|preference)\b/i
    ];
    
    return availabilityPatterns.some(pattern => pattern.test(text));
  }
  
  function isAlreadyProvidedResponse(text) {
    if (!text || text.length < 3) return false;
    
    const lower = text.toLowerCase();
    
    // Patterns that indicate they already provided info
    const alreadyPatterns = [
      /\b(already|already gave|already said|already told|already mentioned)\b/i,
      /\b(we already|we went over|we covered|we did|we discussed)\b/i,
      /\b(same|that one|the same|this one)\b/i,
      /\b(same number|same phone|same address)\b/i,
      /\b(calling from|number i'm|this number|my number)\b/i
    ];
    
    return alreadyPatterns.some(pattern => pattern.test(text));
  }
  
  function isVagueAvailability(text) {
    const vaguePatterns = ['anytime', 'whenever', 'flexible', 'any day', 'any time'];
    return vaguePatterns.some(p => text.includes(p)) && 
           !text.includes('morning') && 
           !text.includes('afternoon') && 
           !text.includes('evening');
  }
  
  /**
   * Normalize system type: clean up filler phrases and map to canonical values
   * Examples: "Oh, it's central here" → "central air", "central ac" → "central air"
   */
  function normalizeSystemType(systemType) {
    if (!systemType) return '';
    
    // Remove filler phrases first
    let cleaned = systemType
      .replace(/^(oh|uh|um|er|ah|yeah|yes|well|so)\s*,?\s*/gi, '')
      .replace(/\b(it'?s|it\s+is|that'?s|that\s+is|here|there)\b/gi, '')
      .trim();
    
    const normalized = cleaned.toLowerCase();
    
    // Map common variations to canonical values
    const systemTypeMap = {
      'furnace': 'furnace',
      'boiler': 'boiler',
      'central air': 'central air',
      'central air conditioning': 'central air',
      'central ac': 'central air',
      'central': 'central air',  // "central here" → "central air"
      'heat pump': 'heat pump',
      'mini split': 'mini split',
      'mini-split': 'mini split',
      'ductless': 'mini split',
      'rooftop unit': 'rooftop unit',
      'rtu': 'rooftop unit',
      'packaged unit': 'packaged unit',
      'package unit': 'packaged unit',
      'ac': 'central air',
      'air conditioning': 'central air',
      'air conditioner': 'central air',
      'air': 'central air'  // If just "air", assume central air
    };
    
    // Check for exact matches first
    if (systemTypeMap[normalized]) {
      return systemTypeMap[normalized];
    }
    
    // Check for partial matches (e.g., "central here" contains "central")
    for (const [key, value] of Object.entries(systemTypeMap)) {
      if (normalized.includes(key) || key.includes(normalized)) {
        return value;
      }
    }
    
    // Return cleaned version if no match
    return cleaned;
  }
  
  function storeDetailAnswer(text, analysis) {
    const questions = getDetailQuestions();
    const currentQuestion = questions[detailsQuestionIndex];
    
    if (data.intent === INTENT_TYPES.HVAC_SERVICE) {
      if (currentQuestion === DETAILS.hvac_service.system_type) {
        // Normalize system type: "Oh, it's central here" → "central air"
        data.details.systemType = normalizeSystemType(text);
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
        // Normalize system type
        data.details.systemType = normalizeSystemType(text);
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
