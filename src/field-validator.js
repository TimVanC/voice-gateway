// field-validator.js - Confidence checking and verification for call intake fields

const CONFIDENCE_THRESHOLD = 0.60;

// Validation helpers
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidPhone(phone) {
  // Remove common formatting characters
  const digitsOnly = phone.replace(/[\s\-\(\)\+\.]/g, '');
  // Accept 10 digits (US) or 11 digits (with country code)
  return /^\d{10,11}$/.test(digitsOnly);
}

function normalizePhone(phone) {
  // Extract just digits
  const digitsOnly = phone.replace(/[\s\-\(\)\+\.]/g, '');
  // Format as (XXX) XXX-XXXX if 10 digits
  if (digitsOnly.length === 10) {
    return `(${digitsOnly.slice(0, 3)}) ${digitsOnly.slice(3, 6)}-${digitsOnly.slice(6)}`;
  }
  // Format with country code if 11 digits
  if (digitsOnly.length === 11) {
    return `+${digitsOnly[0]} (${digitsOnly.slice(1, 4)}) ${digitsOnly.slice(4, 7)}-${digitsOnly.slice(7)}`;
  }
  return digitsOnly;
}

function normalizeEmail(email) {
  return email.toLowerCase().trim();
}

function isValidAddress(address) {
  // Minimal check: has letters and is at least 3 characters
  return address && address.length >= 3 && /[a-zA-Z]/.test(address);
}

function hasUnlikelyNameCharacters(name) {
  // Check for numbers or special characters that are unlikely in names
  return /[0-9@#$%^&*()+=\[\]{}|\\;:'",<>?\/]/.test(name);
}

// Verification prompt templates - FIRST ask to repeat, THEN ask to spell
const VERIFY_PROMPTS = {
  first_name: (transcript, attemptCount) => {
    if (attemptCount === 0) return `Sorry, I didn't catch that. Could you repeat your first name?`;
    return `Thanks. Could you spell your first name for me, slowly?`;
  },
  last_name: (transcript, attemptCount) => {
    if (attemptCount === 0) return `Sorry, I didn't catch that. Could you repeat your last name?`;
    return `Thanks. Could you spell your last name for me, slowly?`;
  },
  email: (transcript, attemptCount) => {
    if (attemptCount === 0) return `Sorry, I didn't catch that. Could you repeat your email?`;
    return `Thanks. Could you spell that email for me, slowly?`;
  },
  phone: (transcript, attemptCount) => {
    if (attemptCount === 0) return `Sorry, I didn't catch that. Could you repeat your phone number?`;
    return `Thanks. Could you say your phone number slowly, one digit at a time?`;
  },
  street: (transcript, attemptCount) => {
    if (attemptCount === 0) return `Sorry, I didn't catch that. Could you repeat that address?`;
    return `Thanks. Could you spell that street name for me?`;
  },
  city: (transcript, attemptCount) => {
    if (attemptCount === 0) return `Sorry, I didn't catch that. Could you repeat the city?`;
    return `Thanks. Could you spell the city name for me?`;
  },
  state: (transcript, attemptCount) => `Could you spell the state for me?`,
  zip: (transcript, attemptCount) => `Could you repeat the zip code?`,
  
  // For problem context fields - use repeat-back
  issue_description: (transcript) => `I heard: "${transcript}". Is that correct?`,
  equipment_type: (transcript) => `I heard: "${transcript}". Is that correct?`,
  brand: (transcript) => `I heard: "${transcript}". Is that correct?`,
  symptoms: (transcript) => `I heard: "${transcript}". Is that correct?`,
  urgency: (transcript) => `I heard: "${transcript}". Is that correct?`
};

const VERIFY_RETRY_PROMPTS = {
  default: "No problem. Please repeat that once more, and I will confirm."
};

// Field categories
const PERSONAL_INFO_FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 
  'street', 'city', 'state', 'zip', 'preferred_contact_method'
];

const PROBLEM_CONTEXT_FIELDS = [
  'issue_description', 'equipment_type', 'brand', 'symptoms', 'urgency'
];

