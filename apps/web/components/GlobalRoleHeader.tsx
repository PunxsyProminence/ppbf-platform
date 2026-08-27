"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import {
  clearRoleSession,
  getRoleSessionSnapshot,
  loadAuthoritativeRoleSession,
  persistAuthoritativeRoleSession,
  subscribeRoleSession,
} from "./roleSession";
import { apiBase } from '@/lib/apiBase';
import { isRefusalSurface } from "./buildingMap";
import { canUseOperationsHub } from "./operationsAccess";
import FeedbackBox from "./FeedbackBox";
import Corridor from "./Corridor";
import CardCatalog from "./CardCatalog";
import CommandsOverlay from "./CommandsOverlay";
import SoundToggle from "./SoundToggle";
import { CONTROL_EXIT, CONTROL_QUIET } from "./sessionBarControls";

// The queue the "Tell Us" box fills is worked by the people who can act on it:
// a gym's own administrators, and the platform owner reading across gyms.
const FEEDBACK_TRIAGE_ROLES = ["admin", "platform_owner"];

/* The session bar is chassis, so it is built from chassis materials: a leather
   ground under a brass rule, framing the warm paper the pages sit on. Every
   value below comes off the design system's scales -- type from the root-phi
   ladder, space from Fibonacci -- rather than being picked by eye.

   Two things here are corrections, not restyling:

   - Targets were px-3 py-1, about 26px tall. That is under the 44px WCAG floor
     on a bar that ships on every route including phones. They are now --tap.
   - The role badge was --safety-locked, which aliases to --locked: the safety
     gate's "this athlete may not participate" red. Law 2 reserves saturated
     colour for safety state, and a job title is not one. Role is identity, so
     it wears patina brass and the red goes back to meaning only what it should.

   Note the text-[length:...] / text-[color:...] hints below. Tailwind v4 cannot
   tell whether text-[var(--x)] is a font size or a colour, so it silently emits
   nothing for either -- the class lands in the DOM and no rule backs it. The
   hints are what make these resolve. */
const SHELL =
  "mat-leather sticky top-0 z-50 border-b-2 border-[var(--brass-700)] shadow-[0_3px_10px_rgba(0,0,0,.45)]";
const BAR =
  "mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-[var(--s4)] px-[var(--s5)] py-[var(--s3)]";
const EYEBROW =
  "font-mono text-[length:var(--t-xs)] uppercase tracking-[0.32em] text-[color:var(--bone-400)]";

/* Control geometry now lives in sessionBarControls.ts, because FeedbackBox and
   SoundToggle render on this same bar and could not reach these constants from
   here. Both fell back to `.btn` and both had their corrections silently
   outranked by it -- see that file for the measurements. */

