import Link from "next/link";
import { notFound } from "next/navigation";
import TopBar from "@/components/TopBar";
import { requireSession } from "@/lib/auth";
import { formatDateTime, fullName } from "@/lib/format";
import { getTicket } from "@/lib/tickets";
import TicketStatusButtons from "@/components/TicketStatusButtons";
import { setTicketStatus } from "../actions";

export const dynamic = "force-dynamic";

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const ticketId = Number.parseInt(id, 10);
  if (!Number.isFinite(ticketId)) notFound();
  const result = await getTicket(ticketId);
  if (!result) notFound();
  const { ticket, calls } = result;
  const back = `/tickets/${ticket.id}`;

  return (
    <>
      <TopBar />
      <main>
        <p className="muted small">
          <Link href="/tickets">← Tickets</Link>
        </p>
        <h1 style={{ marginBottom: 4 }}>
          #{ticket.id} {ticket.title}
        </h1>
        <p style={{ marginTop: 0 }}>
          <span className={`badge sev-${ticket.severity}`}>{ticket.severity}</span>
          <span className={`badge ticket-${ticket.status}`}>{ticket.status}</span>
          <span className="muted small">
            {ticket.category.replace(/_/g, " ")}
            {ticket.fix_area ? ` · ${ticket.fix_area}` : ""} · seen on {ticket.occurrences} call{ticket.occurrences === 1 ? "" : "s"} · first{" "}
            {formatDateTime(ticket.first_seen_at)} · last {formatDateTime(ticket.last_seen_at)}
            {ticket.reopened_at ? ` · reopened ${formatDateTime(ticket.reopened_at)}` : ""}
            {ticket.resolved_at ? ` · ${ticket.status} ${formatDateTime(ticket.resolved_at)}` : ""}
          </span>
        </p>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>What should happen</h2>
          <p>{ticket.detail || <span className="muted">No description.</span>}</p>
          <p className="muted small" style={{ marginBottom: 0 }}>
            fingerprint <code>{ticket.fingerprint}</code>
          </p>
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Status</h2>
          <TicketStatusButtons ticket={ticket} back={back} />
          <form action={setTicketStatus} style={{ marginTop: 12 }}>
            <input type="hidden" name="id" value={ticket.id} />
            <input type="hidden" name="status" value={ticket.status} />
            <input type="hidden" name="back" value={back} />
            <label className="small muted" htmlFor="note">
              Note (what was done, or why it is ignored)
            </label>
            <textarea id="note" name="note" rows={3} defaultValue={ticket.note ?? ""} style={{ width: "100%", marginTop: 4 }} />
            <button type="submit" className="secondary small" style={{ marginTop: 6 }}>
              Save note
            </button>
          </form>
        </section>

        <h2>Calls where it happened</h2>
        {calls.length === 0 ? (
          <div className="card empty">No calls recorded against this ticket.</div>
        ) : (
          calls.map((c) => (
            <section key={c.call_id} className="card">
              <p style={{ marginTop: 0 }}>
                <Link href={`/calls/${c.call_id}`}>
                  <strong>{formatDateTime(c.started_at)}</strong>
                </Link>{" "}
                <span className="muted small">
                  {fullName(c.first_name, c.last_name) || "no name captured"}
                  {c.is_test ? " · test call" : ""}
                  {c.call_status ? ` · ${c.call_status.replace(/_/g, " ")}` : ""}
                  {c.finding.turns?.length ? ` · turns ${c.finding.turns.join(", ")}` : ""}
                </span>
              </p>
              <p style={{ marginBottom: 6 }}>
                <strong>What happened:</strong> {c.finding.what_happened}
              </p>
              <p style={{ marginBottom: 0 }}>
                <strong>Expected:</strong> {c.finding.expected}
              </p>
            </section>
          ))
        )}
      </main>
    </>
  );
}
