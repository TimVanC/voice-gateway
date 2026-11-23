export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  return <span className={`badge status-${status}`}>{status.replace(/_/g, " ")}</span>;
}

/**
 * Which Ava answered a test call: the production server (the daily smoke call,
 * Tim's calls to the 888 line), the staging server (calls to the 973 number
 * while staging runs), or a local run of the bot caller. The value is the
 * Railway environment the server wrote into the row; rows from before the
 * column existed show as unknown.
 */
export function EnvironmentBadge({ environment }: { environment: string | null }) {
  const env = (environment ?? "").trim().toLowerCase();
  const label = env === "production" ? "production" : env === "staging" ? "staging" : env === "local" ? "local" : env || "unknown env";
  const title =
    env === "production"
      ? "Answered by the production server (the live 888 line)"
      : env === "staging"
        ? "Answered by the staging server (the 973 number while staging runs)"
        : env === "local"
          ? "A local run on a developer machine"
          : "Environment not recorded for this call";
  return (
    <span className={"badge env env-" + (env || "unknown")} title={title}>
      {label}
    </span>
  );
}

export function FlagBadges({
  isTest,
  preFix,
  source,
  testReason,
}: {
  isTest: boolean;
  preFix: boolean;
  source: string;
  testReason?: string | null;
}) {
  return (
    <>
      {isTest && (
        <span className="badge test" title={testReason ?? "Test call"}>
          test
        </span>
      )}
      {preFix && (
        <span className="badge prefix" title="Before the caller-ID fix: the phone column shows RSE's own number, not the caller's">
          no caller ID
        </span>
      )}
      {source === "sheets" && (
        <span className="badge sheets" title="Imported from the Google Sheet">
          sheet
        </span>
      )}
    </>
  );
}
