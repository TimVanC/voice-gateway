/**
 * Daily Health Check (standalone one-shot script)
 *
 * Runs a series of independent health checks and emails a single status report
 * to one recipient, then exits. Designed to be run as a scheduled cron / one-shot
 * job (e.g. Railway cron). It does NOT touch the call/voice path or any state
 * machine code.
 *
 * Checks performed (in order):
 *   1. Anthropic model availability (cheap test call)
 *   2. Twilio account balance (warns when low)
 *   3. Railway / server up check (GET /health)
 *   4. Emails the combined result
 *
 * Every check catches its own errors and never throws uncaught, so one failing
 * check never blocks the others or the email send. Exits 0 when all checks pass,
 * 1 when any check failed.
 *
 * Dependencies are limited to those already in package.json:
 *   @anthropic-ai/sdk, twilio, @sendgrid/mail (HTTP GET uses Node's built-in https).
 */

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const WebSocket = require('ws');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// IMPORTANT: This model string MUST be kept in sync with the one used in
// src/utils/data-cleanup.js (currently 'claude-sonnet-4-6', see line ~46).
// If the model is upgraded/deprecated there, update it here too.
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// OpenAI Realtime endpoint that powers Ava's voice. This mirrors the connection
// in src/server-rse.js (line ~544): GA endpoint, Authorization header only, no
// OpenAI-Beta header.
// IMPORTANT: The 'gpt-realtime' model string MUST be kept in sync with
// src/server-rse.js (lines ~33 and ~509). If the model is changed/retired there,
// update this URL too.
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime';

// Warn when the Twilio balance drops below this figure (account currency).
const BALANCE_WARN_THRESHOLD = 5;

const MONITOR_EMAIL_TO = process.env.MONITOR_EMAIL_TO || 'timvancau@gmail.com';
const HEALTH_URL = process.env.MONITOR_HEALTH_URL;

// Google Sheets config, read exactly the way src/utils/google-sheets-logger.js
// does it (lines ~30-33): GOOGLE_APPLICATION_CREDENTIALS may be a file path OR
// inline JSON, with GOOGLE_SHEETS_CREDENTIALS as the inline-JSON fallback.
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_SHEET_NAME || 'RSE Data Call Intake Log';
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS; // File path or JSON
const GOOGLE_SHEETS_CREDENTIALS_JSON = process.env.GOOGLE_SHEETS_CREDENTIALS; // Inline JSON (fallback)

// ============================================================================
// CHECK 1: ANTHROPIC MODEL CHECK
// ============================================================================
async function checkAnthropic() {
  const result = { name: 'Anthropic model', status: 'fail', detail: '' };
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      result.detail = 'Missing ANTHROPIC_API_KEY';
      return result;
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });

    if (response && response.id) {
      result.status = 'pass';
      result.detail = `Model '${ANTHROPIC_MODEL}' responded OK`;
    } else {
      result.detail = `Model '${ANTHROPIC_MODEL}' returned an unexpected response`;
    }
  } catch (err) {
    // Surface the raw error message; 404 / not_found / deprecation notices are
    // the most important signals here.
    const status = err && err.status ? `HTTP ${err.status}: ` : '';
    result.detail = `Model '${ANTHROPIC_MODEL}' error — ${status}${err && err.message ? err.message : String(err)}`;
  }
  return result;
}

