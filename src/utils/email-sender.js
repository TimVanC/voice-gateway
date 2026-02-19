/**
 * Post-Call Email Summary Sender
 *
 * Sends plain-text intake summaries via Outlook SMTP (nodemailer).
 * All SMTP credentials are read from environment variables.
 * Every public function catches its own errors and never throws.
 */

const nodemailer = require('nodemailer');

// ============================================================================
// CONFIGURATION (from environment variables only)
// ============================================================================
const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT, 10) || 587;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO   = process.env.EMAIL_TO;

const NP = 'Not Provided';

// ============================================================================
// TRANSPORTER (lazy-initialized singleton)
// ============================================================================
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!EMAIL_HOST || !EMAIL_USER || !EMAIL_PASS) {
    return null;
  }

  _transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });

  return _transporter;
}

// ============================================================================
// HELPERS
// ============================================================================

function v(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return NP;
  }
  return String(value).trim();
}

function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy} ${hh}:${min}`;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return NP;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function resolveNotes(details) {
  if (!details) return NP;
  return v(details.symptoms)   !== NP ? v(details.symptoms)
       : v(details.issueDescription) !== NP ? v(details.issueDescription)
       : v(details.generatorIssue)   !== NP ? v(details.generatorIssue)
       : v(details.helpNeeded)       !== NP ? v(details.helpNeeded)
       : NP;
}

// ============================================================================
// EMAIL BODY BUILDER
// ============================================================================

function buildEmailBody(callData, metadata) {
  const {
    firstName, lastName, phone, email,
    address, city, state, zip,
    isSafetyRisk, intent,
    details = {},
  } = callData;

  const now = metadata.timestamp ? new Date(metadata.timestamp) : new Date();
  const name = [v(firstName), v(lastName)].filter(p => p !== NP).join(' ') || NP;

  const lines = [
    'RSE Energy – Call Intake Summary',
    '',
    'Caller Information',
    `Name: ${name}`,
    `Phone: ${v(phone || metadata.callerNumber)}`,
    `Email: ${v(email)}`,
    '',
    'Service Address',
    `Street: ${v(address)}`,
    `City: ${v(city)}`,
    `State: ${v(state)}`,
    `Zip: ${v(zip)}`,
    '',
    'Service Details',
    `Emergency: ${isSafetyRisk ? 'Yes' : 'No'}`,
    `Service Type: ${v(intent)}`,
    `Equipment Type: ${v(details.systemType)}`,
    `Maintenance Plan: ${v(details.coverageType)}`,
    `Generator: ${v(details.generatorType)}`,
    `Notes: ${resolveNotes(details)}`,
    '',
    'Call Metadata',
    `Call SID: ${v(metadata.callId)}`,
    `Call Duration: ${formatDuration(metadata.callDurationMs)}`,
    `Date/Time: ${formatDateTime(now)}`,
  ];

  return lines.join('\n');
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Send a post-call intake summary email.
 *
 * @param {object} callData    – state machine getData() snapshot
 * @param {string} currentState – final state name (unused for email, kept for parity)
 * @param {object} metadata    – { callId, callerNumber, callDurationMs, timestamp }
 *
 * Fire-and-forget: never throws, logs errors internally.
 */
async function sendCallSummaryEmail(callData, currentState, metadata = {}) {
  console.log("📧 sendCallSummaryEmail invoked");
  try {
    const transporter = getTransporter();
    if (!transporter) {
      console.warn('⚠️  Email sending disabled (missing SMTP credentials)');
      console.warn(`   EMAIL_HOST=${EMAIL_HOST ? 'set' : 'MISSING'}, EMAIL_USER=${EMAIL_USER ? 'set' : 'MISSING'}, EMAIL_PASS=${EMAIL_PASS ? 'set' : 'MISSING'}`);
      return { success: false, skipped: true, reason: 'missing_credentials' };
    }

    if (!EMAIL_FROM || !EMAIL_TO) {
      console.warn('⚠️  Email sending disabled (missing EMAIL_FROM or EMAIL_TO)');
      console.warn(`   EMAIL_FROM=${EMAIL_FROM ? 'set' : 'MISSING'}, EMAIL_TO=${EMAIL_TO ? 'set' : 'MISSING'}`);
      return { success: false, skipped: true, reason: 'missing_from_or_to' };
    }

    const { firstName, lastName, phone } = callData;
    const callerLabel = [firstName, lastName].filter(Boolean).join(' ')
      || phone
      || metadata.callerNumber
      || 'Unknown';

    const now = metadata.timestamp ? new Date(metadata.timestamp) : new Date();
    const subject = `New Call Intake – ${callerLabel} – ${formatDateTime(now)}`;
    const text = buildEmailBody(callData, metadata);

    console.log(`📧 Sending email to ${EMAIL_TO} via ${EMAIL_HOST}:${EMAIL_PORT}...`);

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject,
      text,
    });

    console.log("✅ Call summary email sent successfully");
    return { success: true };
  } catch (error) {
    console.error("❌ Email send failed:", error);
    return { success: false, error: error.message };
  }
}

module.exports = { sendCallSummaryEmail };
