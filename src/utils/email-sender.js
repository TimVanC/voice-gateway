/**
 * Post-Call Email Summary Sender
 *
 * Sends plain-text intake summaries via SendGrid HTTP API.
 * API credentials are read from environment variables.
 * Every public function catches its own errors and never throws.
 */

const sgMail = require('@sendgrid/mail');

// ============================================================================
// CONFIGURATION (from environment variables only)
// ============================================================================
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO   = process.env.EMAIL_TO;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

const NP = 'Not Provided';

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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('month')}/${get('day')}/${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')} ${get('timeZoneName')}`;
}

function toConfidence10(percentage) {
  const n = Number(percentage);
  if (!Number.isFinite(n)) return 0;
  const score = Math.round(n / 10);
  return Math.max(0, Math.min(10, score));
}

function valueWithConfidence(value, percentage) {
  const valueText = v(value);
  const confidence = valueText === NP ? 0 : toConfidence10(percentage);
  return `${valueText} (Confidence: ${confidence}/10)`;
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
    availability,
    name_confidence, phone_confidence, email_confidence,
    address_confidence, availability_confidence,
    details = {},
  } = callData;

  const now = metadata.timestamp ? new Date(metadata.timestamp) : new Date();
  const name = [v(firstName), v(lastName)].filter(p => p !== NP).join(' ') || NP;

  const lines = [
    'RSE Energy – Call Intake Summary',
    '',
    'Caller Information',
    `Name: ${valueWithConfidence(name, name_confidence)}`,
    `Phone: ${valueWithConfidence(phone || metadata.callerNumber, phone_confidence)}`,
    `Email: ${valueWithConfidence(email, email_confidence)}`,
    '',
    'Service Address',
    `Street: ${v(address)}`,
    `City: ${v(city)}`,
    `State: ${v(state)}`,
    `Zip: ${v(zip)}`,
    `Address Confidence: ${toConfidence10(address_confidence)}/10`,
    '',
    'Availability',
    `Preferred Time: ${valueWithConfidence(availability, availability_confidence)}`,
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
    if (!SENDGRID_API_KEY) {
      console.warn('⚠️  Email sending disabled (missing SENDGRID_API_KEY)');
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

    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log(`📧 Sending email to ${EMAIL_TO} via SendGrid HTTP API...`);

    const mailOptions = {
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject,
      text,
    };

    try {
      const [response] = await sgMail.send(mailOptions);
      console.log("✅ Call summary email sent successfully:", response.statusCode);
    } catch (error) {
      console.error("❌ Email send failed:", error);
    }

    return { success: true };
  } catch (error) {
    console.error("❌ Email send failed:", error);
    return { success: false, error: error.message };
  }
}

module.exports = { sendCallSummaryEmail };
