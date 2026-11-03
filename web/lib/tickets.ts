import { query } from "./db";

/**
 * Call reviews and tickets (db/migrations/003_call_reviews_and_tickets.sql),
 * written by src/review/call-reviewer.js on the voice server.
 */

export type TicketStatus = "open" | "fixed" | "ignored";
export const TICKET_STATUSES: TicketStatus[] = ["open", "fixed", "ignored"];

export interface Finding {
  category: string;
  key: string;
  severity: "high" | "medium" | "low";
  title: string;
  what_happened: string;
  expected: string;
  turns: number[];
  fix_area: string;
}

export interface TicketRow {
  id: number;
  fingerprint: string;
  category: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string | null;
  fix_area: string | null;
  status: TicketStatus;
  occurrences: number;
  first_call_id: number | null;
  last_call_id: number | null;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  reopened_at: Date | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TicketCallRow {
  call_id: number;
  finding: Finding;
  created_at: Date;
  started_at: Date;
  first_name: string | null;
  last_name: string | null;
  is_test: boolean;
  call_status: string | null;
}

export interface ReviewRow {
  id: number;
  call_id: number;
  model: string;
  verdict: string;
  summary: string | null;
  findings: Finding[];
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
}

export interface CallTicketLink {
  id: number;
  fingerprint: string;
  title: string;
  status: TicketStatus;
}

export function isTicketStatus(value: string | undefined): value is TicketStatus {
  return TICKET_STATUSES.includes(value as TicketStatus);
}

const SEVERITY_ORDER = "CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END";

export async function listTickets(status: TicketStatus | "all"): Promise<TicketRow[]> {
  const where = status === "all" ? "" : "WHERE status = $1";
  const params = status === "all" ? [] : [status];
  return query<TicketRow>(
    `SELECT * FROM tickets ${where} ORDER BY ${SEVERITY_ORDER} DESC, last_seen_at DESC LIMIT 500`,
    params,
  );
}

export async function ticketCounts(): Promise<{ open: number; high: number; fixed: number; ignored: number; reviewed: number }> {
  const [t] = await query<{ open: string; high: string; fixed: string; ignored: string }>(
    `SELECT count(*) FILTER (WHERE status = 'open') AS open,
            count(*) FILTER (WHERE status = 'open' AND severity = 'high') AS high,
            count(*) FILTER (WHERE status = 'fixed') AS fixed,
            count(*) FILTER (WHERE status = 'ignored') AS ignored
     FROM tickets`,
  );
  const [r] = await query<{ n: string }>(`SELECT count(*) AS n FROM call_reviews WHERE verdict IN ('clean', 'issues')`);
  return { open: Number(t.open), high: Number(t.high), fixed: Number(t.fixed), ignored: Number(t.ignored), reviewed: Number(r.n) };
}

export async function getTicket(id: number): Promise<{ ticket: TicketRow; calls: TicketCallRow[] } | null> {
  const [ticket] = await query<TicketRow>(`SELECT * FROM tickets WHERE id = $1`, [id]);
  if (!ticket) return null;
  const calls = await query<TicketCallRow>(
    `SELECT tc.call_id, tc.finding, tc.created_at, c.started_at, c.first_name, c.last_name, c.is_test, c.call_status
     FROM ticket_calls tc JOIN calls c ON c.id = tc.call_id
     WHERE tc.ticket_id = $1 ORDER BY c.started_at DESC LIMIT 200`,
    [id],
  );
  return { ticket, calls };
}

export async function getCallReview(callId: number): Promise<{ review: ReviewRow | null; tickets: CallTicketLink[] }> {
  const [review] = await query<ReviewRow>(`SELECT * FROM call_reviews WHERE call_id = $1`, [callId]);
  const tickets = await query<CallTicketLink>(
    `SELECT t.id, t.fingerprint, t.title, t.status FROM ticket_calls tc JOIN tickets t ON t.id = tc.ticket_id WHERE tc.call_id = $1`,
    [callId],
  );
  return { review: review ?? null, tickets };
}

export async function updateTicketStatus(id: number, status: TicketStatus, note: string | null): Promise<void> {
  await query(
    `UPDATE tickets SET status = $2,
       resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END,
       note = COALESCE($3, note),
       updated_at = now()
     WHERE id = $1`,
    [id, status, note],
  );
}
