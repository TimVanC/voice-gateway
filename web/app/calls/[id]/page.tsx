import Link from "next/link";
import { notFound } from "next/navigation";
import TopBar from "@/components/TopBar";
import { FlagBadges, StatusBadge } from "@/components/Badges";
import { requireSession } from "@/lib/auth";
import { formatDateTime, formatDuration, formatIntent, formatPhone, formatTime, fullName } from "@/lib/format";
import { getCall } from "@/lib/queries";

export const dynamic = "force-dynamic";

function Field({ label, value, conf }: { label: string; value: React.ReactNode; conf?: number | null }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {empty ? <span className="muted">—</span> : value}
        {!empty && conf !== null && conf !== undefined && <span className="conf">{conf}% confidence</span>}
      </dd>
    </>
  );
}

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const numericId = Number.parseInt(id, 10);
  if (!Number.isFinite(numericId)) notFound();
  const result = await getCall(numericId);
  if (!result) notFound();
  const { call, turns } = result;
  const name = fullName(call.first_name, call.last_name);

  return (
    <>
      <TopBar />
      <main>
        <p className="small">
          <Link href="/">← All calls</Link>
        </p>
        <h1>
          {name || "Unknown caller"} <span className="muted">· {formatDateTime(call.started_at)}</span>
        </h1>
        <p>
          <StatusBadge status={call.call_status} />
          <FlagBadges isTest={call.is_test} preFix={call.pre_caller_id_fix} source={call.source} testReason={call.test_reason} />
          {call.is_test && call.test_reason && <span className="muted small"> {call.test_reason}</span>}
        </p>

        <div className="detail-grid">
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Intake</h2>
            <dl>
              <Field label="First name" value={call.first_name} conf={call.conf_name} />
              <Field label="Last name" value={call.last_name} />
              <Field label="Phone" value={formatPhone(call.phone_number)} conf={call.conf_pn} />
              <Field label="Email" value={call.email} conf={call.conf_mail} />
              <Field label="Intent" value={formatIntent(call.primary_intent)} />
              <Field label="Service address" value={call.service_address} conf={call.conf_add} />
              <Field label="Availability" value={call.availability_notes} conf={call.conf_avail} />
              <Field label="Summary" value={call.call_summary} />
              <Field label="Status" value={call.call_status} />
            </dl>
          </section>

          <section className="card">
            <h2 style={{ marginTop: 0 }}>Call</h2>
            <dl>
              <Field label="Started" value={formatDateTime(call.started_at)} />
              <Field label="Ended" value={call.source === "sheets" ? null : formatDateTime(call.ended_at)} />
              <Field label="Duration" value={formatDuration(call.duration_seconds)} />
              <Field
                label="Caller ID"
                value={call.pre_caller_id_fix ? <span className="muted">not passed through on this call</span> : formatPhone(call.caller_number)}
              />
              <Field label="Direction" value={call.direction} />
              <Field label="Transferred" value={call.was_transferred === null ? null : call.was_transferred ? "yes" : "no"} />
              <Field label="Safety risk" value={call.is_safety_risk === null ? null : call.is_safety_risk ? "yes" : "no"} />
              <Field label="Final state" value={call.final_state} />
              <Field label="Source" value={call.source === "sheets" ? `Google Sheet (row ${call.sheet_row_number ?? "?"} at import)` : `server (${call.environment ?? "unknown"})`} />
              <Field label="Call ID" value={<code>{call.call_id}</code>} />
              <Field label="Twilio call SID" value={call.twilio_call_sid ? <code>{call.twilio_call_sid}</code> : null} />
            </dl>
          </section>
        </div>

        <h2>Transcript</h2>
        {turns.length === 0 ? (
          <div className="card empty">
            {call.source === "sheets" ? "No transcript: this call was imported from the Google Sheet, which never stored one." : "No transcript was captured for this call."}
          </div>
        ) : (
          <ol className="transcript">
            {turns.map((t) => (
              <li key={t.id} className={`turn ${t.speaker}`}>
                <span className="who">
                  {t.speaker === "ava" ? "Ava" : "Caller"}
                  <span className="when">{formatTime(t.at)}</span>
                </span>
                <p>{t.text}</p>
              </li>
            ))}
          </ol>
        )}

        {call.intake_json && (
          <details style={{ marginTop: 20 }}>
            <summary className="muted small">Raw intake data</summary>
            <pre className="json">{JSON.stringify(call.intake_json, null, 2)}</pre>
          </details>
        )}
      </main>
    </>
  );
}
