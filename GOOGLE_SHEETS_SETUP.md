# Google Sheets Call Intake Log Setup

This document explains how to set up the Google Sheets integration for call intake logging.

## Overview

The Google Sheets integration provides a temporary, client-facing solution to log call intake data. The schema is designed to be future-proof for HubSpot integration, with field names that map directly to HubSpot contact and deal properties.

## Prerequisites

1. A Google Cloud Project
2. Google Sheets API enabled
3. A service account with Sheets API access
4. A Google Sheet (created or existing)

## Setup Steps

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Note your project ID

### 2. Enable Google Sheets API

1. In Google Cloud Console, navigate to **APIs & Services** > **Library**
2. Search for "Google Sheets API"
3. Click **Enable**

### 3. Create a Service Account

1. Navigate to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **Service Account**
3. Give it a name (e.g., "voice-gateway-sheets")
4. Click **Create and Continue**
5. Skip role assignment (optional)
6. Click **Done**

### 4. Create and Download Service Account Key

1. Click on the service account you just created
2. Go to the **Keys** tab
3. Click **Add Key** > **Create new key**
4. Choose **JSON** format
5. Download the JSON file

### 5. Create or Prepare Your Google Sheet

1. Create a new Google Sheet or use an existing one
2. Note the **Spreadsheet ID** from the URL:
   ```
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
   ```
3. Share the sheet with the service account email (found in the JSON file, e.g., `voice-gateway-sheets@project-id.iam.gserviceaccount.com`)
4. Give it **Editor** permissions

### 6. Configure Environment Variables

Add the following to your `.env` file:

```env
# Google Sheets Configuration
GOOGLE_SHEETS_SPREADSHEET_ID=your-spreadsheet-id-here
GOOGLE_SHEETS_SHEET_NAME=Call Intake Log
GOOGLE_SHEETS_CREDENTIALS={"type":"service_account","project_id":"...","private_key_id":"...","private_key":"...","client_email":"...","client_id":"...","auth_uri":"...","token_uri":"...","auth_provider_x509_cert_url":"...","client_x509_cert_url":"..."}
```

**Important:** The `GOOGLE_SHEETS_CREDENTIALS` should be the entire contents of the JSON file you downloaded, as a single-line JSON string. You can:

1. Copy the entire JSON file contents
2. Minify it (remove all whitespace/newlines)
3. Escape any quotes if needed
4. Paste it as the value

Alternatively, you can use a tool to convert the JSON file to a single line:
```bash
# On Linux/Mac
cat service-account-key.json | jq -c . > credentials.json

# Then copy the contents
```

### 7. Test the Integration

1. Start your server:
   ```bash
   npm start
   ```

2. Make a test call through your Twilio number

3. Check your Google Sheet - a new row should appear with the call data

## V1 Schema Overview

The Google Sheet will have exactly 10 columns (automatically created on first use):

1. **call_id** - Unique identifier for the call
2. **call_timestamp** - ISO timestamp when the call was logged
3. **first_name** - Caller's first name
4. **last_name** - Caller's last name
5. **phone_number** - Caller's phone number
6. **email** - Caller's email (may be empty)
7. **primary_intent** - Service type (HVAC Service, Generator, Membership, etc.)
8. **service_address** - Full service address (address, city, zip)
9. **availability_notes** - Caller's availability information
10. **call_summary** - Human-readable 1-2 sentence summary of the call

### Logging Rules

Rows are only written when:
- ✅ Confirmation step succeeds (call reaches CLOSE state)
- ✅ Call has required data (first name, last name, phone, address, intent)
- ❌ Emergency redirects are NOT logged
- ❌ Dropped calls are NOT logged
- ❌ Out-of-scope calls (where caller doesn't pivot) are NOT logged

All rows are appended-only (never overwritten).

## HubSpot Field Mapping

When migrating to HubSpot, the following mappings apply:

### Contact Properties
- `firstname` ← first_name
- `lastname` ← last_name
- `email` ← email
- `phone` ← phone_number
- `address` ← service_address (parsed)

### Deal Properties
- `dealname` ← Generated from: "[primary_intent] - [first_name] [last_name]"
- `dealstage` ← Based on primary_intent
- Custom properties:
  - `availability_notes` ← availability_notes
  - `call_summary` ← call_summary
  - `call_id` ← call_id (for tracking)

The schema is designed to be future-proof and avoid hardcoded logic that would block CRM integration.

## Troubleshooting

### "Missing credentials" warning
- Check that `GOOGLE_SHEETS_CREDENTIALS` is set in your `.env` file
- Verify the JSON is valid (use a JSON validator)

### "Permission denied" error
- Ensure the service account email has Editor access to the sheet
- Verify the Spreadsheet ID is correct

### Sheet not found
- Check that `GOOGLE_SHEETS_SPREADSHEET_ID` is correct
- The sheet will be created automatically if it doesn't exist

### Headers not appearing
- The first row should automatically populate with headers
- If not, manually add the headers from `COLUMN_HEADERS` in `src/utils/google-sheets-logger.js`

## Disabling Google Sheets Logging

To disable logging (for testing or if credentials are unavailable), simply don't set the environment variables. The system will log a warning but continue operating normally.

## Future Migration to HubSpot

The schema is designed to map directly to HubSpot. When ready to migrate:

1. The column names align with HubSpot field names
2. The `Raw Data JSON` column contains the complete call data for reference
3. Custom HubSpot properties can be created to match the service-specific detail columns

