"use client";

import Link from 'next/link';
import type { ReactNode } from 'react';
import RoleSessionGate from './RoleSessionGate';
import ShadowChatButton from './ShadowChatButton';
import type { ClubRole } from './roleRoutes';
import { isFamilyGround } from './roleGround';

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

/* The ink counterparts. The paper band above is right on canvas — a sheet on
   the family-facing page — but dropped onto leather it reads as a bright slab
   fighting the console under it. On the staff ground the band is raised
   leather instead, so the shell and the page it wraps are one object, and the
   type moves from ink-on-paper to bone-and-brass-on-leather. */
const BAND_INK =
  "mat-leather--raised border-b border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]";
const EYEBROW_INK =
  "font-mono text-[length:var(--t-xs)] uppercase tracking-[0.28em] text-[color:var(--brass-400)]";
const TITLE_INK =
  "font-display text-[length:var(--t-lg)] font-black uppercase tracking-[0.04em] text-[color:var(--bone-100)]";
const CHIP_INK =
  "inline-flex min-h-[var(--s6)] items-center rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.28)] bg-[rgba(0,0,0,.26)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] tracking-[0.08em] text-[color:var(--bone-300)]";
const LINK_INK =
  "inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.32)] bg-[rgba(0,0,0,.26)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--bone-200)] transition " +
  "hover:border-[color:var(--brass-400)] hover:text-[color:var(--bone-100)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]";

/* Law 6 gives the platform two grounds: ink leather for staff surfaces, warm
   canvas for the family-facing side. Every workspace this shell wraps was on
   canvas, so eleven staff consoles -- the admin pages, /evidence, and the
   whole coach workspace -- rendered on the ground that belongs to athletes
   and guardians. It showed up first on /admin/shadow, whose panels are dark
   boxes and had to stay opaque to survive the cream behind them.

   The ground is derived from allowedRoles rather than passed in as a prop.
   A prop is a second source of truth that drifts the moment someone adds a
   page and forgets it; allowedRoles is the list that already decides who may
   open the route, so the ground cannot disagree with the audience. A new
   staff page is on leather by construction, without anyone remembering a
   rule.

   A coach is staff: running the session, not attending it. That is the one
   call here that could reasonably go the other way -- a coach works off a
   tablet on the gym floor, which is the environment canvas was tuned for --
   and it was made deliberately rather than by default. */

export default function RoleStandaloneView({
  roleLabel,
  routeLabel,
  allowedRoles,
  children,
  showShellHeader = true,
}: RoleStandaloneViewProps) {
  const familyGround = isFamilyGround(allowedRoles);

  return (
    <RoleSessionGate allowedRoles={allowedRoles}>
      <main
        /* The family branch is deliberately left exactly as it was rather
           than moved to .on-canvas. These pages' own content -- ParentHub,
           AthleteWorkspace -- is built from ink-dark panels, so declaring the
           canvas ground restates every design-system component inside them
           for cream and then renders it on those dark panels: --brass-800
           links at 2.36:1, .on-canvas .t-body at 1.43:1. Measured, not
           guessed. Law 6 does put the family side on canvas, but getting
           there means converting that content first; until then the honest
           change is the eleven staff pages, which this branch verified. */
        className={
          familyGround
            ? 'min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]'
            : 'min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]'
        }
      >
        {showShellHeader && (
          <header className={familyGround ? BAND : BAND_INK}>
            <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-[var(--s4)]">
              <div>
                <p className={familyGround ? EYEBROW : EYEBROW_INK}>Role workspace</p>
                <h1 className={`${familyGround ? TITLE : TITLE_INK} mt-[var(--s2)]`}>{roleLabel}</h1>
              </div>
              <div className="flex flex-wrap items-center gap-[var(--s3)]">
                <span className={familyGround ? CHIP : CHIP_INK}>{routeLabel}</span>
                <Link href="/operations" className={familyGround ? LINK : LINK_INK}>
                  Operations
                </Link>
                <Link href="/dashboard" className={familyGround ? LINK : LINK_INK}>
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