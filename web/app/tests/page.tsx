import Link from "next/link";
import TopBar from "@/components/TopBar";
import { requireSession } from "@/lib/auth";
import { formatDateTime, formatDuration, fullName } from "@/lib/format";
import { listTestRuns } from "@/lib/queries";

export const dynamic = "force-dynamic";

const ms = (v: number | null) => (v === null ? "" : `${(v / 1000).toFixed(1)} s`);

export default async function TestsPage() {
  await requireSession();
  const runs = await listTestRuns();
  const passed = runs.filter((r) => r.passed).length;

  return (
    <>
      <TopBar />
      <main>
        <h1>Test calls</h1>
        <p className="muted small" style={{ marginTop: -8 }}>
          Calls placed by the bot caller (<code>scripts/test-caller</code>): a scripted caller talks to Ava, the call is recorded, and
          what Ava captured is checked against the scenario. Open a call to listen and see the checks.
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
        </div>

        {runs.length === 0 ? (
          <div className="card empty">
            No test calls yet. Run <code>node scripts/test-caller/run.js --scenario no-heat --spawn</code> with <code>DATABASE_URL</code> set.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="nowrap">Time (ET)</th>
                <th>Scenario</th>
                <th>Result</th>
                <th>Ava replied in (p50 / p90)</th>
                <th>Dead air</th>
                <th>How it ended</th>
                <th className="nowrap">Length</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const name = fullName(r.first_name, r.last_name);
                return (
                  <tr key={r.id}>
                    <td className="nowrap">
                      <Link href={`/calls/${r.call_db_id}`}>{formatDateTime(r.started_at)}</Link>
                    </td>
                    <td>
                      <strong>{r.scenario}</strong> <span className="muted small">{r.mode}</span>
                      <div className="muted small">{name || "no name captured"}</div>
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
                      {r.latency_p50_ms === null ? <span className="muted">—</span> : `${ms(r.latency_p50_ms)} / ${ms(r.latency_p90_ms)}`}
                    </td>
                    <td className="nowrap">
                      {r.dead_air_max_ms === null ? <span className="muted">—</span> : `${ms(r.dead_air_max_ms)} max, ${r.dead_air_gaps ?? 0} over 3 s`}
                    </td>
                    <td>{r.ended_how}</td>
                    <td className="nowrap muted">{formatDuration(r.duration_seconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}
