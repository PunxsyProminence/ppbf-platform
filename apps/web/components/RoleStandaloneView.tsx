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

/* This band sits directly under the sticky leather session bar, so it is paper,
   not more chassis -- the page the gym's frame is holding. Same corrections as
   the session bar: type on the root-phi ladder rather than 10px and 11px, space
   on Fibonacci rather than p-8/md:p-10, and every link at --tap instead of the
   26px the px-3 py-1 pair produced.

   The Operations and Bell links are deliberately left in place even though the
   sticky bar above carries the same two. Removing duplicate navigation is a
   behaviour change, not a restyle, so it is raised rather than taken.

   The text-[length:...] / text-[color:...] hints are load-bearing: Tailwind v4
   cannot disambiguate text-[var(--x)] between a size and a colour and emits
   nothing at all for it, so the plain form looks correct in the markup while
   rendering as inherited body type. */
const BAND =
  "border-b border-[color:rgba(0,0,0,.16)] bg-[var(--paper)] px-[var(--s5)] py-[var(--s5)] shadow-[0_2px_8px_rgba(0,0,0,.14)]";
const EYEBROW =
  "font-mono text-[length:var(--t-xs)] uppercase tracking-[0.28em] text-[color:var(--brass-800)]";
const TITLE =
  "font-display text-[length:var(--t-lg)] font-black uppercase tracking-[0.04em] text-[color:var(--hide-950)]";
const CHIP =
  "inline-flex min-h-[var(--s6)] items-center rounded-[var(--r-sm)] border border-[color:rgba(0,0,0,.18)] bg-[var(--paper-2)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] tracking-[0.08em] text-[color:var(--hide-800)]";
const LINK =
  "inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-sm)] border border-[color:rgba(0,0,0,.18)] bg-[var(--paper-2)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--hide-900)] transition " +
  "hover:border-[color:var(--brass-700)] hover:bg-[var(--paper)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]";

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
          <header className={BAND}>
            <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-[var(--s4)]">
              <div>
                <p className={EYEBROW}>Role workspace</p>
                <h1 className={`${TITLE} mt-[var(--s2)]`}>{roleLabel}</h1>
              </div>
              <div className="flex flex-wrap items-center gap-[var(--s3)]">
                <span className={CHIP}>{routeLabel}</span>
                <Link href="/operations" className={LINK}>
                  Operations
                </Link>
                <Link href="/dashboard" className={LINK}>
                  Bell
                </Link>
              </div>
            </div>
          </header>
        )}

        <section className="mx-auto w-full max-w-[1600px] p-[var(--s5)] md:p-[var(--s6)]">
          <div className="mb-[var(--s5)] flex justify-end">
            <ShadowChatButton context={`${roleLabel} ${routeLabel}`} />
          </div>
          {children}
        </section>
      </main>
    </RoleSessionGate>
  );
}