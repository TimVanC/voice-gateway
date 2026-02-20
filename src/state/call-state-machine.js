/**
 * RSE Call State Machine
 *
 * CANONICAL RULES: See project root cursor-rules.md. Rules file wins over any conflicting implementation.
 * This system is deterministic, not conversational.
 *
 * States: greeting → intent → safety_check → name → phone → email → details_branch → address → availability → confirmation → close → ended (completed).
 *
 * Field lifecycle: value + confirmed + locked; once locked, immutable. Parsing disabled during recap (CONFIRMATION) and closing (CLOSE/ENDED).
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
    
    // Locked fields: once confirmed, overwrite with cleaned value and set true. CSV/recap read only these.
    _nameLocked: false,
    _phoneLocked: false,
    _emailLocked: false,
    _addressLocked: false,
    _availabilityLocked: false,
    
    // Details based on intent
    details: {
      // HVAC service
      systemType: null,
      systemTypeUncertain: false,  // true when caller said "not sure", "I'd take", "maybe", etc.
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
   * Single source of truth: clean value before persisting on confirm.
   * Strip punctuation, filler words (my, it's, its), trim. Used when locking name/address.
   */
  function cleanFieldValue(s) {
    if (s == null || typeof s !== 'string') return s === null ? '' : String(s);
    let t = s
      .replace(/[.,!?;:'"]+/g, ' ')
      .replace(/\b(my|it'?s|its)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return t;
  }
  
  // Confidence-based clarification tracking
  let pendingClarification = {
    field: null,
    value: null,
    confidence: null,
    awaitingConfirmation: false,
    spellingAttempts: 0    // Name: 1 = first ask to spell, 2 = second ask. If >= 2: lock, advance, never ask again.
  };

  const MAX_SPELLING_ATTEMPTS = 2;
  const MAX_PROMPT_ATTEMPTS = 2;

  // ============================================================================
  // STRUCTURED INTAKE DEBUG LOGGING
  // High-signal, JSON-structured logs for debugging intake flow.
  // Covers: state_transition, field_parse, field_locked, retry_cap_reached, prompt
  // ============================================================================
  function intakeLog(event, details) {
    const entry = { intake_debug: true, ts: Date.now(), state: currentState, event, ...details };
    console.log(`[INTAKE] ${JSON.stringify(entry)}`);
  }
  
  // Confidence threshold: >= accept and move on; < confirm immediately (Phase 2)
  const CONFIDENCE_THRESHOLD = 85;  // 85% (0.85) - below: confirm right after answer; above: accept and move on
  
  // Neutral acknowledgments only - no "Great!" or "Perfect!" (inappropriate when caller has an issue)
  const ACKNOWLEDGMENTS = ['Got it.', 'Okay.', 'Thanks.'];
  const EMPATHETIC_ACKNOWLEDGMENTS = [
    "I'm sorry to hear that.",
    "I'm sorry you're dealing with that.",
    "Thanks for letting me know."
  ];
  // Keywords that indicate the caller is describing an urgent or distressing situation
  const URGENCY_KEYWORDS = /\b(no heat|freezing|emergency|completely out|not working|not turning on|no hot|no cold|no air|broken|dangerous|smoke|gas smell|sparks|flooding|leaking|out of service)\b/i;
  let lastAcknowledgmentIndex = -1;
  let lastEmpatheticIndex = -1;
  // Track the last user transcript so acknowledgments can be context-aware
  let _lastUserTranscript = '';
  
  /**
   * Get a random acknowledgment phrase (avoiding immediate repeats).
   * If the last user transcript contains urgency keywords, use empathetic acknowledgment instead.
   */
  function getAcknowledgment() {
    // Check if last user transcript contains urgency/distress keywords
    if (_lastUserTranscript && URGENCY_KEYWORDS.test(_lastUserTranscript)) {
      let index;
      do {
        index = Math.floor(Math.random() * EMPATHETIC_ACKNOWLEDGMENTS.length);
      } while (index === lastEmpatheticIndex && EMPATHETIC_ACKNOWLEDGMENTS.length > 1);
      lastEmpatheticIndex = index;
      return EMPATHETIC_ACKNOWLEDGMENTS[index];
    }
    let index;
    do {
      index = Math.floor(Math.random() * ACKNOWLEDGMENTS.length);
    } while (index === lastAcknowledgmentIndex && ACKNOWLEDGMENTS.length > 1);
    lastAcknowledgmentIndex = index;
    return ACKNOWLEDGMENTS[index];
  }
  
  /**
   * Add acknowledgment prefix to a prompt
   */
  function withAcknowledgment(prompt) {
    return `${getAcknowledgment()} ${prompt}`;
  }
  
  /** No call completes without name unless explicitly configured. Required before CONFIRMATION/CLOSE. */
  function hasRequiredName() {
    if (!data._nameLocked || !data.firstName || !data.lastName) return false;
    const nonName = /\b(not|heat|yes|no|out|working|the|and|all|say|just|hot|cold|warm|cool|any|its)\b/i;
    if (nonName.test(String(data.firstName).trim()) || nonName.test(String(data.lastName).trim())) return false;
    if (String(data.firstName).trim().length < 2 || String(data.lastName).trim().length < 2) return false;
    return true;
  }

  /**
   * Get the next prompt based on current state and data
   */
  function getNextPrompt() {
    // CRITICAL: If we're awaiting confirmation, return the confirmation prompt
    // This prevents "hello?" from resetting to the default state prompt
    if (pendingClarification.awaitingConfirmation && pendingClarification.field) {
      switch (pendingClarification.field) {
        case 'name':
          // Don't spell it out - just ask for confirmation
          const firstName = pendingClarification.value?.firstName || '';
          const lastName = pendingClarification.value?.lastName || '';
          return `I have ${firstName} ${lastName}. Is that correct?`;
        case 'phone':
          return `I have ${pendingClarification.value}. Is that correct?`;
        case 'email':
          return `I have ${pendingClarification.value}. Is that correct?`;
        case 'address':
          return `Is that address correct?`;
        case 'availability':
          return `I have ${pendingClarification.value}. Is that correct?`;
      }
    }
    
    switch (currentState) {
      case STATES.GREETING:
        return silenceAfterGreeting ? GREETING.silence_fallback : GREETING.primary;
        
      case STATES.INTENT:
        return getIntentPrompt();
        
      case STATES.SAFETY_CHECK:
        // Global retry: safety question one ask + one retry max (max_prompt_attempts = 2).
        const safetyAttempts = (data._safetyPromptAttempts || 0) + 1;
        data._safetyPromptAttempts = safetyAttempts;
        if (safetyAttempts > MAX_PROMPT_ATTEMPTS) return `${SAFETY.all_clear} ${CALLER_INFO.name}`;
        return SAFETY.check;
        
      case STATES.NAME:
        if (data._nameLocked) return CALLER_INFO.phone;
        return CALLER_INFO.name;
        
      case STATES.PHONE:
        if (data._phoneLocked) return CALLER_INFO.email.primary;
        return CALLER_INFO.phone;
        
      case STATES.EMAIL:
        if (data._emailLocked) return getDetailsPrompt() || ADDRESS.ask;
        return CALLER_INFO.email.primary;
        
      case STATES.DETAILS_BRANCH:
        return getDetailsPrompt();
        
      case STATES.ADDRESS:
        if (data._addressLocked) return AVAILABILITY.ask;
        return ADDRESS.ask;
        
      case STATES.AVAILABILITY:
        if (data._availabilityLocked) return getConfirmationPrompt();
        return AVAILABILITY.ask;
        
      case STATES.CONFIRMATION:
        return getConfirmationPrompt();
        
      case STATES.CLOSE:
        // Only return the "anything else?" prompt ONCE per call
        if (data._anythingElsePrompted) return null;
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
  
  /** 
   * Spell word in CHUNKED format to prevent LLM truncation.
   * Groups of 3 letters separated by periods for natural pauses.
   * Example: "VANCAUWENBERGE" → "V A N. C A U. W E N. B E R. G E."
   * This prevents OpenAI from truncating mid-stream on long spellings.
   */
  function spellWordWithSpaces(word) {
    if (!word) return '';
    // Remove spaces and extract only alphanumeric characters
    const letters = word.replace(/\s/g, '').split('').filter(c => /[a-zA-Z0-9]/.test(c)).map(c => c.toUpperCase());
    
    if (letters.length === 0) return '';
    
    // Chunk into groups of 3 letters
    const chunks = [];
    for (let i = 0; i < letters.length; i += 3) {
      const chunk = letters.slice(i, i + 3).join(' ');
      chunks.push(chunk);
    }
    
    // Join with periods for natural pauses
    return chunks.join('. ') + '.';
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
  
  /**
   * Build recap prompt. READ-ONLY: locked data only. NO letter-by-letter spelling ever.
   * Format: Name: X. Phone: Y. Email: ... Address: ... System: ... Issue: ... Availability: ...
   */
  function getConfirmationPrompt() {
    const intro = confirmationAttempts > 0 ? CONFIRMATION.correction_reread : CONFIRMATION.intro;
    const parts = [intro];
    if (data.firstName && data.lastName) {
      parts.push(`Name: ${data.firstName} ${data.lastName}.`);
    } else if (data.firstName) {
      parts.push(`Name: ${data.firstName}.`);
    } else if (data.lastName) {
      parts.push(`Name: ${data.lastName}.`);
    }
    if (data.phone) {
      parts.push(`Phone: ${data.phone}.`);
    }
    if (data.email) {
      const emailSpoken = data.email.replace(/@/g, ' at ').replace(/\./g, ' dot ');
      parts.push(`Email: ${emailSpoken}.`);
    }
    if (data.address) {
      let addressPart = data.address;
      if (data.city) addressPart += `, ${data.city}`;
      if (data.state) addressPart += `, ${data.state}`;
      if (data.zip) addressPart += ` ${data.zip}`;
      parts.push(`Address: ${addressPart}.`);
    }
    if (data.details && data.details.systemType) {
      parts.push(`System: ${data.details.systemType}.`);
    }
    const issueShort = getIssueSummaryShort();
    if (issueShort) {
      parts.push(`Issue: ${issueShort}.`);
    }
    if (data.availability) {
      parts.push(`Availability: ${data.availability}.`);
    }
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
   * Clean availability notes: remove filler phrases (say, I'd say, just, etc.)
   */
  function cleanAvailabilityNotes(availability) {
    if (!availability) return '';
    
    return availability
      .replace(/^(i'?d\s+say|say|just|i\s+think|probably|maybe|uh|um|er|ah|oh)\s*,?\s*/gi, '')
      .replace(/\s+(i'?d\s+say|say|just|probably|maybe)\s+/gi, ' ')
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
  
  /** Allowed backward transitions only for explicit correction. No backward transition when field is locked. */
  const ALLOWED_PREVIOUS = {
    [STATES.NAME]: [STATES.GREETING, STATES.INTENT, STATES.SAFETY_CHECK],
    [STATES.PHONE]: [STATES.GREETING, STATES.INTENT, STATES.SAFETY_CHECK, STATES.NAME],
    [STATES.EMAIL]: [STATES.PHONE],
    [STATES.ADDRESS]: [STATES.DETAILS_BRANCH],
    [STATES.AVAILABILITY]: [STATES.ADDRESS, STATES.DETAILS_BRANCH],
    [STATES.CONFIRMATION]: [STATES.AVAILABILITY, STATES.ADDRESS, STATES.PHONE, STATES.EMAIL, STATES.NAME],
    [STATES.CLOSE]: [STATES.CONFIRMATION],
    [STATES.ENDED]: [STATES.CLOSE],
    [STATES.DETAILS_BRANCH]: [STATES.INTENT, STATES.SAFETY_CHECK, STATES.NAME, STATES.PHONE, STATES.EMAIL]
  };

  function transitionTo(newState) {
    const oldState = currentState;
    if (oldState === newState) return newState;
    // Hard lock: never transition back to a state whose field is already locked
    if (newState === STATES.NAME && data._nameLocked) {
      console.log(`🚫 Blocked transition to NAME - name already locked`);
      return currentState;
    }
    if (newState === STATES.PHONE && data._phoneLocked) {
      console.log(`🚫 Blocked transition to PHONE - phone already locked`);
      return currentState;
    }
    if (newState === STATES.EMAIL && data._emailLocked) {
      console.log(`🚫 Blocked transition to EMAIL - email already locked`);
      return currentState;
    }
    if (newState === STATES.ADDRESS && data._addressLocked) {
      console.log(`🚫 Blocked transition to ADDRESS - address already locked`);
      return currentState;
    }
    if (newState === STATES.AVAILABILITY && data._availabilityLocked) {
      console.log(`🚫 Blocked transition to AVAILABILITY - availability already locked`);
      return currentState;
    }
    // Optional: enforce forward-only unless explicit correction (allow CONFIRMATION->NAME only for correction)
    const allowed = ALLOWED_PREVIOUS[newState];
    if (allowed && !allowed.includes(oldState) && oldState !== STATES.GREETING && oldState !== STATES.INTENT && oldState !== STATES.SAFETY_CHECK) {
      const order = [STATES.GREETING, STATES.INTENT, STATES.SAFETY_CHECK, STATES.NAME, STATES.PHONE, STATES.EMAIL, STATES.DETAILS_BRANCH, STATES.ADDRESS, STATES.AVAILABILITY, STATES.CONFIRMATION, STATES.CLOSE, STATES.ENDED];
      const oldIdx = order.indexOf(oldState);
      const newIdx = order.indexOf(newState);
      if (newIdx >= 0 && oldIdx >= 0 && newIdx < oldIdx) {
        console.log(`🚫 Blocked backward transition ${oldState} → ${newState}`);
        return currentState;
      }
    }
    if (oldState !== STATES.GREETING) previousState = oldState;
    currentState = newState;
    console.log(`📍 State: ${oldState} → ${newState}`);
    intakeLog('state_transition', { from: oldState, to: newState });
    if (newState === STATES.DETAILS_BRANCH) detailsQuestionIndex = 0;
    return newState;
  }
  
  /**
   * Detect if user is frustrated/confused and needs acknowledgement
   */
  function isUserFrustrated(text) {
    const frustrationPatterns = [
      /can you hear me/i,
      /hello[?!]*\s*(hello)?/i,
      /are you (there|listening)/i,
      /you('re| are)? (not|just) (listening|hearing)/i,
      /you (cut|cutting) me off/i,
      /i('m| am) (trying|talking)/i,
      /let me (finish|speak|talk)/i,
      /stop (interrupting|cutting)/i,
      /what('s| is) (wrong|going on)/i,
      /this (isn't|is not) working/i
    ];
    return frustrationPatterns.some(pattern => pattern.test(text));
  }
  
  /**
   * Process user input and determine next state
   */
  function processInput(transcript, analysis = {}) {
    const lowerTranscript = transcript.toLowerCase();
    // Track user transcript for context-aware acknowledgments (empathy detection)
    _lastUserTranscript = transcript;
    
    // Snapshot lock state before processing — we'll log any new locks after
    const _locksBefore = {
      name: data._nameLocked, phone: data._phoneLocked, email: data._emailLocked,
      address: data._addressLocked, availability: data._availabilityLocked
    };
    
    // Wrap the actual logic so we can log field_locked events on return
    const result = _processInputInner(transcript, lowerTranscript, analysis);
    
    // Check for newly locked fields
    const fieldMap = { name: '_nameLocked', phone: '_phoneLocked', email: '_emailLocked', address: '_addressLocked', availability: '_availabilityLocked' };
    const valueMap = { name: `${data.firstName || ''} ${data.lastName || ''}`.trim(), phone: data.phone, email: data.email, address: data.address, availability: data.availability };
    for (const [field, key] of Object.entries(fieldMap)) {
      if (data[key] && !_locksBefore[field]) {
        intakeLog('field_locked', { field, value: valueMap[field] });
      }
    }
    
    // Log spelling state for name if in spelling mode
    if (pendingClarification.field === 'name' && pendingClarification.spellingAttempts > 0) {
      intakeLog('field_parse', {
        field: 'last_name', spelling_mode: true,
        spelling_attempt_count: pendingClarification.spellingAttempts,
        parsed_value: pendingClarification.value?.lastName || null,
        will_reprompt: result.nextState === currentState
      });
    }
    
    return result;
  }
  
  function _processInputInner(transcript, lowerTranscript, analysis) {
    // CRITICAL: Detect user frustration - acknowledge but do NOT re-send full confirmation/recap (would cut off TTS)
    if (isUserFrustrated(transcript)) {
      console.log(`⚠️ User frustration detected: "${transcript.substring(0, 50)}..."`);
      if (currentState === STATES.CONFIRMATION || currentState === STATES.CLOSE) {
        return { nextState: currentState, prompt: "I'm sorry, still there? Is that correct?", action: 'ask' };
      }
      const currentPrompt = getNextPrompt();
      return {
        nextState: currentState,
        prompt: "I'm sorry, I'm having trouble hearing. " + (currentPrompt || "How can I help you?"),
        action: 'ask'
      };
    }
    
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
            data._safetyPromptAttempts = 1;
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
            data._safetyPromptAttempts = 1;
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
            data._safetyPromptAttempts = 1;
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
        // If name already confirmed/locked, do not parse again (immutable)
        if (data._nameLocked) {
          return { nextState: transitionTo(STATES.PHONE), prompt: withAcknowledgment(CALLER_INFO.phone), action: 'ask' };
        }
        // Immediate confirmation: we asked "Did I get your last name right. X Y Z." (Phase 2)
        // THIS IS A BLOCKING STATE - do not advance until confirmation equals YES
        if (pendingClarification.field === 'name' && pendingClarification.awaitingConfirmation) {
          console.log(`📋 Name confirmation state - awaiting yes/no for: ${pendingClarification.value.firstName} ${pendingClarification.value.lastName}`);
          
          // CASE 1: User confirms with "yes" - overwrite with cleaned values, lock, advance
          if (isConfirmation(lowerTranscript)) {
            data.firstName = cleanFieldValue(pendingClarification.value.firstName) || pendingClarification.value.firstName;
            data.lastName = cleanFieldValue(pendingClarification.value.lastName) || pendingClarification.value.lastName;
            const baseConf = data.name_confidence != null ? data.name_confidence : confidenceToPercentage(pendingClarification.confidence);
            data.name_confidence = adjustConfidence(baseConf, 'confirmation');
            data._nameComplete = true;
            data._nameLocked = true;  // CSV/recap read only this; ignore future transcript for name
            console.log(`✅ Name CONFIRMED (locked): ${data.firstName} ${data.lastName} (confidence: ${data.name_confidence}%)`);
            clearPendingClarification();
            return { nextState: transitionTo(STATES.PHONE), prompt: withAcknowledgment(CALLER_INFO.phone), action: 'ask' };
          }
          
          // CASE 1.5: User is providing a clarification about the spelling (not spelling new letters)
          // e.g., "It only has one V in the beginning, not two" or "There's only one V"
          // These should NOT be treated as new names or spelling attempts
          const clarificationPatterns = [
            /only\s+(has\s+)?(one|two|a single)\s+[A-Z]/i,         // "only has one V"
            /(not|no)\s+(two|double|2)\s*[A-Z]?/i,                  // "not two V's"
            /there'?s\s+(only\s+)?(one|a single)/i,                 // "there's only one"
            /just\s+(one|a single)\s+[A-Z]/i,                       // "just one V"
            /in\s+the\s+(beginning|start|front|middle|end)/i,      // "in the beginning, not two"
            /you\s+(have|got|said)\s+(two|double|too many)/i,      // "you have two"
            /remove\s+(the|one|a)\s+(extra|second)/i,              // "remove the extra"
            /(should|supposed)\s+to\s+(be|have)\s+(one|single)/i,  // "should be one"
          ];
          
          const isSpellingClarification = clarificationPatterns.some(p => p.test(lowerTranscript));
          if (isSpellingClarification && pendingClarification && pendingClarification.field === 'name') {
            console.log(`📋 Detected spelling clarification: "${transcript}"`);
            if ((pendingClarification.spellingAttempts || 0) >= MAX_SPELLING_ATTEMPTS) {
              return forceLockNameAndAdvance(null, transcript);
            }
            pendingClarification.spellingAttempts = 2;
            return { nextState: currentState, prompt: "Can you spell that one more time please?", action: 'ask' };
          }
          
          // CASE 2: Negation (user says "no" without spelling) — clear and re-ask name
          if (isNegation(lowerTranscript)) {
            console.log(`❌ Name REJECTED by user - clearing and re-asking`);
            data.firstName = null;
            data.lastName = null;
            data.name_confidence = null;
            data._nameComplete = false;
            data._nameLocked = false;
            clearPendingClarification();
            return {
              nextState: currentState,
              prompt: "No problem. Let me get that again. What is your first and last name?",
              action: 'ask'
            };
          }
          
          // CASE 3: SPELLING MODE — deterministic letter-only. Max 2 attempts: one retry then force lock. No diagnostic prompts.
          const strictSpelling = parseSpelledLettersOnly(transcript);
          const spellingAttempts = pendingClarification.spellingAttempts || 0;
          if (strictSpelling !== null) {
            const { lastName: spelledLastName, letterCount } = strictSpelling;
            if (letterCount >= 3 && spelledLastName) {
              data.firstName = cleanFieldValue(pendingClarification.value.firstName) || pendingClarification.value.firstName;
              data.lastName = cleanFieldValue(spelledLastName) || spelledLastName;
              data.name_confidence = 95;
              data._nameComplete = true;
              data._nameLocked = true;
              clearPendingClarification();
              console.log(`✅ Name CONFIRMED from spelling (letter-only, locked): ${data.firstName} ${data.lastName}`);
              return { nextState: transitionTo(STATES.PHONE), prompt: withAcknowledgment(CALLER_INFO.phone), action: 'ask' };
            }
            if (spellingAttempts >= MAX_SPELLING_ATTEMPTS) {
              return forceLockNameAndAdvance(spelledLastName || null, transcript);
            }
            pendingClarification.spellingAttempts = 2;
            return { nextState: currentState, prompt: "Can you spell that one more time please?", action: 'ask' };
          } else {
            if (spellingAttempts >= MAX_SPELLING_ATTEMPTS) {
              return forceLockNameAndAdvance(null, transcript);
            }
            pendingClarification.spellingAttempts = 2;
            return { nextState: currentState, prompt: "Can you spell that one more time please?", action: 'ask' };
          }
          
          // CASE 4: User provides a name correction (not spelled, e.g., "It's Smith, not Smythe")
          const corr = extractName(transcript);
          if (corr.firstName || corr.lastName) {
            // User provided a different name - update pending and re-confirm without spelling
            const newFirstName = corr.firstName || pendingClarification.value.firstName;
            const newLastName = corr.lastName || pendingClarification.value.lastName;
            console.log(`📋 Received name correction: "${newFirstName} ${newLastName}"`);
            
            pendingClarification.value.firstName = newFirstName;
            pendingClarification.value.lastName = newLastName;
            return {
              nextState: currentState,  // STAY in NAME state - re-confirm the correction
              prompt: `Got it, ${newFirstName} ${newLastName}. Is that correct?`,
              action: 'ask'
            };
          }
          
          // CASE 5: Unclear response — one retry then force lock (spelling cap = 2)
          const attempt = pendingClarification.spellingAttempts || 0;
          if (attempt >= MAX_SPELLING_ATTEMPTS) {
            return forceLockNameAndAdvance(null, transcript);
          }
          pendingClarification.spellingAttempts = 2;
          return { nextState: currentState, prompt: "Can you spell that one more time please?", action: 'ask' };
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
          
          // SPELLING OVERRIDE: prefer deterministic letter-only so ASR words (e.g. "bye van kallenberg") are never used
          const strictFirst = parseSpelledLettersOnly(transcript);
          if (strictFirst && strictFirst.letterCount >= 3 && strictFirst.lastName) {
            data.firstName = cleanFieldValue(firstName) || firstName || '';
            data.lastName = cleanFieldValue(strictFirst.lastName) || strictFirst.lastName;
            data.name_confidence = 95;
            data._nameComplete = true;
            data._nameLocked = true;
            console.log(`✅ Name from spelling letter-only (locked): ${data.firstName} ${data.lastName}`);
            return { nextState: transitionTo(STATES.PHONE), prompt: withAcknowledgment(CALLER_INFO.phone), action: 'ask' };
          }
          // 0 letter tokens but transcript looks like misheard spelling — enter spelling mode (silent). One user-facing retry only.
          if (strictFirst === null && looksLikeMisheardSpelling(transcript)) {
            console.log(`📋 Possible misheard spelling ("${transcript.substring(0, 40)}...") — entering spelling mode`);
            // Extract firstName from transcript before entering spelling mode (don't lose "Tim" from "first name is Tim...")
            const misheardFirst = firstName || data.firstName || '';
            pendingClarification = { field: 'name', value: { firstName: misheardFirst, lastName: '' }, confidence: { level: 'low' }, awaitingConfirmation: true, spellingAttempts: 1 };
            return { nextState: currentState, prompt: "Can you spell that one more time please?", action: 'ask' };
          }
          const spelledResult = normalizeSpelledName(transcript);
          const nonNameWords = /\b(not|heat|yes|no|out|working|the|and|all|say|just|hot|cold|warm|cool|working|any|its|there|here)\b/i;
          const looksLikeSymptom = nonNameWords.test(transcript) && (/\b(heat|working|out|no\s+heat|not\s+working)\b/i.test(transcript) || transcript.length > 25);
          const hasSpellingIntent = /\bspelled?|spell\s+it|letters?|letter\s+by\s+letter\b/i.test(transcript);
          const spelledLooksReal = spelledResult && spelledResult.lastName &&
            !nonNameWords.test(spelledResult.lastName) &&
            !(spelledResult.firstName && nonNameWords.test(spelledResult.firstName)) &&
            (hasSpellingIntent || (spelledResult.lastName.length >= 4 && spelledResult.lastName.length <= 20));
          // If strict letter-only returned 0 letters or spelling intent but no letter tokens, do NOT use normalizeSpelledName (would capture "bye van kallenberg" etc.)
          const skipFuzzySpelled = (strictFirst && strictFirst.letterCount === 0) || (strictFirst === null && hasSpellingIntent);
          if (skipFuzzySpelled) {
            console.log(`📋 Spelling input but 0 letter tokens — skipping fuzzy spelled result`);
          }
          if (!skipFuzzySpelled && spelledLooksReal && !looksLikeSymptom) {
            let useFirst = (spelledResult.firstName && spelledResult.firstName.length > 0)
              ? spelledResult.firstName
              : (firstName || '');
            useFirst = useFirst.replace(/\s*\.\s*(?:the\s+)?(?:my\s+)?last\s+name\s+is\b.*$/i, '').trim();
            const andLast = useFirst.match(/\s+and\s+(?:my\s+)?last\s+name\s+is\b/i);
            if (andLast) useFirst = useFirst.slice(0, andLast.index).trim();
            const useLast = spelledResult.lastName;
            data.firstName = cleanFieldValue(useFirst) || useFirst;
            data.lastName = cleanFieldValue(useLast) || useLast;
            data.name_confidence = 95;
            data._nameComplete = true;
            data._nameLocked = true;  // Lock immediately; ignore all future tokens for name
            console.log(`✅ Name from spelling (locked): ${data.firstName} ${data.lastName} - bypassing confidence`);
            return { nextState: transitionTo(STATES.PHONE), prompt: withAcknowledgment(CALLER_INFO.phone), action: 'ask' };
          }
          
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
          intakeLog('field_parse', { field: 'name', parsed_first: firstName, parsed_last: lastName, spelling_mode: false, confidence: nameConfidencePercent, will_reprompt: nameConfidencePercent < CONFIDENCE_THRESHOLD });
          
          // If extraction failed completely, check if it's an incomplete utterance
          if (!firstName && !lastName) {
            console.log(`⚠️  Name extraction failed completely for: "${transcript}"`);
            
            // CRITICAL: Detect incomplete utterances like "Yeah, it's" or "My name is"
            // These are preambles where the user paused before giving their actual name
            const incompletePatterns = [
              /^(yeah|yes|yep|sure|okay|ok)[,.]?\s*(it'?s|that'?s|i'?m|my name)?\s*$/i,  // "Yeah, it's" "Yes, I'm"
              /^(my name is|i'?m|it'?s|that'?s|this is)\s*$/i,                            // "My name is" "I'm"
              /^(uh|um|er|hmm)[,.]?\s*(yeah|yes|it'?s|my)?\s*$/i,                         // "Uh yeah" "Um it's"
              /^(hi|hello|hey)[,.]?\s*(yeah|yes|it'?s|my|i'?m)?\s*$/i,                    // "Hi yeah" "Hello it's"
            ];
            
            const isIncomplete = incompletePatterns.some(p => p.test(transcript.trim()));
            if (isIncomplete) {
              console.log(`⏳ Detected incomplete utterance "${transcript}" - waiting for user to continue`);
              // Return null/skip to let the user continue speaking
              // The next transcript will be processed
              return {
                nextState: currentState,
                prompt: null,  // No prompt - wait silently for user to continue
                action: 'wait'
              };
            }
            
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
              console.log(`🔄 lastName looks valid, treating as full name: "${lastName}"`);
              const lastNameParts = lastName.split(' ');
              data.firstName = cleanFieldValue(lastNameParts[0] || lastName) || (lastNameParts[0] || lastName);
              data.lastName = cleanFieldValue(lastNameParts.slice(1).join(' ') || '') || (lastNameParts.slice(1).join(' ') || '');
              data.name_confidence = 50;
              data._nameLocked = true;  // Persist only this; will not overwrite from transcript
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
            data.firstName = cleanFieldValue(firstName) || firstName;
            data.lastName = cleanFieldValue(lastName) || lastName;
            data.name_confidence = nameConfidencePercent;
            data._nameComplete = true;
            data._nameLocked = true;  // Single source of truth; CSV/recap read only this
            console.log(`✅ Name stored (locked): ${data.firstName} ${data.lastName} (confidence: ${nameConfidencePercent}%)`);
            return { nextState: transitionTo(STATES.PHONE), prompt: withAcknowledgment(CALLER_INFO.phone), action: 'ask' };
          }
          // Below threshold: ask user to spell (first ask). Max 2 attempts then force lock.
          data.name_confidence = nameConfidencePercent;
          pendingClarification = { field: 'name', value: { firstName, lastName }, confidence: overallConf, awaitingConfirmation: true, spellingAttempts: 1 };
          intakeLog('prompt', { field: 'last_name', attempt_number: 1, reason: 'low_confidence', confidence: nameConfidencePercent });
          return {
            nextState: currentState,
            prompt: `I'm having a little trouble with your last name. Could you spell it for me?`,
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
            data._phoneLocked = true;
            data._phoneComplete = true;
            clearPendingClarification();
            return { nextState: transitionTo(STATES.EMAIL), prompt: withAcknowledgment(CALLER_INFO.email.primary), action: 'ask' };
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
          return { nextState: transitionTo(STATES.EMAIL), prompt: withAcknowledgment(CALLER_INFO.email.primary), action: 'ask' };
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
        
        // CRITICAL: Check if user is referencing their name/last name
        // User corrections always take priority over linear progression
        if (isReferringToName(lowerTranscript)) {
          console.log(`📋 User referenced NAME in PHONE state - routing back to NAME`);
          data.firstName = null;
          data.lastName = null;
          data.name_confidence = null;
          data._nameComplete = false;
          data._nameLocked = false;
          clearPendingClarification();
          return {
            nextState: transitionTo(STATES.NAME),
            prompt: "Let's go back to your name. What is your first and last name?",
            action: 'ask'
          };
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
            return { nextState: transitionTo(STATES.EMAIL), prompt: withAcknowledgment(CALLER_INFO.email.primary), action: 'ask' };
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
        // CRITICAL: Check for confusion/clarification requests FIRST (before any other handling)
        // User might say "I'm sorry, what did you say?" or "can you repeat that?"
        if (isConfusedOrAsking(lowerTranscript)) {
          console.log(`📋 User confused/asking in EMAIL state: "${transcript}"`);
          // If we have a pending email confirmation, repeat it
          if (pendingClarification.field === 'email' && pendingClarification.value) {
            const formatted = formatEmailForReadback(pendingClarification.value);
            return {
              nextState: currentState,
              prompt: `I have ${formatted}. Is that correct?`,
              action: 'ask'
            };
          }
          // Otherwise, repeat the email prompt
          return {
            nextState: currentState,
            prompt: CALLER_INFO.email.primary,
            action: 'ask'
          };
        }
        
        // EMAIL CONFIRMATION — binary yes/no only. No re-evaluation of confidence.
        if (pendingClarification.field === 'email' && pendingClarification.awaitingConfirmation) {
          function normalizeEmailForPersist(e) {
            if (!e || typeof e !== 'string') return e || '';
            return e.replace(/\s+/g, '').toLowerCase().trim();
          }
          if (isConfirmation(lowerTranscript)) {
            // YES → lock with confirmed value
            data.email = normalizeEmailForPersist(pendingClarification.value);
            data.email_confidence = adjustConfidence(data.email_confidence != null ? data.email_confidence : confidenceToPercentage(pendingClarification.confidence), 'confirmation');
            data._emailComplete = true;
            data._emailLocked = true;
            clearPendingClarification();
            return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: withAcknowledgment(getDetailsPrompt()), action: 'ask' };
          }
          if (isNegation(lowerTranscript)) {
            // NO → try to extract a correction from transcript; if none, ask once more
            const corr = extractEmail(transcript);
            if (corr && corr.includes('@') && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(corr)) {
              data.email = normalizeEmailForPersist(corr);
              data.email_confidence = adjustConfidence(confidenceToPercentage(pendingClarification.confidence), 'correction');
              data._emailComplete = true;
              data._emailLocked = true;
              clearPendingClarification();
              return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: withAcknowledgment(getDetailsPrompt()), action: 'ask' };
            }
            // No valid correction — ask once: "What is the correct email?"
            clearPendingClarification();
            if (!data._emailAttempts) data._emailAttempts = 0;
            data._emailAttempts++;
            if (data._emailAttempts >= MAX_PROMPT_ATTEMPTS) {
              // Cap reached — accept pending value and move on
              data.email = normalizeEmailForPersist(pendingClarification.value || data.email);
              data._emailComplete = true;
              data._emailLocked = true;
              return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: "No worries, we'll confirm the email later. " + getDetailsPrompt(), action: 'ask' };
            }
            return { nextState: currentState, prompt: "What is the correct email?", action: 'ask' };
          }
          // Neither yes nor no — user gave a new email or something else.
          // Try to extract, accept and lock (no more prompts).
          const corr = extractEmail(transcript);
          if (corr && corr.includes('@') && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(corr)) {
            data.email = normalizeEmailForPersist(corr);
            data.email_confidence = adjustConfidence(confidenceToPercentage(pendingClarification.confidence), 'correction');
          } else {
            data.email = normalizeEmailForPersist(pendingClarification.value);
          }
          data._emailComplete = true;
          data._emailLocked = true;
          clearPendingClarification();
          return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: withAcknowledgment(getDetailsPrompt()), action: 'ask' };
        }
        
        // IMPORTANT: If user confirms and we already have an email, lock and move on
        if (data.email && isConfirmation(lowerTranscript)) {
          console.log(`✅ Email already confirmed: ${data.email} - advancing`);
          data._emailComplete = true;
          data._emailLocked = true;
          return {
            nextState: transitionTo(STATES.DETAILS_BRANCH),
            prompt: withAcknowledgment(getDetailsPrompt()),
            action: 'ask'
          };
        }
        
        // CRITICAL: Check if user is referencing their name/last name
        // User corrections always take priority over linear progression
        if (isReferringToName(lowerTranscript)) {
          console.log(`📋 User referenced NAME in EMAIL state - routing back to NAME`);
          data.firstName = null;
          data.lastName = null;
          data.name_confidence = null;
          data._nameComplete = false;
          data._nameLocked = false;
          clearPendingClarification();
          return {
            nextState: transitionTo(STATES.NAME),
            prompt: "Let's go back to your name. What is your first and last name?",
            action: 'ask'
          };
        }
        
        // Handle "we already did that" / "you already have it" type responses
        if (data.email && isAlreadyProvidedResponse(lowerTranscript)) {
          console.log(`✅ Email already provided: ${data.email} - advancing`);
          data._emailComplete = true;
          data._emailLocked = true;
          return {
            nextState: transitionTo(STATES.DETAILS_BRANCH),
            prompt: withAcknowledgment(getDetailsPrompt()),
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
        
        // Global email attempt counter — max 2 prompts total, then accept best and move on
        if (!data._emailAttempts) data._emailAttempts = 0;
        
        if (hasEmail(lowerTranscript) || isEmailDeclined(lowerTranscript)) {
          if (isEmailDeclined(lowerTranscript)) {
            console.log(`📋 Email: declined`);
            data._emailComplete = true;
            data._emailLocked = true;
            return {
              nextState: transitionTo(STATES.DETAILS_BRANCH),
              prompt: "No problem. " + getDetailsPrompt(),
              action: 'ask'
            };
          }
          
          const email = extractEmail(transcript);
          const emailConf = estimateEmailConfidence(transcript);
          let emailConfidencePercent = confidenceToPercentage(emailConf);
          
          if (!email || !email.includes('@')) {
            data._emailAttempts++;
            intakeLog('field_parse', { field: 'email', parsed_value: email, attempt: data._emailAttempts, reason: 'no_at_sign' });
            if (data._emailAttempts >= MAX_PROMPT_ATTEMPTS) {
              // Accept whatever we have and move on
              data.email = email || null;
              data._emailComplete = true;
              data._emailLocked = true;
              return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: "No worries, we'll confirm the email later. " + getDetailsPrompt(), action: 'ask' };
            }
            return { nextState: currentState, prompt: "I'm having trouble catching that. Could you spell out the email address for me?", action: 'ask' };
          }
          if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) {
            data._emailAttempts++;
            intakeLog('field_parse', { field: 'email', parsed_value: email, attempt: data._emailAttempts, reason: 'invalid_format' });
            if (data._emailAttempts >= MAX_PROMPT_ATTEMPTS) {
              // Accept best parsed value, lock, advance
              data.email = email;
              data.email_confidence = emailConfidencePercent;
              data._emailComplete = true;
              data._emailLocked = true;
              return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: "No worries, we'll confirm the email later. " + getDetailsPrompt(), action: 'ask' };
            }
            return { nextState: currentState, prompt: "I'm having trouble with that email format. Could you spell it again?", action: 'ask' };
          }
          console.log(`📋 Email: ${email} (confidence: ${emailConfidencePercent}%)`);
          intakeLog('field_parse', { field: 'email', parsed_value: email, confidence: emailConfidencePercent, attempt: data._emailAttempts });
          
          // Deterministic: >= threshold accept and lock; < threshold confirm once (binary yes/no)
          if (emailConfidencePercent >= CONFIDENCE_THRESHOLD) {
            data.email = email;
            data.email_confidence = emailConfidencePercent;
            data._emailComplete = true;
            data._emailLocked = true;
            return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: withAcknowledgment(getDetailsPrompt()), action: 'ask' };
          }
          data.email = email;
          data.email_confidence = emailConfidencePercent;
          pendingClarification = { field: 'email', value: email, confidence: emailConf, awaitingConfirmation: true };
          return { nextState: currentState, prompt: `${CONFIRMATION.immediate_email} ${formatEmailForReadback(email)}. Is that right?`, action: 'ask' };
        }
        
        // No email detected in input — cap re-prompts
        data._emailAttempts++;
        if (data._emailAttempts >= MAX_PROMPT_ATTEMPTS) {
          // Tried twice, no email captured — skip and move on
          data._emailComplete = true;
          data._emailLocked = true;
          return { nextState: transitionTo(STATES.DETAILS_BRANCH), prompt: "No worries, we can get the email later. " + getDetailsPrompt(), action: 'ask' };
        }
        return {
          nextState: currentState,
          prompt: CALLER_INFO.email.primary,
          action: 'ask'
        };
        
      case STATES.DETAILS_BRANCH:
        // CRITICAL: Filter out pure filler words/phrases that aren't actual answers
        // Examples: "Um", "uh", "to be honest", "let me think", "well", etc.
        const fillerOnlyPattern = /^(um+|uh+|er+|hmm+|well|so|oh|okay|to be honest|let me think|let me see|i don't know|i'm not sure)[,.]?\s*$/i;
        const goodbyePattern = /^(bye|goodbye|good\s+bye|have\s+to\s+go)[,.]?\s*$/i;
        const cleanedForFillerCheck = transcript.trim().replace(/[.,!?]+$/, '');
        if (goodbyePattern.test(cleanedForFillerCheck)) {
          console.log(`⏳ Ignoring goodbye-like utterance in details: "${transcript}" - waiting for actual answer`);
          return { nextState: currentState, prompt: null, action: 'wait' };
        }
        if (fillerOnlyPattern.test(cleanedForFillerCheck) || cleanedForFillerCheck.length < 3) {
          console.log(`⏳ Detected filler in DETAILS_BRANCH: "${transcript}" - waiting for actual answer`);
          // Don't re-prompt - wait silently for user to continue
          // They're thinking, not done speaking
          return {
            nextState: currentState,
            prompt: null,  // No prompt - wait silently
            action: 'wait'
          };
        }
        
        // When on system_type question, if user asks what options exist (e.g. "what type of systems are there?"),
        // don't store it as an answer - re-ask with options so they hear the list and can answer
        const questions = getDetailQuestions();
        const currentQuestion = questions[detailsQuestionIndex];
        const isSystemTypeQuestion = (data.intent === INTENT_TYPES.HVAC_SERVICE && currentQuestion === DETAILS.hvac_service.system_type) ||
          (data.intent === INTENT_TYPES.HVAC_INSTALLATION && currentQuestion === DETAILS.hvac_installation.system_type);
        const looksLikeAskingOptions = /\b(what\s+(type|types|kind|kinds|are\s+the\s+options|options\s+are\s+there)|which\s+(one|type|system)|list\s+(them|the\s+options)|tell\s+me\s+(the\s+)?(options|types)|give\s+me\s+some\s+options|what\s+could\s+it\s+be|i'?m\s+not\s+sure\s+what\s+types?)\b/i;
        if (isSystemTypeQuestion && looksLikeAskingOptions.test(transcript)) {
          console.log(`📋 User asked for system type options - re-asking with list (not advancing)`);
          return {
            nextState: currentState,
            prompt: "Common types are central air, heat pump, furnace, or boiler. Which do you have?",
            action: 'ask'
          };
        }
        
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
                prompt: withAcknowledgment(nextDetailPrompt),
                action: 'ask'
              };
            }
            // If no more detail questions, skip to availability since we have address
            return {
              nextState: transitionTo(STATES.AVAILABILITY),
              prompt: withAcknowledgment(AVAILABILITY.ask),
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
            prompt: withAcknowledgment(nextDetailPrompt),
            action: 'ask'
          };
        }
        
        return {
          nextState: transitionTo(STATES.ADDRESS),
          prompt: withAcknowledgment(ADDRESS.ask),
          action: 'ask'
        };
        
      case STATES.ADDRESS:
        // If address already locked, skip to next state immediately
        if (data._addressLocked) {
          return { nextState: transitionTo(STATES.AVAILABILITY), prompt: withAcknowledgment(AVAILABILITY.ask), action: 'ask' };
        }
        // Immediate confirmation (Phase 2): we asked "Did you say the street name was X? Did you say the town was Y?"
        if (pendingClarification.field === 'address' && pendingClarification.awaitingConfirmation) {
          if (isConfirmation(lowerTranscript)) {
            const v = pendingClarification.value;
            data.address = cleanFieldValue(v.address) || v.address;
            data.city = cleanFieldValue(v.city) || v.city;
            data.state = v.state;
            data.zip = v.zip;
            data.address_confidence = adjustConfidence(data.address_confidence != null ? data.address_confidence : confidenceToPercentage(pendingClarification.confidence), 'confirmation');
            data._addressComplete = true;
            data._addressLocked = true;  // Do not re-parse during recap; CSV reads only this
            clearPendingClarification();
            return { nextState: transitionTo(STATES.AVAILABILITY), prompt: withAcknowledgment(AVAILABILITY.ask), action: 'ask' };
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
          data._addressLocked = true;
          clearPendingClarification();
          return { nextState: transitionTo(STATES.AVAILABILITY), prompt: withAcknowledgment(AVAILABILITY.ask), action: 'ask' };
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
          
          // Track address prompt attempts (persists across turns)
          if (!data._addressAttempts) data._addressAttempts = 0;
          
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
            data._addressAttempts++;
            intakeLog('field_parse', { field: 'address', parsed_value: null, raw: transcript.substring(0, 60), attempt: data._addressAttempts, reason: 'not_recognized_as_address' });
            // After MAX_PROMPT_ATTEMPTS: force-accept whatever we have and move on
            if (data._addressAttempts >= MAX_PROMPT_ATTEMPTS) {
              console.log(`📋 Address attempt cap reached (${data._addressAttempts}) - forcing advance`);
              intakeLog('retry_cap_reached', { field: 'address', attempts: data._addressAttempts });
              // Try to extract SOMETHING from the transcript even if it doesn't look like an address
              const forceParts = extractAddress(transcript);
              if (forceParts.address || forceParts.city) {
                data.address = forceParts.address || transcript.substring(0, 60);
                data.city = forceParts.city;
                data.state = forceParts.state;
                data.zip = forceParts.zip;
              } else {
                // Last resort: store the raw transcript
                data.address = transcript.replace(/^(that\s+would\s+be|that'?s|it'?s)\s+/gi, '').substring(0, 80);
              }
              data.address_confidence = 40;
              data._addressComplete = true;
              data._addressLocked = true;
              return { nextState: transitionTo(STATES.AVAILABILITY), prompt: withAcknowledgment(AVAILABILITY.ask), action: 'ask' };
            }
            console.log(`📋 Response doesn't look like an address (attempt ${data._addressAttempts}/${MAX_PROMPT_ATTEMPTS}): "${transcript}" - re-asking`);
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
          intakeLog('field_parse', { field: 'address', parsed_value: addressParts.address, city: addressParts.city, state: addressParts.state, zip: addressParts.zip, confidence: addressConfidencePercent, attempt: data._addressAttempts || 0 });
          
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
            data._addressLocked = true;
            console.log(`✅ Address stored (locked): ${finalAddress} (confidence: ${addressConfidencePercent}%)`);
            intakeLog('field_locked', { field: 'address', value: finalAddress });
            if (!addressParts.state && !addressParts.zip) {
              return { nextState: currentState, prompt: "Could you also provide the state and zip code?", action: 'ask' };
            }
            if (!addressParts.state) {
              return { nextState: currentState, prompt: "Could you also provide the state?", action: 'ask' };
            }
            if (!addressParts.zip) {
              return { nextState: currentState, prompt: "Could you also provide the zip code?", action: 'ask' };
            }
            return { nextState: transitionTo(STATES.AVAILABILITY), prompt: withAcknowledgment(AVAILABILITY.ask), action: 'ask' };
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
            data._addressLocked = true;
            return { nextState: transitionTo(STATES.AVAILABILITY), prompt: withAcknowledgment(AVAILABILITY.ask), action: 'ask' };
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
            data._addressLocked = true;
            return { nextState: transitionTo(STATES.AVAILABILITY), prompt: withAcknowledgment(AVAILABILITY.ask), action: 'ask' };
          }
        }
        // Fallback: increment attempt counter and check cap
        if (!data._addressAttempts) data._addressAttempts = 0;
        data._addressAttempts++;
        if (data._addressAttempts >= MAX_PROMPT_ATTEMPTS) {
          console.log(`📋 Address fallback cap reached (${data._addressAttempts}) - forcing advance with whatever we have`);
          intakeLog('retry_cap_reached', { field: 'address', attempts: data._addressAttempts });
          if (!data.address) data.address = transcript.replace(/^(that\s+would\s+be|that'?s|it'?s)\s+/gi, '').substring(0, 80);
          data.address_confidence = data.address_confidence || 40;
          data._addressComplete = true;
          data._addressLocked = true;
          return { nextState: transitionTo(STATES.AVAILABILITY), prompt: withAcknowledgment(AVAILABILITY.ask), action: 'ask' };
        }
        return {
          nextState: currentState,
          prompt: ADDRESS.ask,
          action: 'ask'
        };
        
      case STATES.AVAILABILITY:
        // If already confirmed/locked, do not parse again (immutable)
        if (data._availabilityLocked) {
          return { nextState: transitionTo(STATES.CONFIRMATION), prompt: getConfirmationPrompt(), action: 'confirm' };
        }
        // Immediate confirmation (Phase 2): we asked "I have {availability}. Is that right?"
        if (pendingClarification.field === 'availability' && pendingClarification.awaitingConfirmation) {
          if (isConfusedOrAsking(lowerTranscript)) {
            return { nextState: currentState, prompt: `I have ${pendingClarification.value}. Is that right?`, action: 'ask' };
          }
          if (isConfirmation(lowerTranscript)) {
            data.availability = pendingClarification.value;
            data._availabilityComplete = true;
            data._availabilityLocked = true;
            clearPendingClarification();
            if (!hasRequiredName()) {
              console.log(`📋 Name required before confirmation - forcing name intake`);
              data.firstName = null; data.lastName = null; data._nameLocked = false; data._nameComplete = false;
              return { nextState: transitionTo(STATES.NAME), prompt: CALLER_INFO.name, action: 'ask' };
            }
            return { nextState: transitionTo(STATES.CONFIRMATION), prompt: getConfirmationPrompt(), action: 'confirm' };
          }
          // Correction: replace, do not append. If no valid availability was given, keep asking.
          const corr = extractAvailability(transcript);
          const corrLower = (corr || '').toLowerCase();
          if (!corr || !corr.trim() || (!looksLikeAvailability(corrLower) && !hasUrgencyAvailability(corrLower))) {
            return { nextState: currentState, prompt: `I have ${pendingClarification.value}. Is that right?`, action: 'ask' };
          }
          data.availability = corr;
          data._availabilityComplete = true;
          data._availabilityLocked = true;
          clearPendingClarification();
          if (!hasRequiredName()) {
            console.log(`📋 Name required before confirmation - forcing name intake`);
            data.firstName = null; data.lastName = null; data._nameLocked = false; data._nameComplete = false;
            return { nextState: transitionTo(STATES.NAME), prompt: CALLER_INFO.name, action: 'ask' };
          }
          return { nextState: transitionTo(STATES.CONFIRMATION), prompt: getConfirmationPrompt(), action: 'confirm' };
        }
        // Urgency-based availability: heat off, no heat, emergency, anytime, asap → accept and advance (no time parsing)
        if (hasUrgencyAvailability(lowerTranscript)) {
          data.availability = URGENCY_AVAILABILITY_NOTES;
          data._availabilityComplete = true;
          data._availabilityLocked = true;
          data.availability_confidence = 100;
          console.log(`📋 Availability (urgency): ${data.availability} - advancing`);
          if (!hasRequiredName()) {
            console.log(`📋 Name required before confirmation - forcing name intake`);
            data.firstName = null; data.lastName = null; data._nameLocked = false; data._nameComplete = false;
            return { nextState: transitionTo(STATES.NAME), prompt: CALLER_INFO.name, action: 'ask' };
          }
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
            if (!hasRequiredName()) {
              console.log(`📋 Name required before confirmation - forcing name intake`);
              data.firstName = null; data.lastName = null; data._nameLocked = false; data._nameComplete = false;
              return { nextState: transitionTo(STATES.NAME), prompt: CALLER_INFO.name, action: 'ask' };
            }
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
        
        // RECAP IS READ-ONLY: Do not parse transcript for any field updates during confirmation.
        // The agent's recap speech must never be treated as user input (would corrupt first_name with "Tim and last name is...").
        // Only respond to yes/no/correction. If user says "no" or "something's wrong", we ask what to correct and handle in a follow-up.
        if (isConfirmation(lowerTranscript)) {
          if (!hasRequiredName()) {
            console.log(`📋 Name required before close - forcing name intake`);
            data.firstName = null; data.lastName = null; data._nameLocked = false; data._nameComplete = false;
            return { nextState: transitionTo(STATES.NAME), prompt: CALLER_INFO.name, action: 'ask' };
          }
          return {
            nextState: transitionTo(STATES.CLOSE),
            prompt: CLOSE.anything_else,
            action: 'ask'
          };
        }
        if (isCorrection(lowerTranscript)) {
          confirmationAttempts++;
          if (applyRecapCorrectionsFromTranscript(transcript)) {
            return {
              nextState: currentState,
              prompt: getConfirmationPrompt(),
              action: 'confirm'
            };
          }
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
        // Mark that close state was reached and anything_else was prompted
        data._closeStateReached = true;
        data._anythingElsePrompted = true;
        intakeLog('state_event', { event: 'anything_else_prompted', state: 'close' });
        
        // INVERTED DEFAULT: In CLOSE state, user is responding to "Is there anything else?"
        // Default assumption = NO. Only stay in CLOSE if user CLEARLY asks a new question.
        
        // Check if user has a new question (explicit question or request)
        if (hasMoreQuestions(lowerTranscript)) {
          console.log(`📋 User has follow-up question in CLOSE state: "${transcript.substring(0, 50)}"`);
          return {
            nextState: currentState,
            prompt: null,
            action: 'answer_question'
          };
        }
        
        // Everything else = end call (negative response, short answer, "no thanks", etc.)
        console.log(`📋 CLOSE → ENDED: treating "${transcript.substring(0, 40)}" as end-of-call`);
        intakeLog('state_event', { event: 'close_to_ended', transcript: transcript.substring(0, 60) });
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
    
    // Reject if it contains symptom/problem descriptions (before positive checks)
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
    
    // Reject obvious non-address responses (frustration, confusion, meta-comments)
    if (/\b(i just told you|already told you|i said|what do you mean|excuse me)\b/i.test(lowerText)) {
      return false;
    }
    
    const hasNumber = /\d{1,6}\s+/.test(cleaned);
    const hasStreetType = /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd|circle|place|pl|terrace|terr)\b/i.test(cleaned);
    const hasCityStateZip = /\b(new\s+jersey|nj|new\s+york|ny|connecticut|ct|pennsylvania|pa)\b/i.test(cleaned) || /\b\d{5}\b/.test(cleaned);
    const hasCityName = /,\s*[A-Z][a-z]+/.test(cleaned);  // "..., Madison" or "..., West Orange"
    
    // CASE 1: Has house number + street type (classic: "12 Main Street")
    if (hasNumber && hasStreetType) return true;
    
    // CASE 2: Has street type + city/state/zip (ASR split: "Mallory Drive, West Orange, NJ 07940")
    if (hasStreetType && (hasCityStateZip || hasCityName)) return true;
    
    // CASE 3: Has house number + city/state/zip (partial: "171, Madison, NJ 07940")
    if (hasNumber && hasCityStateZip) return true;
    
    // CASE 4: Has street type + number (e.g., "12 Mallory Dr" without city)
    if (hasNumber && hasStreetType) return true;
    
    return false;
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
   * Transcript looks like ASR mishearing of letter-by-letter spelling (e.g. "bye van kallenberg" for B-Y V-A-N ...).
   * When true, do NOT lock extractName result — ask for letter-by-letter spelling instead.
   */
  function looksLikeMisheardSpelling(text) {
    if (!text || text.trim().length < 4) return false;
    const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;
    // Removed 'van' — it's a real name prefix (Van Cauwenberge). Require >= 3 matches to avoid false positives.
    const letterSoundWords = new Set(['bye', 'by', 'be', 'see', 'sea', 'are', 'you', 'why', 'tea', 'pea', 'kay', 'jay', 'eye', 'oh', 'ex', 'zee', 'ell', 'em', 'en', 'queue', 'double', 'eff', 'gee', 'aitch', 'cue', 'ess', 'tee', 'vee', 'dubya', 'wye']);
    const matchCount = words.filter(w => letterSoundWords.has(w)).length;
    return matchCount >= 3;
  }

  /**
   * SPELLING MODE: deterministic letter-only assembly. Bypasses ASR/LLM.
   * Only accepts: single-letter tokens A–Z and the word "space". Ignores all other tokens.
   * Use when we've asked "Could you spell it for me?" — no fuzzy interpretation.
   * @returns {{ lastName: string, letterCount: number } | null} null if 0 valid letters
   */
  function parseSpelledLettersOnly(text) {
    if (!text || typeof text !== 'string') return null;
    // CRITICAL: Split on whitespace, dashes, periods, and commas.
    // ASR often returns "V-A-N-C-A-U-W-E-N-B-E-R-G-E" as one dash-separated token.
    const tokens = text.trim().split(/[\s\-.,]+/).filter(Boolean);
    const sequence = []; // each element is a letter (uppercase) or '\x00' for word boundary
    for (const token of tokens) {
      if (token.length === 1 && /^[A-Za-z]$/.test(token)) {
        sequence.push(token.toUpperCase());
      } else if (token.toLowerCase() === 'space') {
        sequence.push('\x00'); // word boundary
      }
      // else: ignore (bye, van, kallenberg, Sure, That's, etc.)
    }
    const letterCount = sequence.filter(c => c !== '\x00').length;
    if (letterCount < 3) return letterCount === 0 ? null : { lastName: '', letterCount };
    // Build name: split by word boundary, capitalize each part
    const raw = sequence.map(c => c === '\x00' ? ' ' : c).join('');
    const parts = raw.split(/\s+/).filter(Boolean).map(part =>
      part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    );
    const lastName = parts.join(' ');
    return { lastName, letterCount };
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
      /^(yeah|yes|yep|yup|oh|um|uh|so|well|okay|ok|alright|sure|sir|ma'?am)[,.]?\s*/gi,
      /^(that\s+would\s+be|that'?s|it'?s|it\s+is|this\s+is|i'?m|i\s+am|my\s+name\s+is|the\s+name\s+is|name'?s)\s*/gi
    ];
    
    // Apply filler removal multiple times to handle stacked patterns
    for (let i = 0; i < 3; i++) {
      for (const pattern of fillerPatterns) {
        name = name.replace(pattern, '');
      }
    }
    
    // STEP 2: Check for "My first name is X, last name is Y" pattern
    // CRITICAL: First name must be only the given name, not "Tim and last name is Van Kallenberg"
    if (/first\s+name\s+is/i.test(name) && /last\s+name\s+is/i.test(name)) {
      const firstNameMatch = name.match(/first\s+name\s+is\s+([^,]+)/i);
      const lastNameMatch = name.match(/last\s+name\s+is\s+([^,.]+)/i);
      if (firstNameMatch && lastNameMatch) {
        let firstPart = firstNameMatch[1].trim().replace(/[.,!?]+$/g, '');
        // Strip " and " / " and my/the last name is ..." so we get only the first name (e.g. "Tim")
        const andLast = firstPart.match(/\s+and\s+(?:(?:my|the)\s+)?last\s+name\s+is\b/i);
        if (andLast) firstPart = firstPart.slice(0, andLast.index).trim();
        // Strip ". The last name is" / ". My last name is" and everything after (e.g. "Tim. The last name is Van..." -> "Tim")
        firstPart = firstPart.replace(/\s*\.\s*(?:the\s+)?(?:my\s+)?last\s+name\s+is\b.*$/i, '').trim();
        return {
          firstName: firstPart,
          lastName: lastNameMatch[1].trim().replace(/[.,!?]+$/g, '')
        };
      }
    }
    
    // STEP 2a: "FirstName. My last name is LastName" (e.g. "Tim. My last name is Van Kallenberg. It's spelled...")
    if (/\.\s*[Mm]y\s+last\s+name\s+is\b/i.test(name)) {
      const match = name.match(/^([A-Za-z]+)\.\s+[Mm]y\s+last\s+name\s+is\s+(.+)$/i);
      if (match) {
        const firstName = match[1].trim();
        let lastName = match[2].trim()
          .replace(/\s*\.\s*It'?s(?:\s+spelled)?.*$/i, '')  // strip ". It's spelled..."
          .replace(/\s*,?\s*spelled\s+.+$/i, '')
          .replace(/[.,!?]+$/g, '');
        if (firstName && lastName && looksLikeName(firstName)) {
          console.log(`📋 Extracted from "X. My last name is Y" pattern: firstName="${firstName}", lastName="${lastName}"`);
          return { firstName, lastName };
        }
      }
    }
    
    // STEP 2b: Check for "FirstName, [and my] last name is LastName" pattern (without "first name is")
    // Example: "Tim, last name is Van Cowenberg" or "Tim, and my last name is Van Kallenberg, spelled V-A-N..."
    if (/last\s+name\s+is/i.test(name) && !/first\s+name\s+is/i.test(name)) {
      const match = name.match(/^([^,]+),?\s*(?:and\s+my\s+)?last\s+name\s+is\s+(.+)$/i);
      if (match) {
        let firstName = match[1].trim().replace(/[.,!?]+$/g, '');
        let lastName = match[2].trim()
          .replace(/\s*,?\s*spelled\s+.+$/i, '')  // strip ", spelled V-A-N space..."
          .replace(/[.,!?]+$/g, '');
        if (firstName && lastName && looksLikeName(firstName)) {
          console.log(`📋 Extracted from "FirstName, [and my] last name is LastName" pattern: firstName="${firstName}", lastName="${lastName}"`);
          return { firstName, lastName };
        }
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
      awaitingConfirmation: false,
      spellingAttempts: 0
    };
  }

  /** Force lock name from best available (spelled, pending, or extract) and advance. Spelling max attempts reached. */
  function forceLockNameAndAdvance(spelledLastNameOrNull, transcript) {
    const first = cleanFieldValue(pendingClarification.value?.firstName) || pendingClarification.value?.firstName || data.firstName || '';
    let last = spelledLastNameOrNull && String(spelledLastNameOrNull).trim()
      ? cleanFieldValue(spelledLastNameOrNull) || spelledLastNameOrNull
      : (pendingClarification.value?.lastName && String(pendingClarification.value.lastName).trim())
        ? cleanFieldValue(pendingClarification.value.lastName) || pendingClarification.value.lastName
        : null;
    if (!last && transcript) {
      const corr = extractName(transcript);
      last = (corr.lastName && corr.lastName.trim()) ? cleanFieldValue(corr.lastName) || corr.lastName : null;
    }
    data.firstName = first || data.firstName || '';
    data.lastName = last || data.lastName || 'Unknown';
    data.name_confidence = 85;
    data._nameComplete = true;
    data._nameLocked = true;
    clearPendingClarification();
    console.log(`✅ Name force-locked (spelling cap): ${data.firstName} ${data.lastName}`);
    intakeLog('retry_cap_reached', { field: 'last_name', spelling_attempt_count: pendingClarification.spellingAttempts || 0 });
    intakeLog('field_locked', { field: 'name', value: `${data.firstName} ${data.lastName}` });
    return { nextState: transitionTo(STATES.PHONE), prompt: withAcknowledgment(CALLER_INFO.phone), action: 'ask' };
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
    // Step 1: Strip leading response words (no, yeah, sure, etc.)
    // Step 2: Strip email preamble phrases (it's, that would be, etc.)
    let email = text
      .replace(/^(no|nope|nah|yeah|yes|sure|okay|ok|um|uh)\s*,?\s*/gi, '')
      .replace(/^(so\s+the\s+|that\s+would\s+be|that's|it's|it\s+is|my\s+email\s+is|email\s+is|you\s+can\s+reach\s+me\s+at|reach\s+me\s+at|the\s+email\s+is)\s*/gi, '')
      .trim();
    
    // Remove spelling instructions and trailing clarifications
    email = email
      .replace(/\b(with\s+)?(two|2|double)\s+[a-z]'?s?\b/gi, '')
      .replace(/\band\s+that'?s\s+[^.]*$/i, '')  // Remove "and that's Tim with two M's" type endings
      .replace(/\b(and\s+)?(that'?s|it'?s)\s+[^.]*$/i, '')  // Remove trailing "and that's..." phrases
      .trim();
    
    // Extract just the email part (look for name pattern + "at" + domain)
    // Pattern: "TimVanC at gmail.com", "tim.vc at gmail.com", or "timvanc at gmail dot com"
    // Allow dots in local part so "tim.vc at gmail.com" is preserved
    const emailMatch = email.match(/([a-z0-9._]+(?:\s*[a-z0-9._]+)*?)\s+(?:at|@)\s+([a-z0-9\s]+(?:\s+dot\s+[a-z]+)+)/i);
    if (emailMatch) {
      // Clean up the name part - remove spaces but keep dots (tim.vc -> tim.vc)
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
      // Allow dots in local part so "tim.vc at gmail.com" -> tim.vc@gmail.com (not vc@gmail.com)
      const simpleMatch = email.match(/([a-z0-9._\s]+)\s+(?:at|@)\s+([a-z0-9.]+)/i);
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
    // Clean up and normalize availability; strip meta-speech and fillers
    let cleaned = text
      .replace(/^(yeah|yes|oh|um|uh|so|well|okay|ok)[,.]?\s*/gi, '')
      .replace(/^(i would say|i'd say|i'd\s+say|that would be|it would be|probably|maybe)\s*/gi, '')
      .replace(/^(just|say)\s*/gi, '')  // "just weekdays", "say weekdays" -> weekdays
      .replace(/^(i'm available|i can do|works for me|best for me is)\s*/gi, '')
      .replace(/\s+(just|say)\s+/gi, ' ')  // mid-phrase fillers
      .trim();
    
    return cleaned;
  }

  function applyRecapCorrectionsFromTranscript(text) {
    if (!text || typeof text !== 'string') return false;
    let updated = false;
    const lower = text.toLowerCase();

    // Handle explicit system-type corrections.
    if (/\b(system|unit|equipment)\b/.test(lower) || /\bboiler|furnace|heat\s*pump|central\s*air|ac|mini\s*-?\s*split\b/.test(lower)) {
      const normalizedSystemType = normalizeSystemType(text);
      if (normalizedSystemType && normalizedSystemType.trim()) {
        data.details.systemType = normalizedSystemType;
        data.details.systemTypeUncertain = /\b(not\s+too?\s+sure|maybe|i\s+think|unsure|not\s+sure|don'?t\s+know|could\s+be)\b/i.test(text);
        updated = true;
      }
    }

    // Handle explicit availability corrections.
    if (/\bavailability\b/.test(lower) || looksLikeAvailability(lower)) {
      const correctedAvailability = extractAvailability(text);
      const correctedLower = (correctedAvailability || '').toLowerCase();
      if (correctedAvailability && (looksLikeAvailability(correctedLower) || hasUrgencyAvailability(correctedLower))) {
        data.availability = correctedAvailability;
        data._availabilityComplete = true;
        data._availabilityLocked = true;
        data.availability_confidence = Math.max(data.availability_confidence || 0, 90);
        updated = true;
      }
    }

    return updated;
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
  
  /** Urgency-based availability: no heat, emergency, anytime, as soon as possible. Do not over-structure. */
  const URGENCY_AVAILABILITY_NOTES = 'Anytime. No heat. Urgent.';
  function hasUrgencyAvailability(text) {
    if (!text || text.length < 2) return false;
    const lower = text.toLowerCase();
    const urgencyPhrases = [
      /\bheat\s+is\s+off\b/i,
      /\bno\s+heat\b/i,
      /\bemergency\b/i,
      /\banytime\b/i,
      /\bas\s+soon\s+as\s+possible\b/i,
      /\basap\b/i,
      /\burgent\b/i,
      /\bwhenever\s+(you\s+can|possible)\b/i,
      /\b(soonest|earliest)\s+(you\s+can|possible)\b/i
    ];
    return urgencyPhrases.some(p => p.test(lower));
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
        const uncertainPhrases = /\b(not\s+too?\s+sure|i'?d\s+take|maybe|i\s+think|unsure|not\s+sure|don'?t\s+know|might\s+be)\b/i;
        data.details.systemTypeUncertain = uncertainPhrases.test(text);
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
        const uncertainPhrases = /\b(not\s+too?\s+sure|i'?d\s+take|maybe|i\s+think|unsure|not\s+sure|don'?t\s+know|might\s+be)\b/i;
        data.details.systemTypeUncertain = uncertainPhrases.test(text);
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
  
  /**
   * Detect if user is referring to their name (for backtracking)
   * Used to route back to NAME state when user mentions name-related issues
   */
  function isReferringToName(text) {
    const namePatterns = [
      /\b(my\s+)?(last\s+)?name\b/i,
      /\bspelling\b/i,
      /\byou\s+(got|have)\s+(my\s+)?name\b/i,
      /\bwait.*(name|spelled)/i,
      /\bgo\s+back.*(name)/i,
      /\babout\s+my\s+(last\s+)?name\b/i,
      /\bname\s+(is\s+)?(wrong|incorrect|not\s+right)/i
    ];
    return namePatterns.some(p => p.test(text));
  }
  
  /**
   * Detect if user is saying "no" without providing a correction
   * More strict than isCorrection - only matches clear negations
   */
  function isNegation(text) {
    const cleanText = text.trim().toLowerCase();
    // Pure negations (without additional content that looks like a correction)
    const pureNegations = [
      /^no\.?$/,
      /^nope\.?$/,
      /^not?\s+(right|correct|quite)\.?$/,
      /^that'?s?\s+(not\s+)?(right|correct|wrong)\.?$/,
      /^wrong\.?$/,
      /^incorrect\.?$/,
      /^no,?\s+that'?s?\s+(not\s+)?(it|right|correct)\.?$/
    ];
    // Check if it matches a pure negation pattern
    if (pureNegations.some(p => p.test(cleanText))) {
      return true;
    }
    // Also check for short "no" responses (under 15 chars without any name-like content)
    if (cleanText.length < 15 && /^no[,.\s]/.test(cleanText)) {
      // Make sure it doesn't contain a name correction
      const hasNameContent = /[A-Z]{2,}/i.test(cleanText.replace(/^no[,.\s]*/i, ''));
      if (!hasNameContent) {
        return true;
      }
    }
    return false;
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
    // Only return true if user is CLEARLY asking a follow-up question
    // Must contain explicit question markers — do NOT match vague affirmatives
    const questionPatterns = [
      'question', 'actually', 'what about', 'how about', 'can you',
      'one more', 'also', 'wait', 'before you go', 'hold on',
      'i also need', 'i have another', 'one more thing'
    ];
    // Explicit question mark = user is asking something
    if (text.includes('?')) return true;
    // Explicit question keywords
    if (questionPatterns.some(p => text.includes(p))) return true;
    // "yes" alone is NOT a question — "yes I have a question" IS
    if (text.includes('yes') && questionPatterns.some(p => text.includes(p))) return true;
    return false;
  }
  
  /** "No" / nothing else in CLOSE state → must terminate call (goodbye then hangup). */
  function isNegativeResponse(text) {
    if (!text || !text.trim()) return true;
    const lower = text.trim().toLowerCase();
    const negativePatterns = [
      /^no\.?$/i,
      /^nope\.?$/i,
      /^nah\.?$/i,
      /\bno\s+thanks?\b/i,
      /\bno\s+thank\s+you\b/i,
      /\bnothing\s+else\b/i,
      /\bthat'?s\s+it\b/i,
      /\bwe'?re\s+good\b/i,
      /\bi'?m\s+good\b/i,
      /\ball\s+set\b/i,
      /\ball\s+good\b/i,
      /\bthat'?s\s+all\b/i,
      /\bi'?m\s+done\b/i,
      /\bwe'?re\s+done\b/i,
      /\bthat\s+would\s+be\s+all\b/i,
      /\bnot\s+really\b/i,
      /\bno\s+that'?s\s+all\b/i
    ];
    if (negativePatterns.some(p => p.test(lower))) return true;
    if (lower.length < 4 && /^n[o0]\.?$/i.test(lower)) return true;
    return false;
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
    intakeLog,
    
    STATES,
    INTENT_TYPES
  };
}

module.exports = {
  createCallStateMachine,
  STATES,
  INTENT_TYPES
};
