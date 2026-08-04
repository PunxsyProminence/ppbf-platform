"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { clearRoleSession, getRoleSessionSnapshot, subscribeRoleSession } from "./roleSession";
import { apiBase } from '@/lib/apiBase';
import FeedbackBox from "./FeedbackBox";
import Corridor from "./Corridor";
import CardCatalog from "./CardCatalog";
import CommandsOverlay from "./CommandsOverlay";
import SoundToggle from "./SoundToggle";

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

/* Shared geometry for every control on the bar: --tap tall, on the type scale,
   and a focus ring that is visible against leather. */
const CONTROL =
  "inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-sm)] border px-[var(--s4)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] transition " +
  "focus-visible:outline-none focus-visible:shadow-[var(--focus)]";
const CONTROL_QUIET = `${CONTROL} border-[color:rgba(212,175,74,.32)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-200)] hover:border-[color:var(--brass-400)] hover:text-[color:var(--bone-100)]`;
const CONTROL_EXIT = `${CONTROL} border-[color:var(--rust-500)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-300)] hover:border-[color:var(--locked)] hover:text-[color:var(--bone-100)]`;

export default function GlobalRoleHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);

  /* The wall display stands alone. /wall is a television bolted to the gym
     floor: no pointer, no keyboard, nobody signed in, and nobody within fifteen
     feet of it. A sticky session bar there is a strip of furniture that can
     never be used, and on a screen that runs twelve hours a day it is also a
     fixed high-contrast band in the same pixels all evening -- the exact shape
     that burns into a panel.

     This is placed AFTER every hook above deliberately: an early return before
     useSyncExternalStore would make the hook order depend on the route. */
  if (pathname === "/wall" || pathname?.startsWith("/wall/")) {
    return null;
  }

  // Minimal bar pre-auth and on login
  if (!session || pathname === "/login") {
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
          <span className="inline-flex min-h-[var(--s6)] items-center rounded-[var(--r-sm)] border border-[color:var(--brass-700)] bg-[rgba(0,0,0,.4)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--brass-200)] shadow-[inset_0_1px_0_rgba(232,206,122,.16)]">
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
          <Link href="/operations" className={CONTROL_QUIET}>
            Operations
          </Link>
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
