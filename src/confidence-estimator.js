// confidence-estimator.js - Heuristic confidence estimation for transcriptions
// Since OpenAI Realtime API doesn't provide real confidence scores,
// we estimate confidence based on transcription quality indicators

/**
 * Estimate confidence based on transcription characteristics
 * @param {string} transcript - The transcribed text
 * @param {string} fieldContext - Field being captured (e.g., 'email', 'phone', 'name')
 * @returns {number} - Estimated confidence (0-1)
 */
function estimateConfidence(transcript, fieldContext = 'general') {
  if (!transcript || transcript.trim().length === 0) {
    return 0.0;
  }

  const text = transcript.trim();
  let confidence = 1.0; // Start optimistic
  const indicators = [];

  // 1. Check for common transcription artifacts that indicate low confidence
  const lowConfidencePatterns = [
    /\[inaudible\]/i,
    /\[unclear\]/i,
    /\[unintelligible\]/i,
    /\?\?\?/,
    /\*\*\*/,
    /\[music\]/i,
    /\[noise\]/i,
    /\[static\]/i,
  ];

  for (const pattern of lowConfidencePatterns) {
    if (pattern.test(text)) {
      confidence -= 0.4;
      indicators.push('transcription_artifact');
      break;
    }
  }

  // 2. Unusual length for field type
  if (fieldContext === 'email' && text.length > 100) {
    confidence -= 0.3;
    indicators.push('unusual_length');
  }
  if (fieldContext === 'phone' && text.length > 50) {
    confidence -= 0.3;
    indicators.push('unusual_length');
  }
  if ((fieldContext === 'first_name' || fieldContext === 'last_name') && text.length > 50) {
    confidence -= 0.3;
    indicators.push('unusual_length');
  }

  // 3. Excessive filler words (indicates uncertain speech)
  const fillerWords = ['um', 'uh', 'like', 'you know', 'i mean', 'sort of', 'kind of'];
  const fillerCount = fillerWords.reduce((count, filler) => {
    const regex = new RegExp(`\\b${filler}\\b`, 'gi');
    return count + (text.match(regex) || []).length;
  }, 0);
  
  if (fillerCount > 2) {
    confidence -= 0.2;
    indicators.push('excessive_fillers');
  }

  // 4. Check for gibberish patterns (random consonant clusters)
  const gibberishPatterns = [
    /[bcdfghjklmnpqrstvwxyz]{6,}/i,  // 6+ consonants in a row
    /^[a-z]{1,2}$/i,  // Single or double letter (suspicious for names/emails)
  ];

  for (const pattern of gibberishPatterns) {
    if (pattern.test(text.replace(/\s/g, ''))) {
      confidence -= 0.3;
      indicators.push('gibberish_pattern');
      break;
    }
  }

  // 5. Repeated words (often indicates transcription confusion)
  const words = text.toLowerCase().split(/\s+/);
  const wordSet = new Set(words);
  if (words.length > 2 && wordSet.size < words.length * 0.6) {
    confidence -= 0.3;
    indicators.push('repeated_words');
  }

  // 6. Field-specific validation (boost confidence if valid format)
  if (fieldContext === 'email') {
    const hasAtSymbol = /@/.test(text);
    const hasDotCom = /\.(com|org|net|edu|gov)/i.test(text);
    if (hasAtSymbol && hasDotCom) {
      confidence = Math.min(1.0, confidence + 0.1);
      indicators.push('valid_email_pattern');
    } else if (!hasAtSymbol) {
      // Missing @ symbol - likely spoken format or garbled
      confidence -= 0.5;
      if (text.includes('at') || text.includes('dot')) {
        indicators.push('spoken_email_format');
      } else {
        indicators.push('missing_email_format');
      }
    }
  }

  if (fieldContext === 'phone') {
    const digitsOnly = text.replace(/\D/g, '');
    if (digitsOnly.length === 10 || digitsOnly.length === 11) {
      confidence = Math.min(1.0, confidence + 0.1);
      indicators.push('valid_phone_length');
    } else if (digitsOnly.length < 5) {
      confidence -= 0.4;
      indicators.push('insufficient_digits');
    }
  }

  // 7. Very short responses for open-ended questions
  if (fieldContext === 'issue_description' && text.length < 10) {
    confidence -= 0.2;
    indicators.push('too_short');
  }

  // 8. Question marks (indicates uncertain transcription)
  const questionMarkCount = (text.match(/\?/g) || []).length;
  if (questionMarkCount > 1) {
    confidence -= 0.2;
    indicators.push('multiple_question_marks');
  }

  // 9. All caps (sometimes indicates shouting or transcription error)
  if (text === text.toUpperCase() && text.length > 10) {
    confidence -= 0.1;
    indicators.push('all_caps');
  }

  // 10. Contains only numbers when expecting text
  if ((fieldContext === 'first_name' || fieldContext === 'last_name') && /^\d+$/.test(text)) {
    confidence -= 0.5;
    indicators.push('numbers_in_name');
  }

  // 11. Common farewell/dismissal phrases (not actual data)
  const farewellPhrases = ['bye', 'goodbye', 'see you', 'thanks for your time', 'have a good day', 'no thanks'];
  if (farewellPhrases.some(phrase => text.toLowerCase().includes(phrase))) {
    confidence -= 0.6;  // Very low confidence for goodbye phrases
    indicators.push('farewell_phrase');
  }

  // 12. For name fields, check if response is too short or contains common non-names
  if ((fieldContext === 'first_name' || fieldContext === 'last_name')) {
    if (text.length < 2) {
      confidence -= 0.5;
      indicators.push('name_too_short');
    }
    const nonNameWords = ['no', 'yes', 'okay', 'ok', 'thanks', 'bye', 'uh', 'um', 'hello', 'hi', 'model'];
    if (nonNameWords.includes(text.toLowerCase().trim())) {
      confidence -= 0.7;  // Very unlikely to be a name
      indicators.push('non_name_word');
    }
    
    // Check for unusual characters in names (–, —, special symbols)
    if (/[–—•°©®™\[\]{}|\\<>]/.test(text)) {
      confidence -= 0.6;
      indicators.push('unusual_name_characters');
    }
    
    // Single word that's too short for a full name
    const words = text.trim().split(/\s+/);
    if (words.length === 1 && text.length < 3) {
      confidence -= 0.5;
      indicators.push('incomplete_name');
    }
  }

  // Clamp confidence to 0-1 range
  confidence = Math.max(0.0, Math.min(1.0, confidence));

  return {
    confidence: parseFloat(confidence.toFixed(2)),
    indicators: indicators,
    originalText: text
  };
}

