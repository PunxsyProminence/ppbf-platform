'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { apiBase } from '@/lib/apiBase';
import {
  isGymTabletMarked,
  markSessionBoundary,
  readGymTabletLastUse,
  readGymTabletSignedOutAt,
  subscribeGymTabletMark,
  writeGymTabletLastUse,
} from '@/src/lib/gymTabletMark';
import { endThisSession, leaveForLogin } from '@/src/lib/signOut';
import {
  DEFAULT_TABLET_IDLE_MINUTES,
  isTabletIdleMinutes,
  TABLET_IDLE_COUNTDOWN_SECONDS,
} from '@/src/shared/tabletIdle';

import { clearRoleSession } from './roleSession';

/**
 * GYM TABLET IDLE SIGN-OUT (lane U1, AS2-b; app scrub ATH-10 / stage 3 AS-2).
 *
 * Jason's ruling OW25-53 A (OD-2026-11-19-007): the gym admin sets the idle
 * time (first value 1 hour). Overwatch Q1 = A: only a device the gym admin
 * has MARKED as a gym tablet signs itself out; personal phones and computers
 * are not.
 *
 * Mounted by GlobalRoleHeader on every signed-in page (refusal screens
 * included), and on /change-pin, whose session is never cached. On a marked
 * device:
 *  - Use = a pointer press, a touch, a key or a wheel turn. The clock is the
 *    DEVICE's: the last use is kept in this browser's storage and shared by
 *    its tabs, so a page the browser reloads on waking resumes it instead of
 *    starting again (review A, BLOCKER), and a hidden tab does not sign out
 *    someone working in another. A time in the future (a clock set back)
 *    counts as now.
 *  - In the last minute a banner counts down. Any use hides it and starts
 *    the time again.
 *  - At the limit, sign-out starts and NOTHING ON THE PAGE CAN STOP IT: a
 *    plain cover (not React's) goes over everything, the page under it is
 *    made inert and loses focus, and the session is ended. Only once the
 *    server confirms does the device leave for /login, as a full load. If
 *    the logout does not land (no connection, a server error) the cover says
 *    it could not finish, and it retries every 15 seconds and when the
 *    connection returns. This runs outside React on purpose (review A):
 *    another component clearing the role cache, or a soft move to /login,
 *    would otherwise unmount the cover and the retry while the session lives.
 *  - Opened or woken past the limit: sign-out starts at once, no countdown.
 *    The page can show for the moment before the first check.
 *  - The time comes from GET /api/pilot/gym-tablet/idle. If that read fails
 *    (a session that still owes a PIN change is refused by it), the default
 *    applies: one hour, never "no sign-out" (AS2-a review carry-over).
 *  - Unsaved typing on the screen is lost; the banner says so.
 *  - The clock is cleared on a confirmed sign-out here, on a fresh sign-in,
 *    and when the server says nobody is signed in; never by a mere cache
 *    clear, which can happen while the session is still alive (review A).
 *
 * On EVERY device, marked or not: a page restored from the browser's
 * back/forward cache re-asks the server who is signed in, and leaves for
 * /login if nobody is. Before this, Back after a sign-out could show the last
 * person's page from the cache.
 */

const ACTIVITY_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'wheel'] as const;
const RETRY_MS = 15_000;
const TICK_MS = 1_000;
/* How long the banner stays up after a finger leaves it, so the click the
   browser makes from that lift lands on the banner (iPad Safari makes it at
   the lift point) and not on a button the banner was covering. */
const BANNER_RELEASE_MS = 500;
/* A hold whose lift never arrives (a lost pointerup) is let go after this,
   so a stale countdown cannot stay up over the page. */
const BANNER_HOLD_MAX_MS = 10_000;
const COVER_ID = 'gym-tablet-leaving';
const SIGNING_OUT_WORDS = 'Signing out…';
const OFFLINE_WORDS = 'This tablet could not finish signing out. It keeps trying.';

let lateNodes: MutationObserver | null = null;

/** A plain cover over the whole page; it stays until the document is replaced. */
function pinCover(text: string): HTMLElement {
  let cover = document.getElementById(COVER_ID);
  if (!cover) {
    cover = document.createElement('div');
    cover.id = COVER_ID;
    cover.setAttribute('role', 'alert');
    cover.style.cssText = 'position:fixed;inset:0;z-index:1002;display:flex;align-items:center;justify-content:center;'
      + 'background:var(--hide-950,#0b0906);color:var(--bone-100,#f7f1e1);font-size:var(--t-md,19px);padding:24px;text-align:center;';
    document.body.appendChild(cover);
  }
  for (const child of Array.from(document.body.children)) {
    if (child !== cover) child.setAttribute('inert', '');
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  // A dialog or toast the page adds to <body> afterwards is made inert too.
  if (!lateNodes && typeof MutationObserver !== 'undefined') {
    lateNodes = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element && node.id !== COVER_ID) node.setAttribute('inert', '');
        }
      }
    });
    lateNodes.observe(document.body, { childList: true });
  }
  cover.textContent = text;
  return cover;
}

