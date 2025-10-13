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

// Verification prompt templates
const VERIFY_PROMPTS = {
  first_name: (transcript) => `Got it. Could you please spell your first name for me?`,
  last_name: (transcript) => `Okay, thanks. Could you please spell your last name for me?`,
  email: (transcript) => `Thanks. Do you mind spelling out that email for me?`,
  phone: (transcript) => `Thanks. Could you say your phone number slowly, digit by digit?`,
  street: (transcript) => `Thanks. Could you please spell that street name for me?`,
  city: (transcript) => `Could you please spell the city name for me?`,
  state: (transcript) => `Could you spell the state for me?`,
  zip: (transcript) => `Could you repeat the zip code?`,
  
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
  }

  /**
   * Capture a field value with confidence checking
   * @param {string} fieldName - Name of the field
   * @param {string} transcript - Transcribed value
   * @param {number} confidence - Confidence score (0-1)
   * @returns {Object} - { needsVerify: boolean, prompt: string|null, shouldHalt: boolean }
   */
  captureField(fieldName, transcript, confidence) {
    // Check if already verified (skip re-verification)
    if (this.fields[fieldName]?.verified) {
      console.log(`⏭️  Field '${fieldName}' already verified, skipping`);
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
      const prompt = VERIFY_PROMPTS[fieldName] 
        ? VERIFY_PROMPTS[fieldName](transcript)
        : `Could you please confirm: "${transcript}"?`;

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
   * Handle verification response
   * @param {string} verifiedValue - User's verification response
   * @returns {Object} - { success: boolean, normalizedValue: string, prompt: string|null }
   */
  handleVerificationResponse(verifiedValue) {
    if (!this.awaitingVerification) {
      return { success: false, normalizedValue: null, prompt: "I'm not currently verifying anything." };
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

    if (fieldName === 'email') {
      normalizedValue = normalizeEmail(verifiedValue);
      // Re-validate
      if (!isValidEmail(normalizedValue)) {
        return {
          success: false,
          normalizedValue: null,
          prompt: "I'm sorry, that still doesn't look like a valid email. Could you spell it again, slowly?"
        };
      }
    } else if (fieldName === 'phone') {
      normalizedValue = normalizePhone(verifiedValue);
      if (!isValidPhone(normalizedValue)) {
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
    this.fields[fieldName] = {
      field: fieldName,
      raw_value: rawValue,
      final_value: finalValue,
      confidence: confidence,
      verified: verified,
      verified_at: verified ? new Date().toISOString() : null
    };
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

