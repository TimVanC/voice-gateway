/**
 * Google Sheets Call Intake Logger - V1
 * 
 * Temporary client-facing solution to log call intake data.
 * Schema designed to be future-proof for HubSpot integration.
 * 
 * V1 Requirements:
 * - Only log after confirmation step succeeds (CLOSE state)
 * - Skip emergency redirects, dropped calls, out-of-scope calls
 * - Append-only (never overwrite)
 * - Human-readable call_summary (1-2 sentences plain English)
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ============================================================================
// CONFIGURATION
// ============================================================================
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_SHEET_NAME || 'RSE Data Call Intake Log';
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS; // File path
const GOOGLE_SHEETS_CREDENTIALS_JSON = process.env.GOOGLE_SHEETS_CREDENTIALS; // Inline JSON (fallback)

// ============================================================================
// V1 SCHEMA DEFINITION (Required columns only)
// ============================================================================
// Expected column order (for reference)
// A: call_id
// B: call_timestamp
// C: first_name
// D: last_name
// E: conf_name (confidence for name - column C in user's spec means 3rd data column, which is E after call_id and timestamp)
// F: phone_number
// G: conf_pn (confidence for phone - column F in user's spec means 6th data column, which is G)
// H: conf_mail (confidence for email - before email column)
// I: email
// J: primary_intent
// K: conf_add (confidence for address - before service_address)
// L: service_address
// M: conf_avail (confidence for availability - before availability_notes)
// N: availability_notes
// O: call_summary
// P: call_status

const COLUMN_HEADERS = [
  'call_id',
  'call_timestamp',
  'first_name',
  'last_name',
  'conf_name',        // Column E (user said column C, but that's 3rd data column = E after call_id/timestamp)
  'phone_number',
  'conf_pn',          // Column G (user said column F, but that's 6th data column = G)
  'conf_mail',        // Before email
  'email',
  'primary_intent',
  'conf_add',         // Before service_address
  'service_address',
  'conf_avail',       // Before availability_notes
  'availability_notes',
  'call_summary',
  'call_status'
];

// ============================================================================
// VALIDATION AND NORMALIZATION FUNCTIONS
// ============================================================================

/**
 * Remove filler phrases and partial utterances from text
 * Examples: "yeah it's", "uh", "um", "that would be", etc.
 */
function removeFillerPhrases(text) {
  if (!text || typeof text !== 'string') return '';
  
  let cleaned = text.trim();
  
  // Common filler phrases to remove
  const fillerPatterns = [
    /^(yeah\s*,?\s*)?(it'?s|it\s+is|that'?s|that\s+is|that\s+would\s+be|so\s+the|the)\s+/gi,
    /^(um|uh|er|ah|oh|well|so|like)\s*,?\s*/gi,
    /^(okay|ok|alright|right|sure|yeah|yes|yep|yup)\s*,?\s*/gi,
    /\s+(um|uh|er|ah|oh|well|so|like)\s*$/gi,
    /\s+(okay|ok|alright|right|sure|yeah|yes|yep|yup)\s*$/gi,
    /^(i\s+think|i\s+guess|i\s+mean|you\s+know)\s*,?\s*/gi,
    /\s+(i\s+think|i\s+guess|i\s+mean|you\s+know)\s*$/gi,
    // Additional filler phrases
    /\b(to\s+be\s+honest|let\s+me\s+think|let\s+me\s+see|i\s+don'?t\s+know|i'?m\s+not\s+sure)\b\s*,?\s*/gi,
    /^a\s+(to\s+be\s+honest|um+|uh+)\s*\.?\s*/gi  // "a to be honest." pattern
  ];
  
  fillerPatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '');
  });
  
  // Remove multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

/**
 * Normalize spelled-out words (E L F → Elf)
 * Handles patterns like "E L F", "E-L-F", "E. L. F.", "E L F Road"
 */
