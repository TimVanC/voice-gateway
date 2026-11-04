/**
 * Call reviewer (CALL_REVIEW=on): after a call is saved to Neon, Claude reads
 * the transcript and the intake row, compares them with what the script
 * requires, and reports discrepancies. Each finding becomes, or joins, a
 * ticket keyed by a fingerprint (category:key), so one underlying bug seen
 * on many calls is one ticket with many occurrences. The web app lists the
 * tickets (/tickets); the daily check reports new ones.
 *
 * Runs after the call is over and never touches the call. Every entry point
 * swallows its own errors and logs them. With DATABASE_URL or
 * ANTHROPIC_API_KEY unset the module is inert.
 *
 * Schema: db/migrations/003_call_reviews_and_tickets.sql
 */

const callDb = require('../utils/call-db');
const script = require('../scripts/rse-script');

const ENABLED = (process.env.CALL_REVIEW || '').toLowerCase() === 'on';
const MODEL = process.env.CALL_REVIEW_MODEL || 'claude-sonnet-5-5';
const CALL_LOG_URL = (process.env.CALL_LOG_URL || 'https://rse-ava-calls.vercel.app').replace(/\/$/, '');
const MIN_TURNS = 2;            // fewer: nothing happened worth a review
const MAX_TOKENS = 6000;        // the findings run long; a cut-off answer is unparseable
const OPEN_TICKETS_IN_PROMPT = 60; // existing tickets the model is asked to reuse the keys of
const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

const CATEGORIES = [
  'wrong_field',        // a saved intake field does not match what the caller said
  'missed_answer',      // the caller answered and Ava ignored it or asked again as if they had not
  'repeated_question',  // the same question asked twice or more without a reason
  'wrong_intent',       // the call was routed to the wrong branch (service vs install vs generator etc.)
  'safety_handling',    // the safety check skipped, mis-read, or the 911 response given/not given wrongly
  'premature_end',      // Ava ended the call before the intake was complete
  'improvised_line',    // Ava said something the script does not contain, with a different meaning
  'cut_off',            // Ava stopped mid-sentence or restarted a prompt
  'dead_air',           // long silence the caller had to sit through
  'transfer_issue',     // a transfer offered/made when it should not have been, or not when it should
  'caller_confusion',   // the caller was clearly confused by what Ava said or did
  'other',
];

let anthropicClient = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (anthropicClient) return anthropicClient;
  const Anthropic = require('@anthropic-ai/sdk');
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 2 });
  return anthropicClient;
}

// ---------------------------------------------------------------------------
// The script, as the reviewer sees it (built once from src/scripts/rse-script)
// ---------------------------------------------------------------------------

function scriptSummary() {
  const d = script.DETAILS || {};
  const detailLines = Object.entries(d).map(([intent, prompts]) =>
    `  ${intent}: ${Object.values(prompts || {}).filter((v) => typeof v === 'string').map((v) => `"${v}"`).join(' / ')}`);
  return [
    'Ava is an intake assistant: she collects a lead and ends the call. She never books, quotes, diagnoses or troubleshoots, and never promises a time.',
    '',
    'The script, in order:',
    `1. Greeting, exact: "${script.GREETING.primary}"`,
    '2. Intent: HVAC service (a problem with heating/cooling), HVAC installation or upgrade (new equipment), generator (service or new), the Energy Efficiency Program, a maintenance membership / Home Comfort Plan, an existing project, or out of scope (solar, plumbing, electrical, anything else: polite decline with the list of what RSE does, then close).',
    `   Clarifying questions when unclear: "${script.INTENT_PROMPTS.unclear}" / "${script.INTENT_PROMPTS.service_or_problem}" / "${script.INTENT_PROMPTS.estimate_or_new}"`,
    `3. Safety check, only for HVAC service and generator service: "${script.SAFETY.check}". Any yes means "${script.SAFETY.emergency_response}" and the call ends. A no, "nothing like that", "just no heat" etc. continues. A backchannel ("mhm", "okay", "go ahead") is asked once more.`,
    `4. Name: "${script.CALLER_INFO.name}" (first and last; Ava may spell the last name back once to confirm it)`,
    `5. Phone: "${script.CALLER_INFO.phone}" (Ava may read it back once)`,
    `6. Email: "${script.CALLER_INFO.email.primary}", optional ("${script.CALLER_INFO.email.optional}")`,
    '7. Details for the branch:',
    ...detailLines,
    `8. Service address: "${script.ADDRESS.ask}" (street and town; Ava may spell the street or town back once, and may ask once for the state and zip code when the address lacks them: "Could you also provide the state and zip code?")`,
    `9. Availability: "${script.AVAILABILITY.ask}"`,
    `10. Recap: "${script.CONFIRMATION.intro}" then every captured field, then "${script.CONFIRMATION.verify}". A correction is applied and read back again. If a field such as the name is still missing at the recap Ava asks for it once and returns to the recap.`,
    `11. After the caller confirms the recap: "${script.CLOSE.anything_else}" (scripted; a short acknowledgement such as "Thanks." or "All right." before it is fine). A "no" leads to the close; a real question gets a brief answer and the question is asked again.`,
    `12. Close, exact: "${script.CLOSE.goodbye}" (out of scope: "${script.CLOSE.out_of_scope_close}"). Then Ava hangs up; a stray "Goodbye." or "Take care." after the close line is a low-severity blemish, not an improvised line.`,
    '',
    'Transfers: pressing 0, or asking for a person, gets a transfer to a team member. If Ava cannot understand the caller after several tries she offers a transfer; the offer must actually be spoken before a "yes" counts.',
    'Ava is a scripted voice; a different wording of the same question is fine, a line that changes the meaning (offers troubleshooting, promises a callback time, invents a service) is not.',
  ].join('\n');
}

