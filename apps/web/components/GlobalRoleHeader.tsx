"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { clearRoleSession, getRoleSessionSnapshot, subscribeRoleSession } from "./roleSession";
import { apiBase } from '@/lib/apiBase';
import FeedbackBox from "./FeedbackBox";

// The queue the "Tell Us" box fills is worked by the people who can act on it:
// a gym's own administrators, and the platform owner reading across gyms.
const FEEDBACK_TRIAGE_ROLES = ["admin", "platform_owner"];

export default function GlobalRoleHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);

  // Minimal bar pre-auth and on login
  if (!session || pathname === "/login") {
    return (
      <header className="sticky top-0 z-50 border-b-[3px] border-[var(--black)] bg-[var(--canvas-tan-dark)] shadow-[var(--shadow-sm)]">
        <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-6 py-3">
          <span className="text-[10px] font-mono uppercase tracking-[0.35em] text-[var(--black)]">
            PPBF
          </span>
        </div>
      </header>
    );
  }

  function signOut() {
    // credentials matters here: cross-origin (SWA static + Container App API)
    // a fetch without it does not carry the session cookie, so the server had
    // nothing to revoke and "logout" silently left the session alive.
    void fetch(`${apiBase()}/api/pilot/auth/logout`, { method: 'POST', credentials: 'include' });
    clearRoleSession();
    router.replace("/login");
  }

  return (
    <header className="sticky top-0 z-50 border-b-[3px] border-[var(--black)] bg-[var(--canvas-tan-dark)] shadow-[var(--shadow-sm)]">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-[0.35em] text-[var(--black)]">Session Active</span>
          <span className="border-2 border-[var(--black)] bg-[var(--red-primary)] px-2.5 py-1 text-[11px] font-mono uppercase text-[var(--white)]">
            {session.role}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <FeedbackBox />
          {FEEDBACK_TRIAGE_ROLES.includes(session.role) ? (
            <Link
              href="/admin/feedback"
              className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-1 text-[11px] font-mono text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)]"
            >
              Triage
            </Link>
          ) : null}
          <Link
            href="/operations"
            className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-1 text-[11px] font-mono text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)]"
          >
            Operations
          </Link>
          <Link
            href="/dashboard"
            className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-1 text-[11px] font-mono text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
          >
            Bell
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="border-2 border-[var(--black)] bg-[var(--red-primary)] px-3 py-1 text-[11px] font-mono text-[var(--white)] transition hover:bg-[var(--red-highlight)]"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