class FieldValidator {
  constructor() {
    this.fields = {}; // Store field data
    this.verificationEvents = []; // Log all verification attempts
    this.awaitingVerification = null; // Current field awaiting verification
    this.verificationAttempts = {}; // Track attempts per field (0 = first attempt = repeat, 1+ = spell)
  }

  /**
   * Capture a field value with confidence checking
   * @param {string} fieldName - Name of the field
   * @param {string} transcript - Transcribed value
   * @param {number} confidence - Confidence score (0-1)
   * @returns {Object} - { needsVerify: boolean, prompt: string|null, shouldHalt: boolean }
   */
  captureField(fieldName, transcript, confidence) {
    // Check if already verified AND has valid data (skip re-verification)
    if (this.fields[fieldName]?.verified && this.fields[fieldName]?.final_value) {
      console.log(`⏭️  Field '${fieldName}' already verified with value, skipping`);
      return { needsVerify: false, prompt: null, shouldHalt: false, alreadyVerified: true };
    }

    // Format validation checks
    let needsFormatFix = false;
    let formatReason = null;

    if (fieldName === 'email' && !isValidEmail(transcript)) {
      needsFormatFix = true;
      formatReason = 'invalid_format';
    } else if (fieldName === 'phone' && !isValidPhone(transcript)) {
      needsFormatFix = true;
      formatReason = 'invalid_format';
    } else if ((fieldName === 'first_name' || fieldName === 'last_name') && hasUnlikelyNameCharacters(transcript)) {
      needsFormatFix = true;
      formatReason = 'unlikely_characters';
    } else if ((fieldName === 'street' || fieldName === 'city') && !isValidAddress(transcript)) {
      needsFormatFix = true;
      formatReason = 'invalid_format';
    }

    // Confidence check
    const lowConfidence = confidence <= CONFIDENCE_THRESHOLD;
    const needsVerify = lowConfidence || needsFormatFix;

    if (needsVerify) {
      // Store raw value
      this.fields[fieldName] = {
        field: fieldName,
        raw_value: transcript,
        final_value: null,
        confidence: confidence,
        verified: false,
        verified_at: null
      };

      // Log verification event
      const reason = formatReason || 'low_confidence';
      
      // Track attempts for this field
      if (!this.verificationAttempts[fieldName]) {
        this.verificationAttempts[fieldName] = 0;
      }
      const attemptCount = this.verificationAttempts[fieldName];
      
      const prompt = VERIFY_PROMPTS[fieldName] 
        ? VERIFY_PROMPTS[fieldName](transcript, attemptCount)
        : `Could you please confirm: "${transcript}"?`;
      
      // Increment attempt count for next time
      this.verificationAttempts[fieldName]++;

      this.verificationEvents.push({
        field: fieldName,
        reason: reason,
        prompt_used: prompt,
        timestamp: new Date().toISOString(),
        confidence: confidence
      });

      // Set awaiting state
      this.awaitingVerification = {
        fieldName,
        originalTranscript: transcript,
        confidence,
        reason
      };

      return { needsVerify: true, prompt, shouldHalt: true };
    }

    // No verification needed - save directly
    this.saveField(fieldName, transcript, transcript, confidence, true);
    return { needsVerify: false, prompt: null, shouldHalt: false };
  }

  /**
   * Parse spelled-out text to actual format
   * Example: "T-I-M at example dot com" -> "tim@example.com"
   */
  parseSpelledText(text) {
    // Remove spaces between single characters (T I M -> TIM)
    let parsed = text.replace(/\b([A-Z])\s+(?=[A-Z]\s|[A-Z]$)/gi, '$1');
    
    // Replace spelled-out symbols - be more flexible
    parsed = parsed.replace(/\s*@\s*/gi, '@');  // Handle existing @
    parsed = parsed.replace(/\s+at\s+/gi, '@');
    parsed = parsed.replace(/\s+dot\s+/gi, '.');
    parsed = parsed.replace(/\s+dash\s+/gi, '-');
    parsed = parsed.replace(/\s+underscore\s+/gi, '_');
    
    // Remove hyphens between single characters (T-I-M -> TIM)
    parsed = parsed.replace(/([A-Z])-(?=[A-Z])/gi, '$1');
    
    // Handle "gmail" without ".com"
    if (parsed.toLowerCase().includes('gmail') && !parsed.toLowerCase().includes('gmail.com')) {
      parsed = parsed.replace(/gmail/gi, 'gmail.com');
    }
    
    // Remove all remaining spaces
    parsed = parsed.replace(/\s+/g, '');
    
    return parsed.toLowerCase();
  }

