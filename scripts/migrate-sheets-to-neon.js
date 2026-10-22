#!/usr/bin/env node
/**
 * One-time import of the Google Sheet call log into Neon.
 *
 *   node scripts/migrate-sheets-to-neon.js --dry-run     # read the Sheet, print what WOULD happen
 *   node scripts/migrate-sheets-to-neon.js --write       # import into DATABASE_URL (safe to re-run)
 *
 * Options:
 *   --caller-id-fix-date=YYYY-MM-DD   override the auto-detected date before which every
 *                                     row shows RSE's own number (caller ID was not passed
 *                                     through until then)
 *   --own-numbers=+1833...,+1973...   extra RSE numbers (added to TWILIO_NUMBER,
 *                                     TRANSFER_PHONE_NUMBER and TEST_CALLER_NUMBERS)
 *   --limit=N                         only consider the N newest rows (for a quick trial)
 *
 * Reads the Sheet with the same env vars as src/utils/google-sheets-logger.js
 * (GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SHEETS_SHEET_NAME, and either
 * GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SHEETS_CREDENTIALS), read-only
 * scope. Nothing is ever written to the Sheet.
 *
 * Every row becomes a calls row with source = 'sheets'. Rows whose call_id
 * is already in the table (a previous run, or a call the server wrote live)
 * are skipped, so the script is idempotent. The Sheet's call_timestamp is the
 * time the row was written (call end), so started_at = ended_at = that time.
 *
 * Flags:
 *   pre_caller_id_fix  row is older than the caller-ID fix date. Its phone
 *                      column shows RSE's own number for every call where the
 *                      caller did not state a number, so it says nothing about
 *                      who called. Never treated as a test call on its own.
 *   is_test            (a) a row from on or after the fix date whose phone is
 *                          one of RSE's own numbers, or
 *                      (b) any row with obvious test content (name/email/
 *                          summary containing "test"), or
 *                      (c) any row whose name is in TEST_CALLER_NAMES.
 *                      test_reason records which.
 */
process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET || 'true';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { COLUMN_HEADERS } = require('../src/utils/google-sheets-logger');
const {
  lastTenDigits, ownNumberDigits, insertCall, withTransaction, closePool, getPool,
} = require('../src/utils/call-db');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const DRY_RUN = flag('dry-run');
const WRITE = flag('write');
if (DRY_RUN === WRITE) {
  console.error('Pass exactly one of --dry-run or --write.');
  process.exit(2);
}

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_SHEET_NAME || 'RSE Data Call Intake Log';
const LIMIT = opt('limit') ? Number(opt('limit')) : null;
const FIX_DATE_OVERRIDE = opt('caller-id-fix-date');

// ---------------------------------------------------------------------------
// Google Sheets (read-only), same credential rules as the logger
// ---------------------------------------------------------------------------

function sheetsClient() {
  if (!SPREADSHEET_ID) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set');
  const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
  const fileOrJson = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fileOrJson) {
    const trimmed = fileOrJson.trim();
    if (trimmed.startsWith('{')) {
      return google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ credentials: JSON.parse(trimmed), scopes }) });
    }
    const p = path.resolve(trimmed);
    if (fs.existsSync(p)) {
      return google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ keyFile: p, scopes }) });
    }
  }
  if (process.env.GOOGLE_SHEETS_CREDENTIALS) {
    const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
    return google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ credentials, scopes }) });
  }
  throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SHEETS_CREDENTIALS');
}

