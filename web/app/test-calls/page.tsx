import Link from "next/link";
import CallsList, { type SearchParams } from "@/components/CallsList";

export const dynamic = "force-dynamic";

/** Calls placed by RSE's own numbers or by scripts: the daily smoke call, the bot caller, Tim's test calls. */
export default async function TestCallsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <CallsList
      scope="test"
      base="/test-calls"
      title="Test calls"
      intro={
        <>
          Calls from RSE&apos;s own and test numbers and from scripts (the daily smoke call, the bot caller). They never reach the Google
          Sheet or the inbox and are kept out of the main Calls page. The pass/fail checks on the scripted ones are under{" "}
          <Link href="/tests">Test runs</Link>.
        </>
      }
      searchParams={searchParams}
    />
  );
}
