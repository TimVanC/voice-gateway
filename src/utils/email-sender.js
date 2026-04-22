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
const EMAIL_TO_RAW = process.env.EMAIL_TO;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const MAX_EMAIL_RECIPIENTS = 5;

const NP = 'Not Provided';

// ============================================================================
// DEDUPLICATION STATE
// ============================================================================
// In-memory guard so a given Call SID can only trigger one summary email per
// process. Cleanup paths can fire more than once for the same call (timeouts,
// socket close races, etc.), which previously caused duplicate sends.
const processedCallSids = new Set();

// ============================================================================
// HELPERS
// ============================================================================

function v(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return NP;
  }
  return String(value).trim();
}

function parseRecipientList(rawValue) {
  if (!rawValue) return [];
  const parts = String(rawValue)
    .split(/[,\n;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  if (unique.length > MAX_EMAIL_RECIPIENTS) {
    console.warn(`⚠️  EMAIL_TO has ${unique.length} recipients; only first ${MAX_EMAIL_RECIPIENTS} will be used.`);
    return unique.slice(0, MAX_EMAIL_RECIPIENTS);
  }
  return unique;
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
// GATING: decide whether an email should be sent at all
// ============================================================================

/**
 * Returns true when the call collected at least one piece of real,
 * actionable intake data. Used to suppress empty/useless summary emails.
 *
 * Meaningful data is defined as ANY of:
 *   - phone number present AND phone_confidence > 0
 *   - name (first or last) present AND name_confidence > 0
 *   - service type (intent) present
 *   - notes or summary text longer than 10 characters
 */
function hasMeaningfulData(callData = {}) {
  const {
    firstName, lastName, phone, intent,
    name_confidence, phone_confidence,
    details = {},
  } = callData;

  const phoneText = v(phone);
  const phoneConf = Number(phone_confidence) || 0;
  if (phoneText !== NP && phoneConf > 0) return true;

  const nameText = [v(firstName), v(lastName)].filter(p => p !== NP).join(' ');
  const nameConf = Number(name_confidence) || 0;
  if (nameText && nameConf > 0) return true;

  if (v(intent) !== NP) return true;

  const notesText = resolveNotes(details);
  if (notesText !== NP && notesText.trim().length > 10) return true;

  const summaryText = v(callData.summary);
  if (summaryText !== NP && summaryText.length > 10) return true;

  return false;
}

function determineCallStatus(callData = {}, metadata = {}) {
  const wasTransferred = Boolean(metadata.wasTransferred);
  if (wasTransferred) return 'transferred';
  if (hasMeaningfulData(callData)) return 'complete';
  return 'incomplete';
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

  const emergencyDisposition = isSafetyRisk
    ? 'Emergency redirect triggered: caller was instructed to hang up and call 911 immediately.'
    : 'No emergency redirect triggered.';
  const wasTransferred = Boolean(metadata.wasTransferred);
  const callStatus = metadata.callStatus || determineCallStatus(callData, metadata);

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
    `Emergency Disposition: ${emergencyDisposition}`,
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
    `Transferred to Agent: ${wasTransferred ? 'Yes' : 'No'}`,
    `Call Status: ${v(callStatus)}`,
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
    // Deduplication: ensure a given Call SID only ever sends one summary email
    // per process. Must run before ANY SendGrid / gating logic.
    const callSid = metadata.callId || metadata.callSid || null;
    if (callSid) {
      if (processedCallSids.has(callSid)) {
        console.log(`📭 Duplicate email prevented for Call SID: ${callSid}`);
        return { success: false, skipped: true, reason: 'duplicate_call_sid', callSid };
      }
      processedCallSids.add(callSid);
    } else {
      console.warn('⚠️  sendCallSummaryEmail called without a Call SID; dedupe guard cannot apply');
    }

    const emailRecipients = parseRecipientList(EMAIL_TO_RAW);

    // Gating: skip the email when no meaningful intake data was captured.
    // Prevents empty summary emails from hitting the daily send limit.
    const meaningfulDataCollected = hasMeaningfulData(callData);
    if (!meaningfulDataCollected) {
      console.log('📭 Skipping summary email: no meaningful intake data collected');
      return { success: false, skipped: true, reason: 'no_meaningful_data' };
    }

    if (!SENDGRID_API_KEY) {
      console.warn('⚠️  Email sending disabled (missing SENDGRID_API_KEY)');
      return { success: false, skipped: true, reason: 'missing_credentials' };
    }

    if (!EMAIL_FROM || emailRecipients.length === 0) {
      console.warn('⚠️  Email sending disabled (missing EMAIL_FROM or EMAIL_TO)');
      console.warn(`   EMAIL_FROM=${EMAIL_FROM ? 'set' : 'MISSING'}, EMAIL_TO=${emailRecipients.length > 0 ? 'set' : 'MISSING'}`);
      return { success: false, skipped: true, reason: 'missing_from_or_to' };
    }

    const { firstName, lastName, phone } = callData;
    const callerLabel = [firstName, lastName].filter(Boolean).join(' ')
      || phone
      || metadata.callerNumber
      || 'Unknown';

    const now = metadata.timestamp ? new Date(metadata.timestamp) : new Date();
    const emergencyPrefix = callData?.isSafetyRisk ? '[EMERGENCY REDIRECT] ' : '';
    const subject = `${emergencyPrefix}New Call Intake – ${callerLabel} – ${formatDateTime(now)}`;
    const callStatus = determineCallStatus(callData, metadata);
    const text = buildEmailBody(callData, { ...metadata, callStatus });

    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log(`📧 Sending email to ${emailRecipients.join(', ')} via SendGrid HTTP API...`);

    const mailOptions = {
      from: EMAIL_FROM,
      to: emailRecipients.length === 1 ? emailRecipients[0] : emailRecipients,
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

module.exports = { sendCallSummaryEmail, hasMeaningfulData };
