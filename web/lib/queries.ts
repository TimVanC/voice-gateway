import { query } from "./db";

export const PAGE_SIZE = 50;

export type TestFilter = "hide" | "only" | "all";

export interface CallFilters {
  q: string;
  from: string; // YYYY-MM-DD (Eastern) or ""
  to: string; // YYYY-MM-DD (Eastern) or ""
  test: TestFilter;
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
}

export interface TranscriptTurn {
  id: number;
  sequence: number;
  speaker: "caller" | "ava";
  text: string;
  at: Date;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFilters(params: Record<string, string | string[] | undefined>): CallFilters {
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const test = one("test");
  const page = Math.max(1, Number.parseInt(one("page") || "1", 10) || 1);
  return {
    q: one("q").trim().slice(0, 100),
    from: ISO_DATE.test(one("from")) ? one("from") : "",
    to: ISO_DATE.test(one("to")) ? one("to") : "",
    test: test === "only" || test === "all" ? test : "hide",
    page,
  };
}

function whereClause(f: CallFilters): { sql: string; params: unknown[] } {
  const digits = f.q.replace(/\D/g, "");
  const params: unknown[] = [f.q, digits.length >= 3 ? digits : "", f.from || null, f.to || null, f.test];
  const sql = `
    WHERE ($1 = '' OR concat_ws(' ', first_name, last_name, phone_number, caller_number, email,
                                 call_summary, service_address, availability_notes, primary_intent, call_id)
                        ILIKE '%' || $1 || '%'
           OR ($2 <> '' AND (regexp_replace(coalesce(phone_number, ''), '\\D', '', 'g') LIKE '%' || $2 || '%'
                          OR regexp_replace(coalesce(caller_number, ''), '\\D', '', 'g') LIKE '%' || $2 || '%')))
      AND ($3::date IS NULL OR started_at >= ($3::date)::timestamp AT TIME ZONE 'America/New_York')
      AND ($4::date IS NULL OR started_at < ($4::date + 1)::timestamp AT TIME ZONE 'America/New_York')
      AND (CASE $5 WHEN 'hide' THEN NOT is_test WHEN 'only' THEN is_test ELSE TRUE END)
  `;
  return { sql, params };
}

export async function listCalls(f: CallFilters): Promise<{ rows: CallRow[]; total: number }> {
  const { sql, params } = whereClause(f);
  const offset = (f.page - 1) * PAGE_SIZE;
  const [rows, counts] = await Promise.all([
    query<CallRow>(
      `SELECT id, call_id, source, is_test, test_reason, pre_caller_id_fix, caller_number, started_at,
              duration_seconds, first_name, last_name, phone_number, email, primary_intent,
              call_summary, call_status, was_transferred, created_at
         FROM calls ${sql}
        ORDER BY started_at DESC, id DESC
        LIMIT ${PAGE_SIZE} OFFSET $6`,
      [...params, offset],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM calls ${sql}`, params),
  ]);
  return { rows, total: counts[0]?.n ?? 0 };
}

export async function getCall(id: number): Promise<{ call: CallRow; turns: TranscriptTurn[] } | null> {
  const calls = await query<CallRow>(`SELECT * FROM calls WHERE id = $1`, [id]);
  if (calls.length === 0) return null;
  const turns = await query<TranscriptTurn>(
    `SELECT id, sequence, speaker, text, at FROM transcript_turns WHERE call_id = $1 ORDER BY sequence`,
    [id],
  );
  return { call: calls[0], turns };
}

export async function countSummary(): Promise<{ total: number; real: number; test: number; withTranscript: number }> {
  const rows = await query<{ total: number; real: number; test: number; with_transcript: number }>(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE NOT is_test)::int AS real,
           count(*) FILTER (WHERE is_test)::int AS test,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM transcript_turns t WHERE t.call_id = calls.id))::int AS with_transcript
      FROM calls
  `);
  const r = rows[0];
  return { total: r.total, real: r.real, test: r.test, withTranscript: r.with_transcript };
}