const SYSTEM_PROMPT = [
  'You are the QA reviewer for Ava, the phone intake assistant of RSE Energy Group (HVAC, generators, an Energy Efficiency Program and maintenance memberships in New Jersey).',
  'You get one finished call: the transcript as Ava heard and said it, and the intake row Ava saved. Compare them with the script below and report discrepancies an engineer should fix.',
  '',
  scriptSummary(),
  '',
  'Rules for findings:',
  '- Report only what the evidence shows. Cite the turn numbers. Do not guess at what the caller meant beyond what they said.',
  '- One finding per underlying problem on this call. Two symptoms of the same bug are one finding.',
  '- Do not flag: a single re-ask after an unclear or partial answer; Ava spelling a name or street back once; the caller\'s own fillers, typos or accents in the transcript; speech-to-text variants of a name that the saved row got right; the caller hanging up on their own after the close; a test caller being a bot (review Ava\'s behaviour the same way).',
  '- The saved intake row is the truth about what RSE will see. A field that the caller stated clearly and the row has wrong, missing or garbled is always a finding (wrong_field), even if the transcript shows Ava read it back right.',
  '- Severity: high = wrong or missing data in the saved row, the caller was lost, the safety check or a transfer was mishandled; medium = a question repeated, an improvised line that changed the meaning, a premature end, long dead air; low = wording or flow blemishes with no effect on the outcome.',
  '- key: a short stable snake_case identifier for the underlying bug, the same for the same bug on any call (describe the bug, never this caller), e.g. name_particle_dropped, safety_backchannel_taken_as_answer, recap_repeated_after_yes. The user message may list existing tickets as "category:key — title": when a finding is the same underlying bug as one of them, use that category and key exactly, so the finding joins that ticket instead of opening a new one.',
  '- title: one line, generic, under 80 characters, describing the bug (not this caller).',
  '- what_happened and expected: at most two sentences each. Keep the whole answer compact.',
  '- fix_area: where in Ava this most likely lives, e.g. "state machine: NAME", "data cleanup: address", "Realtime: barge-in", "intent classifier", "scripted prompt text".',
  '',
  `Categories: ${CATEGORIES.join(', ')}.`,
  '',
  'Answer with JSON only, no prose and no code fence, exactly this shape:',
  '{"verdict": "clean" | "issues", "summary": "one or two sentences on how the call went", "findings": [{"category": "...", "key": "...", "severity": "high" | "medium" | "low", "title": "...", "what_happened": "...", "expected": "...", "turns": [1, 2], "fix_area": "..."}]}',
  'An uneventful call is {"verdict": "clean", "summary": "...", "findings": []}.',
].join('\n');

// ---------------------------------------------------------------------------
// Loading the call
// ---------------------------------------------------------------------------

async function loadCall(pool, callRowId) {
  const { rows } = await pool.query('SELECT * FROM calls WHERE id = $1', [callRowId]);
  if (!rows.length) return null;
  const call = rows[0];
  const turns = (await pool.query(
    'SELECT sequence, speaker, text, at FROM transcript_turns WHERE call_id = $1 ORDER BY sequence',
    [callRowId]
  )).rows;
  return { call, turns };
}

function secondsInto(call, at) {
  const t0 = call.started_at ? new Date(call.started_at).getTime() : null;
  if (!t0 || !at) return null;
  return Math.max(0, Math.round((new Date(at).getTime() - t0) / 1000));
}

