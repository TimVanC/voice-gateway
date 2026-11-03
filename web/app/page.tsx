import CallsList, { type SearchParams } from "@/components/CallsList";

export const dynamic = "force-dynamic";

/** The main page: calls customers made to Ava since the server started writing to Neon. */
export default async function CallsPage({ searchParams }: { searchParams: SearchParams }) {
  return <CallsList scope="live" base="/" title="Calls" searchParams={searchParams} />;
}
