"use client";

import Link from 'next/link';
import type { ReactNode } from 'react';
import RoleSessionGate from './RoleSessionGate';
import ShadowChatButton from './ShadowChatButton';
import type { ClubRole } from './roleRoutes';
import { isFamilyGround } from './roleGround';

/* One rung of the trail. `href` is optional because a trail routinely passes
   through a grouping that is not itself a page -- "Coach / Review / Video" has
   no /coach/review route -- and inventing a dead link for it is worse than
   printing it as text. The last rung never links whatever it carries: you are
   already there, and a link to the current page is a control that does
   nothing. */
export interface RoleBreadcrumb {
  readonly label: string;
  readonly href?: string;
}

interface RoleStandaloneViewProps {
  readonly roleLabel: string;
  readonly routeLabel: string;
  readonly allowedRoles: ClubRole[];
  readonly children: ReactNode;
  readonly showShellHeader?: boolean;
  readonly room?: 'office' | 'floor' | 'board' | 'file' | 'clinic' | 'night';
  /* Optional, and it has to stay that way: this shell wraps every role route in
     the app, so a required prop would be a 68-file edit before anything could
     ship. A page that passes nothing renders exactly what it rendered
     before. */
  readonly breadcrumbs?: ReadonlyArray<RoleBreadcrumb>;
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

/* --- The trail ------------------------------------------------------------

   The band already told you WHO you are (roleLabel) and WHERE you are
   (routeLabel, in a chip). It never told you how you got there or how to get
   back. A coach sent from /coach/review-queue into /coach/video-analysis
   arrives on a page whose only route out is the browser's Back button and the
   two global links -- Operations and Bell -- neither of which is the queue
   they came from. Nested routes are the majority of this shell's 68 pages, so
   that is most of the app with no visible parent.

   Voice is mono, not stencil: Law 4 gives mono to the record, and a route path
   IS a record -- it is the same voice the routeLabel chip is already set in,
   one rung quieter than the title above it.

   The rungs are at --tap like every other link in this band. That reads as
   generous for a breadcrumb and it is deliberate: the comment at the top of
   this file is about exactly this correction, and a trail whose rungs are
   26px tall is the same defect the LINK constants were written to end. The
   trail is one row, so the whole strip costs one --tap of height, not one per
   rung. */

/* TRAIL is the one constant here without an _INK twin, and the omission is the
   point rather than an oversight: it carries no colour and no material, only
   the row geometry, which is identical on leather and on paper. A duplicate
   constant with nothing different in it is a place for the two grounds to
   drift apart silently. Everything below it that DOES touch colour is
   paired. */
const TRAIL = "flex flex-wrap items-center gap-[var(--s2)]";

const CRUMB_LINK =
  "inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-sm)] px-[var(--s2)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--brass-800)] transition " +
  "hover:text-[color:var(--hide-950)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--focus)]";
const CRUMB_CURRENT =
  "inline-flex min-h-[var(--tap)] items-center px-[var(--s2)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--hide-800)]";
/* Brass, per the separator brief, and the rung is chosen by ground rather than
   by taste: the paper band puts brass-700 at 4.96:1, which a 11.8px glyph
   needs, while brass-400 on that same paper is 1.66:1 and would vanish. */
const CRUMB_SEP =
  "select-none font-mono text-[length:var(--t-xs)] text-[color:var(--brass-700)]";

/* The ink counterparts. Same three moves as LINK_INK above: the link end of the
   brass ramp instead of the dark end (brass-300 is 10.4:1 on leather, brass-800
   is 2.45:1 and unreadable), bone instead of hide for the current page, and the
   separator up at brass-400 -- the rung EYEBROW_INK already uses on this
   material. */
const CRUMB_LINK_INK =
  "inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-sm)] px-[var(--s2)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--brass-300)] transition " +
  "hover:text-[color:var(--bone-100)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--focus)]";
const CRUMB_CURRENT_INK =
  "inline-flex min-h-[var(--tap)] items-center px-[var(--s2)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--bone-300)]";
const CRUMB_SEP_INK =
  "select-none font-mono text-[length:var(--t-xs)] text-[color:var(--brass-400)]";

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
  room,
  breadcrumbs,
}: RoleStandaloneViewProps) {
  const familyGround = isFamilyGround(allowedRoles);
  const trail = breadcrumbs ?? [];

  return (
    <RoleSessionGate allowedRoles={allowedRoles}>
      <main
        /* Golden-era pass: the family branch now stands on the design
           system's own .on-canvas ground. The condition the old comment set —
           "getting there means converting that content first" — is met:
           ParentHub and the guardian portal are built from paper-on-canvas
           materials and rely on the .on-canvas restatements. Athlete routes
           left the family branch entirely (see roleGround.ts): they are the
           floor kiosk, ink by PAGE_MAP, so they now take rooms like any staff
           surface. */
        /* A room supplies the wall, the light and the floor shadow. It is only
           applied on the ink branch, and that restriction is load-bearing:
           .room--* sets a background-image as well as a colour, and this sheet
           is unlayered while Tailwind's utilities sit in a layer, so a room
           would beat the canvas ground and put a dark plank wall behind
           canvas-coloured text. Rooms stay ink-only. */
        className={[
          familyGround ? '' : (room ? `room--${room}` : ''),
          familyGround
            ? 'on-canvas min-h-screen'
            : 'min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]',
        ].filter(Boolean).join(' ')}
      >
        {showShellHeader && (
          <header className={familyGround ? BAND : BAND_INK}>
            <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-[var(--s4)]">
              <div>
                <p className={familyGround ? EYEBROW : EYEBROW_INK}>Role workspace</p>
                <h1 className={`${familyGround ? TITLE : TITLE_INK} mt-[var(--s2)]`}>{roleLabel}</h1>
                {/* An <ol> because the order is the meaning -- a breadcrumb
                    trail read out of sequence is not a path -- and a labelled
                    <nav> so a screen reader can skip it or jump to it as the
                    landmark it is. The separator is aria-hidden: it is a
                    drawn rule between rungs, and read aloud it turns
                    "Coach, Review queue, Video" into "Coach slash Review
                    queue slash Video". */}
                {trail.length > 0 && (
                  <nav aria-label="Breadcrumb" className="mt-[var(--s3)]">
                    <ol className={TRAIL}>
                      {trail.map((crumb, index) => {
                        const isCurrent = index === trail.length - 1;
                        return (
                          <li key={`${index}-${crumb.label}`} className="flex items-center gap-x-[var(--s2)]">
                            {index > 0 && (
                              <span aria-hidden="true" className={familyGround ? CRUMB_SEP : CRUMB_SEP_INK}>
                                /
                              </span>
                            )}
                            {isCurrent || !crumb.href ? (
                              <span
                                aria-current={isCurrent ? 'page' : undefined}
                                className={familyGround ? CRUMB_CURRENT : CRUMB_CURRENT_INK}
                              >
                                {crumb.label}
                              </span>
                            ) : (
                              <Link href={crumb.href} className={familyGround ? CRUMB_LINK : CRUMB_LINK_INK}>
                                {crumb.label}
                              </Link>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </nav>
                )}
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