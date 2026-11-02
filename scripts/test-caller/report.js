/**
 * Reporting for a test call: what Ava captured (from her log or the Neon
 * row), whether it matches the scenario, the two-column transcript and the
 * turn latency table.
 */

const fs = require('fs');

// ---------------------------------------------------------------------------
// Intake: from Ava's server log
// ---------------------------------------------------------------------------

/**
 * Pull the section of a server log that belongs to one stream, then the
 * intake JSON Ava prints at hang-up, her state transitions and the outcome
 * markers. Returns null when the stream never appears in the log.
 */
function parseServerLog(text, streamSid) {
  const startMarker = `Stream started: ${streamSid}`;
  const startIdx = text.indexOf(startMarker);
  if (startIdx < 0) return null;
  const nextIdx = text.indexOf('Stream started: ', startIdx + startMarker.length);
  const section = nextIdx > 0 ? text.slice(startIdx, nextIdx) : text.slice(startIdx);

  const intake = extractJsonAfter(section, 'Call data collected:');
  const transitions = [];
  const prompts = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/\[INTAKE\] (\{.*\})\s*$/);
    if (!m) continue;
    try {
      const e = JSON.parse(m[1]);
      if (e.event === 'state_transition') transitions.push({ from: e.from, to: e.to, ts: e.ts });
      if (e.event === 'prompt' && e.prompt) prompts.push(e.prompt);
    } catch (_) { /* partial line */ }
  }
  const finalState = (section.match(/Final state: (\w+)/) || [])[1] || null;
  const summary = section.match(/Call summary \|.*transferred: (yes|no)/);
  const summarySeen = /Call summary \|/.test(section);
  return {
    source: 'server-log',
    complete: summarySeen,
    intake,
    finalState,
    transitions,
    confirmationReached:
      transitions.some((t) => t.to === 'confirmation') ||
      Boolean(intake && intake._confirmationDelivered) ||
      prompts.some((p) => /read that back/i.test(p)),
    outOfScope: /Out-of-scope request detected/.test(section) || Boolean(intake && intake.intent === 'other_out_of_scope'),
    transferred:
      (summary && summary[1] === 'yes') ||
      /Transferring call|Transfer not configured|transferring to team member/i.test(section),
    deadAirEvents: (section.match(/WATCHDOG: No response/g) || []).length,
  };
}

function extractJsonAfter(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const open = text.indexOf('{', idx);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(open, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

/** Wait until the log section for this stream has Ava's call summary line. */
async function waitForServerLog(readText, streamSid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = parseServerLog(readText(), streamSid);
    if (last && last.complete) return last;
    await sleep(1000);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Intake: from the Neon row (PR #3's calls table)
// ---------------------------------------------------------------------------

async function waitForNeonRow(databaseUrl, callId, timeoutMs) {
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (e) {
    return { error: 'DATABASE_URL is set but the pg package is not installed (it arrives with PR #3); run npm install' };
  }
  const local = /sslmode=disable/i.test(databaseUrl) || /@(localhost|127\.0\.0\.1)[:/]/i.test(databaseUrl);
  let connectionString = databaseUrl;
  try {
    const u = new URL(databaseUrl);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('channel_binding');
    connectionString = u.toString();
  } catch (_) { /* leave as is */ }
  const pool = new Pool({ connectionString, ssl: local ? false : { rejectUnauthorized: true }, max: 1 });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const res = await pool.query('SELECT * FROM calls WHERE call_id = $1', [callId]);
      if (res.rows.length) return { row: res.rows[0] };
      await sleep(2000);
    }
    return { error: `no calls row with call_id ${callId} after ${timeoutMs / 1000}s` };
  } catch (e) {
    return { error: `Neon query failed: ${e.message}` };
  } finally {
    await pool.end().catch(() => {});
  }
}

function intakeFromNeonRow(row) {
  const j = row.intake_json || {};
  return {
    source: 'neon',
    complete: true,
    intake: {
      intent: row.primary_intent,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone_number,
      email: row.email,
      address: row.service_address,
      availability: row.availability_notes,
      situationSummary: row.call_summary,
      details: j.details || null,
      _confirmationDelivered: Boolean(j._confirmationDelivered),
    },
    finalState: row.final_state,
    transitions: [],
    confirmationReached:
      Boolean(j._confirmationDelivered) || ['confirmation', 'close', 'ended'].includes(row.final_state) && row.call_status !== 'incomplete_hangup',
    outOfScope: row.primary_intent === 'other_out_of_scope',
    transferred: Boolean(row.was_transferred),
    deadAirEvents: null,
  };
}

// ---------------------------------------------------------------------------
// Intake: inferred from what the caller heard (last resort)
// ---------------------------------------------------------------------------

function inferFromTranscript(turns) {
  const ava = turns.filter((t) => t.speaker === 'ava').map((t) => t.text).join(' \n ');
  return {
    source: 'transcript (inferred; no server log and no DATABASE_URL)',
    complete: true,
    intake: null,
    finalState: null,
    transitions: [],
    confirmationReached: /read that back/i.test(ava),
    outOfScope: /don'?t (handle|offer) that|we specialize in hvac/i.test(ava),
    transferred: /transferr?ing you|transfer you/i.test(ava),
    deadAirEvents: null,
  };
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

// Transcription sometimes writes "Fourteen Elm Street"; compare on digits.
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
};
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9@]+/g, ' ')
    .replace(/\b([a-z]+)\b/g, (w) => (w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w))
    .replace(/\b(\d+) (\d+)\b/g, (m, a, b) => (Number(a) >= 20 && Number(b) < 10 ? String(Number(a) + Number(b)) : m))
    .trim();
}
function digits(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

function fieldMatches(field, expected, actual) {
  if (actual == null || actual === '') return false;
  if (field === 'intent') return String(actual) === String(expected);
  if (field === 'phone') {
    const a = digits(actual);
    const e = digits(expected).slice(-10);
    return e.length > 0 && a.endsWith(e);
  }
  if (field === 'email') return norm(actual).replace(/\s+/g, '') === norm(expected).replace(/\s+/g, '');
  return norm(actual).includes(norm(expected));
}

/**
 * @returns {{ pass: boolean, outcome: object, fields: object[] }}
 */
function checkExpectations(expect, result) {
  const want = expect.outcome || 'confirmation';
  const reached = {
    confirmation: result.confirmationReached,
    out_of_scope: result.outOfScope,
    transfer: result.transferred,
  };
  const outcomeOk = Boolean(reached[want]);
  const fields = [];
  const required = new Set(expect.required || []);
  const intake = result.intake || {};
  for (const [field, expected] of Object.entries(expect.fields || {})) {
    const actual = intake[field];
    const ok = result.intake ? fieldMatches(field, expected, actual) : null;
    fields.push({ field, expected, actual: actual == null ? null : actual, ok, required: required.has(field) });
  }
  const requiredFailed = fields.filter((f) => f.required && f.ok !== true);
  return {
    pass: outcomeOk && requiredFailed.length === 0,
    outcome: { want, ok: outcomeOk, reached },
    fields,
    intakeAvailable: Boolean(result.intake),
  };
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * s.length) - 1;
  return s[Math.max(0, Math.min(idx, s.length - 1))];
}

