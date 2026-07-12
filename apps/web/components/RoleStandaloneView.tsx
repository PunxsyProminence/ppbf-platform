"use client";

import Link from 'next/link';
import type { ReactNode } from 'react';
import RoleSessionGate from './RoleSessionGate';
import type { ClubRole } from './roleRoutes';

interface RoleStandaloneViewProps {
  roleLabel: string;
  routeLabel: string;
  allowedRoles: ClubRole[];
  children: ReactNode;
}

export default function RoleStandaloneView({ roleLabel, routeLabel, allowedRoles, children }: RoleStandaloneViewProps) {
  return (
    <RoleSessionGate allowedRoles={allowedRoles}>
      <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
        <header className="border-b-4 border-[#8b4444] bg-[#1a1a1a] px-6 py-5">
          <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#8a8a8a]">Role Workspace</p>
              <h1 className="font-display text-lg font-black tracking-wide text-[#e8d7c6]">{roleLabel}</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="border-2 border-[#8b4444] bg-[#0f0f0f] px-3 py-1 text-[11px] font-mono text-[#b0a095]">
                {routeLabel}
              </span>
              <Link
                href="/operations"
                className="border-2 border-[#8b4444] bg-[#5a4a3a] px-3 py-1 text-[11px] font-mono text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#6b5a4a]"
              >
                Operations
              </Link>
              <Link
                href="/launch"
                className="border-2 border-[#5a4a3a] bg-[#4a4a4a] px-3 py-1 text-[11px] font-mono text-[#b0a095] transition hover:border-[#8b4444] hover:bg-[#5a5a5a] hover:text-[#e8d7c6]"
              >
                Launch
              </Link>
            </div>
          </div>
        </header>

        <section className="mx-auto w-full max-w-[1600px] p-8 md:p-10">{children}</section>
      </main>
    </RoleSessionGate>
  );
}