/*
 * THE SIGN-OUT, ONCE STARTED, BELONGS TO THE DOCUMENT, NOT TO A COMPONENT.
 * One per page load; a second start is ignored.
 */
let leaving = false;
/** When this document's first watcher started: a soft navigation does not move it. */
let documentWatchedSince: number | null = null;

export function startTabletSignOut(): void {
  if (leaving || typeof window === 'undefined') return;
  leaving = true;
  const cover = pinCover(SIGNING_OUT_WORDS);
  let inFlight = false;
  let retry: number | undefined;
  const attempt = async () => {
    if (inFlight) return;
    inFlight = true;
    const done = await endThisSession();
    inFlight = false;
    if (done) {
      window.clearTimeout(retry);
      window.removeEventListener('online', onOnline);
      // A session boundary: a fresh clock, and the device's older tabs leave.
      markSessionBoundary();
      clearRoleSession();
      leaveForLogin();
      return;
    }
    cover.textContent = OFFLINE_WORDS;
    pinCover(OFFLINE_WORDS); // whatever the page drew since is made inert too
    window.clearTimeout(retry);
    retry = window.setTimeout(() => void attempt(), RETRY_MS);
  };
  const onOnline = () => void attempt();
  window.addEventListener('online', onOnline);
  void attempt();
}

/** This tab shows a person since signed out on this device: cover it and reload /login, ending nothing. */
function leaveStaleTab(): void {
  if (leaving) return;
  leaving = true;
  pinCover(SIGNING_OUT_WORDS);
  leaveForLogin();
}

/** Tests only: a fresh page load. */
export function resetTabletSignOutForTests(): void {
  leaving = false;
  documentWatchedSince = null;
  lateNodes?.disconnect();
  lateNodes = null;
  document.getElementById(COVER_ID)?.remove();
  for (const child of Array.from(document.body.children)) child.removeAttribute('inert');
}

function countdownWords(seconds: number): string {
  const whole = Math.max(0, seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export default function TabletIdleSignOut({ showPlate = true }: { readonly showPlate?: boolean }) {
  const marked = useSyncExternalStore(subscribeGymTabletMark, isGymTabletMarked, () => false);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void (async () => {
        try {
          const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
          });
          const body = (await response.json().catch(() => null)) as { authenticated?: unknown } | null;
          if (response.ok && body?.authenticated === false) {
            pinCover(SIGNING_OUT_WORDS);
            clearRoleSession();
            leaveForLogin();
          }
        } catch {
          // No answer is not "signed out": RoleSessionGate still guards the page.
        }
      })();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  return marked ? <MarkedTabletWatch showPlate={showPlate} /> : null;
}

