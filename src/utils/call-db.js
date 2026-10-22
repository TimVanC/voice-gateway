/**
 * Neon Postgres call records.
 *
 * Writes each finished call, with its transcript, to the database in
 * DATABASE_URL. This runs ALONGSIDE the Google Sheets logger: the Sheet row
 * is written exactly as before, and nothing here can stop it. Every function
 * swallows its own errors and logs them; a database outage costs one row in
 * Neon, never a call and never a Sheet row.
 *
 * When DATABASE_URL is unset the module is inert (one log line at the first
 * call, then silence), so local runs and staging work without a database.
 *
 * Schema: db/migrations/001_calls_and_transcripts.sql
 */

const { COLUMN_HEADERS, transformCallDataToRow } = require('./google-sheets-logger');

const DATABASE_URL = process.env.DATABASE_URL;
const WRITE_TIMEOUT_MS = 15_000;

let pool = null;
let warnedDisabled = false;

function getPool() {
  if (!DATABASE_URL) return null;
  if (pool) return pool;
  // Required lazily so the server still boots if `pg` is somehow missing.
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: WRITE_TIMEOUT_MS,
  });
  pool.on('error', (err) => {
    // Idle clients can be dropped by Neon's scale-to-zero; log, keep going.
    console.error(`⚠️ Call DB pool error (ignored): ${err.message}`);
  });
  return pool;
}

// ---------------------------------------------------------------------------
// Own-number detection
// ---------------------------------------------------------------------------

/** Last ten digits of a phone number in any formatting, or '' if fewer. */
function lastTenDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Numbers that count as RSE's own: TWILIO_NUMBER plus any in
 * TEST_CALLER_NUMBERS (comma separated). Calls from these are flagged
 * is_test = true, never dropped.
 */
function ownNumberDigits(env = process.env) {
  const list = [env.TWILIO_NUMBER, ...String(env.TEST_CALLER_NUMBERS || '').split(',')];
  return new Set(list.map(lastTenDigits).filter(Boolean));
}

function isOwnNumber(phone, env = process.env) {
  const digits = lastTenDigits(phone);
  return Boolean(digits) && ownNumberDigits(env).has(digits);
}

// ---------------------------------------------------------------------------
// Transcript accumulation (one recorder per call)
// ---------------------------------------------------------------------------

/**
 * Collects (speaker, text, time) turns during a call. The server calls
 * add() from its OpenAI event handlers and hands turns() to saveCall().
 */