function normalizeSpelling(text) {
  if (!text || typeof text !== 'string') return '';
  
  // Find sequences of single uppercase letters separated by spaces, dashes, or periods
  // Pattern: Match "E L F", "E-L-F", "E. L. F." etc.
  // We'll use a simpler iterative approach
  let result = text;
  
  // Match pattern: single letter, then 1-14 more single letters separated by spaces/dashes/periods
  // Example: "E L F" or "E-L-F" or "E. L. F."
  const pattern = /\b([A-Z])(?:\s*[-.\s]+\s*([A-Z]))(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?(?:\s*[-.\s]+\s*([A-Z]))?\b/g;
  
  result = result.replace(pattern, (match) => {
    // Extract all single uppercase letters
    const letters = match.match(/\b[A-Z]\b/g);
    if (letters && letters.length >= 2 && letters.length <= 15) {
      // Combine into word and capitalize first letter
      const word = letters.join('').toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
    return match;
  });
  
  return result;
}

/**
 * Validate and normalize phone number
 * Returns normalized phone (10 digits) or empty string if invalid
 */
function validateAndNormalizePhone(phone) {
  if (!phone) return '';
  
  // Remove filler phrases first
  let cleaned = removeFillerPhrases(phone);
  
  // Extract digits only
  const digits = cleaned.replace(/\D/g, '');
  
  // Must be exactly 10 digits (US phone number)
  if (digits.length === 10) {
    // Format as XXX-XXX-XXXX
    return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
  }
  
  // If 11 digits and starts with 1, use last 10
  if (digits.length === 11 && digits.startsWith('1')) {
    const last10 = digits.slice(1);
    return `${last10.slice(0,3)}-${last10.slice(3,6)}-${last10.slice(6)}`;
  }
  
  // Invalid - return empty string
  console.log(`⚠️  Invalid phone number: "${phone}" (${digits.length} digits)`);
  return '';
}

/**
 * Validate and normalize email
 * Returns normalized email or empty string if invalid
 */
function validateAndNormalizeEmail(email) {
  if (!email) return '';
  
  // Remove filler phrases first
  let cleaned = removeFillerPhrases(email);
  
  // Normalize spelling in email (handle spelled-out domains)
  cleaned = normalizeSpelling(cleaned);
  
  // Convert "at" and "dot" to symbols
  cleaned = cleaned
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s+/g, '') // Remove all spaces
    .toLowerCase()
    .trim();
  
  // Remove trailing periods and other punctuation
  cleaned = cleaned.replace(/[.,;:!?]+$/, '');
  
  // Basic email validation
  // Must have exactly one @
  const atCount = (cleaned.match(/@/g) || []).length;
  if (atCount !== 1) {
    console.log(`⚠️  Invalid email: "${email}" (${atCount} @ symbols)`);
    return '';
  }
  
  // Must have domain and extension
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
  if (!emailRegex.test(cleaned)) {
    console.log(`⚠️  Invalid email format: "${email}"`);
    return '';
  }
  
  return cleaned;
}

/**
 * Validate and normalize service address
 * Returns normalized address or empty string if invalid
 */
function validateAndNormalizeAddress(address) {
  if (!address) return '';
  
  // Remove filler phrases first
  let cleaned = removeFillerPhrases(address);
  
  // Normalize spelling (E L F → Elf)
  cleaned = normalizeSpelling(cleaned);
  
  // Must look like a real address - should have a street number at minimum
  const hasNumber = /^\s*\d{1,6}\s+/.test(cleaned);
  const hasStreetType = /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd|circle|place|pl|terrace|terr)\b/i.test(cleaned);
  
  // Accept address if it has a number and at least one word after it
  // Street type is preferred but not required (user might say "11 Elf" instead of "11 Elf Road")
  const hasStreetName = /^\s*\d{1,6}\s+\S+/.test(cleaned);
  
  if (!hasNumber || !hasStreetName) {
    console.log(`⚠️  Invalid address format: "${address}"`);
    return '';
  }
  
  // Log if street type is missing (but still accept it)
  if (!hasStreetType) {
    console.log(`📋 Address accepted without explicit street type: "${cleaned}"`);
  }
  
  // Reject if it contains symptom/problem descriptions
  const symptomPatterns = [
    /\b(blowing|heating|cooling|not working|broken|issue|problem|symptom|error|fault)\b/i,
    /\b(lukewarm|warm|cold|hot|air|unit|system|hvac|furnace|boiler|running|still)\b/i,
    /\b(just|only)\s+(blowing|heating|cooling|working|running)\b/i,
    /\b(no|not)\s+(hot|cold|warm|air|heat|cooling)\s+(coming|blowing|out)\b/i
  ];
  
  if (symptomPatterns.some(pattern => pattern.test(cleaned))) {
    console.log(`⚠️  Address contains symptom description: "${address}"`);
    return '';
  }
  
  // Capitalize first letter of each word (proper address format)
  cleaned = cleaned.split(' ').map(word => {
    if (word.length === 0) return word;
    // Don't capitalize common words
    const lower = word.toLowerCase();
    if (['the', 'of', 'and', 'a', 'an', 'in', 'on', 'at', 'to', 'for'].includes(lower)) {
      return lower;
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
  
  return cleaned;
}

/**
 * Clean name: remove fillers and normalize spelling, but preserve spaces
 * Examples: "that's Tim" → "Tim", "V-A-N space C-A-U-W-E-N-B-E-R-G-E" → "Van Cauwenberge"
 */
function cleanName(name) {
  if (!name) return '';
  
  // Remove filler phrases first
  let cleaned = removeFillerPhrases(name);
  
  // Remove tokens like "space", "dash", "hyphen" that might be left over from spelled names
  cleaned = cleaned.replace(/\b(space|dash|hyphen)\b/gi, ' ');
  
  // Normalize spelling: convert "E L F" → "Elf", but preserve existing spaces
  // Don't collapse multiple spaces that are part of the name structure
  cleaned = normalizeSpelling(cleaned);
  
  // Clean up multiple spaces but preserve single spaces (for names like "Van Cauwenberge")
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

/**
 * Clean availability notes: remove filler phrases
 */
function cleanAvailabilityNotes(availability) {
  if (!availability) return '';
  
  return availability
    .replace(/^(i'?d\s+say|i\s+think|probably|maybe|uh|um|er|ah|oh)\s*,?\s*/gi, '')
    .replace(/\s+(i'?d\s+say|probably|maybe)\s+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean and make call summary semantic
 * Removes filler words and rephrases into operational language
 */
function cleanCallSummary(summary) {
  if (!summary) return '';
  
  // Remove common filler words (expanded list)
  const fillerWords = ['uh', 'um', 'er', 'ah', 'oh', 'like', 'you know', 'i mean', 'i think', 'i guess', 
                       'yeah', 'yes', 'yep', 'yup', 'just', 'only', 'really', 'very', 'quite', 'pretty',
                       'well', 'so', 'okay', 'ok', 'alright', 'right', 'sure', 'there\'s', 'there is'];
  let cleaned = summary;
  
  fillerWords.forEach(filler => {
    const regex = new RegExp(`\\b${filler}\\b`, 'gi');
    cleaned = cleaned.replace(regex, '');
  });
  
  // Remove filler phrases
  cleaned = removeFillerPhrases(cleaned);
  
  // Normalize spelling
  cleaned = normalizeSpelling(cleaned);
  
  // Clean up multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Rephrase common patterns into operational language
  cleaned = cleaned
    .replace(/\b(no|not|isn'?t|isn't|doesn'?t|doesn't|won'?t|won't)\s+(hot|warm|air|heat|cooling)\s+(coming|blowing|out)\b/gi, 'no warm air')
    .replace(/\b(blowing|pushing)\s+(out|out of)\s+(lukewarm|warm|cold|hot)\s+air\b/gi, 'blowing warm air')
    .replace(/\b(just|only)\s+(blowing|heating|cooling|working|running)\b/gi, 'operating')
    .replace(/\b(not|no)\s+(working|heating|cooling|running)\b/gi, 'not functioning')
    .replace(/\b(issue|problem|trouble)\s+with\b/gi, 'issue with')
    .replace(/\b(reported|said|mentioned)\s+that\b/gi, 'reported');
  
  // Ensure it's 1-2 sentences
  const sentences = cleaned.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 2) {
    cleaned = sentences.slice(0, 2).join('. ') + '.';
  }
  
  // Ensure it ends with punctuation
  if (!cleaned.match(/[.!?]$/)) {
    cleaned += '.';
  }
  
  return cleaned;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Initialize Google Sheets API client
 * Supports both file-based (GOOGLE_APPLICATION_CREDENTIALS) and inline JSON (GOOGLE_SHEETS_CREDENTIALS)
 */
function getSheetsClient() {
  if (!SPREADSHEET_ID) {
    throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID environment variable is required');
  }
  
  try {
    let auth;
    
    // Check if GOOGLE_APPLICATION_CREDENTIALS is actually JSON (starts with {)
    // This handles cases where Railway sets it to JSON instead of a file path
    if (GOOGLE_APPLICATION_CREDENTIALS) {
      const trimmed = GOOGLE_APPLICATION_CREDENTIALS.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        // It's JSON, not a file path - use it directly
        console.log(`📝 Using JSON credentials from GOOGLE_APPLICATION_CREDENTIALS`);
        let credentials;
        try {
          credentials = JSON.parse(trimmed);
        } catch (e) {
          throw new Error('GOOGLE_APPLICATION_CREDENTIALS contains invalid JSON');
        }
        auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        return google.sheets({ version: 'v4', auth });
      } else {
        // It's a file path - try to use it
        const credentialsPath = path.resolve(GOOGLE_APPLICATION_CREDENTIALS);
        if (fs.existsSync(credentialsPath)) {
          console.log(`📁 Using file-based credentials from: ${credentialsPath}`);
          auth = new google.auth.GoogleAuth({
            keyFile: credentialsPath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
          });
          return google.sheets({ version: 'v4', auth });
        } else {
          console.warn(`⚠️  Credentials file not found at: ${credentialsPath}, trying inline JSON...`);
        }
      }
    }
    
    // Fall back to inline JSON credentials (GOOGLE_SHEETS_CREDENTIALS)
    if (GOOGLE_SHEETS_CREDENTIALS_JSON) {
      console.log(`📝 Using inline JSON credentials from GOOGLE_SHEETS_CREDENTIALS`);
      let credentials;
      try {
        credentials = typeof GOOGLE_SHEETS_CREDENTIALS_JSON === 'string' 
          ? JSON.parse(GOOGLE_SHEETS_CREDENTIALS_JSON) 
          : GOOGLE_SHEETS_CREDENTIALS_JSON;
      } catch (e) {
        throw new Error('GOOGLE_SHEETS_CREDENTIALS must be valid JSON');
      }
      
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      return google.sheets({ version: 'v4', auth });
    }
    
    // Neither method available
    throw new Error('Google credentials not configured. Set either GOOGLE_APPLICATION_CREDENTIALS (file path or JSON) or GOOGLE_SHEETS_CREDENTIALS (JSON string)');
  } catch (error) {
    throw new Error(`Failed to initialize Google Sheets client: ${error.message}`);
  }
}

/**
 * Generate human-readable call summary (1-2 sentences plain English)
 * For completed calls: Include system type and key symptoms if provided
 * For incomplete calls: Summarize collected information and note early disconnect
 * Summary is cleaned and semantic (no filler words)
 */
function generateCallSummary(callData, callStatus) {
  const {
    intent,
    details = {}
  } = callData;
  
  const normalizedIntent = normalizeIntent(intent, callData);
  const systemType = normalizeSystemType(details.systemType);
  
  // Build summary based on available details
  let summary = '';
  
  // Add the issue/problem description (clean it first)
  let issueText = '';
  if (details.symptoms) {
    issueText = cleanCallSummary(details.symptoms);
  } else if (details.issueDescription) {
    issueText = cleanCallSummary(details.issueDescription);
  } else if (details.generatorIssue) {
    issueText = cleanCallSummary(details.generatorIssue);
  } else if (details.helpNeeded) {
    issueText = cleanCallSummary(details.helpNeeded);
  }
  
  // Clean issue text: remove filler words like "uh", "yeah", "just"
  issueText = issueText
    .replace(/\b(uh|um|er|ah|oh|yeah|yes|yep|yup|just|only|really|very|quite|pretty)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Truncate issue text if too long
  if (issueText.length > 150) {
    issueText = issueText.substring(0, 150) + '...';
  }
  
  // Combine system type and issue (make semantic, not verbatim)
  if (systemType && issueText) {
    // Clean issue text: remove filler words and rephrase
    const cleanedIssue = issueText
      .replace(/\b(there'?s|there\s+is|there'?s\s+no)\s+/gi, 'no ')
      .replace(/\b(no|not)\s+(hot|warm|air|heat|cooling)\s+(coming|blowing|out|from)\b/gi, 'no warm air')
      .replace(/\s+/g, ' ')
      .trim();
    
    summary = `Caller reported no warm air coming from a ${systemType} system.`;
    
    // If we have more specific info, use it
    if (cleanedIssue && cleanedIssue.length > 10 && cleanedIssue !== 'no warm air') {
      summary = `Caller reported ${cleanedIssue} from a ${systemType} system.`;
    }
  } else if (systemType) {
    summary = `Caller reported issue with a ${systemType} system.`;
  } else if (issueText) {
    // Clean and simplify issue text
    const cleanedIssue = issueText
      .replace(/\b(there'?s|there\s+is)\s+(no)\s+/gi, 'no ')
      .replace(/\b(no|not)\s+(hot|warm|air|heat|cooling)\s+(coming|blowing|out)\b/gi, 'no warm air')
      .trim();
    summary = `Caller reported ${cleanedIssue}.`;
  } else {
    // Fallback: basic intent description (clean and semantic)
    const intentDescriptions = {
      'hvac_service': 'HVAC service request',
      'hvac_installation': 'HVAC installation request',
      'generator_existing': 'Existing generator service request',
      'generator_new': 'New generator installation request',
      'membership': 'Membership inquiry',
      'existing_project': 'Existing project inquiry'
    };
    summary = intentDescriptions[normalizedIntent] || 'Service request';
    
    // For generator_existing, add issue if available
    if (normalizedIntent === 'generator_existing' && details.generatorIssue) {
      const cleanIssue = cleanCallSummary(details.generatorIssue)
        .replace(/\b(uh|um|er|ah|oh|yeah|yes|yep|yup|just|only|really|very|quite|pretty)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleanIssue) {
        summary = `Caller reported an existing generator that ${cleanIssue}.`;
      }
    }
  }
  
  // Add safety status if relevant
  if (callData.isSafetyRisk === false && normalizedIntent === 'hvac_service') {
    summary += ' No safety issues reported.';
  }
  
  // For incomplete calls, explicitly note early disconnect
  if (callStatus === 'incomplete_hangup') {
    summary += ' Call ended before intake was completed.';
  }
  
  // For out of scope calls
  if (callStatus === 'out_of_scope_only') {
    return 'Caller requested service outside of scope.';
  }
  
  // Clean the final summary (remove any remaining fillers)
  summary = cleanCallSummary(summary);
  
  // Ensure it's 1-2 sentences (split if too long)
  const sentences = summary.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 2) {
    summary = sentences.slice(0, 2).join('. ') + '.';
  }
  
  // Ensure it ends with punctuation
  if (!summary.match(/[.!?]$/)) {
    summary += '.';
  }
  
  return summary;
}

/**
 * Normalize intent to canonical values only
 * Returns: hvac_service, hvac_installation, generator_existing, generator_new, 
 *          membership, existing_project, out_of_scope
 */
function normalizeIntent(intent, callData = {}) {
  if (!intent) return '';
  
  const normalized = intent.toLowerCase().trim();
  
  // Map to canonical values
  if (normalized === 'hvac_service' || normalized === 'hvac service') {
    return 'hvac_service';
  }
  if (normalized === 'hvac_installation' || normalized === 'hvac_installation_or_upgrade' || 
      normalized === 'hvac installation' || normalized === 'hvac installation or upgrade') {
    return 'hvac_installation';
  }
  if (normalized === 'generator') {
    // Check if it's existing or new based on details
    if (callData.details?.generatorType === 'existing') {
      return 'generator_existing';
    }
    if (callData.details?.generatorType === 'new') {
      return 'generator_new';
    }
    // Default to existing if we have generatorIssue, otherwise new
    if (callData.details?.generatorIssue) {
      return 'generator_existing';
    }
    return 'generator_new'; // Default assumption for new installations
  }
  if (normalized === 'generator_existing' || normalized === 'generator existing') {
    return 'generator_existing';
  }
  if (normalized === 'generator_new' || normalized === 'generator new') {
    return 'generator_new';
  }
  if (normalized === 'membership') {
    return 'membership';
  }
  if (normalized === 'existing_project' || normalized === 'existing project') {
    return 'existing_project';
  }
  if (normalized === 'other_out_of_scope' || normalized === 'out_of_scope' || 
      normalized === 'other out of scope' || normalized === 'out of scope') {
    return 'out_of_scope';
  }
  
  // Fallback: return as-is if it matches a canonical value
  const canonicalValues = [
    'hvac_service', 'hvac_installation', 'generator_existing', 'generator_new',
    'membership', 'existing_project', 'out_of_scope'
  ];
  if (canonicalValues.includes(normalized)) {
    return normalized;
  }
  
  // Unknown intent - return empty string
  return '';
}

/**
 * Build service address from address components
 * Validates and normalizes the address before returning
 */
function buildServiceAddress(callData) {
  const { address, city, state, zip } = callData;
  
  // Validate and normalize the street address
  const normalizedAddress = address ? validateAndNormalizeAddress(address) : '';
  
  // Only build full address if we have a valid street address
  if (!normalizedAddress) {
    return '';
  }
  
  const parts = [normalizedAddress];
  
  // Add city if provided (normalize spelling, remove trailing period)
  if (city) {
    let normalizedCity = normalizeSpelling(removeFillerPhrases(city));
    normalizedCity = normalizedCity.replace(/\.+$/, ''); // Remove trailing periods
    if (normalizedCity) {
      parts.push(normalizedCity);
    }
  }
  
  // Add state if provided (convert full name to abbreviation)
  if (state) {
    const stateAbbreviations = {
      'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
      'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
      'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
      'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
      'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO',
      'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
      'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
      'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
      'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
      'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
      'district of columbia': 'DC'
    };
    const stateLower = state.toLowerCase().trim();
    const normalizedState = stateAbbreviations[stateLower] || state.toUpperCase().trim();
    if (normalizedState.length === 2) {
      parts.push(normalizedState);
    }
  }
  
  // Add zip if provided (validate it's numeric)
  if (zip) {
    const zipDigits = zip.replace(/\D/g, '');
    if (zipDigits.length === 5 || zipDigits.length === 9) {
      parts.push(zipDigits);
    }
  }
  
  return parts.join(', ') || '';
}

/**
 * Normalize system type to lowercase canonical values
 * Examples: furnace, boiler, central air, heat pump, mini split, rooftop unit, etc.
 * If multiple systems mentioned, returns comma-separated list
 */
function normalizeSystemType(systemType) {
  if (!systemType) return '';
  
  // Remove filler phrases first - these should never be system types
  let cleaned = systemType
    .replace(/^(oh|uh|um|er|ah|yeah|yes|well|so|okay|to be honest|let me think|let me see|i don't know|i'm not sure)\s*[,.]?\s*/gi, '')
    .replace(/\b(it'?s|it\s+is|that'?s|that\s+is|here|there)\b/gi, '')
    .trim();
  
  // If only filler words, return empty (fallback to intent-based summary)
  if (!cleaned || cleaned.length < 2) return '';
  
  const normalized = cleaned.toLowerCase().trim();
  
  // Map common variations to canonical values
  const systemTypeMap = {
    'furnace': 'furnace',
    'boiler': 'boiler',
    'central air': 'central air',
    'central air conditioning': 'central air',
    'central ac': 'central air',
    'heat pump': 'heat pump',
    'mini split': 'mini split',
    'mini-split': 'mini split',
    'ductless': 'mini split',
    'rooftop unit': 'rooftop unit',
    'rtu': 'rooftop unit',
    'packaged unit': 'packaged unit',
    'package unit': 'packaged unit',
    'generator standby': 'generator standby',
    'standby generator': 'generator standby',
    'generator portable': 'generator portable',
    'portable generator': 'generator portable',
    'ac': 'central air',
    'air conditioning': 'central air',
    'air conditioner': 'central air'
  };
  
  // Check for exact matches first
  if (systemTypeMap[normalized]) {
    return systemTypeMap[normalized];
  }
  
  // Check for partial matches (e.g., "gas furnace" contains "furnace")
  for (const [key, value] of Object.entries(systemTypeMap)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return value;
    }
  }
  
  // If multiple systems mentioned (comma-separated), normalize each
  if (normalized.includes(',')) {
    const systems = normalized.split(',').map(s => s.trim());
    const normalizedSystems = systems.map(s => {
      for (const [key, value] of Object.entries(systemTypeMap)) {
        if (s.includes(key) || key.includes(s)) {
          return value;
        }
      }
      return s; // Return as-is if no match
    });
    return normalizedSystems.filter(s => s).join(', ');
  }
  
  // Return as-is if no normalization found
  return normalized;
}

/**
 * Determine call completion status
 * Returns canonical values: completed, incomplete_hangup, emergency_redirect, out_of_scope_only
 * 
 * Distinction is based only on flow completion:
 * - completed: CLOSE state reached OR confirmation prompt was delivered (regardless of who hangs up)
 * - incomplete_hangup: caller disconnected before confirmation was delivered
 */
function determineCallStatus(currentState, callData) {
  const { STATES, INTENT_TYPES } = require('../scripts/rse-script');
  
  // Emergency redirects
  if (callData.isSafetyRisk === true) {
    return 'emergency_redirect';
  }
  
  // Out of scope only (caller never pivoted to allowed service)
  if (callData.intent === INTENT_TYPES.OUT_OF_SCOPE || callData.intent === 'other_out_of_scope') {
    return 'out_of_scope_only';
  }
  
  // Complete - reached CLOSE state or confirmation was delivered
  // If confirmation prompt was delivered, the call is complete even if user hangs up
  if (currentState === STATES.CLOSE || currentState === STATES.ENDED || callData._confirmationDelivered || callData._closeStateReached) {
    return 'completed';
  }
  
  // All other cases are incomplete hangups (didn't reach confirmation)
  return 'incomplete_hangup';
}

/**
 * Transform call data to v1 row format
 * 
 * Progressive data capture: Log all information successfully collected before disconnect.
 * For incomplete_hangup: Log all collected data (first_name, last_name, phone, email, intent, etc.)
 * For completed: Log all fields including availability and address
 * 
 * Only leave fields blank if they were never collected.
 * All fields are validated and normalized before persisting.
 */
function transformCallDataToRow(callData, currentState, metadata = {}) {
  const {
    firstName,
    lastName,
    phone,
    email,
    intent,
    address,
    city,
    zip,
    availability,
    name_confidence,
    phone_confidence,
    email_confidence,
    address_confidence,
    availability_confidence
  } = callData;
  
  const callId = metadata.callId || `CALL-${Date.now()}`;
  const timestamp = metadata.timestamp || new Date().toISOString();
  const callStatus = determineCallStatus(currentState, callData);
  
  // Normalize intent to canonical value (only if intent was collected)
  const normalizedIntent = intent ? normalizeIntent(intent, callData) : '';
  
  // Validate and normalize phone number
  // Use phone from callData, or fallback to callerNumber from metadata
  const rawPhone = phone || metadata.callerNumber || '';
  const phoneNumber = rawPhone ? validateAndNormalizePhone(rawPhone) : '';
  
  // Validate and normalize email
  const normalizedEmail = email ? validateAndNormalizeEmail(email) : '';
  
  // Build and validate service address
  const serviceAddress = buildServiceAddress(callData);
  
  // Clean availability notes (remove fillers like "I'd say", "probably")
  const availabilityNotes = availability ? cleanAvailabilityNotes(availability) : '';
  
  // Clean names (remove fillers, normalize spelling)
  // CRITICAL: normalizeSpelling should preserve spaces in names like "Van Cauwenberge"
  // Don't remove spaces - they're part of the name structure
  const cleanFirstName = firstName ? cleanName(firstName) : '';
  const cleanLastName = lastName ? cleanName(lastName) : '';
  
  // For all calls (complete and incomplete): Log all collected data
  // Only leave fields blank if they were never collected or failed validation
  // Column order matches COLUMN_HEADERS array
  return [
    callId,
    timestamp,
    cleanFirstName, // Validated and cleaned
    cleanLastName, // Validated and cleaned
    name_confidence !== null && name_confidence !== undefined ? name_confidence : '', // conf_name - Confidence percentage (0-100)
    phoneNumber, // Validated (10 digits) or empty if invalid
    phone_confidence !== null && phone_confidence !== undefined ? phone_confidence : '', // conf_pn - Confidence percentage (0-100)
    email_confidence !== null && email_confidence !== undefined ? email_confidence : '', // conf_mail - Confidence percentage (0-100)
    normalizedEmail, // Validated (proper format) or empty if invalid
    normalizedIntent, // Normalized to canonical value
    address_confidence !== null && address_confidence !== undefined ? address_confidence : '', // conf_add - Confidence percentage (0-100)
    serviceAddress, // Validated (real address) or empty if invalid
    availability_confidence !== null && availability_confidence !== undefined ? availability_confidence : '', // conf_avail - Confidence percentage (0-100)
    availabilityNotes, // Cleaned (filler phrases removed)
    generateCallSummary(callData, callStatus), // Cleaned and semantic
    callStatus
  ];
}

/**
 * Check if call should be logged based on state and data
 * 
 * Log ALL calls except:
 * - Emergency redirects (safety risk)
 * 
 * Even incomplete calls, crashes, and early hangups should be logged
 * with appropriate status designation.
 * 
 * @param {string} currentState - Current state from state machine
 * @param {Object} callData - Call data object
 * @returns {boolean} True if call should be logged
 */
function shouldLogCall(currentState, callData) {
  // Don't log emergency redirects (these are handled differently)
  if (callData.isSafetyRisk === true) {
    return false;
  }
  
  // Log everything else - complete, incomplete, crashes, hangups
  return true;
}

/**
 * Ensure confidence columns exist at specific positions
 * Column positions based on user specification:
 * - conf_name at column C (3rd data column = E after call_id/timestamp)
 * - conf_pn at column F (6th data column = G after call_id/timestamp)
 * - conf_mail before email
 * - conf_add before service_address
 * - conf_avail before availability_notes
 */
async function ensureConfidenceColumns(sheets, spreadsheetId, sheetName, existingHeaders) {
  const sheetId = await getSheetId(sheets, spreadsheetId, sheetName);
  
  const columnMap = {
    'conf_name': { beforeColumn: 'phone_number', description: 'name confidence at column E (after first_name, last_name)' },
    'conf_pn': { beforeColumn: 'conf_mail', description: 'phone confidence at column G (after phone_number)' },
    'conf_mail': { beforeColumn: 'email', description: 'email confidence before email' },
    'conf_add': { beforeColumn: 'service_address', description: 'address confidence before service_address' },
    'conf_avail': { beforeColumn: 'availability_notes', description: 'availability confidence before availability_notes' }
  };
  
  let needsUpdate = false;
  const insertRequests = [];
  
  // Check each confidence column in order (process from right to left to avoid index shifting issues)
  const columnsToCheck = ['conf_avail', 'conf_add', 'conf_mail', 'conf_pn', 'conf_name'];
  
  for (const columnName of columnsToCheck) {
    const config = columnMap[columnName];
    const columnIndex = existingHeaders.indexOf(columnName);
    
    if (columnIndex === -1) {
      // Column is missing - need to insert it
      console.log(`📊 Missing confidence column: ${columnName} (${config.description})`);
      
      // Find the index of the "before" column to insert before it
      const beforeIndex = existingHeaders.indexOf(config.beforeColumn);
      
      if (beforeIndex === -1) {
        console.warn(`⚠️  Cannot find "${config.beforeColumn}" column to insert "${columnName}" before it. Skipping.`);
        continue;
      }
      
      // Insert column at beforeIndex position
      insertRequests.push({
        insertDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'COLUMNS',
            startIndex: beforeIndex,
            endIndex: beforeIndex + 1
          },
          inheritFromBefore: false
        }
      });
      
      // Insert the header value
      insertRequests.push({
        updateCells: {
          range: {
            sheetId: sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: beforeIndex,
            endColumnIndex: beforeIndex + 1
          },
          rows: [{
            values: [{
              userEnteredValue: { stringValue: columnName }
            }]
          }],
          fields: 'userEnteredValue'
        }
      });
      
      // Update existingHeaders array to account for the new column (for subsequent checks)
      existingHeaders.splice(beforeIndex, 0, columnName);
      
      needsUpdate = true;
      const columnLetter = columnNumberToLetter(beforeIndex + 1);
      console.log(`✅ Will insert ${columnName} at column ${columnLetter} (before ${config.beforeColumn})`);
    } else {
      const columnLetter = columnNumberToLetter(columnIndex + 1);
      console.log(`✅ Confidence column ${columnName} already exists at column ${columnLetter}`);
    }
  }
  
  if (needsUpdate && insertRequests.length > 0) {
    try {
      // Execute batch update to insert columns (process in reverse order to avoid index issues)
      // Actually, we processed from right to left, so we can execute in order
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: insertRequests
        }
      });
      
      console.log(`✅ Schema update complete: Inserted ${insertRequests.length / 2} confidence columns`);
    } catch (error) {
      console.error(`❌ Failed to insert confidence columns: ${error.message}`);
      throw error;
    }
  } else if (!needsUpdate) {
    console.log(`✅ All confidence columns already exist - no schema update needed`);
  }
}

/**
 * Get sheet ID by sheet name
 */
async function getSheetId(sheets, spreadsheetId, sheetName) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found`);
  }
  return sheet.properties.sheetId;
}

/**
 * Convert column number to letter (1-indexed: A=1, B=2, etc.)
 */
function columnNumberToLetter(n) {
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

/**
 * Ensure sheet exists and has headers
 * Also handles schema evolution - inserts missing confidence columns at specific positions
 */
async function ensureSheetSetup(sheets, spreadsheetId, sheetName) {
  try {
    // Get spreadsheet metadata
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId
    });
    
    // Check if sheet exists
    const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetName);
    
    if (!sheet) {
      // Create sheet
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: sheetName
              }
            }
          }]
        }
      });
      
      // Add headers
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [COLUMN_HEADERS]
        }
      });
      
      console.log(`✅ Created sheet "${sheetName}" with v1 headers`);
    } else {
      // Check if headers exist (read first row)
      const firstRow = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A1:Z1` // Read more columns to check for schema evolution
      });
      
      if (!firstRow.data.values || firstRow.data.values.length === 0) {
        // Add headers
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A1`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [COLUMN_HEADERS]
          }
        });
        
        console.log(`✅ Added v1 headers to sheet "${sheetName}"`);
      } else {
        // Schema evolution: Check and insert missing confidence columns at specific positions
        const existingHeaders = firstRow.data.values[0] || [];
        await ensureConfidenceColumns(sheets, spreadsheetId, sheetName, existingHeaders);
      }
    }
  } catch (error) {
    console.error('❌ Error setting up sheet:', error.message);
    throw error;
  }
}

/**
 * Check if a call_id already exists in the sheet (idempotency check)
 * Returns true if call_id exists, false otherwise
 */
async function callIdExists(sheets, spreadsheetId, sheetName, callId) {
  try {
    // Read all call_id values from column A (skip header row)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:A`, // Column A, starting from row 2
    });
    
    if (!response.data.values) {
      return false;
    }
    
    // Flatten array and check if callId exists
    const existingCallIds = response.data.values.flat();
    return existingCallIds.includes(callId);
  } catch (error) {
    console.error(`⚠️  Error checking for duplicate call_id: ${error.message}`);
    // If check fails, allow the write (better to have duplicates than miss data)
    return false;
  }
}

