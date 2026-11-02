import { redirect } from "next/navigation";
import { hasSession } from "@/lib/auth";
import { login } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await hasSession()) redirect("/");
  const params = await searchParams;
  const failed = params.error === "1";

  return (
    <main className="login">
      <div className="card">
        <h1>Ava call log</h1>
        <p className="muted small">Enter the app password to continue.</p>
        <form action={login}>
          <input type="password" name="password" placeholder="Password" autoFocus required autoComplete="current-password" />
          {failed && <div className="error">That password is not right.</div>}
          <button type="submit">Sign in</button>
        </form>
      </div>
    </main>
  );
}