function createTranscriptRecorder() {
  const turns = [];
  return {
    add(speaker, text) {
      const clean = String(text || '').trim();
      if (!clean) return;
      turns.push({ sequence: turns.length + 1, speaker, text: clean, at: new Date() });
    },
    turns() {
      return turns.slice();
    },
    get length() {
      return turns.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

function toSmallInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Build the calls-table row for a live call. The intake columns come from
 * the exact same transform the Sheet uses, so both stores agree.
 */
function buildCallRow(callData, currentState, metadata) {
  const row = transformCallDataToRow(callData, currentState, {
    callId: metadata.callId,
    callerNumber: metadata.callerNumber,
    wasTransferred: metadata.wasTransferred,
    timestamp: metadata.endedAt,
  });
  const sheet = {};
  COLUMN_HEADERS.forEach((name, i) => { sheet[name] = row[i]; });

  const startedAt = metadata.startedAt ? new Date(metadata.startedAt) : new Date();
  const endedAt = metadata.endedAt ? new Date(metadata.endedAt) : new Date();
  const durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const testByNumber = isOwnNumber(metadata.callerNumber);

  return {
    call_id: metadata.callId,
    twilio_call_sid: toText(metadata.twilioCallSid),
    source: 'server',
    environment: metadata.environment || null,
    is_test: testByNumber,
    test_reason: testByNumber ? 'caller is an RSE number' : null,
    direction: 'inbound',
    caller_number: toText(metadata.callerNumber),
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
    first_name: toText(sheet.first_name),
    last_name: toText(sheet.last_name),
    conf_name: toSmallInt(sheet.conf_name),
    phone_number: toText(sheet.phone_number),
    conf_pn: toSmallInt(sheet.conf_pn),
    conf_mail: toSmallInt(sheet.conf_mail),
    email: toText(sheet.email),
    primary_intent: toText(sheet.primary_intent),
    conf_add: toSmallInt(sheet.conf_add),
    service_address: toText(sheet.service_address),
    conf_avail: toSmallInt(sheet.conf_avail),
    availability_notes: toText(sheet.availability_notes),
    call_summary: toText(sheet.call_summary),
    call_status: toText(sheet.call_status),
    final_state: toText(currentState),
    was_transferred: Boolean(metadata.wasTransferred),
    is_safety_risk: callData.isSafetyRisk === true,
    intake_json: callData,
  };
}

const CALL_COLUMNS = [
  'call_id', 'twilio_call_sid', 'source', 'environment', 'sheet_row_number',
  'is_test', 'test_reason', 'pre_caller_id_fix',
  'direction', 'caller_number', 'started_at', 'ended_at', 'duration_seconds',
  'first_name', 'last_name', 'conf_name', 'phone_number', 'conf_pn', 'conf_mail', 'email',
  'primary_intent', 'conf_add', 'service_address', 'conf_avail', 'availability_notes',
  'call_summary', 'call_status',
  'final_state', 'was_transferred', 'is_safety_risk', 'intake_json',
];

/**
 * Insert one calls row and its turns in a transaction. Duplicate call_ids
 * (Twilio fires the stop and close events for the same call) are ignored.
 * Returns { inserted: boolean, id }.
 */
async function insertCall(client, row, turns) {
  const values = CALL_COLUMNS.map((c) => {
    const v = row[c];
    if (v === undefined) return null;
    if (c === 'intake_json') return v === null ? null : JSON.stringify(v);
    return v;
  });
  const placeholders = CALL_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
  const res = await client.query(
    `INSERT INTO calls (${CALL_COLUMNS.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (call_id) DO NOTHING RETURNING id`,
    values
  );
  if (res.rows.length === 0) return { inserted: false, id: null };
  const id = res.rows[0].id;

  if (turns && turns.length > 0) {
    const params = [];
    const tuples = turns.map((t, i) => {
      const base = i * 5;
      params.push(id, t.sequence, t.speaker, t.text, t.at);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    await client.query(
      `INSERT INTO transcript_turns (call_id, sequence, speaker, text, at) VALUES ${tuples.join(', ')}`,
      params
    );
  }
  return { inserted: true, id };
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection may be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Public entry point used by the server
// ---------------------------------------------------------------------------

/**
 * Persist a finished call. Never throws. The server does not await the
 * returned promise, so a slow database cannot delay call teardown.
 *
 * @param {Object} callData      cleaned intake data (same object the Sheet gets)
 * @param {string} currentState  state machine state at hang-up
 * @param {Object} metadata      { callId, twilioCallSid, callerNumber,
 *                                 wasTransferred, startedAt, endedAt,
 *                                 environment, transcript: [turns] }
 * @returns {Promise<{success: boolean, skipped?: boolean, id?: number, error?: string}>}
 */
async function saveCall(callData, currentState, metadata = {}) {
  if (!DATABASE_URL) {
    if (!warnedDisabled) {
      console.log('ℹ️ Call DB disabled (DATABASE_URL not set); calls go to Google Sheets only');
      warnedDisabled = true;
    }
    return { success: false, skipped: true, reason: 'no DATABASE_URL' };
  }
  if (!metadata.callId) {
    return { success: false, skipped: true, reason: 'no callId' };
  }

  try {
    const row = buildCallRow(callData || {}, currentState, metadata);
    const turns = Array.isArray(metadata.transcript) ? metadata.transcript : [];
    const result = await withTransaction((client) => insertCall(client, row, turns));
    if (!result.inserted) {
      console.log(`⏭️  Call ${metadata.callId} already in DB - skipping duplicate`);
      return { success: true, skipped: true, reason: 'duplicate_call_id' };
    }
    console.log(`🗄️  Call saved to DB (id ${result.id}, ${turns.length} transcript turns${row.is_test ? ', test call' : ''})`);
    return { success: true, id: result.id };
  } catch (err) {
    console.error(`❌ Call DB write failed for ${metadata.callId} (call and Sheet row unaffected): ${err.message}`);
    return { success: false, error: err.message };
  }
}

/** Close the pool (scripts only; the server never calls this). */
async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = {
  saveCall,
  createTranscriptRecorder,
  isOwnNumber,
  lastTenDigits,
  ownNumberDigits,
  insertCall,
  withTransaction,
  getPool,
  closePool,
  CALL_COLUMNS,
};
