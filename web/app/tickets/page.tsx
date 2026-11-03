import Link from "next/link";
import TopBar from "@/components/TopBar";
import { requireSession } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import TicketStatusButtons from "@/components/TicketStatusButtons";
import { isTicketStatus, listTickets, ticketCounts, type TicketStatus } from "@/lib/tickets";

export const dynamic = "force-dynamic";

function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge sev-${severity}`}>{severity}</span>;
}

function TicketStatusBadge({ status }: { status: string }) {
  return <span className={`badge ticket-${status}`}>{status}</span>;
}

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const params = await searchParams;
  const raw = typeof params.status === "string" ? params.status : "open";
  const status: TicketStatus | "all" = raw === "all" ? "all" : isTicketStatus(raw) ? raw : "open";
  const [tickets, counts] = await Promise.all([listTickets(status), ticketCounts()]);
  const back = status === "open" ? "/tickets" : `/tickets?status=${status}`;

  const tab = (value: TicketStatus | "all", label: string, n?: number) => (
    <Link href={value === "open" ? "/tickets" : `/tickets?status=${value}`} className={`button secondary${status === value ? " active" : ""}`}>
      {label}
      {n !== undefined ? ` (${n})` : ""}
    </Link>
  );

  return (
    <>
      <TopBar />
      <main>
        <h1>Tickets</h1>
        <p className="muted small" style={{ marginTop: -8 }}>
          After each call a reviewer (Claude) reads the transcript and the saved intake row, compares them with Ava&apos;s script and
          reports what went wrong. The same problem seen on several calls is one ticket with a count; a fixed ticket that comes back is
          reopened. The 8 AM daily check email lists new ones.
        </p>
        <div className="stats">
          <span>
            <strong>{counts.open}</strong> open
          </span>
          <span>
            <strong>{counts.high}</strong> high
          </span>
          <span>
            <strong>{counts.reviewed}</strong> calls reviewed
          </span>
        </div>
        <div className="filters" style={{ marginBottom: 12 }}>
          {tab("open", "Open", counts.open)}
          {tab("fixed", "Fixed", counts.fixed)}
          {tab("ignored", "Ignored", counts.ignored)}
          {tab("all", "All")}
        </div>

        {tickets.length === 0 ? (
          <div className="card empty">
            {status === "open" ? (
              <>
                No open tickets. The reviewer needs <code>CALL_REVIEW=on</code> on the server; <code>node scripts/review-calls.js</code> reviews
                stored calls.
              </>
            ) : (
              "Nothing here."
            )}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Ticket</th>
                <th className="nowrap">Seen</th>
                <th className="nowrap">Last seen (ET)</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td className="nowrap">
                    <SeverityBadge severity={t.severity} />
                  </td>
                  <td>
                    <Link href={`/tickets/${t.id}`}>
                      <strong>
                        #{t.id} {t.title}
                      </strong>
                    </Link>
                    <div className="muted small">
                      {t.category.replace(/_/g, " ")}
                      {t.fix_area ? ` · ${t.fix_area}` : ""}
                      {t.reopened_at ? " · reopened" : ""}
                    </div>
                  </td>
                  <td className="nowrap">
                    {t.occurrences} call{t.occurrences === 1 ? "" : "s"}
                  </td>
                  <td className="nowrap">
                    {t.last_call_id ? <Link href={`/calls/${t.last_call_id}`}>{formatDateTime(t.last_seen_at)}</Link> : formatDateTime(t.last_seen_at)}
                  </td>
                  <td className="nowrap">
                    <TicketStatusBadge status={t.status} />
                  </td>
                  <td className="nowrap">
                    <TicketStatusButtons ticket={t} back={back} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}
