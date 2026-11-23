import { query } from "./db";

export const PAGE_SIZE = 50;

/**
 * Which calls a list shows. Every row is in exactly one scope:
 *   live:    written by the server for a real caller (the main page)
 *   test:    flagged is_test (RSE's own numbers, the smoke call, the bot caller)
 *   history: imported from the Google Sheet (source = 'sheets'), test or not
 */
export type CallScope = "live" | "test" | "history";

export interface CallFilters {
  q: string;
  from: string; // YYYY-MM-DD (Eastern) or ""
  to: string; // YYYY-MM-DD (Eastern) or ""
  scope: CallScope;
  page: number;
}

export interface CallRow {
  id: number;
  call_id: string;
  twilio_call_sid: string | null;
  source: string;
  environment: string | null;
  sheet_row_number: number | null;
  is_test: boolean;
  test_reason: string | null;
  pre_caller_id_fix: boolean;
  direction: string;
  caller_number: string | null;
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number | null;
  first_name: string | null;
  last_name: string | null;
  conf_name: number | null;
  phone_number: string | null;
  conf_pn: number | null;
  conf_mail: number | null;
  email: string | null;
  primary_intent: string | null;
  conf_add: number | null;
  service_address: string | null;
  conf_avail: number | null;
  availability_notes: string | null;
  call_summary: string | null;
  call_status: string | null;
  final_state: string | null;
  was_transferred: boolean | null;
  is_safety_risk: boolean | null;
  intake_json: Record<string, unknown> | null;
  created_at: Date;
  has_recording?: boolean; // list query only
}

export interface RecordingMeta {
  id: number;
  source: string;
  codec: string;
  sample_rate: number;
  duration_seconds: number | null;
  created_at: Date;
}

export interface RecordingAudio {
  sample_rate: number;
  caller_audio: Buffer;
  ava_audio: Buffer;
}

export interface TestRunRow {
  id: number;
  scenario: string;
  mode: string;
  passed: boolean;
  outcome_expected: string | null;
  outcome_reached: boolean | null;
  ended_how: string | null;
  latency_p50_ms: number | null;
  latency_p90_ms: number | null;
  latency_max_ms: number | null;
  dead_air_max_ms: number | null;
  dead_air_gaps: number | null;
  barge_ins: number | null;
  interjections: number | null;
  report: TestRunReport;
  created_at: Date;
}

/**
 * The report JSON on a test_runs row (only what the pages read). Two writers:
 * scripts/test-caller (report.json) and the daily smoke call
 * (src/monitor/smoke-call.js, kind "smoke", scenario "daily-greeting").
 */
export interface TestRunReport {
  fields?: { field: string; expected: unknown; actual: unknown; ok: boolean | null; required: boolean }[];
  intakeSource?: string;
  latency?: { firstAudible?: { p50: number | null; p90: number | null; max: number | null } };
  routineClears?: number;
  // daily smoke call
  kind?: "smoke";
  transcript?: string | null;
  reason?: string | null;
  expectedGreeting?: string;
  greetingMatch?: { matched: number; total: number; fraction: number; ok: boolean } | null;
  timings?: { ringMs?: number; firstAudioMs?: number; streamMs?: number; callMs?: number; transcribeMs?: number };
  audioMs?: number;
  callSid?: string | null;
  from?: string;
  to?: string;
  [key: string]: unknown;
}

/** test_runs.scenario of the daily smoke call. */
export const SMOKE_SCENARIO = "daily-greeting";

export function isSmokeRun(run: { scenario: string; report: TestRunReport }): boolean {
  return run.scenario === SMOKE_SCENARIO || run.report?.kind === "smoke";
}