async function readSheet() {
  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:Z` });
  const values = res.data.values || [];
  if (values.length === 0) throw new Error(`Sheet "${SHEET_NAME}" is empty`);
  const header = values[0].map((h) => String(h).trim());
  const missing = COLUMN_HEADERS.filter((h) => !header.includes(h));
  if (missing.length) throw new Error(`Sheet is missing columns: ${missing.join(', ')}`);
  const rows = values.slice(1).map((cells, i) => {
    const r = { sheet_row_number: i + 2 };
    header.forEach((h, j) => { r[h] = cells[j] === undefined ? '' : String(cells[j]).trim(); });
    return r;
  }).filter((r) => r.call_id || r.call_timestamp);
  return rows;
}

// ---------------------------------------------------------------------------
// Timestamps: "MM/DD/YYYY, hh:mm:ss AM" is Eastern wall-clock time
// ---------------------------------------------------------------------------

const NY = 'America/New_York';

function zoneOffsetMs(utcDate, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(utcDate);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - utcDate.getTime();
}

/** Interpret Y/M/D h:m:s as wall-clock time in `timeZone`; returns a Date. */
function zonedToDate(y, mo, d, h, mi, s, timeZone) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const off1 = zoneOffsetMs(guess, timeZone);
  const candidate = new Date(guess.getTime() - off1);
  const off2 = zoneOffsetMs(candidate, timeZone);
  return off1 === off2 ? candidate : new Date(guess.getTime() - off2);
}

function parseSheetTimestamp(text) {
  if (!text) return null;
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)$/i);
  if (us) {
    let hour = Number(us[4]) % 12;
    if (us[7].toUpperCase() === 'PM') hour += 12;
    return zonedToDate(Number(us[3]), Number(us[1]), Number(us[2]), hour, Number(us[5]), Number(us[6]), NY);
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const TEST_CONTENT = /\btest(?:ing|er|s)?\b/i;

function testContentReason(row) {
  const name = `${row.first_name} ${row.last_name}`.trim();
  if (name && TEST_CONTENT.test(name)) return `test content in name ("${name}")`;
  if (row.email && /test/i.test(row.email)) return `test content in email ("${row.email}")`;
  if (/\btest(?:ing)?\s+call\b|\btesting\b/i.test(`${row.call_summary} ${row.availability_notes}`)) {
    return 'test content in summary/notes';
  }
  return null;
}

function testNameReason(row, names) {
  if (!names.size) return null;
  const full = `${row.first_name} ${row.last_name}`.trim().toLowerCase().replace(/\s+/g, ' ');
  if (full && names.has(full)) return `name is in TEST_CALLER_NAMES ("${full}")`;
  return null;
}

/**
 * Find the number that stands in for "unknown caller" in the oldest rows
 * and the moment it stops dominating. Returns { number, cutoff, evidence }.
 */
function detectCallerIdFix(rowsAsc) {
  const oldest = rowsAsc.slice(0, Math.min(40, rowsAsc.length));
  const freq = new Map();
  for (const r of oldest) {
    const d = lastTenDigits(r.phone_number);
    if (d) freq.set(d, (freq.get(d) || 0) + 1);
  }
  let number = null; let best = 0;
  for (const [d, n] of freq) if (n > best) { best = n; number = d; }
  if (!number || best < oldest.length * 0.5) {
    return { number: null, cutoff: null, evidence: ['no single number dominates the oldest rows'] };
  }

  // Sliding window of 25 rows: the block ends after the last window in which
  // the placeholder number is still the majority.
  const W = 25;
  let lastMajorityIndex = -1;
  for (let i = 0; i + W <= rowsAsc.length; i += 1) {
    const share = rowsAsc.slice(i, i + W).filter((r) => lastTenDigits(r.phone_number) === number).length / W;
    if (share >= 0.5) lastMajorityIndex = i + W - 1;
  }
  let cutoffIndex = lastMajorityIndex;
  while (cutoffIndex >= 0 && lastTenDigits(rowsAsc[cutoffIndex].phone_number) !== number) cutoffIndex -= 1;
  const cutoffRow = cutoffIndex >= 0 ? rowsAsc[cutoffIndex] : null;
  const cutoff = cutoffRow ? new Date(cutoffRow.ts.getTime() + 1000) : null;

  const evidence = [];
  const byWeek = new Map();
  for (const r of rowsAsc) {
    const wk = r.ts.toISOString().slice(0, 10);
    const key = wk.slice(0, 8) + (Number(wk.slice(8)) <= 15 ? '01-15' : '16-31');
    const e = byWeek.get(key) || { n: 0, own: 0 };
    e.n += 1; if (lastTenDigits(r.phone_number) === number) e.own += 1;
    byWeek.set(key, e);
  }
  evidence.push(`placeholder number ${fmtPhone(number)} appears in ${best}/${oldest.length} of the oldest rows`);
  evidence.push('share of rows showing it, per half-month:');
  for (const [k, e] of [...byWeek.entries()].sort()) {
    evidence.push(`    ${k}  ${String(e.own).padStart(4)} / ${String(e.n).padEnd(4)} (${Math.round((100 * e.own) / e.n)}%)`);
  }
  return { number, cutoff, evidence };
}

function fmtPhone(digits) {
  return digits ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : '';
}

function toSmallInt(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
const toText = (v) => (v === '' || v === null || v === undefined ? null : String(v));

function buildRow(r, flags) {
  return {
    call_id: r.call_id,
    twilio_call_sid: null,
    source: 'sheets',
    environment: 'production',
    sheet_row_number: r.sheet_row_number,
    is_test: Boolean(flags.testReason),
    test_reason: flags.testReason,
    pre_caller_id_fix: flags.preFix,
    direction: 'inbound',
    caller_number: null,
    started_at: r.ts,
    ended_at: r.ts,
    duration_seconds: null,
    first_name: toText(r.first_name),
    last_name: toText(r.last_name),
    conf_name: toSmallInt(r.conf_name),
    phone_number: toText(r.phone_number),
    conf_pn: toSmallInt(r.conf_pn),
    conf_mail: toSmallInt(r.conf_mail),
    email: toText(r.email),
    primary_intent: toText(r.primary_intent),
    conf_add: toSmallInt(r.conf_add),
    service_address: toText(r.service_address),
    conf_avail: toSmallInt(r.conf_avail),
    availability_notes: toText(r.availability_notes),
    call_summary: toText(r.call_summary),
    call_status: toText(r.call_status),
    final_state: null,
    was_transferred: r.call_status === 'transferred',
    is_safety_risk: null,
    intake_json: null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`${DRY_RUN ? 'DRY RUN' : 'WRITE'}: Google Sheet "${SHEET_NAME}" -> Neon calls (source = 'sheets')`);
  if (WRITE && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  let rows = await readSheet();
  console.log(`\nRead ${rows.length} data rows from the Sheet.`);
  if (LIMIT) { rows = rows.slice(0, LIMIT); console.log(`Considering only the ${rows.length} newest rows (--limit).`); }

  // Parse timestamps; drop rows we cannot date (reported, never silently).
  const undated = [];
  for (const r of rows) {
    r.ts = parseSheetTimestamp(r.call_timestamp);
    if (!r.ts) undated.push(r);
  }
  rows = rows.filter((r) => r.ts);
  if (undated.length) {
    console.log(`\n${undated.length} row(s) have an unreadable call_timestamp and will be SKIPPED:`);
    undated.slice(0, 10).forEach((r) => console.log(`  row ${r.sheet_row_number}: "${r.call_timestamp}" (call_id ${r.call_id})`));
  }

  // Duplicate call_ids inside the Sheet: keep the first (newest) occurrence.
  const seen = new Set(); const dupes = [];
  rows = rows.filter((r) => {
    if (!r.call_id) { r.call_id = `SHEET-ROW-${r.sheet_row_number}`; }
    if (seen.has(r.call_id)) { dupes.push(r); return false; }
    seen.add(r.call_id); return true;
  });
  if (dupes.length) {
    console.log(`\n${dupes.length} duplicate call_id row(s) inside the Sheet will be skipped (first occurrence wins):`);
    dupes.slice(0, 10).forEach((r) => console.log(`  row ${r.sheet_row_number}: ${r.call_id}`));
  }

  const asc = rows.slice().sort((a, b) => a.ts - b.ts);
  const oldest = asc[0]; const newest = asc[asc.length - 1];
  console.log(`\nDate range: ${oldest.ts.toISOString()} .. ${newest.ts.toISOString()} (UTC)`);

  // Caller-ID fix detection.
  const detected = detectCallerIdFix(asc);
  let cutoff = detected.cutoff;
  console.log('\nCaller-ID fix detection:');
  detected.evidence.forEach((l) => console.log(`  ${l}`));
  if (FIX_DATE_OVERRIDE) {
    cutoff = new Date(`${FIX_DATE_OVERRIDE}T00:00:00-04:00`);
    if (Number.isNaN(cutoff.getTime())) throw new Error(`Bad --caller-id-fix-date "${FIX_DATE_OVERRIDE}"`);
    console.log(`  using --caller-id-fix-date override: rows before ${cutoff.toISOString()} are pre-fix`);
  } else if (cutoff) {
    console.log(`  auto-detected: rows up to ${cutoff.toISOString()} are pre-fix (override with --caller-id-fix-date=YYYY-MM-DD)`);
  } else {
    console.log('  no pre-fix block detected; no row gets pre_caller_id_fix');
  }

  // Own numbers: env + CLI + the detected placeholder (it IS RSE's number).
  const env = { ...process.env };
  env.TEST_CALLER_NUMBERS = [process.env.TEST_CALLER_NUMBERS, process.env.TRANSFER_PHONE_NUMBER, opt('own-numbers'), detected.number]
    .filter(Boolean).join(',');
  const own = ownNumberDigits(env);
  console.log(`\nRSE / test numbers in effect: ${[...own].map(fmtPhone).join(', ') || '(none)'}`);
  console.log('  (TWILIO_NUMBER, TRANSFER_PHONE_NUMBER, TEST_CALLER_NUMBERS, --own-numbers, detected placeholder)');
  const testNames = new Set(String(process.env.TEST_CALLER_NAMES || '').split(',')
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean));
  if (testNames.size) console.log(`TEST_CALLER_NAMES in effect: ${[...testNames].join(', ')}`);

  // Classify.
  const counts = { total: rows.length, preFix: 0, test: 0, byReason: {}, byStatus: {}, byMonth: {} };
  const prepared = rows.map((r) => {
    const preFix = cutoff ? r.ts < cutoff : false;
    let testReason = null;
    if (!preFix && own.has(lastTenDigits(r.phone_number))) testReason = `phone is an RSE number (${fmtPhone(lastTenDigits(r.phone_number))})`;
    testReason = testReason || testContentReason(r) || testNameReason(r, testNames);
    if (preFix) counts.preFix += 1;
    if (testReason) {
      counts.test += 1;
      const key = testReason.replace(/\s*\(.*\)$/, '');
      counts.byReason[key] = (counts.byReason[key] || 0) + 1;
    }
    counts.byStatus[r.call_status || '(blank)'] = (counts.byStatus[r.call_status || '(blank)'] || 0) + 1;
    const m = r.ts.toISOString().slice(0, 7);
    const mm = counts.byMonth[m] || { n: 0, preFix: 0, test: 0 };
    mm.n += 1; if (preFix) mm.preFix += 1; if (testReason) mm.test += 1;
    counts.byMonth[m] = mm;
    return { row: buildRow(r, { preFix, testReason }), src: r };
  });

  console.log('\nSummary');
  console.log(`  rows to import:        ${counts.total}`);
  console.log(`  pre_caller_id_fix:     ${counts.preFix}`);
  console.log(`  is_test:               ${counts.test}`);
  Object.entries(counts.byReason).forEach(([k, n]) => console.log(`      ${String(n).padStart(5)}  ${k}`));
  console.log('  by call_status:');
  Object.entries(counts.byStatus).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`      ${String(n).padStart(5)}  ${k}`));
  console.log('  by month (rows / pre-fix / test):');
  Object.entries(counts.byMonth).sort().forEach(([k, v]) => console.log(`      ${k}  ${String(v.n).padStart(4)} / ${String(v.preFix).padStart(4)} / ${String(v.test).padStart(4)}`));

  const flagged = prepared.filter((p) => p.row.is_test);
  if (flagged.length) {
    console.log(`\nFirst ${Math.min(15, flagged.length)} rows flagged is_test:`);
    flagged.slice(0, 15).forEach(({ row, src }) => console.log(
      `  row ${String(src.sheet_row_number).padStart(4)}  ${src.call_timestamp.padEnd(24)}  ${(`${src.first_name} ${src.last_name}`.trim() || '-').padEnd(22).slice(0, 22)}  ${(src.phone_number || '-').padEnd(13)}  ${row.test_reason}`
    ));
  }

  if (DRY_RUN) {
    if (process.env.DATABASE_URL) {
      try {
        const { rows: existing } = await getPool().query(
          'SELECT count(*)::int AS n FROM calls WHERE call_id = ANY($1::text[])', [prepared.map((p) => p.row.call_id)]
        );
        console.log(`\nAlready in Neon (would be skipped): ${existing[0].n} of ${prepared.length}`);
      } catch (err) {
        console.log(`\n(Could not check Neon for existing rows: ${err.message})`);
      }
    }
    console.log('\nDry run only. Nothing was written. Re-run with --write to import.');
    return;
  }

  // Write, oldest first, in batches. Each batch is its own transaction.
  console.log('\nWriting to Neon...');
  const ordered = prepared.slice().sort((a, b) => a.row.started_at - b.row.started_at);
  let inserted = 0; let skipped = 0;
  const BATCH = 50;
  for (let i = 0; i < ordered.length; i += BATCH) {
    const batch = ordered.slice(i, i + BATCH);
    await withTransaction(async (client) => {
      for (const { row } of batch) {
        const res = await insertCall(client, row, []);
        if (res.inserted) inserted += 1; else skipped += 1;
      }
    });
    process.stdout.write(`  ${Math.min(i + BATCH, ordered.length)}/${ordered.length}\r`);
  }
  console.log(`\nDone. Inserted ${inserted}, skipped ${skipped} already-present call_id(s). The Sheet was not modified.`);
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(`\nFailed: ${err.message}`);
    await closePool().catch(() => {});
    process.exit(1);
  });
