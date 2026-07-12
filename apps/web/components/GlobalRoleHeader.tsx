"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearRoleSession, readRoleSession, type RoleSession } from "./roleSession";

export default function GlobalRoleHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<RoleSession | null>(null);

  useEffect(() => {
    setSession(readRoleSession());
  }, [pathname]);

  useEffect(() => {
    function handleStorageChange() {
      setSession(readRoleSession());
    }

    window.addEventListener("storage", handleStorageChange);
    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  if (!session || pathname === "/login") {
    return null;
  }

  function signOut() {
    clearRoleSession();
    setSession(null);
    router.replace("/login");
  }

  return (
    <header className="sticky top-0 z-50 border-b border-slate-800 bg-[#0b0f19]/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-[0.3em] text-slate-500">Session Active</span>
          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-mono uppercase text-emerald-300">
            {session.role}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/operations"
            className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1 text-[11px] font-mono text-cyan-200 transition hover:border-cyan-300/70 hover:text-cyan-100"
          >
            Operations
          </Link>
          <Link
            href="/launch"
            className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1 text-[11px] font-mono text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
          >
            Launch
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-[11px] font-mono text-rose-200 transition hover:bg-rose-500/20"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