/**
 * Get field context from conversation state or question type
 * @param {string} lastQuestion - The last question asked
 * @returns {string} - Field context
 */
function inferFieldContext(lastQuestion) {
  const lowerQuestion = lastQuestion.toLowerCase();
  
  // Order matters - check most specific first
  if (lowerQuestion.includes('first name')) return 'first_name';
  if (lowerQuestion.includes('last name')) return 'last_name';
  if (lowerQuestion.includes('full name') || lowerQuestion.includes('your name')) return 'first_name';  // FIX: Detect "What's your name?"
  if (lowerQuestion.includes('email')) return 'email';
  if (lowerQuestion.includes('phone') || lowerQuestion.includes('number to reach')) return 'phone';
  if (lowerQuestion.includes('street') || lowerQuestion.includes('address')) return 'street';
  if (lowerQuestion.includes('city')) return 'city';
  if (lowerQuestion.includes('state')) return 'state';
  if (lowerQuestion.includes('zip')) return 'zip';
  if (lowerQuestion.includes('issue') || lowerQuestion.includes('problem')) return 'issue_description';
  if (lowerQuestion.includes('system') || lowerQuestion.includes('equipment')) return 'equipment_type';
  if (lowerQuestion.includes('brand')) return 'brand';
  if (lowerQuestion.includes('symptoms') || lowerQuestion.includes('happening')) return 'symptoms';
  if (lowerQuestion.includes('urgent')) return 'urgency';
  
  return 'general';
}

module.exports = {
  estimateConfidence,
  inferFieldContext
};

