"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearRoleSession, readRoleSession } from "./roleSession";

export default function GlobalRoleHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const session = typeof window !== "undefined" ? readRoleSession() : null;

  if (!session || pathname === "/login") {
    return null;
  }

  function signOut() {
    clearRoleSession();
    router.replace("/login");
  }

  return (
    <header className="sticky top-0 z-50 border-b-4 border-[#8b4444] bg-[#0a0a0a]">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-[0.35em] text-[#8a8a8a]">Session Active</span>
          <span className="border-2 border-[#8b4444] bg-[#5a2a2a] px-2.5 py-1 text-[11px] font-mono uppercase text-[#d4a574]">
            {session.role}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/operations"
            className="border-2 border-[#8b4444] bg-[#5a4a3a] px-3 py-1 text-[11px] font-mono text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#6b5a4a]"
          >
            Operations
          </Link>
          <Link
            href="/login"
            className="border-2 border-[#5a4a3a] bg-[#4a4a4a] px-3 py-1 text-[11px] font-mono text-[#b0a095] transition hover:border-[#8b4444] hover:bg-[#5a5a5a] hover:text-[#e8d7c6]"
          >
            Bell
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="border-2 border-[#8b4444] bg-[#4a4a4a] px-3 py-1 text-[11px] font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#5a5a5a]"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