  /**
   * Handle verification response
   * @param {string} verifiedValue - User's verification response
   * @returns {Object} - { success: boolean, normalizedValue: string, prompt: string|null }
   */
  handleVerificationResponse(verifiedValue) {
    if (!this.awaitingVerification) {
      console.log(`⚠️  handleVerificationResponse called but awaitingVerification is null/false`);
      return { success: false, normalizedValue: null, prompt: "I'm not currently verifying anything.", resetState: true };
    }

    const { fieldName, originalTranscript } = this.awaitingVerification;

    // For problem context fields, check if they said yes/no
    if (PROBLEM_CONTEXT_FIELDS.includes(fieldName)) {
      const response = verifiedValue.toLowerCase().trim();
      if (response.includes('yes') || response.includes('correct') || response.includes('right')) {
        // Accept original transcript
        this.saveField(fieldName, originalTranscript, originalTranscript, 0.60, true);
        this.awaitingVerification = null;
        return { success: true, normalizedValue: originalTranscript, prompt: null };
      } else if (response.includes('no') || response.includes('wrong') || response.includes('incorrect')) {
        // Ask them to repeat
        return { 
          success: false, 
          normalizedValue: null, 
          prompt: VERIFY_RETRY_PROMPTS.default,
          shouldRetry: true
        };
      }
      // If unclear, treat as new value
    }

    // For personal info fields, normalize the spelled/confirmed value
    let normalizedValue = verifiedValue.trim();
    
    // Check if this is obviously garbage before accepting
    if (fieldName === 'first_name' || fieldName === 'last_name') {
      // Reject obvious garbage patterns
      const garbagePatterns = [
        /^[a-z]{1,3}$/i,  // Single short word (a, ok, um)
        /-bit-/i,  // Shmitty-bit-shmitty
        /-do-/i,   // Sha-do-sha
        /^(shmit|schmit|shmoot|bit|boop)/i,  // Nonsense syllables
      ];
      
      if (garbagePatterns.some(pattern => pattern.test(normalizedValue))) {
        console.log(`⚠️  Garbage pattern detected in name: "${normalizedValue}"`);
        const attempts = this.verificationAttempts[fieldName] || 0;
        if (attempts >= 3) {
          console.log(`⚠️  Too many attempts, giving up on this field`);
          this.awaitingVerification = null;
          return { success: false, normalizedValue: null, prompt: null, giveUp: true };
        }
        return {
          success: false,
          normalizedValue: null,
          prompt: "I'm having trouble understanding. Could you spell your name using letters, like: J-O-H-N?"
        };
      }
    }

    if (fieldName === 'email') {
      // Parse spelled-out format (T-I-M at gmail dot com -> tim@gmail.com)
      normalizedValue = this.parseSpelledText(verifiedValue);
      normalizedValue = normalizeEmail(normalizedValue);
      
      console.log(`📧 Email parsing: "${verifiedValue}" -> "${normalizedValue}"`);
      
      // Re-validate
      if (!isValidEmail(normalizedValue)) {
        // Check attempt count - give up after 3 attempts (reduced from 5)
        const attempts = this.verificationAttempts[fieldName] || 0;
        if (attempts >= 3) {
          console.log(`⚠️  Too many verification attempts (${attempts}), accepting raw value and continuing`);
          // Accept the original spoken value (best we have)
          this.saveField(fieldName, originalTranscript, verifiedValue, 0.5, true);
          this.awaitingVerification = null;
          return { success: true, normalizedValue: verifiedValue, prompt: null };
        }
        
        return {
          success: false,
          normalizedValue: null,
          prompt: `I'm having trouble with the email. Could you try saying it like: john at gmail dot com?`
        };
      }
    } else if (fieldName === 'phone') {
      // Parse spelled-out digits (nine seven three -> 973)
      normalizedValue = this.parseSpelledText(verifiedValue);
      normalizedValue = normalizePhone(normalizedValue);
      
      console.log(`📞 Phone parsing: "${verifiedValue}" -> "${normalizedValue}"`);
      
      if (!isValidPhone(normalizedValue)) {
        // Check attempt count - give up after 5 attempts
        const attempts = this.verificationAttempts[fieldName] || 0;
        if (attempts >= 5) {
          console.log(`⚠️  Too many verification attempts (${attempts}), accepting as-is`);
          this.saveField(fieldName, originalTranscript, verifiedValue, 0.5, true);
          this.awaitingVerification = null;
          return { success: true, normalizedValue: verifiedValue, prompt: null };
        }
        
        return {
          success: false,
          normalizedValue: null,
          prompt: "I'm sorry, I didn't catch all the digits. Could you repeat your phone number, one digit at a time?"
        };
      }
    }

    // Save verified field
    this.saveField(fieldName, originalTranscript, normalizedValue, this.awaitingVerification.confidence, true);
    this.awaitingVerification = null;

    return { success: true, normalizedValue, prompt: null };
  }

