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
 * For completed calls: Include system type and key symptoms if provided
 * For incomplete calls: Summarize collected information and note early disconnect
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
  
  // Start with system type if available
  if (systemType) {
    summary = systemType;
  }
  
  // Add the issue/problem description
  let issueText = '';
  if (details.symptoms) {
    issueText = details.symptoms.trim();
  } else if (details.issueDescription) {
    issueText = details.issueDescription.trim();
  } else if (details.generatorIssue) {
    issueText = details.generatorIssue.trim();
  } else if (details.helpNeeded) {
    issueText = details.helpNeeded.trim();
  }
  
  // Truncate issue text if too long
  if (issueText.length > 150) {
    issueText = issueText.substring(0, 150) + '...';
  }
  
  // Combine system type and issue
  if (systemType && issueText) {
    summary = `Caller reported ${issueText} from a ${systemType}.`;
  } else if (systemType) {
    summary = `Caller reported issue with a ${systemType}.`;
  } else if (issueText) {
    summary = `Caller reported ${issueText}.`;
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
 * Normalize system type to lowercase canonical values
 * Examples: furnace, boiler, central air, heat pump, mini split, rooftop unit, etc.
 * If multiple systems mentioned, returns comma-separated list
 */
function normalizeSystemType(systemType) {
  if (!systemType) return '';
  
  const normalized = systemType.toLowerCase().trim();
  
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
 * - completed: confirmation step reached and accepted (CLOSE state)
 * - incomplete_hangup: caller disconnected before confirmation
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
  
  // Complete - reached CLOSE state (confirmation accepted)
  if (currentState === STATES.CLOSE) {
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
  const callStatus = determineCallStatus(currentState, callData);
  
  // Normalize intent to canonical value (only if intent was collected)
  const normalizedIntent = intent ? normalizeIntent(intent, callData) : '';
  
  // Use phone from callData, or fallback to callerNumber from metadata
  const phoneNumber = phone || metadata.callerNumber || '';
  
  // Build service address (partial or full - whatever was collected)
  const serviceAddress = buildServiceAddress(callData);
  
  // For all calls (complete and incomplete): Log all collected data
  // Only leave fields blank if they were never collected
  return [
    callId,
    timestamp,
    firstName || '', // Log if collected
    lastName || '', // Log if collected
    phoneNumber, // Always log (from caller number if not provided)
    email || '', // Log if collected
    normalizedIntent, // Log if collected (normalized to canonical value)
    serviceAddress, // Log if collected (partial or full)
    availability || '', // Log if collected
    generateCallSummary(callData, callStatus), // Summary based on collected data
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
