import Link from "next/link";
import { logout } from "@/app/login/actions";

export default function TopBar() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand">
          Ava call log
        </Link>
        <span className="muted small">RSE Energy Group</span>
        <span className="spacer" />
        <form action={logout}>
          <button type="submit" className="secondary">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
