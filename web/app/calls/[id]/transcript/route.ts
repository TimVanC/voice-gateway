import { hasSession } from "@/lib/auth";
import { formatDateTime, formatTimeMs, fullName } from "@/lib/format";
import { getCall } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * GET /calls/<id>/transcript: the call's transcript as a plain-text file
 * (one line per turn with its time), for download.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await hasSession())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const callId = Number.parseInt(id, 10);
  if (!Number.isFinite(callId)) return new Response("Not found", { status: 404 });
  const data = await getCall(callId);
  if (!data) return new Response("Not found", { status: 404 });
  const { call, turns } = data;
  const name = fullName(call.first_name, call.last_name) || "unknown caller";
  const lines = [
    `Ava call ${call.id} - ${name} - ${formatDateTime(call.started_at)} ET`,
    `Caller ID: ${call.caller_number ?? "unknown"} - intent: ${call.primary_intent ?? "none"} - final state: ${call.final_state ?? "unknown"}${call.environment ? ` - ${call.environment}` : ""}`,
    "",
    ...turns.map((t) => `[${formatTimeMs(t.at)}] ${t.speaker === "ava" ? "Ava:   " : "Caller:"} ${t.text}`),
    "",
  ];
  if (turns.length === 0) lines.splice(3, 0, "(no transcript was captured for this call)");
  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="call-${call.id}-transcript.txt"`,
      "Cache-Control": "private, max-age=60",
    },
  });
}