  /**
   * Save field data
   */
  saveField(fieldName, rawValue, finalValue, confidence, verified) {
    // CRITICAL: Don't mark as verified if the value is clearly invalid
    const isActuallyValid = this.validateFieldValue(fieldName, finalValue);
    
    this.fields[fieldName] = {
      field: fieldName,
      raw_value: rawValue,
      final_value: finalValue,
      confidence: confidence,
      verified: verified && isActuallyValid,  // Only mark verified if actually valid
      verified_at: (verified && isActuallyValid) ? new Date().toISOString() : null
    };
  }
  
  /**
   * Validate that a field value is actually valid (not garbage)
   */
  validateFieldValue(fieldName, value) {
    if (!value || value.trim().length === 0) return false;
    
    const lowerValue = value.toLowerCase().trim();
    
    // Universal garbage words
    const garbageWords = ['thank you', 'thanks', 'bye', 'goodbye', 'hello', 'hi', 'okay', 'ok', 'yes', 'no', 'uh', 'um', 'watching'];
    if (garbageWords.includes(lowerValue)) return false;
    
    // Also check if value CONTAINS these words (for phrases like "thanks for watching")
    const garbagePhrases = ['thank', 'watching', 'for watching'];
    if (garbagePhrases.some(phrase => lowerValue.includes(phrase))) return false;
    
    // Field-specific validation
    if (fieldName === 'first_name' || fieldName === 'last_name') {
      // Names must be at least 2 chars, no numbers, no special symbols
      if (value.length < 2) return false;
      if (/\d/.test(value)) return false;
      if (garbageWords.some(word => lowerValue.includes(word))) return false;
      
      // Single word names are suspicious (should be first + last)
      const words = value.trim().split(/\s+/);
      if (words.length < 2) return false;
    }
    
    if (fieldName === 'email') {
      // Must have @ and domain
      if (!isValidEmail(value)) return false;
    }
    
    if (fieldName === 'phone') {
      // Must have 10-11 digits
      if (!isValidPhone(value)) return false;
    }
    
    return true;
  }

  /**
   * Get current field being verified
   */
  getCurrentVerification() {
    return this.awaitingVerification;
  }

  /**
   * Clear verification state (for retry)
   */
  clearVerification() {
    this.awaitingVerification = null;
  }

  /**
   * Get all captured fields
   */
  getAllFields() {
    return Object.values(this.fields);
  }

  /**
   * Get verification events log
   */
  getVerificationEvents() {
    return this.verificationEvents;
  }

  /**
   * Get SharePoint-ready data
   */
  getSharePointData() {
    return {
      fields: this.getAllFields(),
      verification_events: this.getVerificationEvents()
    };
  }

  /**
   * Reset all state (for new call)
   */
  reset() {
    this.fields = {};
    this.verificationEvents = [];
    this.awaitingVerification = null;
  }
}

module.exports = {
  FieldValidator,
  isValidEmail,
  isValidPhone,
  normalizePhone,
  normalizeEmail,
  CONFIDENCE_THRESHOLD,
  PERSONAL_INFO_FIELDS,
  PROBLEM_CONTEXT_FIELDS
};