/**
 * For each caller utterance: time from the end of the caller's speech to
 * Ava's first audio frame (and first audible frame). Negative when Ava was
 * already talking before the caller stopped.
 */
function computeLatency(callerUtts, avaUtts) {
  const rows = [];
  for (let i = 0; i < callerUtts.length; i++) {
    const c = callerUtts[i];
    if (c.end == null) continue;
    const nextStart = callerUtts[i + 1] ? callerUtts[i + 1].start : Infinity;
    // First Ava utterance that began after this caller utterance began and before the next one.
    const a = avaUtts.find((u) => u.start > c.start && u.start < nextStart);
    rows.push({
      turn: i + 1,
      callerText: c.text || '',
      callerEndMs: c.end,
      avaFirstFrameMs: a ? a.start - c.end : null,
      avaFirstAudibleMs: a && a.firstAudible != null ? a.firstAudible - c.end : null,
      avaText: a ? a.text || '' : '',
    });
  }
  const firstFrame = rows.map((r) => r.avaFirstFrameMs).filter((v) => v != null && v >= 0);
  const audible = rows.map((r) => r.avaFirstAudibleMs).filter((v) => v != null && v >= 0);
  return {
    rows,
    stats: {
      turns: rows.length,
      answered: firstFrame.length,
      overlaps: rows.filter((r) => r.avaFirstFrameMs != null && r.avaFirstFrameMs < 0).length,
      unanswered: rows.filter((r) => r.avaFirstFrameMs == null).length,
      firstFrame: { p50: percentile(firstFrame, 50), p90: percentile(firstFrame, 90), max: firstFrame.length ? Math.max(...firstFrame) : null },
      firstAudible: { p50: percentile(audible, 50), p90: percentile(audible, 90), max: audible.length ? Math.max(...audible) : null },
    },
  };
}

