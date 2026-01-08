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
const COLUMN_HEADERS = [
  'call_id',
  'call_timestamp',
  'first_name',
  'last_name',
  'phone_number',
  'email',
  'primary_intent',
  'service_address',
  'availability_notes',
  'call_summary',
  'call_status'
];

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
 * For completed calls: based on collected details
 * For incomplete_hangup: "Caller disconnected before completing intake."
 * For out_of_scope_only: "Caller requested service outside of scope."
 */
function generateCallSummary(callData, callStatus) {
  // For incomplete hangups, use standard message
  if (callStatus === 'incomplete_hangup') {
    return 'Caller disconnected before completing intake.';
  }
  
  // For out of scope calls
  if (callStatus === 'out_of_scope_only') {
    return 'Caller requested service outside of scope.';
  }
  
  // For completed calls, build detailed summary
  const {
    intent,
    firstName,
    lastName,
    situationSummary,
    availability,
    details = {}
  } = callData;
  
  const normalizedIntent = normalizeIntent(intent, callData);
  
  // Build summary based on intent and available details
  let summary = '';
  
  // Start with the issue/problem description
  if (details.symptoms) {
    const symptoms = details.symptoms.trim();
    if (symptoms.length > 200) {
      summary = symptoms.substring(0, 200) + '...';
    } else {
      summary = symptoms;
    }
  } else if (situationSummary) {
    const summaryText = situationSummary.trim();
    if (summaryText.length > 200) {
      summary = summaryText.substring(0, 200) + '...';
    } else {
      summary = summaryText;
    }
  } else if (details.issueDescription) {
    const issue = details.issueDescription.trim();
    if (issue.length > 200) {
      summary = issue.substring(0, 200) + '...';
    } else {
      summary = issue;
    }
  } else if (details.generatorIssue) {
    const issue = details.generatorIssue.trim();
    if (issue.length > 200) {
      summary = issue.substring(0, 200) + '...';
    } else {
      summary = issue;
    }
  } else if (details.helpNeeded) {
    const help = details.helpNeeded.trim();
    if (help.length > 200) {
      summary = help.substring(0, 200) + '...';
    } else {
      summary = help;
    }
  } else {
    // Fallback: basic intent description
    const intentDescriptions = {
      'hvac_service': 'HVAC service request',
      'hvac_installation': 'HVAC installation request',
      'generator_existing': 'Existing generator service request',
      'generator_new': 'New generator installation request',
      'membership': 'Membership inquiry',
      'existing_project': 'Existing project inquiry'
    };
    summary = intentDescriptions[normalizedIntent] || 'Service request';
  }
  
  // Add system type if available
  if (details.systemType && !summary.toLowerCase().includes(details.systemType.toLowerCase())) {
    summary = `${details.systemType}. ${summary}`;
  }
  
  // Add safety status if relevant
  if (callData.isSafetyRisk === false && normalizedIntent === 'hvac_service') {
    summary += ' No safety issues reported.';
  }
  
  // Ensure it's 1-2 sentences (split if too long)
  const sentences = summary.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 2) {
    return sentences.slice(0, 2).join('. ') + '.';
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
 */
function buildServiceAddress(callData) {
  const { address, city, zip } = callData;
  
  const parts = [];
  if (address) parts.push(address);
  if (city) parts.push(city);
  if (zip) parts.push(zip);
  
  return parts.join(', ') || '';
}

/**
 * Determine call completion status
 * Returns canonical values: completed, incomplete_hangup, emergency_redirect, out_of_scope_only
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
  
  // Complete - reached CLOSE state with required data
  if (currentState === STATES.CLOSE) {
    const hasRequiredData = callData.firstName && 
                            callData.lastName && 
                            callData.phone && 
                            callData.intent;
    if (hasRequiredData) {
      return 'completed';
    }
    // Missing required data - downgrade to incomplete
    return 'incomplete_hangup';
  }
  
  // All other cases are incomplete hangups
  return 'incomplete_hangup';
}

/**
 * Transform call data to v1 row format
 * 
 * For incomplete_hangup: Only populate call_id, call_timestamp, phone_number, call_status
 * For completed: Require first_name, last_name, phone_number, primary_intent
 *                If missing, downgrade to incomplete_hangup
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
    availability
  } = callData;
  
  const callId = metadata.callId || `CALL-${Date.now()}`;
  const timestamp = metadata.timestamp || new Date().toISOString();
  let callStatus = determineCallStatus(currentState, callData);
  
  // For incomplete_hangup and out_of_scope_only: Only log minimal fields
  if (callStatus === 'incomplete_hangup' || callStatus === 'out_of_scope_only') {
    // Use phone from callData, or fallback to callerNumber from metadata
    const phoneNumber = phone || metadata.callerNumber || '';
    return [
      callId,
      timestamp,
      '', // first_name
      '', // last_name
      phoneNumber, // phone_number
      '', // email
      '', // primary_intent
      '', // service_address
      '', // availability_notes
      generateCallSummary(callData, callStatus), // call_summary
      callStatus
    ];
  }
  
  // For completed calls: Validate required fields
  if (callStatus === 'completed') {
    const hasRequiredFields = firstName && lastName && phone && intent;
    if (!hasRequiredFields) {
      // Downgrade to incomplete_hangup if missing required fields
      callStatus = 'incomplete_hangup';
      const phoneNumber = phone || metadata.callerNumber || '';
      return [
        callId,
        timestamp,
        '', // first_name
        '', // last_name
        phoneNumber, // phone_number
        '', // email
        '', // primary_intent
        '', // service_address
        '', // availability_notes
        generateCallSummary(callData, callStatus), // call_summary
        callStatus
      ];
    }
  }
  
  // For completed calls: Populate all fields
  // Normalize intent to canonical value
  const normalizedIntent = normalizeIntent(intent, callData);
  
  // Only populate availability_notes and service_address for completed calls
  const serviceAddress = callStatus === 'completed' ? buildServiceAddress(callData) : '';
  const availabilityNotes = callStatus === 'completed' ? (availability || '') : '';
  
  // Build row matching COLUMN_HEADERS order
  return [
    callId,
    timestamp,
    firstName || '',
    lastName || '',
    phone || '',
    email || '', // Email is optional even for completed calls
    normalizedIntent, // Normalized canonical intent value
    serviceAddress,
    availabilityNotes,
    generateCallSummary(callData, callStatus),
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
 * Ensure sheet exists and has headers
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
        range: `${sheetName}!A1:K1` // 11 columns (added call_status)
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
      }
    }
  } catch (error) {
    console.error('❌ Error setting up sheet:', error.message);
    throw error;
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
    
    // Ensure sheet exists with headers
    await ensureSheetSetup(sheets, SPREADSHEET_ID, SHEET_NAME);
    
    // Transform data to row format
    const row = transformCallDataToRow(callData, currentState, {
      ...metadata,
      timestamp: metadata.timestamp || new Date().toISOString()
    });
    
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
    
    console.log(`✅ Call intake logged to Google Sheets (row ${response.data.updates.updatedRows})`);
    
    return {
      success: true,
      rowNumber: response.data.updates.updatedRows,
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