export interface TranscriptTurn {
  id: number;
  sequence: number;
  speaker: "caller" | "ava";
  text: string;
  at: Date;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFilters(params: Record<string, string | string[] | undefined>, scope: CallScope): CallFilters {
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const page = Math.max(1, Number.parseInt(one("page") || "1", 10) || 1);
  return {
    q: one("q").trim().slice(0, 100),
    from: ISO_DATE.test(one("from")) ? one("from") : "",
    to: ISO_DATE.test(one("to")) ? one("to") : "",
    scope,
    page,
  };
}

/** SQL for one scope; the three are disjoint and together cover every row. */
const SCOPE_SQL: Record<CallScope, string> = {
  live: "source <> 'sheets' AND NOT is_test",
  test: "source <> 'sheets' AND is_test",
  history: "source = 'sheets'",
};

function whereClause(f: CallFilters): { sql: string; params: unknown[] } {
  const digits = f.q.replace(/\D/g, "");
  const params: unknown[] = [f.q, digits.length >= 3 ? digits : "", f.from || null, f.to || null];
  const sql = `
    WHERE ($1 = '' OR concat_ws(' ', first_name, last_name, phone_number, caller_number, email,
                                 call_summary, service_address, availability_notes, primary_intent, call_id)
                        ILIKE '%' || $1 || '%'
           OR ($2 <> '' AND (regexp_replace(coalesce(phone_number, ''), '\\D', '', 'g') LIKE '%' || $2 || '%'
                          OR regexp_replace(coalesce(caller_number, ''), '\\D', '', 'g') LIKE '%' || $2 || '%')))
      AND ($3::date IS NULL OR started_at >= ($3::date)::timestamp AT TIME ZONE 'America/New_York')
      AND ($4::date IS NULL OR started_at < ($4::date + 1)::timestamp AT TIME ZONE 'America/New_York')
      AND (${SCOPE_SQL[f.scope]})
  `;
  return { sql, params };
}

export async function listCalls(f: CallFilters): Promise<{ rows: CallRow[]; total: number }> {
  const { sql, params } = whereClause(f);
  const offset = (f.page - 1) * PAGE_SIZE;
  const [rows, counts] = await Promise.all([
    query<CallRow>(
      `SELECT id, call_id, source, environment, is_test, test_reason, pre_caller_id_fix, caller_number, started_at,
              duration_seconds, first_name, last_name, phone_number, email, primary_intent,
              call_summary, call_status, was_transferred, created_at,
              EXISTS (SELECT 1 FROM recordings r WHERE r.call_id = calls.id) AS has_recording
         FROM calls ${sql}
        ORDER BY started_at DESC, id DESC
        LIMIT ${PAGE_SIZE} OFFSET $5`,
      [...params, offset],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM calls ${sql}`, params),
  ]);
  return { rows, total: counts[0]?.n ?? 0 };
}

export async function getCall(
  id: number,
): Promise<{ call: CallRow; turns: TranscriptTurn[]; recording: RecordingMeta | null; testRuns: TestRunRow[] } | null> {
  const calls = await query<CallRow>(`SELECT * FROM calls WHERE id = $1`, [id]);
  if (calls.length === 0) return null;
  const [turns, recordings, testRuns] = await Promise.all([
    query<TranscriptTurn>(`SELECT id, sequence, speaker, text, at FROM transcript_turns WHERE call_id = $1 ORDER BY sequence`, [id]),
    query<RecordingMeta>(`SELECT id, source, codec, sample_rate, duration_seconds, created_at FROM recordings WHERE call_id = $1`, [id]),
    query<TestRunRow>(`SELECT * FROM test_runs WHERE call_id = $1 ORDER BY created_at DESC`, [id]),
  ]);
  return { call: calls[0], turns, recording: recordings[0] ?? null, testRuns };
}

export interface TestRunListRow extends TestRunRow {
  call_db_id: number;
  started_at: Date;
  duration_seconds: number | null;
  first_name: string | null;
  last_name: string | null;
  primary_intent: string | null;
  final_state: string | null;
  has_recording: boolean;
}

/** Every test-caller run, newest first, with the call it was attached to. */
export async function listTestRuns(limit = 200): Promise<TestRunListRow[]> {
  return query<TestRunListRow>(
    `SELECT t.*, c.id AS call_db_id, c.started_at, c.duration_seconds, c.first_name, c.last_name,
            c.primary_intent, c.final_state,
            EXISTS (SELECT 1 FROM recordings r WHERE r.call_id = c.id) AS has_recording
       FROM test_runs t
       JOIN calls c ON c.id = t.call_id
      ORDER BY t.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

/** The raw mu-law audio of both sides; null when the call has no recording. */
export async function getRecordingAudio(callId: number): Promise<RecordingAudio | null> {
  const rows = await query<RecordingAudio & { codec: string }>(
    `SELECT codec, sample_rate, caller_audio, ava_audio FROM recordings WHERE call_id = $1`,
    [callId],
  );
  if (rows.length === 0) return null;
  if (rows[0].codec !== "pcmu") throw new Error(`unsupported recording codec ${rows[0].codec}`);
  return rows[0];
}

export async function countSummary(): Promise<{ total: number; live: number; test: number; history: number; withTranscript: number }> {
  const rows = await query<{ total: number; live: number; test: number; history: number; with_transcript: number }>(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE ${SCOPE_SQL.live})::int AS live,
           count(*) FILTER (WHERE ${SCOPE_SQL.test})::int AS test,
           count(*) FILTER (WHERE ${SCOPE_SQL.history})::int AS history,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM transcript_turns t WHERE t.call_id = calls.id))::int AS with_transcript
      FROM calls
  `);
  const r = rows[0];
  return { total: r.total, live: r.live, test: r.test, history: r.history, withTranscript: r.with_transcript };
}
