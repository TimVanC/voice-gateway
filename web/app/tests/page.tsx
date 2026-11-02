import Link from "next/link";
import TopBar from "@/components/TopBar";
import { requireSession } from "@/lib/auth";
import { formatDateTime, formatDuration, fullName, truncate } from "@/lib/format";
import { isSmokeRun, listTestRuns, SMOKE_SCENARIO, type TestRunListRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "" : `${(v / 1000).toFixed(1)} s`);

/** Second column: what the run was, and a one-line summary under it. */
function RunLabel({ r }: { r: TestRunListRow }) {
  if (isSmokeRun(r)) {
    return (
      <>
        <strong>Daily smoke call</strong> <span className="muted small">{r.mode}</span>
        <div className="small">
          {r.passed ? (
            <span className="muted">“{truncate(r.report.transcript, 110)}”</span>
          ) : (
            <span className="fail-reason">{truncate(r.report.reason ?? "failed", 140)}</span>
          )}
        </div>
      </>
    );
  }
  const name = fullName(r.first_name, r.last_name);
  return (
    <>
      <strong>{r.scenario}</strong> <span className="muted small">{r.mode}</span>
      <div className="muted small">{name || "no name captured"}</div>
    </>
  );
}

export default async function TestsPage() {
  await requireSession();
  const runs = await listTestRuns();
  const passed = runs.filter((r) => r.passed).length;
  const smoke = runs.filter(isSmokeRun);
  const latestSmoke = smoke[0];

  return (
    <>
      <TopBar />
      <main>
        <h1>Test calls</h1>
        <p className="muted small" style={{ marginTop: -8 }}>
          Calls placed to Ava by scripts, never by customers; the main Calls list hides them. <strong>Daily smoke call</strong>: once a
          day the server phones Ava&apos;s number from a test number, listens to her opening greeting and checks it (scenario{" "}
          <code>{SMOKE_SCENARIO}</code>). <strong>Bot caller</strong> (<code>scripts/test-caller</code>): a scripted caller talks to Ava and
          what she captured is checked against the scenario. Open a call to listen and see the checks.
        </p>
        <div className="stats">
          <span>
            <strong>{runs.length}</strong> runs
          </span>
          <span>
            <strong>{passed}</strong> passed
          </span>
          <span>
            <strong>{runs.length - passed}</strong> failed
          </span>
          {latestSmoke && (
            <span>
              last smoke call{" "}
              <span className={`badge ${latestSmoke.passed ? "status-completed" : "status-failed"}`}>{latestSmoke.passed ? "PASS" : "FAIL"}</span>
              <Link href={`/calls/${latestSmoke.call_db_id}`}>{formatDateTime(latestSmoke.started_at)}</Link>
            </span>
          )}
        </div>

        {runs.length === 0 ? (
          <div className="card empty">
            No test calls yet. The daily smoke call needs <code>DAILY_SMOKE_CALL=on</code> on the server; the bot caller is{" "}
            <code>node scripts/test-caller/run.js --scenario no-heat --spawn</code> with <code>DATABASE_URL</code> set.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="nowrap">Time (ET)</th>
                <th>Run</th>
                <th>Result</th>
                <th>Ava replied in</th>
                <th>Dead air</th>
                <th>How it ended</th>
                <th className="nowrap">Length</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">
                    <Link href={`/calls/${r.call_db_id}`}>{formatDateTime(r.started_at)}</Link>
                  </td>
                  <td>
                    <RunLabel r={r} />
                  </td>
                  <td>
                    <span className={`badge ${r.passed ? "status-completed" : "status-failed"}`}>{r.passed ? "PASS" : "FAIL"}</span>
                    {r.has_recording && (
                      <span className="badge rec" title="Recording available">
                        audio
                      </span>
                    )}
                  </td>
                  <td className="nowrap">
                    {isSmokeRun(r) ? (
                      r.report.timings?.firstAudioMs == null ? (
                        <span className="muted">—</span>
                      ) : (
                        <span title="From the stream starting to Ava's first audio">{ms(r.report.timings.firstAudioMs)}</span>
                      )
                    ) : r.latency_p50_ms === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span title="p50 / p90 over the call's turns">{`${ms(r.latency_p50_ms)} / ${ms(r.latency_p90_ms)}`}</span>
                    )}
                  </td>
                  <td className="nowrap">
                    {r.dead_air_max_ms === null ? <span className="muted">—</span> : `${ms(r.dead_air_max_ms)} max, ${r.dead_air_gaps ?? 0} over 3 s`}
                  </td>
                  <td>{r.ended_how}</td>
                  <td className="nowrap muted">{formatDuration(r.duration_seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}
