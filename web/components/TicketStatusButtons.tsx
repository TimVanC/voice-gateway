import { setTicketStatus } from "@/app/tickets/actions";
import type { TicketRow, TicketStatus } from "@/lib/tickets";

/** One-click status change, used on the tickets list and on the ticket page. */
export default function TicketStatusButtons({ ticket, back }: { ticket: TicketRow; back: string }) {
  const options: { status: TicketStatus; label: string }[] = [
    { status: "fixed", label: "Mark fixed" },
    { status: "ignored", label: "Ignore" },
    { status: "open", label: "Reopen" },
  ];
  return (
    <span className="ticket-actions">
      {options
        .filter((o) => o.status !== ticket.status)
        .map((o) => (
          <form key={o.status} action={setTicketStatus} style={{ display: "inline" }}>
            <input type="hidden" name="id" value={ticket.id} />
            <input type="hidden" name="status" value={o.status} />
            <input type="hidden" name="back" value={back} />
            <button type="submit" className="secondary small">
              {o.label}
            </button>
          </form>
        ))}
    </span>
  );
}