// ============================================================================
// CHECK 2: OPENAI REALTIME CHECK (powers Ava's voice — most critical dependency)
// ============================================================================
function checkOpenAIRealtime() {
  // Returns a Promise that always resolves (never rejects) with a result object,
  // so this check can never block the others or the email send.
  return new Promise((resolve) => {
    const result = { name: 'OpenAI Realtime', status: 'fail', detail: '' };

    if (!process.env.OPENAI_API_KEY) {
      result.detail = 'Missing OPENAI_API_KEY';
      resolve(result);
      return;
    }

    let settled = false;
    let ws;

    // Ensures we resolve exactly once and always tear down the socket.
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.status = status;
      result.detail = detail;
      try {
        if (ws) ws.close();
      } catch (e) {
        // Ignore close errors; the result is already determined.
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish('fail', 'Timed out after 15000ms waiting for session.created');
    }, 15000);

    try {
      ws = new WebSocket(OPENAI_REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      });

      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          if (event && event.type === 'session.created') {
            finish('pass', 'Connection opened and session.created received');
          } else if (event && event.type === 'error') {
            const msg = event.error && event.error.message ? event.error.message : JSON.stringify(event.error);
            finish('fail', `OpenAI error event before session.created — ${msg}`);
          }
        } catch (e) {
          // Non-JSON / unexpected frame; keep waiting until session.created or timeout.
        }
      });

      ws.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : '';
        finish('fail', `Connection closed before session.created (code: ${code}${reasonStr ? `, reason: ${reasonStr}` : ''})`);
      });

      ws.on('error', (err) => {
        finish('fail', `Connection error — ${err && err.message ? err.message : String(err)}`);
      });
    } catch (err) {
      finish('fail', `Failed to open WebSocket — ${err && err.message ? err.message : String(err)}`);
    }
  });
}

// ============================================================================
// CHECK 3: TWILIO BALANCE CHECK
// ============================================================================
async function checkTwilioBalance() {
  const result = { name: 'Twilio balance', status: 'fail', detail: '' };
  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      result.detail = 'Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN';
      return result;
    }

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const balance = await client.balance.fetch();

    const amount = Number(balance.balance);
    const currency = balance.currency || '';

    if (!Number.isFinite(amount)) {
      result.detail = `Could not parse balance value: ${JSON.stringify(balance.balance)}`;
      return result;
    }

    const formatted = `${amount.toFixed(2)} ${currency}`.trim();

    if (amount < BALANCE_WARN_THRESHOLD) {
      result.status = 'warning';
      result.detail = `Balance is ${formatted} (below ${BALANCE_WARN_THRESHOLD} ${currency} threshold)`;
    } else {
      result.status = 'pass';
      result.detail = `Balance is ${formatted}`;
    }
  } catch (err) {
    const status = err && err.status ? `HTTP ${err.status}: ` : '';
    result.detail = `Balance fetch error — ${status}${err && err.message ? err.message : String(err)}`;
  }
  return result;
}

// ============================================================================
// CHECK 4: GOOGLE SHEETS CHECK (call intake destination — highest priority)
// ============================================================================
// Builds an authenticated Sheets client using the SAME credential-loading logic
// as src/utils/google-sheets-logger.js (getSheetsClient, lines ~438-503):
// GOOGLE_APPLICATION_CREDENTIALS may be inline JSON or a file path, with
// GOOGLE_SHEETS_CREDENTIALS as the inline-JSON fallback. READ-ONLY here.
function buildSheetsClient() {
  let auth;

  if (GOOGLE_APPLICATION_CREDENTIALS) {
    const trimmed = GOOGLE_APPLICATION_CREDENTIALS.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      let credentials;
      try {
        credentials = JSON.parse(trimmed);
      } catch (e) {
        throw new Error('GOOGLE_APPLICATION_CREDENTIALS contains invalid JSON');
      }
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });
      return google.sheets({ version: 'v4', auth });
    }

    const credentialsPath = path.resolve(GOOGLE_APPLICATION_CREDENTIALS);
    if (fs.existsSync(credentialsPath)) {
      auth = new google.auth.GoogleAuth({
        keyFile: credentialsPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });
      return google.sheets({ version: 'v4', auth });
    }
    // Fall through to inline JSON fallback if the file path does not exist.
  }

  if (GOOGLE_SHEETS_CREDENTIALS_JSON) {
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
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    return google.sheets({ version: 'v4', auth });
  }

  throw new Error('Google credentials not configured (set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SHEETS_CREDENTIALS)');
}

