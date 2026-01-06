# Google Sheets Call Intake Log - V1 Implementation

## Overview

The Google Sheets integration has been implemented with a strict v1 schema designed for initial testing and client-facing handoff. The schema is future-proof for HubSpot integration.

## V1 Schema (10 Required Columns)

| Column | Description | Example |
|--------|-------------|---------|
| `call_id` | Unique call identifier | `CALL-1234567890` |
| `call_timestamp` | ISO timestamp | `2025-01-15T10:30:00.000Z` |
| `first_name` | Caller's first name | `John` |
| `last_name` | Caller's last name | `Smith` |
| `phone_number` | Caller's phone | `555-123-4567` |
| `email` | Caller's email (optional) | `john@example.com` |
| `primary_intent` | Service type | `HVAC Service` |
| `service_address` | Full address | `123 Main St, Anytown, 12345` |
| `availability_notes` | Availability info | `Weekday mornings` |
| `call_summary` | 1-2 sentence summary | `John Smith called about HVAC service. Issue: System not cooling. Available: Weekday mornings.` |

## Logging Rules

### ✅ Log When:
- Confirmation step succeeds (call reaches `CLOSE` state)
- Call has required data:
  - First name
  - Last name
  - Phone number
  - Address
  - Intent

### ❌ Do NOT Log When:
- Emergency redirects (`isSafetyRisk === true`)
- Dropped calls (never reached `CLOSE` state)
- Out-of-scope calls where caller doesn't pivot
- Missing required data

## Implementation Details

### File: `src/utils/google-sheets-logger.js`

**Key Functions:**
- `logCallIntake(callData, currentState, metadata)` - Main logging function
- `shouldLogCall(currentState, callData)` - Determines if call should be logged
- `generateCallSummary(callData)` - Creates human-readable 1-2 sentence summary
- `transformCallDataToRow(callData, metadata)` - Transforms data to row format

**Features:**
- Append-only (never overwrites existing rows)
- Auto-creates sheet and headers if missing
- Graceful error handling (warns but doesn't crash if credentials missing)
- Non-blocking (doesn't delay call cleanup)

### Integration: `src/server-rse.js`

The logger is called in the `cleanup()` function:
```javascript
logCallIntake(data, currentState, {
  callId: streamSid || `CALL-${Date.now()}`,
  callerNumber: callerNumber
})
```

## Call Summary Generation

The `call_summary` field is automatically generated as:
1. **First sentence**: Name + service type + situation/issue
2. **Second sentence** (if applicable): Availability information

Examples:
- `John Smith called about HVAC service. Issue: System not cooling. Available: Weekday mornings.`
- `Jane Doe called about generator. Needs help with installation.`
- `Bob Johnson called about membership and is available afternoons.`

The summary:
- Uses plain English (no technical jargon)
- Limits to 1-2 sentences
- Truncates long details to 150 characters
- Always includes name and service type
- Includes situation/issue if available
- Includes availability if provided

## Future-Proofing for HubSpot

The schema is designed to map directly to HubSpot:

### Contact Properties
- `firstname` ← `first_name`
- `lastname` ← `last_name`
- `email` ← `email`
- `phone` ← `phone_number`
- `address` ← `service_address` (parsed)

### Deal Properties
- `dealname` ← Generated from: `[primary_intent] - [first_name] [last_name]`
- `dealstage` ← Based on `primary_intent`
- Custom properties:
  - `availability_notes` ← `availability_notes`
  - `call_summary` ← `call_summary`
  - `call_id` ← `call_id` (for tracking)

**No hardcoded logic** that would block future CRM integration. The logging function is modular and can be easily extended or replaced with HubSpot API calls.

## Environment Variables

Required in `.env`:
```env
GOOGLE_SHEETS_SPREADSHEET_ID=your-spreadsheet-id
GOOGLE_SHEETS_SHEET_NAME=Call Intake Log
GOOGLE_SHEETS_CREDENTIALS={"type":"service_account",...}
```

See `GOOGLE_SHEETS_SETUP.md` for detailed setup instructions.

## Testing

To test the integration:
1. Configure Google Sheets credentials
2. Make a test call through Twilio
3. Complete the full intake flow (including confirmation)
4. Check Google Sheet for new row

The system will log a skip reason if the call doesn't meet logging criteria (e.g., "confirmation not completed", "emergency redirect", etc.).

