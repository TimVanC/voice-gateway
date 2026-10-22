import Link from "next/link";
import TopBar from "@/components/TopBar";
import { FlagBadges, StatusBadge } from "@/components/Badges";
import { requireSession } from "@/lib/auth";
import { formatDateTime, formatDuration, formatIntent, formatPhone, fullName, truncate } from "@/lib/format";
import { countSummary, listCalls, PAGE_SIZE, parseFilters, type CallFilters } from "@/lib/queries";

export const dynamic = "force-dynamic";

function pageHref(f: CallFilters, page: number): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.test !== "hide") p.set("test", f.test);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `/?${s}` : "/";
}

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const filters = parseFilters(await searchParams);
  const [{ rows, total }, summary] = await Promise.all([listCalls(filters), countSummary()]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = total === 0 ? 0 : (filters.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, filters.page * PAGE_SIZE);

  return (
    <>
      <TopBar />
      <main>
        <h1>Calls</h1>
        <div className="stats">
          <span>
            <strong>{summary.real}</strong> calls
          </span>
          <span>
            <strong>{summary.test}</strong> test calls
          </span>
          <span>
            <strong>{summary.withTranscript}</strong> with transcript
          </span>
        </div>

        <form className="filters" method="get" action="/">
          <label>
            Search
            <input type="search" name="q" defaultValue={filters.q} placeholder="name, phone, email, summary, address" />
          </label>
          <label>
            From
            <input type="date" name="from" defaultValue={filters.from} />
          </label>
          <label>
            To
            <input type="date" name="to" defaultValue={filters.to} />
          </label>
          <label>
            Test calls
            <select name="test" defaultValue={filters.test}>
              <option value="hide">Hide</option>
              <option value="only">Only</option>
              <option value="all">Show all</option>
            </select>
          </label>
          <button type="submit">Filter</button>
          {(filters.q || filters.from || filters.to || filters.test !== "hide") && (
            <Link href="/" className="button secondary">
              Clear
            </Link>
          )}
        </form>

        {rows.length === 0 ? (
          <div className="card empty">No calls match.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="nowrap">Time (ET)</th>
                <th>Caller</th>
                <th className="nowrap">Phone</th>
                <th>Intent</th>
                <th>Status</th>
                <th>Summary</th>
                <th className="nowrap">Length</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const name = fullName(c.first_name, c.last_name);
                return (
                  <tr key={c.id}>
                    <td className="nowrap">
                      <Link href={`/calls/${c.id}`}>{formatDateTime(c.started_at)}</Link>
                    </td>
                    <td>
                      {name || <span className="muted">unknown</span>}
                      <div>
                        <FlagBadges isTest={c.is_test} preFix={c.pre_caller_id_fix} source={c.source} testReason={c.test_reason} />
                      </div>
                    </td>
                    <td className="nowrap">{formatPhone(c.phone_number ?? c.caller_number)}</td>
                    <td>{formatIntent(c.primary_intent)}</td>
                    <td>
                      <StatusBadge status={c.call_status} />
                    </td>
                    <td>{truncate(c.call_summary)}</td>
                    <td className="nowrap muted">{formatDuration(c.duration_seconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="pager">
          <span className="muted small">
            {first}–{last} of {total}
          </span>
          {filters.page > 1 && <Link href={pageHref(filters, filters.page - 1)}>← Newer</Link>}
          {filters.page < pages && <Link href={pageHref(filters, filters.page + 1)}>Older →</Link>}
        </div>
      </main>
    </>
  );
}
