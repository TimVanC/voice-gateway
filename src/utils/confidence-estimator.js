/**
 * Confidence Estimator for Transcription Quality
 * 
 * Estimates confidence levels for user-provided fields based on:
 * - Pattern matching (phone, email, names)
 * - Presence of uncertainty markers
 * - Response length vs expected length
 * - Common ASR errors
 */

// Confidence levels
const CONFIDENCE = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

// Thresholds
const THRESHOLDS = {
  // Minimum expected lengths
  MIN_NAME_LENGTH: 2,
  MIN_PHONE_DIGITS: 10,
  MIN_EMAIL_LENGTH: 5,
  MIN_ADDRESS_LENGTH: 5,
  MIN_ZIP_LENGTH: 5
};

// Uncertainty markers that lower confidence (as standalone words/phrases)
const UNCERTAINTY_MARKERS = [
  /\bum\b/, /\buh\b/, /\ber\b/, /\bhmm\b/, /\blike\b/, 
  /\bmaybe\b/, /\bi think\b/, /\bi guess\b/,
  /\bsomething like\b/, /\baround\b/, /\bapproximately\b/, /\bor something\b/
];

// Common ASR confusion patterns
const ASR_CONFUSION_PATTERNS = [
  // Letters that sound similar
  /[bpdtgk]{2,}/i,  // Consecutive plosives
  /[mn]{2,}/i,      // Consecutive nasals
  /[sz]{2,}/i,      // Consecutive sibilants
  // Numbers that sound similar
  /\b(fifteen|fifty|thirteen|thirty|fourteen|forty|sixteen|sixty)\b/i
];

/**
 * Estimate confidence for a first name
 */
function estimateFirstNameConfidence(transcript) {
  const cleaned = cleanTranscript(transcript);
  
  // Too short
  if (cleaned.length < THRESHOLDS.MIN_NAME_LENGTH) {
    return { level: CONFIDENCE.LOW, reason: 'name too short' };
  }
  
  // Contains numbers (unlikely for first name)
  if (/\d/.test(cleaned)) {
    return { level: CONFIDENCE.LOW, reason: 'contains numbers' };
  }
  
  // Has uncertainty markers
  if (hasUncertaintyMarkers(transcript)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'uncertainty detected' };
  }
  
  // Multiple words (might include filler words)
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 2) {
    return { level: CONFIDENCE.MEDIUM, reason: 'multiple words detected' };
  }
  
  // Unusual characters
  if (/[^a-zA-Z\s'-]/.test(cleaned)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'unusual characters' };
  }
  
  return { level: CONFIDENCE.HIGH, reason: 'clear' };
}

/**
 * Estimate confidence for a last name
 */
function estimateLastNameConfidence(transcript) {
  const cleaned = cleanTranscript(transcript);
  
  // Too short
  if (cleaned.length < THRESHOLDS.MIN_NAME_LENGTH) {
    return { level: CONFIDENCE.LOW, reason: 'name too short' };
  }
  
  // Contains numbers
  if (/\d/.test(cleaned)) {
    return { level: CONFIDENCE.LOW, reason: 'contains numbers' };
  }
  
  // Has uncertainty markers
  if (hasUncertaintyMarkers(transcript)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'uncertainty detected' };
  }
  
  // Complex/unusual spelling (long name or unusual patterns)
  if (cleaned.length > 12 || hasASRConfusionPatterns(cleaned)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'complex name - should confirm spelling' };
  }
  
  // Multiple spaces suggesting compound name
  const parts = cleaned.split(/\s+/).filter(w => w.length > 0);
  if (parts.length > 2) {
    return { level: CONFIDENCE.MEDIUM, reason: 'compound name detected' };
  }
  
  return { level: CONFIDENCE.HIGH, reason: 'clear' };
}

/**
 * Estimate confidence for a phone number
 */
