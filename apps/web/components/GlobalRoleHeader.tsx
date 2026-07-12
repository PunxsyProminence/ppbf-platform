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
    <header className="sticky top-0 z-50 border-b-4 border-[#8b0000] bg-[#1a1a1a]">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#8a8a8a]">Session Active</span>
          <span className="border-2 border-[#dc2626] bg-[#2a1a1a] px-2.5 py-1 text-[11px] font-mono uppercase text-[#dc2626]">
            {session.role}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/operations"
            className="border-2 border-[#b35806] bg-[#1f1f1f] px-3 py-1 text-[11px] font-mono text-[#c85a17] transition hover:border-[#c85a17] hover:bg-[#2a1f1f]"
          >
            Operations
          </Link>
          <Link
            href="/launch"
            className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-3 py-1 text-[11px] font-mono text-[#b0b0b0] transition hover:border-[#8a8a8a] hover:text-[#e5e5e5]"
          >
            Launch
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="border-2 border-[#8b0000] bg-[#1a1a1a] px-3 py-1 text-[11px] font-mono text-[#dc2626] transition hover:border-[#dc2626] hover:bg-[#2a1a1a]"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
