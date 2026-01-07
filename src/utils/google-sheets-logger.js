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
require('dotenv').config();

// ============================================================================
// CONFIGURATION
// ============================================================================
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_SHEET_NAME || 'RSE Data Call Intake Log';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_SHEETS_CREDENTIALS;

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
 */
function getSheetsClient() {
  if (!GOOGLE_CREDENTIALS) {
    throw new Error('GOOGLE_SHEETS_CREDENTIALS environment variable is required');
  }
  
  if (!SPREADSHEET_ID) {
    throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID environment variable is required');
  }
  
  let credentials;
  try {
    credentials = JSON.parse(GOOGLE_CREDENTIALS);
  } catch (e) {
    throw new Error('GOOGLE_SHEETS_CREDENTIALS must be valid JSON');
  }
  
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  
  return google.sheets({ version: 'v4', auth });
}

/**
 * Generate human-readable call summary (1-2 sentences plain English)
 */
function generateCallSummary(callData) {
  const {
    intent,
    firstName,
    lastName,
    situationSummary,
    availability,
    details = {}
  } = callData;
  
  const intentMap = {
    'hvac_service': 'HVAC service',
    'hvac_installation': 'HVAC installation',
    'generator': 'generator',
    'membership': 'membership',
    'existing_project': 'existing project',
    'other': 'service'
  };
  
  const serviceType = intentMap[intent] || 'service';
  const name = firstName ? `${firstName}${lastName ? ' ' + lastName : ''}` : 'Caller';
  
  // Build summary based on intent and available details
  let summary = `${name} called about ${serviceType}`;
  
  // Add situation summary if available (truncate if too long)
  let situationText = '';
  if (situationSummary) {
    situationText = situationSummary.length > 150 ? situationSummary.substring(0, 150) + '...' : situationSummary;
    summary += `. ${situationText}`;
  } else if (details.symptoms) {
    situationText = details.symptoms.length > 150 ? details.symptoms.substring(0, 150) + '...' : details.symptoms;
    summary += `. Issue: ${situationText}`;
  } else if (details.issueDescription) {
    situationText = details.issueDescription.length > 150 ? details.issueDescription.substring(0, 150) + '...' : details.issueDescription;
    summary += `. ${situationText}`;
  } else if (details.helpNeeded) {
    situationText = details.helpNeeded.length > 150 ? details.helpNeeded.substring(0, 150) + '...' : details.helpNeeded;
    summary += `. Needs help with: ${situationText}`;
  }
  
  // Add availability if provided (as second sentence if we have situation, otherwise append)
  if (availability) {
    if (situationText) {
      summary += `. Available: ${availability}.`;
    } else {
      summary += ` and is available ${availability}.`;
    }
  } else {
    summary += '.';
  }
  
  // Ensure it's 1-2 sentences (split if too long)
  const sentences = summary.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 2) {
    return sentences.slice(0, 2).join('. ') + '.';
  }
  
  return summary;
}

/**
 * Format intent for human readability
 */
function formatIntent(intent) {
  const intentMap = {
    'hvac_service': 'HVAC Service',
    'hvac_installation': 'HVAC Installation',
    'generator': 'Generator',
    'membership': 'Membership',
    'existing_project': 'Existing Project',
    'other': 'Other'
  };
  
  return intentMap[intent] || intent || '';
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
 */
function determineCallStatus(currentState, callData) {
  const { STATES } = require('../state/call-state-machine');
  
  // Emergency redirects
  if (callData.isSafetyRisk === true) {
    return 'Emergency Redirect';
  }
  
  // Out of scope
  if (currentState === STATES.OUT_OF_SCOPE) {
    return 'Out of Scope';
  }
  
  // Complete - reached CLOSE state with required data
  if (currentState === STATES.CLOSE) {
    const hasRequiredData = callData.firstName && 
                            callData.lastName && 
                            callData.phone && 
                            callData.address && 
                            callData.intent;
    if (hasRequiredData) {
      return 'Complete';
    }
    return 'Incomplete - Missing Data';
  }
  
  // Incomplete - didn't reach CLOSE state
  // Determine how far they got
  if (currentState === STATES.CONFIRMATION) {
    return 'Incomplete - Confirmation Not Confirmed';
  }
  if (currentState === STATES.AVAILABILITY) {
    return 'Incomplete - No Availability';
  }
  if (currentState === STATES.ADDRESS) {
    return 'Incomplete - No Address';
  }
  if (currentState === STATES.EMAIL) {
    return 'Incomplete - No Email';
  }
  if (currentState === STATES.PHONE) {
    return 'Incomplete - No Phone';
  }
  if (currentState === STATES.NAME) {
    return 'Incomplete - No Name';
  }
  if (currentState === STATES.SAFETY_CHECK || currentState === STATES.INTENT) {
    return 'Incomplete - Early Exit';
  }
  if (currentState === STATES.GREETING) {
    return 'Incomplete - No Response';
  }
  
  return 'Incomplete - Unknown State';
}

/**
 * Transform call data to v1 row format
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
  
  // Build row matching COLUMN_HEADERS order
  return [
    callId,
    timestamp,
    firstName || '',
    lastName || '',
    phone || '',
    email || '',
    formatIntent(intent),
    buildServiceAddress(callData),
    availability || '',
    generateCallSummary(callData),
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
  
  if (!SPREADSHEET_ID || !GOOGLE_CREDENTIALS) {
    console.warn('⚠️  Google Sheets logging disabled (missing credentials)');
    console.warn(`   Call would have been logged with status: ${determineCallStatus(currentState, callData)}`);
    console.warn(`   To enable logging, set GOOGLE_SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_CREDENTIALS in .env`);
    return { success: false, error: 'Google Sheets credentials not configured', skipped: true };
  }
  
  try {
    const sheets = getSheetsClient();
    
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