function estimatePhoneConfidence(transcript) {
  const cleaned = transcript.toLowerCase();
  
  // Extract digits
  const digits = cleaned.replace(/\D/g, '');
  
  // Not enough digits
  if (digits.length < THRESHOLDS.MIN_PHONE_DIGITS) {
    return { level: CONFIDENCE.LOW, reason: 'not enough digits' };
  }
  
  // Too many digits
  if (digits.length > 11) {
    return { level: CONFIDENCE.LOW, reason: 'too many digits' };
  }
  
  // Has uncertainty markers
  if (hasUncertaintyMarkers(transcript)) {
    return { level: CONFIDENCE.LOW, reason: 'uncertainty in phone number' };
  }
  
  // Contains confusing number words
  if (hasConfusingNumberWords(cleaned)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'potentially confused number words' };
  }
  
  // Exactly 10 digits and no issues
  if (digits.length === 10) {
    return { level: CONFIDENCE.HIGH, reason: 'clear' };
  }
  
  return { level: CONFIDENCE.MEDIUM, reason: 'verify digit count' };
}

/**
 * Estimate confidence for an email
 */
function estimateEmailConfidence(transcript) {
  const cleaned = cleanTranscript(transcript).toLowerCase();
  
  // Too short
  if (cleaned.length < THRESHOLDS.MIN_EMAIL_LENGTH) {
    return { level: CONFIDENCE.LOW, reason: 'email too short' };
  }
  
  // Missing @ or at
  if (!cleaned.includes('@') && !cleaned.includes(' at ')) {
    return { level: CONFIDENCE.LOW, reason: 'missing @ symbol' };
  }
  
  // Has uncertainty markers
  if (hasUncertaintyMarkers(transcript)) {
    return { level: CONFIDENCE.LOW, reason: 'uncertainty in email' };
  }
  
  // Normalize and check format
  const normalized = cleaned
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s/g, '');
  
  // Basic email pattern check
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(normalized)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'unusual email format' };
  }
  
  // Complex domain or username
  if (normalized.length > 30) {
    return { level: CONFIDENCE.MEDIUM, reason: 'long email - should confirm spelling' };
  }
  
  return { level: CONFIDENCE.HIGH, reason: 'clear' };
}

/**
 * Estimate confidence for a street address
 */
function estimateAddressConfidence(transcript) {
  const cleaned = cleanTranscript(transcript);
  
  // Too short
  if (cleaned.length < THRESHOLDS.MIN_ADDRESS_LENGTH) {
    return { level: CONFIDENCE.LOW, reason: 'address too short' };
  }
  
  // Has uncertainty markers
  if (hasUncertaintyMarkers(transcript)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'uncertainty in address' };
  }
  
  // Check for common address patterns
  const hasNumber = /\d+/.test(cleaned);
  const hasStreetWord = /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd|circle|place|pl)\b/i.test(cleaned);
  
  if (!hasNumber) {
    return { level: CONFIDENCE.MEDIUM, reason: 'missing street number' };
  }
  
  if (!hasStreetWord) {
    return { level: CONFIDENCE.MEDIUM, reason: 'missing street type' };
  }
  
  // Very long address might have issues
  if (cleaned.length > 80) {
    return { level: CONFIDENCE.MEDIUM, reason: 'long address - should confirm' };
  }
  
  return { level: CONFIDENCE.HIGH, reason: 'clear' };
}

/**
 * Estimate confidence for a city name
 */
function estimateCityConfidence(transcript) {
  const cleaned = cleanTranscript(transcript);
  
  // Too short
  if (cleaned.length < 2) {
    return { level: CONFIDENCE.LOW, reason: 'city too short' };
  }
  
  // Has uncertainty markers
  if (hasUncertaintyMarkers(transcript)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'uncertainty detected' };
  }
  
  // Contains numbers (unusual for city)
  if (/\d/.test(cleaned)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'contains numbers' };
  }
  
  return { level: CONFIDENCE.HIGH, reason: 'clear' };
}

/**
 * Estimate confidence for a zip code
 */
