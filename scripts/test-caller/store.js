/**
 * Store a finished test call in Neon so it shows up in the call-log web app
 * next to real calls: the `calls` row (Ava's own if she wrote one, else one
 * built here), the transcript, the recording of both sides, and a
 * `test_runs` row with the measurements and checks.
 *
 * Inert without DATABASE_URL. Needs the `pg` package (part of the Neon
 * call-records work); says so and returns if it is missing.
 */

const path = require('path');
const { sleep } = require('./report');

const REPO = path.resolve(__dirname, '..', '..');

function loadDb() {
  try {
    require.resolve('pg');
  } catch (_) {
    return null;
  }
  return require(path.join(REPO, 'src', 'utils', 'call-db'));
}

/** Ava writes her row a moment after hang-up; give her a little time. */
async function findCallRow(pool, callId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await pool.query('SELECT id, is_test FROM calls WHERE call_id = $1', [callId]);
    if (res.rows.length) return res.rows[0];
    if (Date.now() >= deadline) return null;
    await sleep(2000);
  }
}

/** A calls row from the harness's own view of the call, when Ava wrote none. */
function buildOwnRow({ callId, callSid, scenario, mode, summary, result, callerNumber }) {
  const intake = result.intake || {};
  const started = new Date(summary.startedAt);
  const ended = new Date(started.getTime() + summary.durationMs);
  const status = result.transferred ? 'transferred' : result.confirmationReached ? 'completed' : 'incomplete';
  return {
    call_id: callId,
    twilio_call_sid: mode === 'phone' && callSid ? callSid : null,
    source: 'test-caller',
    environment: mode === 'phone' ? 'phone' : 'local',
    sheet_row_number: null,
    is_test: true,
    test_reason: `test-caller scenario ${scenario.name}`,
    pre_caller_id_fix: false,
    direction: 'inbound',
    caller_number: callerNumber || null,
    started_at: started,
    ended_at: ended,
    duration_seconds: Math.round(summary.durationMs / 1000),
    first_name: intake.firstName || null,
    last_name: intake.lastName || null,
    conf_name: null,
    phone_number: intake.phone || null,
    conf_pn: null,
    conf_mail: null,
    email: intake.email || null,
    primary_intent: intake.intent || null,
    conf_add: null,
    service_address: [intake.address, intake.city, intake.zip].filter(Boolean).join(', ') || null,
    conf_avail: null,
    availability_notes: intake.availability || null,
    call_summary: intake.situationSummary || null,
    call_status: status,
    final_state: result.finalState || null,
    was_transferred: Boolean(result.transferred),
    is_safety_risk: false,
    intake_json: result.intake || null,
  };
}

/**
 * @param {object} args
 * @param {string} args.databaseUrl
 * @param {string} args.callId        stream SID (the calls.call_id key)
 * @param {string} [args.callSid]
 * @param {object} args.scenario
 * @param {string} args.mode
 * @param {object} args.summary       the run's report.json object
 * @param {object} args.result        intake result (confirmationReached, intake, ...)
 * @param {object[]} args.turns       transcript rows { t, speaker, text }
 * @param {object} args.recorder      TrackRecorder
 * @param {number} args.t0            epoch ms of the call start
 * @param {string} [args.callerNumber]
 * @param {(line: string) => void} args.log
 * @returns {Promise<{ id: number, url: string } | null>}
 */
async function storeRun(args) {
  const { databaseUrl, callId, scenario, mode, summary, turns, recorder, t0, log } = args;
  if (!databaseUrl) return null;
  const db = loadDb();
  if (!db) {
    log('DATABASE_URL is set but the pg package is not installed; run npm install to store runs in Neon');
    return null;
  }
  const pool = db.getPool();
  try {
    let row = await findCallRow(pool, callId, 20000);
    const transcriptTurns = turns
      .filter((t) => t.speaker === 'caller' || t.speaker === 'ava')
      .sort((a, b) => a.t - b.t)
      .map((t, i) => ({ sequence: i + 1, speaker: t.speaker, text: t.text, at: new Date(t0 + t.t) }));

    if (!row) {
      const own = buildOwnRow(args);
      const ins = await db.withTransaction((client) => db.insertCall(client, own, transcriptTurns));
      if (ins.inserted) {
        row = { id: ins.id, is_test: true };
        log(`Neon: calls row ${ins.id} written by the harness (Ava wrote none)`);
      } else {
        row = await findCallRow(pool, callId, 0);
      }
    } else {
      // Ava wrote the row; mark it as this scenario's test call and add the
      // harness transcript only if she captured none.
      await pool.query('UPDATE calls SET is_test = TRUE, test_reason = $2 WHERE id = $1', [row.id, `test-caller scenario ${scenario.name}`]);
      const has = await pool.query('SELECT 1 FROM transcript_turns WHERE call_id = $1 LIMIT 1', [row.id]);
      if (!has.rows.length && transcriptTurns.length) {
        await db.withTransaction(async (client) => {
          for (const t of transcriptTurns) {
            await client.query(
              'INSERT INTO transcript_turns (call_id, sequence, speaker, text, at) VALUES ($1,$2,$3,$4,$5)',
              [row.id, t.sequence, t.speaker, t.text, t.at]
            );
          }
        });
      }
      log(`Neon: using Ava's calls row ${row.id}`);
    }

    const totalSamples = Math.ceil((recorder.durationMs() / 1000) * 8000);
    const caller = recorder.renderMulaw('caller', totalSamples);
    const ava = recorder.renderMulaw('ava', totalSamples);
    await pool.query(
      `INSERT INTO recordings (call_id, source, codec, sample_rate, duration_seconds, caller_audio, ava_audio)
       VALUES ($1, 'test-caller', 'pcmu', 8000, $2, $3, $4)
       ON CONFLICT (call_id) DO UPDATE SET duration_seconds = EXCLUDED.duration_seconds,
         caller_audio = EXCLUDED.caller_audio, ava_audio = EXCLUDED.ava_audio, created_at = now()`,
      [row.id, (totalSamples / 8000).toFixed(1), caller, ava]
    );

    const lat = summary.latency || {};
    await pool.query(
      `INSERT INTO test_runs (call_id, scenario, mode, passed, outcome_expected, outcome_reached, ended_how,
         latency_p50_ms, latency_p90_ms, latency_max_ms, dead_air_max_ms, dead_air_gaps, barge_ins, interjections, report)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        row.id, scenario.name, mode, Boolean(summary.pass),
        summary.outcome && summary.outcome.want, summary.outcome ? Boolean(summary.outcome.ok) : null, summary.endedHow || null,
        intOrNull(lat.firstFrame && lat.firstFrame.p50), intOrNull(lat.firstFrame && lat.firstFrame.p90), intOrNull(lat.firstFrame && lat.firstFrame.max),
        intOrNull(summary.deadAir && summary.deadAir.maxGapMs), intOrNull(summary.deadAir && summary.deadAir.gapsOver3s),
        intOrNull(summary.clears), intOrNull(summary.interjections),
        JSON.stringify(summary),
      ]
    );
    const base = (process.env.TEST_CALLER_WEB_URL || 'https://rse-ava-calls.vercel.app').replace(/\/+$/, '');
    const url = `${base}/calls/${row.id}`;
    log(`Neon: recording (${(totalSamples / 8000).toFixed(0)} s) and test run stored; ${url}`);
    return { id: row.id, url };
  } catch (err) {
    log(`Neon store failed (outputs on disk are unaffected): ${err.message}`);
    return null;
  } finally {
    await db.closePool().catch(() => {});
  }
}

function intOrNull(v) {
  return v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v));
}

module.exports = { storeRun };