async function checkGoogleSheets() {
  const result = { name: 'Google Sheets', status: 'fail', detail: '' };
  try {
    if (!SPREADSHEET_ID) {
      result.detail = 'Missing GOOGLE_SHEETS_SPREADSHEET_ID';
      return result;
    }
    if (!GOOGLE_APPLICATION_CREDENTIALS && !GOOGLE_SHEETS_CREDENTIALS_JSON) {
      result.detail = 'Missing Google credentials (GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SHEETS_CREDENTIALS)';
      return result;
    }

    const sheets = buildSheetsClient();

    // READ-ONLY metadata read. Does NOT write/append/modify the spreadsheet.
    // Request only the title field to keep the call as light as possible.
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'properties.title,sheets.properties.title',
    });

    const title = meta.data && meta.data.properties ? meta.data.properties.title : '(unknown)';
    const tabs = (meta.data && meta.data.sheets) ? meta.data.sheets.map((s) => s.properties.title) : [];
    const tabPresent = tabs.includes(SHEET_NAME);

    if (tabPresent) {
      result.status = 'pass';
      result.detail = `Reachable — spreadsheet "${title}", tab "${SHEET_NAME}" present`;
    } else {
      // Credentials and access are fine, but the expected tab is missing.
      result.status = 'fail';
      result.detail = `Spreadsheet "${title}" reachable but tab "${SHEET_NAME}" not found (tabs: ${tabs.join(', ') || 'none'})`;
    }
  } catch (err) {
    const status = err && err.code ? `HTTP ${err.code}: ` : '';
    result.detail = `Sheets access error — ${status}${err && err.message ? err.message : String(err)}`;
  }
  return result;
}

// ============================================================================
// CHECK 5: EMAIL_TO PRESENCE CHECK (read-only; never emails EMAIL_TO)
// ============================================================================
// IMPORTANT: This validates EMAIL_TO format only. It NEVER sends mail to
// EMAIL_TO. The monitor's only email recipient remains MONITOR_EMAIL_TO.
function isValidEmail(addr) {
  // Pragmatic email shape check (not full RFC 5322): local@domain.tld
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

async function checkEmailToPresence() {
  const result = { name: 'EMAIL_TO config', status: 'fail', detail: '' };
  try {
    const raw = process.env.EMAIL_TO;
    if (!raw || !String(raw).trim()) {
      result.detail = 'Missing EMAIL_TO';
      return result;
    }

    const addresses = String(raw)
      .split(/[,\n;]+/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (addresses.length === 0) {
      result.detail = 'EMAIL_TO is set but contains no addresses';
      return result;
    }

    const invalid = addresses.filter((a) => !isValidEmail(a));
    if (invalid.length > 0) {
      result.detail = `EMAIL_TO has malformed address(es): ${invalid.join(', ')}`;
      return result;
    }

    result.status = 'pass';
    result.detail = `${addresses.length} valid recipient(s) configured`;
  } catch (err) {
    result.detail = `EMAIL_TO validation error — ${err && err.message ? err.message : String(err)}`;
  }
  return result;
}

// ============================================================================
// CHECK 6: TRANSFER_PHONE_NUMBER PRESENCE CHECK
// ============================================================================
async function checkTransferNumber() {
  const result = { name: 'TRANSFER_PHONE_NUMBER config', status: 'fail', detail: '' };
  try {
    const raw = process.env.TRANSFER_PHONE_NUMBER;
    if (!raw || !String(raw).trim()) {
      result.detail = 'Missing TRANSFER_PHONE_NUMBER';
      return result;
    }

    const value = String(raw).trim();
    // E.164: leading +, first digit 1-9, up to 15 digits total.
    if (!/^\+[1-9]\d{1,14}$/.test(value)) {
      result.detail = `TRANSFER_PHONE_NUMBER "${value}" is not valid E.164 (expected e.g. +18623701734)`;
      return result;
    }

    result.status = 'pass';
    result.detail = `Valid E.164 number configured (${value})`;
  } catch (err) {
    result.detail = `TRANSFER_PHONE_NUMBER validation error — ${err && err.message ? err.message : String(err)}`;
  }
  return result;
}

// ============================================================================
// CHECK 7: RAILWAY / SERVER UP CHECK
// ============================================================================
function httpGetJson(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      reject(new Error(`Invalid URL: ${targetUrl}`));
      return;
    }

    const transport = parsed.protocol === 'http:' ? http : https;

    const req = transport.get(parsed, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: raw });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => reject(err));
  });
}

