#!/usr/bin/env node
/**
 * Review stored calls with the call reviewer (src/review/call-reviewer.js)
 * and file tickets for what it finds. For calls that were saved before
 * CALL_REVIEW was on, or to re-run the reviewer after a prompt change.
 *
 *   node scripts/review-calls.js                     # unreviewed real calls of the last 7 days, newest first, up to 50
 *   node scripts/review-calls.js --days 30 --limit 20
 *   node scripts/review-calls.js --call 2591         # one call (also re-reviews with --force)
 *   node scripts/review-calls.js --include-tests     # test calls too
 *   node scripts/review-calls.js --force             # re-review calls that already have a review
 *   node scripts/review-calls.js --show 2591         # print the prompt for a call and exit (no model call)
 *
 * Needs DATABASE_URL and ANTHROPIC_API_KEY (reads .env). Each review is one
 * model call of a few thousand tokens.
 */
process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET || 'true';
require('dotenv').config({ quiet: true });

const callDb = require('../src/utils/call-db');
const reviewer = require('../src/review/call-reviewer');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

async function main() {
  const pool = callDb.getPool();
  if (!pool) { console.error('DATABASE_URL is not set'); process.exit(1); }

  const show = arg('--show', null);
  if (show) {
    const loaded = await reviewer.loadCall(pool, Number(show));
    if (!loaded) { console.error(`no call ${show}`); process.exit(1); }
    console.log('--- SYSTEM ---\n' + reviewer.SYSTEM_PROMPT + '\n--- USER ---\n' + reviewer.buildUserPrompt(loaded.call, loaded.turns));
    await callDb.closePool();
    return;
  }

  const force = has('--force');
  let ids;
  if (arg('--call', null)) {
    ids = [Number(arg('--call'))];
  } else {
    const days = Number(arg('--days', 7));
    const limit = Number(arg('--limit', 50));
    const includeTests = has('--include-tests');
    const { rows } = await pool.query(
      `SELECT c.id FROM calls c
       WHERE c.started_at > now() - make_interval(days => $1::int)
         AND ($2::boolean OR NOT c.is_test)
         AND ($3::boolean OR NOT EXISTS (SELECT 1 FROM call_reviews r WHERE r.call_id = c.id AND r.verdict <> 'error'))
         AND EXISTS (SELECT 1 FROM transcript_turns t WHERE t.call_id = c.id)
       ORDER BY c.started_at DESC LIMIT $4`,
      [days, includeTests, force, limit]
    );
    ids = rows.map((r) => r.id);
  }
  console.log(`Reviewing ${ids.length} call(s) with ${reviewer.model}${force ? ' (force)' : ''}`);

  let tokensIn = 0, tokensOut = 0, issues = 0, opened = 0;
  for (const id of ids) {
    const r = await reviewer.reviewCall(id, { force });
    if (r.skipped) { console.log(`  call ${id}: skipped (${r.reason})`); continue; }
    tokensIn += r.review.usage.input_tokens || 0;
    tokensOut += r.review.usage.output_tokens || 0;
    if (r.review.findings.length) issues++;
    opened += r.tickets.filter((t) => t.inserted).length;
    console.log(`  call ${id}: ${r.review.verdict} — ${r.review.summary}`);
    for (const t of r.tickets) console.log(`     ${t.inserted ? 'NEW ' : t.reopened ? 'REOPENED ' : ''}ticket #${t.id} [${t.severity}] ${t.title}`);
  }
  console.log(`\nDone: ${ids.length} reviewed, ${issues} with findings, ${opened} new ticket(s); ${tokensIn} input / ${tokensOut} output tokens.`);
  console.log(`${reviewer.CALL_LOG_URL}/tickets`);
  await callDb.closePool();
}

main().catch((err) => { console.error(err); process.exit(1); });