/** Longest stretch where neither side had audio, and every gap above the threshold. */
function deadAir(callerUtts, avaUtts, endMs, thresholdMs) {
  const spans = [...callerUtts, ...avaUtts]
    .filter((u) => u.start != null)
    .map((u) => [u.start, u.end == null ? endMs : u.end])
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of spans) {
    if (s - cursor > 0) gaps.push({ from: cursor, to: s, ms: s - cursor });
    cursor = Math.max(cursor, e);
  }
  if (endMs - cursor > 0) gaps.push({ from: cursor, to: endMs, ms: endMs - cursor });
  return {
    maxGapMs: gaps.length ? Math.max(...gaps.map((g) => g.ms)) : 0,
    gapsOver: gaps.filter((g) => g.ms >= thresholdMs),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 100))}`;
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Two columns, caller on the left, Ava on the right, one row per turn or event. */
function renderTranscript(turns, { width = 44 } = {}) {
  const gutter = 10;
  const header = `${'TIME'.padEnd(gutter)}${'CALLER'.padEnd(width + 2)}AVA`;
  const out = [header, '-'.repeat(gutter + width * 2 + 2)];
  for (const t of [...turns].sort((a, b) => a.t - b.t)) {
    const text = t.speaker === 'event' ? `-- ${t.text} --` : t.text;
    const lines = wrap(text, width);
    lines.forEach((line, i) => {
      const time = i === 0 ? fmtTime(t.t).padEnd(gutter) : ' '.repeat(gutter);
      if (t.speaker === 'caller') out.push(`${time}${line}`);
      else out.push(`${time}${' '.repeat(width + 2)}${line}`);
    });
  }
  return out.join('\n') + '\n';
}

function ms(v) {
  return v == null ? '-' : `${Math.round(v)} ms`;
}

function renderLatency(latency, dead, extra = {}) {
  const { rows, stats } = latency;
  const lines = [];
  lines.push('# Turn latency (caller speech end -> Ava audio)', '');
  lines.push('| turn | caller said | first frame | first audible | Ava said |');
  lines.push('|-----:|-------------|------------:|--------------:|----------|');
  for (const r of rows) {
    const flag = r.avaFirstFrameMs != null && r.avaFirstFrameMs < 0 ? ' (Ava started before caller finished)' : '';
    lines.push(`| ${r.turn} | ${cell(r.callerText)} | ${ms(r.avaFirstFrameMs)}${flag} | ${ms(r.avaFirstAudibleMs)} | ${cell(r.avaText)} |`);
  }
  lines.push('');
  lines.push('| metric | p50 | p90 | max |');
  lines.push('|--------|----:|----:|----:|');
  lines.push(`| first frame | ${ms(stats.firstFrame.p50)} | ${ms(stats.firstFrame.p90)} | ${ms(stats.firstFrame.max)} |`);
  lines.push(`| first audible | ${ms(stats.firstAudible.p50)} | ${ms(stats.firstAudible.p90)} | ${ms(stats.firstAudible.max)} |`);
  lines.push('');
  lines.push(`Caller turns: ${stats.turns}; answered: ${stats.answered}; Ava talked over the caller: ${stats.overlaps}; unanswered: ${stats.unanswered}.`);
  lines.push(`Dead air: longest gap ${ms(dead.maxGapMs)}; gaps of 3 s or more: ${dead.gapsOver.length}${dead.gapsOver.length ? ' (' + dead.gapsOver.map((g) => `${fmtTime(g.from)} for ${Math.round(g.ms / 100) / 10} s`).join(', ') + ')' : ''}.`);
  if (extra.clears != null) lines.push(`Barge-ins (Ava stopped because the caller spoke): ${extra.clears}; routine clears before Ava speaks: ${extra.routineClears == null ? '-' : extra.routineClears}.`);
  if (extra.interjections != null) lines.push(`Caller interjected ${extra.interjections} time(s) while Ava was talking.`);
  return lines.join('\n') + '\n';
}

function cell(s) {
  const t = String(s || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 57) + '...' : t;
}

function renderChecks(check, result, extra = {}) {
  const lines = [];
  if (extra.endedHow) lines.push(`Call length ${fmtTime(extra.durationMs || 0)}: ${extra.endedHow}.`);
  lines.push(`Intake source: ${result.source}${result.finalState ? `; final state: ${result.finalState}` : ''}`);
  const o = check.outcome;
  lines.push(`Outcome: expected ${o.want} -> ${o.ok ? 'REACHED' : 'NOT REACHED'} (confirmation=${yn(o.reached.confirmation)} out_of_scope=${yn(o.reached.out_of_scope)} transfer=${yn(o.reached.transfer)})`);
  if (check.fields.length) {
    lines.push('Fields:');
    for (const f of check.fields) {
      const mark = f.ok === true ? 'OK  ' : f.ok === false ? (f.required ? 'FAIL' : 'warn') : 'n/a ';
      lines.push(`  ${mark} ${f.field.padEnd(13)} expected ${JSON.stringify(f.expected)}  got ${JSON.stringify(f.actual)}${f.required ? '' : '  (optional)'}`);
    }
    if (!check.intakeAvailable) lines.push('  (no intake data available: field checks could not run)');
  }
  lines.push(`Result: ${check.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n') + '\n';
}

function yn(v) {
  return v ? 'yes' : 'no';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return '';
  }
}

module.exports = {
  parseServerLog,
  waitForServerLog,
  waitForNeonRow,
  intakeFromNeonRow,
  inferFromTranscript,
  checkExpectations,
  computeLatency,
  deadAir,
  percentile,
  renderTranscript,
  renderLatency,
  renderChecks,
  fmtTime,
  readFileSafe,
  sleep,
};