function fmtClock(s) {
  if (s === null) return '     ';
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The user message: the saved row, the numbered transcript, and the open tickets to reuse. */
function buildUserPrompt(call, turns, openTickets = []) {
  const row = {
    started_at: call.started_at,
    duration_seconds: call.duration_seconds,
    is_test_call: call.is_test ? `yes (${call.test_reason || 'test'})` : 'no',
    call_status: call.call_status,
    final_state: call.final_state,
    was_transferred: call.was_transferred,
    is_safety_risk: call.is_safety_risk,
    primary_intent: call.primary_intent,
    first_name: call.first_name,
    last_name: call.last_name,
    phone_number: call.phone_number,
    email: call.email,
    service_address: call.service_address,
    availability_notes: call.availability_notes,
    call_summary: call.call_summary,
    details: call.intake_json && call.intake_json.details ? call.intake_json.details : undefined,
  };
  const lines = turns.map((t) => {
    const s = secondsInto(call, t.at);
    return `${String(t.sequence).padStart(3, ' ')} [${fmtClock(s)}] ${t.speaker === 'ava' ? 'AVA   ' : 'CALLER'}: ${t.text}`;
  });
  const ticketLines = openTickets.length
    ? ['', 'EXISTING TICKETS (reuse the category and key when a finding is the same bug):',
      ...openTickets.map((t) => `- ${t.fingerprint} — ${t.title}`)]
    : [];
  return [
    'SAVED INTAKE ROW (what RSE sees):',
    JSON.stringify(row, null, 2),
    '',
    `TRANSCRIPT (${turns.length} turns; [mm:ss] is time into the call; the caller lines are speech-to-text of what the caller said):`,
    ...lines,
    ...ticketLines,
  ].join('\n');
}

async function loadOpenTickets(pool) {
  const { rows } = await pool.query(
    `SELECT fingerprint, title FROM tickets WHERE status <> 'ignored' ORDER BY last_seen_at DESC LIMIT $1`,
    [OPEN_TICKETS_IN_PROMPT]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Asking the model
// ---------------------------------------------------------------------------

/**
 * The model's answer as an object. Tolerates a code fence, prose before or
 * after the JSON, and a trailing comma; the first complete top-level object
 * is taken (brace matching that ignores braces inside strings).
 */
function parseJson(text) {
  let t = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start < 0) throw new Error('no JSON object in the answer');
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('the answer was cut off before the JSON object closed');
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (err) {
    // A trailing comma before ] or } is the usual slip.
    return JSON.parse(body.replace(/,\s*([\]}])/g, '$1'));
  }
}

function cleanFinding(f) {
  if (!f || typeof f !== 'object') return null;
  const category = CATEGORIES.includes(f.category) ? f.category : 'other';
  const severity = SEVERITY_RANK[f.severity] ? f.severity : 'medium';
  const key = String(f.key || f.title || 'unspecified').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'unspecified';
  const turns = Array.isArray(f.turns) ? f.turns.map(Number).filter(Number.isFinite) : [];
  return {
    category,
    key,
    severity,
    title: String(f.title || key).slice(0, 120),
    what_happened: String(f.what_happened || ''),
    expected: String(f.expected || ''),
    turns,
    fix_area: String(f.fix_area || ''),
  };
}

async function askModel(userPrompt) {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set');
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (response.stop_reason === 'max_tokens') throw new Error(`the answer hit the ${MAX_TOKENS}-token limit`);
  const parsed = parseJson(text);
  const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).map(cleanFinding).filter(Boolean);
  return {
    verdict: findings.length ? 'issues' : 'clean',
    summary: String(parsed.summary || '').slice(0, 1000),
    findings,
    usage: response.usage || {},
  };
}

// ---------------------------------------------------------------------------
// Storing the review and the tickets
// ---------------------------------------------------------------------------

async function storeReview(pool, callRowId, review) {
  await pool.query(
    `INSERT INTO call_reviews (call_id, model, verdict, summary, findings, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (call_id) DO UPDATE SET model = EXCLUDED.model, verdict = EXCLUDED.verdict, summary = EXCLUDED.summary,
       findings = EXCLUDED.findings, input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, created_at = now()`,
    [callRowId, MODEL, review.verdict, review.summary || null, JSON.stringify(review.findings || []),
      review.usage && review.usage.input_tokens != null ? review.usage.input_tokens : null,
      review.usage && review.usage.output_tokens != null ? review.usage.output_tokens : null]
  );
}

function fingerprintOf(finding) {
  return `${finding.category}:${finding.key}`;
}

