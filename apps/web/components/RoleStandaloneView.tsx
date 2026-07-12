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
      <main className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5]">
        <header className="border-b-4 border-[#8b0000] bg-[#1a1a1a] px-6 py-4">
          <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-[#8a8a8a]">Role Workspace</p>
              <h1 className="font-display text-lg font-black tracking-tight text-[#e5e5e5]">{roleLabel}</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="border-2 border-[#8b0000] bg-[#0f0f0f] px-3 py-1 text-[11px] font-mono text-[#b0b0b0]">
                {routeLabel}
              </span>
              <Link
                href="/operations"
                className="border-2 border-[#8b0000] bg-[#1a1a1a] px-3 py-1 text-[11px] font-mono text-[#dc2626] transition hover:border-[#dc2626] hover:bg-[#2a1a1a]"
              >
                Operations
              </Link>
              <Link
                href="/launch"
                className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-3 py-1 text-[11px] font-mono text-[#b0b0b0] transition hover:border-[#8a8a8a] hover:text-[#e5e5e5]"
              >
                Launch
              </Link>
            </div>
          </div>
        </header>

        <section className="mx-auto w-full max-w-[1600px] p-6 md:p-8">{children}</section>
      </main>
    </RoleSessionGate>
  );
}