export default function GlobalRoleHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const isWallRoute = pathname === "/wall" || pathname?.startsWith("/wall/");

  /* This bar is the one component mounted on every route (see app/layout.tsx),
     so it is the only place guaranteed to run regardless of which page-level
     gate -- RoleSessionGate, /login's own effect, neither -- happens to be
     present. Before this effect existed, the Logout button and role badge
     depended entirely on some OTHER component having already populated the
     shared in-memory cache: on any page without that gate (or before its
     fetch resolved), this bar rendered the pre-auth look even though the
     HttpOnly server session was still perfectly valid. A user who landed
     there had no visible way to sign out short of knowing to revisit /login.

     This self-heals that gap by asking the server directly whenever the
     cache is empty, rather than waiting on someone else's side effect. It
     never redirects on failure -- an unauthenticated visitor to a public
     page is not an error, and redirect-on-401 stays RoleSessionGate's job so
     this bar does not fight it over the URL. */
  useEffect(() => {
    if (session || isWallRoute || pathname === "/login") {
      return;
    }

    const controller = new AbortController();

    void (async () => {
      try {
        // POST: /api/pilot/auth/session only implements POST (no GET export
        // in its route.ts). RoleSessionGate briefly called this with 'GET'
        // and 405'd on every check -- see the fix there for the incident.
        const resolution = await loadAuthoritativeRoleSession(
          `${apiBase()}/api/pilot/auth/session`,
          { signal: controller.signal },
        );

        if (controller.signal.aborted) {
          return;
        }

        if (resolution.ok) {
          persistAuthoritativeRoleSession(resolution.session);
        }
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        // Best-effort refresh only. A failed check here leaves the pre-auth
        // bar showing, which is correct for a genuinely signed-out visitor;
        // it is RoleSessionGate's job, not this bar's, to act on a refusal.
      }
    })();

    return () => controller.abort();
  }, [session, isWallRoute, pathname]);

  /* The wall display stands alone. /wall is a television bolted to the gym
     floor: no pointer, no keyboard, nobody signed in, and nobody within fifteen
     feet of it. A sticky session bar there is a strip of furniture that can
     never be used, and on a screen that runs twelve hours a day it is also a
     fixed high-contrast band in the same pixels all evening -- the exact shape
     that burns into a panel.

     This is placed AFTER every hook above deliberately: an early return before
     useSyncExternalStore would make the hook order depend on the route. */
  if (isWallRoute) {
    return null;
  }

  /* A REFUSAL IS A WHOLE SCREEN, AND THIS BAR IS PART OF IT.
     P0.2 (docs/shadow-ui/PRODUCTION-FAST-TRACK.md) says the SHADOW deny screen
     is "Title + body + Dashboard + Logout only -- no library, no mode badge, no
     chat, no Master Mode". The page had that exactly right and this bar
     overruled it from above: the full signed-in chassis rendered over every
     refusal, including the Corridor, which opens a `room--board` panel naming
     every board door a board member holds. ROOM-PURPOSE-DNA.md forbids that in
     as many words -- "Forbidden: Board chrome on deny". Beside it the bar put a
     second Dashboard (labelled Bell) and a second Logout next to the pair the
     refusal already offers, plus the catalog, the sound switch, Tell Us and
     Operations, on a screen whose whole content is meant to be a refusal.

     So a refusal gets the same bar a signed-out visitor gets: the mark, and
     nothing to press. That is the branch immediately below rather than a second
     minimal header, because two ways to draw "no controls here" is how one of
     them drifts. Which surfaces refuse in place is buildingMap.ts's answer, not
     this component's -- see `refusesInPlace` there. It decides chrome only; the
     page's own guard is still the thing that refuses. */
  const refusedHere = isRefusalSurface(session?.role ?? null, pathname);

  // Minimal bar pre-auth, on login, and on a screen refusing this session.
  if (!session || pathname === "/login" || refusedHere) {
    return (
      <header className={SHELL}>
        <div className={BAR}>
          <span className={EYEBROW}>PPBF</span>
        </div>
      </header>
    );
  }

  function signOut() {
    // credentials matters here: cross-origin (SWA static + Container App API)
    // a fetch without it does not carry the session cookie, so the server had
    // nothing to revoke and "logout" silently left the session alive.
    void fetch(`${apiBase()}/api/pilot/auth/logout`, { method: 'POST', credentials: 'include' });
    clearRoleSession();
    router.replace("/login");
  }

  return (
    <header className={SHELL}>
      <div className={BAR}>
        <div className="flex items-center gap-[var(--s4)]">
          <span className={EYEBROW}>Session active</span>
          {/* An engraved plate, not a painted one. This badge was
              .mat-brass--patina with ink type, which reads fine in a mockup and
              fails in pixels: patina is a mottled material, and its gradient
              runs from rgb(72,68,32) to rgb(181,170,110). Sampling the rendered
              badge put the ink label at 1.91:1 over the dark stops and 8.06:1
              over the light ones -- legibility that depends on where in the
              gradient a given role name happens to land.

              A material with a range cannot carry small text. This is
              ppbf.css's .plaque treatment instead: a recessed dark plate,
              brass-700 rim, brass-200 legend. Flat ground, one contrast value,
              and it is still unmistakably brass. Written out rather than using
              .plaque itself because that class pins 13px through the `font:`
              shorthand, which would beat the ladder size every other control on
              this bar uses. */}
          <span className="inline-flex min-h-[var(--s6)] items-center rounded-[var(--r-sm)] border border-[color:var(--brass-700)] bg-[rgba(0,0,0,.4)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--brass-200)] shadow-[inset_0_1px_0_rgb(var(--brass-300-rgb)_/_.16)]">
            {session.role}
          </span>
          {/* The corridor: the other 61 routes used to be reachable only by
              typing a URL. It lives in the header so every surface gets it.
              Keyed on the pathname so walking through a door leaves it shut --
              a remount rather than a setState-in-effect, which would cascade a
              render on every navigation. */}
          <Corridor key={`corridor:${pathname}`} />
        </div>

        <div className="flex flex-wrap items-center gap-[var(--s3)]">
          {/* Keyed for the same reason as the corridor: a fresh, closed palette
              on every surface, with no effect writing state on navigation. */}
          <CardCatalog key={`catalog:${pathname}`} />
          <CommandsOverlay />
          {/* Sound is opt-in and off by default, and turning it on has to
              happen inside a click because no browser starts audio otherwise.
              The bar is where it belongs: on every signed-in surface, so
              anyone who wants it can find it, and saying one short thing
              rather than advertising itself. Nothing in this app needs sound
              to be understood — see useGymSound.ts. */}
          <SoundToggle />
          <FeedbackBox />
          {FEEDBACK_TRIAGE_ROLES.includes(session.role) ? (
            <Link href="/admin/feedback" className={CONTROL_QUIET}>
              Triage
            </Link>
          ) : null}
          {/* Administration, not a cross-role launcher (owner decision,
              2026-08-26). This link sat on every signed-in surface for every
              role, one tab stop from Logout, and led to a page that now
              bounces fourteen of the sixteen roles straight back to their own
              dashboard -- a control whose only outcome is a silent redirect.
              The same predicate the page's own gate uses, so the two cannot
              disagree about who this is for. */}
          {canUseOperationsHub(session.role) ? (
            <Link href="/operations" className={CONTROL_QUIET}>
              Operations
            </Link>
          ) : null}
          <Link href="/dashboard" className={CONTROL_QUIET}>
            Bell
          </Link>
          <button type="button" onClick={signOut} className={CONTROL_EXIT}>
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
