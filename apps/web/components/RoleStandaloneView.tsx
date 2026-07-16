"use client";

import Link from 'next/link';
import type { ReactNode } from 'react';
import RoleSessionGate from './RoleSessionGate';
import ShadowChatButton from './ShadowChatButton';
import type { ClubRole } from './roleRoutes';

interface RoleStandaloneViewProps {
  readonly roleLabel: string;
  readonly routeLabel: string;
  readonly allowedRoles: ClubRole[];
  readonly children: ReactNode;
  readonly showShellHeader?: boolean;
}

export default function RoleStandaloneView({
  roleLabel,
  routeLabel,
  allowedRoles,
  children,
  showShellHeader = true,
}: RoleStandaloneViewProps) {
  return (
    <RoleSessionGate allowedRoles={allowedRoles}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        {showShellHeader && (
          <header className="border-b-[3px] border-[var(--black)] bg-[var(--canvas-tan-dark)] px-6 py-5 shadow-[var(--shadow-sm)]">
            <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[var(--gray-dark)]">Role Workspace</p>
                <h1 className="font-display text-lg font-black tracking-wide text-[var(--black)]">{roleLabel}</h1>
              </div>
              <div className="flex items-center gap-3">
                <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-1 text-[11px] font-mono text-[var(--gray-dark)]">
                  {routeLabel}
                </span>
                <Link
                  href="/operations"
                  className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-1 text-[11px] font-mono text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)]"
                >
                  Operations
                </Link>
                <Link
                  href="/login"
                  className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-1 text-[11px] font-mono text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
                >
                  Bell
                </Link>
              </div>
            </div>
          </header>
        )}

        <section className="mx-auto w-full max-w-[1600px] p-8 md:p-10">
          <div className="mb-4 flex justify-end">
            <ShadowChatButton context={`${roleLabel} ${routeLabel}`} />
          </div>
          {children}
        </section>
      </main>
    </RoleSessionGate>
  );
}