// ============================================================================
// MAIN LOGGING FUNCTION
// ============================================================================

/**
 * Log call intake data to Google Sheets (V1)
 * 
 * Logs ALL calls including:
 * - Complete calls (reached CLOSE state)
 * - Incomplete calls (early exit, crash, hangup)
 * - Calls with missing data
 * 
 * Does NOT log:
 * - Emergency redirects (safety risk)
 * 
 * @param {Object} callData - Call data from state machine
 * @param {string} currentState - Current state from state machine
 * @param {Object} metadata - Additional metadata (callId, callerNumber, timestamp)
 * @returns {Promise<Object>} Result of the logging operation
 */
async function logCallIntake(callData, currentState, metadata = {}) {
  // Check if call should be logged
  if (!shouldLogCall(currentState, callData)) {
    const reason = callData.isSafetyRisk ? 'emergency redirect' : 'unknown';
    console.log(`⏭️  Skipping Google Sheets log: ${reason}`);
    return { success: false, skipped: true, reason };
  }
  
  if (!SPREADSHEET_ID || (!GOOGLE_APPLICATION_CREDENTIALS && !GOOGLE_SHEETS_CREDENTIALS_JSON)) {
    console.warn('⚠️  Google Sheets logging disabled (missing credentials)');
    console.warn(`   Call would have been logged with status: ${determineCallStatus(currentState, callData)}`);
    console.warn(`   To enable logging, set GOOGLE_SHEETS_SPREADSHEET_ID and either:`);
    console.warn(`     - GOOGLE_APPLICATION_CREDENTIALS (file path), or`);
    console.warn(`     - GOOGLE_SHEETS_CREDENTIALS (JSON string)`);
    return { success: false, error: 'Google Sheets credentials not configured', skipped: true };
  }
  
  try {
    let sheets;
    try {
      sheets = getSheetsClient();
    } catch (error) {
      console.error(`❌ Failed to initialize Google Sheets client: ${error.message}`);
      return { success: false, error: error.message };
    }
    
    // Ensure sheet exists with headers (and handle schema evolution)
    await ensureSheetSetup(sheets, SPREADSHEET_ID, SHEET_NAME);
    
    // Generate call_id
    const callId = metadata.callId || `CALL-${Date.now()}`;
    
    // Idempotency check: Prevent duplicate rows for the same call_id
    const alreadyExists = await callIdExists(sheets, SPREADSHEET_ID, SHEET_NAME, callId);
    if (alreadyExists) {
      console.log(`⏭️  Call ${callId} already logged - skipping duplicate`);
      return {
        success: true,
        skipped: true,
        reason: 'duplicate_call_id',
        callId
      };
    }
    
    // Transform data to row format (with validation and normalization)
    const row = transformCallDataToRow(callData, currentState, {
      ...metadata,
      callId,
      timestamp: metadata.timestamp || new Date().toISOString()
    });
    
    // Get current header count to ensure row matches column count
    const currentHeaders = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:Z1`
    });
    
    const headerCount = currentHeaders.data.values?.[0]?.length || COLUMN_HEADERS.length;
    
    // Pad row to match header count (in case schema evolved)
    while (row.length < headerCount) {
      row.push('');
    }
    
    // Append row to sheet (append-only, never overwrite)
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [row]
      }
    });
    
    console.log(`✅ Call intake logged to Google Sheets (row ${response.data.updates.updatedRows}, call_id: ${callId})`);
    
    return {
      success: true,
      rowNumber: response.data.updates.updatedRows,
      callId,
      spreadsheetId: SPREADSHEET_ID,
      sheetName: SHEET_NAME
    };
    
  } catch (error) {
    console.error('❌ Error logging to Google Sheets:', error.message);
    console.error('Stack:', error.stack);
    
    return {
      success: false,
      error: error.message
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  logCallIntake,
  COLUMN_HEADERS,
  transformCallDataToRow,
  shouldLogCall,
  generateCallSummary,
  determineCallStatus
};
