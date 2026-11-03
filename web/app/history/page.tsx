import CallsList, { type SearchParams } from "@/components/CallsList";

export const dynamic = "force-dynamic";

/** Rows imported from the Google Sheet: calls from before the server wrote to Neon, with no transcript or recording. */
export default async function HistoryPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <CallsList
      scope="history"
      base="/history"
      title="History"
      intro={
        <>
          Calls imported from the Google Sheet, from before Ava wrote to this database (November 2026). They have the Sheet&apos;s
          intake fields but no transcript or recording. Calls from April to June 2026 show RSE&apos;s own number as the phone unless the
          caller stated one.
        </>
      }
      searchParams={searchParams}
    />
  );
}
