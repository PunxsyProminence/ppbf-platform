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
      <main className="min-h-screen bg-[#030712] text-slate-100">
        <header className="border-b border-slate-800 bg-[#0b0f19] px-6 py-4">
          <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-slate-500">Standalone Role View</p>
              <h1 className="text-lg font-black tracking-tight text-slate-100">{roleLabel}</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-mono text-emerald-300">
                {routeLabel}
              </span>
              <Link
                href="/operations"
                className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1 text-[11px] font-mono text-cyan-200 transition hover:border-cyan-300/70 hover:text-cyan-100"
              >
                Operations Hub
              </Link>
              <Link
                href="/launch"
                className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1 text-[11px] font-mono text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
              >
                Launch Portal
              </Link>
            </div>
          </div>
        </header>

        <section className="mx-auto w-full max-w-[1600px] p-6 md:p-8">{children}</section>
      </main>
    </RoleSessionGate>
  );
}