async function checkServerHealth() {
  const result = { name: 'Railway server health', status: 'fail', detail: '' };
  try {
    if (!HEALTH_URL) {
      result.detail = 'Missing MONITOR_HEALTH_URL';
      return result;
    }

    const { statusCode, body } = await httpGetJson(HEALTH_URL, 10000);

    if (statusCode !== 200) {
      result.detail = `Unexpected HTTP ${statusCode} from ${HEALTH_URL}`;
      return result;
    }

    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      result.detail = `HTTP 200 but response was not valid JSON: ${body.slice(0, 200)}`;
      return result;
    }

    if (json && json.status === 'healthy') {
      result.status = 'pass';
      result.detail = `HTTP 200, status "healthy"`;
    } else {
      result.detail = `HTTP 200 but status was "${json && json.status}" (expected "healthy")`;
    }
  } catch (err) {
    result.detail = `Health check error — ${err && err.message ? err.message : String(err)}`;
  }
  return result;
}

// ============================================================================
// EMAIL THE RESULT
// ============================================================================
function statusLabel(status) {
  if (status === 'pass') return 'PASS';
  if (status === 'warning') return 'WARNING';
  return 'FAIL';
}

async function sendReport(checks, allGood) {
  const result = { sent: false, detail: '' };
  try {
    if (!process.env.SENDGRID_API_KEY) {
      result.detail = 'Missing SENDGRID_API_KEY';
      return result;
    }
    if (!process.env.EMAIL_FROM) {
      result.detail = 'Missing EMAIL_FROM';
      return result;
    }

    const subject = allGood
      ? 'RSE Ava daily check: ALL GOOD'
      : 'RSE Ava daily check: ATTENTION NEEDED';

    const now = new Date().toISOString();
    const lines = [
      'RSE Ava — Daily Health Check',
      `Run at: ${now}`,
      '',
      ...checks.map((c) => `[${statusLabel(c.status)}] ${c.name}: ${c.detail}`),
      '',
      `Overall: ${allGood ? 'ALL GOOD' : 'ATTENTION NEEDED'}`,
    ];

    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const [response] = await sgMail.send({
      from: process.env.EMAIL_FROM,
      to: MONITOR_EMAIL_TO,
      subject,
      text: lines.join('\n'),
    });

    result.sent = true;
    result.detail = `SendGrid responded ${response.statusCode}`;
  } catch (err) {
    result.detail = `Email send error — ${err && err.message ? err.message : String(err)}`;
  }
  return result;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('🔍 Running RSE Ava daily health check...');

  // Run each check; each one handles its own errors and resolves a result object.
  const checks = [];
  checks.push(await checkAnthropic());
  checks.push(await checkOpenAIRealtime());
  checks.push(await checkTwilioBalance());
  checks.push(await checkGoogleSheets());
  checks.push(await checkEmailToPresence());
  checks.push(await checkTransferNumber());
  checks.push(await checkServerHealth());

  for (const c of checks) {
    console.log(`[${statusLabel(c.status)}] ${c.name}: ${c.detail}`);
  }

  // "All good" requires every check to pass. A WARNING (e.g. low balance) or a
  // FAIL both count as attention needed.
  const allGood = checks.every((c) => c.status === 'pass');

  const email = await sendReport(checks, allGood);
  if (email.sent) {
    console.log(`📧 Report emailed to ${MONITOR_EMAIL_TO}: ${email.detail}`);
  } else {
    console.error(`❌ Report email NOT sent: ${email.detail}`);
  }

  // Exit non-zero if any check failed/warned OR the email could not be sent, so
  // the scheduler surfaces the problem.
  const ok = allGood && email.sent;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  // Last-resort guard: main() should never throw, but if it does, fail loudly.
  console.error('❌ Fatal error in daily-check:', err);
  process.exit(1);
});
