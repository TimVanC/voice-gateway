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
const https = require('https');
const http = require('http');
const { URL } = require('url');

// IMPORTANT: This model string MUST be kept in sync with the one used in
// src/utils/data-cleanup.js (currently 'claude-sonnet-4-6', see line ~46).
// If the model is upgraded/deprecated there, update it here too.
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// Warn when the Twilio balance drops below this figure (account currency).
const BALANCE_WARN_THRESHOLD = 5;

const MONITOR_EMAIL_TO = process.env.MONITOR_EMAIL_TO || 'timvancau@gmail.com';
const HEALTH_URL = process.env.MONITOR_HEALTH_URL;

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
// CHECK 2: TWILIO BALANCE CHECK
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
// CHECK 3: RAILWAY / SERVER UP CHECK
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
  checks.push(await checkTwilioBalance());
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