function MarkedTabletWatch({ showPlate }: { readonly showPlate: boolean }) {
  const [counting, setCounting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(TABLET_IDLE_COUNTDOWN_SECONDS);
  const countingRef = useRef(false);
  const limitMs = useRef(DEFAULT_TABLET_IDLE_MINUTES * 60_000);
  // Set when the watch starts (the first effect below), not during render.
  const lastUse = useRef(0);
  const lastWritten = useRef(0);
  /* A finger is down on the banner (lane U1, AS2-d review B). The press
     restarts the time, so the next tick would hide the banner under the
     finger, and the lift would press whatever it covered. While held, the
     tick leaves it up; it is released a moment after the lift. */
  const bannerHeld = useRef(false);
  const bannerHeldSince = useRef(0);
  const bannerRelease = useRef<number | undefined>(undefined);

  const showCountdown = useCallback((next: boolean) => {
    countingRef.current = next;
    setCounting(next);
  }, []);

  const check = useCallback(() => {
    if (leaving || lastUse.current === 0) return;
    const now = Date.now();
    // A sign-out confirmed on this device after this page opened (in another
    // tab): this page shows that person. It leaves, ending nothing.
    const signedOutAt = readGymTabletSignedOutAt();
    if (signedOutAt !== null && documentWatchedSince !== null && signedOutAt >= documentWatchedSince) {
      showCountdown(false);
      leaveStaleTab();
      return;
    }
    // Another tab's use counts: the clock is the device's, not this tab's.
    // A stored time in the future (a clock set back) is written back as now,
    // once: left in place it would keep pulling the clock forward every tick.
    let stored = readGymTabletLastUse();
    if (stored !== null && stored > now) {
      writeGymTabletLastUse(now);
      stored = now;
    }
    if (stored !== null && stored > lastUse.current) lastUse.current = stored;
    if (lastUse.current > now) lastUse.current = now;
    const idle = now - lastUse.current;
    if (idle >= limitMs.current) {
      showCountdown(false);
      startTabletSignOut();
      return;
    }
    const left = limitMs.current - idle;
    if (left <= TABLET_IDLE_COUNTDOWN_SECONDS * 1000) {
      setSecondsLeft(Math.ceil(left / 1000));
      if (!countingRef.current) showCountdown(true);
    } else if (countingRef.current) {
      // A clock set back while held (now before the press) lets go as well.
      const heldFor = now - bannerHeldSince.current;
      if (bannerHeld.current && (heldFor >= BANNER_HOLD_MAX_MS || heldFor < 0)) bannerHeld.current = false;
      if (!bannerHeld.current) showCountdown(false);
    }
  }, [showCountdown]);

  // Resume the device's clock, or start it when there is none (a fresh
  // sign-in cleared it), then check at once: a page opened past the limit
  // signs out without a countdown.
  useEffect(() => {
    const now = Date.now();
    documentWatchedSince ??= now;
    const stored = readGymTabletLastUse();
    lastUse.current = stored === null ? now : Math.min(stored, now);
    if (stored === null || stored > now) writeGymTabletLastUse(lastUse.current);
    // Checked on the next turn, not inside the effect's own render pass.
    const first = window.setTimeout(check, 0);
    return () => window.clearTimeout(first);
  }, [check]);

  // The gym's time. A failed read keeps the default; it never turns the
  // sign-out off.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/gym-tablet/idle`, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) return;
        const body = (await response.json()) as { idle_minutes?: unknown };
        if (!cancelled && isTabletIdleMinutes(body.idle_minutes)) {
          limitMs.current = body.idle_minutes * 60_000;
          check();
        }
      } catch {
        // The default stands.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [check]);

  const bannerRef = useRef<HTMLDivElement | null>(null);

  const markUse = useCallback((event?: Event) => {
    if (leaving) return;
    lastUse.current = Date.now();
    // At most one write every two seconds: a finger on a scrolling list is
    // many events.
    if (lastUse.current - lastWritten.current >= 2_000) {
      lastWritten.current = lastUse.current;
      writeGymTabletLastUse(lastUse.current);
    }
    // A press ON the banner keeps it up until its own click: hidden at the
    // press, the tap would land on whatever is under it (review B). The next
    // tick hides it anyway, since the time has started again.
    const onBanner = event?.target instanceof Node && bannerRef.current?.contains(event.target);
    if (onBanner && event?.type === 'pointerdown') {
      // A second press before the last lift's release: that release must not
      // drop the hold under this finger.
      window.clearTimeout(bannerRelease.current);
      bannerHeld.current = true;
      bannerHeldSince.current = lastUse.current;
    } else if (!onBanner) {
      bannerHeld.current = false;
    }
    if (countingRef.current && !onBanner && !bannerHeld.current) showCountdown(false);
  }, [showCountdown]);

  // The finger leaves the banner: keep it up a moment longer, for the click.
  useEffect(() => {
    const onLift = () => {
      if (!bannerHeld.current) return;
      window.clearTimeout(bannerRelease.current);
      bannerRelease.current = window.setTimeout(() => {
        bannerHeld.current = false;
      }, BANNER_RELEASE_MS);
    };
    window.addEventListener('pointerup', onLift, { capture: true, passive: true });
    window.addEventListener('pointercancel', onLift, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerup', onLift, { capture: true });
      window.removeEventListener('pointercancel', onLift, { capture: true });
      window.clearTimeout(bannerRelease.current);
    };
  }, []);

  // Use, the tick, and the moments a sleeping tablet comes back.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== 'hidden') check();
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, markUse, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('pageshow', onWake);
    const tick = window.setInterval(check, TICK_MS);
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, markUse, { capture: true });
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('pageshow', onWake);
      window.clearInterval(tick);
    };
  }, [check, markUse]);

  const stay = () => {
    bannerHeld.current = false;
    lastWritten.current = 0;
    markUse();
    showCountdown(false);
  };

  return (
    <>
      {showPlate ? (
        <span className="inline-flex min-h-[var(--s6)] items-center rounded-[var(--r-sm)] border border-[color:var(--brass-700)] bg-[rgba(0,0,0,.4)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--brass-200)]">
          Gym tablet
        </span>
      ) : null}
      {counting
        ? createPortal(
          /* PINNED INLINE, AS THE COVER IS (lane U1, AS2-d). A direct child of
             <body> meets app/globals.css's unlayered `body > * { position:
             relative; z-index: 2 }`, which beats Tailwind's layered `fixed`
             and `z-[1000]` whatever their specificity. With classes alone the
             banner was laid out at the end of the document, so on a long page
             it could sit below the screen, out of sight, until the sign-out.
             An inline style outranks both. */
          <div
            ref={bannerRef}
            data-surface="kiosk"
            role="alert"
            style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1000 }}
            className="mat-leather--raised border-t-2 border-[color:var(--brass-500)] p-[var(--s5)]"
          >
            <div className="mx-auto flex max-w-[1000px] flex-wrap items-center justify-between gap-[var(--s4)]">
              <p className="t-body text-[length:var(--t-md)] text-[color:var(--bone-100)]">
                No one has used this tablet for a while. Signing out in {countdownWords(secondsLeft)}. Tap anywhere to
                stay signed in. Anything not saved on this screen will be lost.
              </p>
              <button type="button" className="btn" onClick={stay}>
                Stay signed in
              </button>
            </div>
          </div>,
          document.body,
        )
        : null}
    </>
  );
}
