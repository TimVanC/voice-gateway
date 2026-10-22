export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  return <span className={`badge status-${status}`}>{status.replace(/_/g, " ")}</span>;
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