/**
 * One ticket per fingerprint. A new fingerprint opens a ticket; a known one
 * gains this call (occurrences are recomputed from ticket_calls, so
 * re-reviewing a call never double-counts). A fixed ticket that shows up
 * again is reopened; an ignored one stays ignored.
 */
async function upsertTickets(pool, callRowId, findings) {
  const out = [];
  for (const f of findings) {
    const fp = fingerprintOf(f);
    const t = (await pool.query(
      `INSERT INTO tickets (fingerprint, category, severity, title, detail, fix_area, first_call_id, last_call_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (fingerprint) DO UPDATE SET
         last_call_id = EXCLUDED.last_call_id,
         last_seen_at = now(),
         updated_at = now(),
         severity = CASE
           WHEN (CASE EXCLUDED.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) >
                (CASE tickets.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)
           THEN EXCLUDED.severity ELSE tickets.severity END,
         reopened_at = CASE WHEN tickets.status = 'fixed' THEN now() ELSE tickets.reopened_at END,
         status = CASE WHEN tickets.status = 'fixed' THEN 'open' ELSE tickets.status END
       RETURNING id, status, (xmax = 0) AS inserted, (reopened_at IS NOT NULL AND reopened_at > now() - interval '5 seconds') AS reopened`,
      [fp, f.category, f.severity, f.title, f.expected || null, f.fix_area || null, callRowId]
    )).rows[0];
    await pool.query(
      `INSERT INTO ticket_calls (ticket_id, call_id, finding) VALUES ($1, $2, $3)
       ON CONFLICT (ticket_id, call_id) DO UPDATE SET finding = EXCLUDED.finding`,
      [t.id, callRowId, JSON.stringify(f)]
    );
    await pool.query(
      'UPDATE tickets SET occurrences = (SELECT count(*) FROM ticket_calls WHERE ticket_id = $1) WHERE id = $1',
      [t.id]
    );
    out.push({ id: t.id, fingerprint: fp, inserted: t.inserted, reopened: t.reopened && !t.inserted, status: t.status, severity: f.severity, title: f.title });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Review one call by its calls.id. Never throws.
 * @returns {{skipped?: boolean, reason?: string, review?: object, tickets?: object[]}}
 */
async function reviewCall(callRowId, { force = false, log = console } = {}) {
  const pool = callDb.getPool();
  if (!pool) return { skipped: true, reason: 'no DATABASE_URL' };
  if (!getClient()) return { skipped: true, reason: 'no ANTHROPIC_API_KEY' };
  try {
    if (!force) {
      // A failed review ('error') is tried again; anything else stands.
      const existing = await pool.query(`SELECT verdict FROM call_reviews WHERE call_id = $1 AND verdict <> 'error'`, [callRowId]);
      if (existing.rows.length) return { skipped: true, reason: `already reviewed (${existing.rows[0].verdict})` };
    }
    const loaded = await loadCall(pool, callRowId);
    if (!loaded) return { skipped: true, reason: 'no such call' };
    const { call, turns } = loaded;
    if (turns.length < MIN_TURNS) {
      await storeReview(pool, callRowId, { verdict: 'skipped', summary: `Not reviewed: ${turns.length} transcript turn(s).`, findings: [] });
      return { skipped: true, reason: 'too short' };
    }

    const review = await askModel(buildUserPrompt(call, turns, await loadOpenTickets(pool)));
    await storeReview(pool, callRowId, review);
    const tickets = await upsertTickets(pool, callRowId, review.findings);
    const opened = tickets.filter((t) => t.inserted).length;
    const reopened = tickets.filter((t) => t.reopened).length;
    log.log(`🔎 Call ${callRowId} reviewed: ${review.verdict}${review.findings.length ? `, ${review.findings.length} finding(s)` : ''}`
      + `${opened ? `, ${opened} new ticket(s)` : ''}${reopened ? `, ${reopened} reopened` : ''}`
      + ` (${review.usage.input_tokens || '?'} in / ${review.usage.output_tokens || '?'} out tokens)`);
    return { review, tickets };
  } catch (err) {
    log.error(`❌ Call review failed for call ${callRowId} (call unaffected): ${err.message}`);
    try {
      await storeReview(pool, callRowId, { verdict: 'error', summary: `Review failed: ${err.message}`.slice(0, 500), findings: [] });
    } catch (_) { /* nothing more to do */ }
    return { skipped: true, reason: err.message };
  }
}

/**
 * Review the unreviewed real calls of the last `days` days, newest first,
 * one at a time (CALL_REVIEW_BACKFILL_DAYS on the server, or
 * scripts/review-calls.js). Already-reviewed calls are skipped, so running
 * it again costs nothing. Never throws.
 */
async function backfill({ days = 7, limit = 50, includeTests = false, log = console } = {}) {
  const pool = callDb.getPool();
  if (!pool || !getClient()) return { reviewed: 0, skipped: true };
  let ids = [];
  try {
    ids = (await pool.query(
      `SELECT c.id FROM calls c
       WHERE c.started_at > now() - make_interval(days => $1::int)
         AND ($2::boolean OR NOT c.is_test)
         AND NOT EXISTS (SELECT 1 FROM call_reviews r WHERE r.call_id = c.id AND r.verdict <> 'error')
         AND (SELECT count(*) FROM transcript_turns t WHERE t.call_id = c.id) >= $3
       ORDER BY c.started_at DESC LIMIT $4`,
      [days, includeTests, MIN_TURNS, limit]
    )).rows.map((r) => r.id);
  } catch (err) {
    log.error(`❌ Call review backfill could not list calls: ${err.message}`);
    return { reviewed: 0, error: err.message };
  }
  if (!ids.length) {
    log.log(`🔎 Call review backfill: nothing to review in the last ${days} days`);
    return { reviewed: 0 };
  }
  log.log(`🔎 Call review backfill: reviewing ${ids.length} call(s) from the last ${days} days`);
  let reviewed = 0, withFindings = 0, opened = 0;
  for (const id of ids) {
    const r = await reviewCall(id, { log });
    if (r.review) {
      reviewed++;
      if (r.review.findings.length) withFindings++;
      opened += r.tickets.filter((t) => t.inserted).length;
    }
  }
  log.log(`🔎 Call review backfill done: ${reviewed} reviewed, ${withFindings} with findings, ${opened} new ticket(s)`);
  return { reviewed, withFindings, opened };
}

/**
 * The daily check's line: tickets opened or reopened in the last 24 hours,
 * and how many are open in all. A quiet day is a pass.
 */
async function ticketsCheck() {
  const result = { name: 'Call review tickets', status: 'pass', detail: '' };
  const pool = callDb.getPool();
  if (!pool) {
    result.detail = 'no DATABASE_URL';
    return result;
  }
  try {
    const counts = (await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'open') AS open,
              count(*) FILTER (WHERE status = 'open' AND severity = 'high') AS open_high,
              count(*) FILTER (WHERE status = 'open' AND (created_at > now() - interval '24 hours' OR reopened_at > now() - interval '24 hours')) AS fresh,
              count(*) FILTER (WHERE last_seen_at > now() - interval '24 hours') AS seen
       FROM tickets`
    )).rows[0];
    const reviewed = (await pool.query(
      `SELECT count(*) AS n, count(*) FILTER (WHERE verdict = 'issues') AS with_issues FROM call_reviews WHERE created_at > now() - interval '24 hours'`
    )).rows[0];
    const fresh = (await pool.query(
      `SELECT id, severity, title, occurrences FROM tickets
       WHERE status = 'open' AND (created_at > now() - interval '24 hours' OR reopened_at > now() - interval '24 hours')
       ORDER BY CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, last_seen_at DESC LIMIT 5`
    )).rows;
    const n = (v) => Number(v || 0);
    const parts = [`${n(reviewed.n)} call(s) reviewed since yesterday, ${n(reviewed.with_issues)} with findings`];
    if (n(counts.fresh) > 0) {
      result.status = 'warning';
      parts.push(`${n(counts.fresh)} new ticket(s): ${fresh.map((t) => `#${t.id} [${t.severity}] ${t.title}${t.occurrences > 1 ? ` (×${t.occurrences})` : ''}`).join('; ')}`);
    } else {
      parts.push('no new tickets');
    }
    parts.push(`${n(counts.open)} open in all${n(counts.open_high) ? ` (${n(counts.open_high)} high)` : ''}, ${n(counts.seen)} seen again today`);
    parts.push(`${CALL_LOG_URL}/tickets`);
    result.detail = parts.join('. ');
  } catch (err) {
    result.status = 'fail';
    result.detail = `could not read the tickets — ${err.message}`;
  }
  return result;
}

module.exports = {
  enabled: ENABLED,
  model: MODEL,
  CALL_LOG_URL,
  CATEGORIES,
  SYSTEM_PROMPT,
  buildUserPrompt,
  loadCall,
  parseJson,
  cleanFinding,
  fingerprintOf,
  upsertTickets,
  reviewCall,
  backfill,
  ticketsCheck,
};