function estimateZipConfidence(transcript) {
  const cleaned = transcript.toLowerCase();
  
  // Extract digits
  const digits = cleaned.replace(/\D/g, '');
  
  // Check for 5-digit or 9-digit zip
  if (digits.length !== 5 && digits.length !== 9) {
    return { level: CONFIDENCE.LOW, reason: 'invalid zip length' };
  }
  
  // Has uncertainty markers
  if (hasUncertaintyMarkers(transcript)) {
    return { level: CONFIDENCE.LOW, reason: 'uncertainty in zip code' };
  }
  
  // Contains confusing number words
  if (hasConfusingNumberWords(cleaned)) {
    return { level: CONFIDENCE.MEDIUM, reason: 'potentially confused digits' };
  }
  
  return { level: CONFIDENCE.HIGH, reason: 'clear' };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function cleanTranscript(transcript) {
  return transcript
    .replace(/^(my name is|i'm|i am|it's|this is|that's|yeah|yes|the|its)\s+/gi, '')
    .replace(/[.,!?]+$/g, '')
    .trim();
}

function hasUncertaintyMarkers(transcript) {
  const lower = transcript.toLowerCase();
  return UNCERTAINTY_MARKERS.some(pattern => pattern.test(lower));
}

function hasASRConfusionPatterns(text) {
  return ASR_CONFUSION_PATTERNS.some(pattern => pattern.test(text));
}

function hasConfusingNumberWords(text) {
  // Numbers that sound similar: 15/50, 13/30, 14/40, 16/60
  const confusingPairs = [
    ['fifteen', 'fifty'],
    ['thirteen', 'thirty'],
    ['fourteen', 'forty'],
    ['sixteen', 'sixty'],
    ['seventeen', 'seventy'],
    ['eighteen', 'eighty'],
    ['nineteen', 'ninety']
  ];
  
  return confusingPairs.some(pair => 
    pair.some(word => text.includes(word))
  );
}

// ============================================================================
// CLARIFICATION PROMPTS
// ============================================================================

const CLARIFICATION_PROMPTS = {
  firstName: {
    medium: (value) => `I heard ${value}. Is that correct?`,
    low: () => "I didn't catch that clearly. Could you repeat your first name?"
  },
  lastName: {
    medium: (value) => `I heard ${value}. Is that right?`,
    low: () => "Could you spell your last name for me?"
  },
  phone: {
    medium: (value) => `I have ${formatPhoneForReadback(value)}. Is that correct?`,
    low: () => "I may have missed a digit. Could you repeat the phone number slowly?"
  },
  email: {
    medium: (value) => `I have ${formatEmailForReadback(value)}. Is that right?`,
    low: () => "Could you spell out the email address for me?"
  },
  address: {
    medium: (value) => `I heard ${value}. Is that correct?`,
    low: () => "I didn't catch that clearly. Could you repeat the street address?"
  },
  city: {
    medium: (value) => `The city is ${value}, correct?`,
    low: () => "What city is that?"
  },
  zip: {
    medium: (value) => `Zip code ${formatZipForReadback(value)}, is that right?`,
    low: () => "Could you repeat the zip code?"
  }
};

function formatPhoneForReadback(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    return `${last10.slice(0,3)}, ${last10.slice(3,6)}, ${last10.slice(6)}`;
  }
  return phone;
}

function formatEmailForReadback(email) {
  return email
    .replace(/@/g, ' at ')
    .replace(/\./g, ' dot ');
}

function formatZipForReadback(zip) {
  const digits = zip.replace(/\D/g, '');
  return digits.split('').join(' ');
}

/**
 * Get clarification prompt for a field based on confidence
 */
function getClarificationPrompt(fieldType, value, confidenceResult) {
  const prompts = CLARIFICATION_PROMPTS[fieldType];
  if (!prompts) return null;
  
  if (confidenceResult.level === CONFIDENCE.MEDIUM) {
    return prompts.medium(value);
  } else if (confidenceResult.level === CONFIDENCE.LOW) {
    return prompts.low();
  }
  
  return null; // HIGH confidence - no clarification needed
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  CONFIDENCE,
  estimateFirstNameConfidence,
  estimateLastNameConfidence,
  estimatePhoneConfidence,
  estimateEmailConfidence,
  estimateAddressConfidence,
  estimateCityConfidence,
  estimateZipConfidence,
  getClarificationPrompt,
  formatPhoneForReadback,
  formatEmailForReadback,
  formatZipForReadback,
  cleanTranscript
};

