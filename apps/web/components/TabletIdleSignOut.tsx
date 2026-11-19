'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { apiBase } from '@/lib/apiBase';
import { isGymTabletMarked, subscribeGymTabletMark } from '@/src/lib/gymTabletMark';
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
 * Jason's ruling OW25-53 A: the gym admin sets the idle time (first value 1
 * hour). Overwatch Q1 = A: only a device the gym admin has MARKED as a gym
 * tablet signs itself out; personal phones and computers are not.
 *
 * Mounted by GlobalRoleHeader on every signed-in page (refusal screens
 * included). On a marked device:
 *  - Use = a pointer press, a touch, a key or a wheel turn. Time is measured
 *    from timestamps, not from a running timer, so a tablet that slept is
 *    judged by how long it was really left.
 *  - In the last minute a banner counts down. Any use hides it and starts
 *    the time again.
 *  - At the limit the page is covered at once and the session is ended. The
 *    tablet leaves for /login only once the server confirms; the cookie is
 *    HttpOnly, so a request that did not land would leave the next person
 *    one tap from the last one's account. Until then the cover stays and it
 *    retries every 15 seconds and when the connection comes back.
 *  - Woken after the limit has passed: covered and signed out at once, with
 *    no countdown, so the next person never sees the last screen.
 *  - The time comes from GET /api/pilot/gym-tablet/idle. If that read fails
 *    (a session that still owes a PIN change is refused by it), the default
 *    applies: one hour, never "no sign-out" (AS2-a review carry-over).
 *  - Unsaved typing on the screen is lost; the banner says so.
 *
 * On EVERY device, marked or not: a page restored from the browser's
 * back/forward cache re-asks the server who is signed in, and leaves for
 * /login if nobody is. Before this, Back after a sign-out could show the last
 * person's page from the cache.
 */

const ACTIVITY_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'wheel'] as const;
const RETRY_MS = 15_000;
const TICK_MS = 1_000;

type Phase = 'watching' | 'countdown' | 'signing-out' | 'offline';

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
  const [phase, setPhase] = useState<Phase>('watching');
  const [secondsLeft, setSecondsLeft] = useState(TABLET_IDLE_COUNTDOWN_SECONDS);
  const phaseRef = useRef<Phase>('watching');
  const limitMs = useRef(DEFAULT_TABLET_IDLE_MINUTES * 60_000);
  // Set when the watch starts (the first effect below), not during render.
  const lastUse = useRef(0);
  const inFlight = useRef(false);

  const moveTo = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const attemptSignOut = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const done = await endThisSession();
    inFlight.current = false;
    if (done) {
      clearRoleSession();
      leaveForLogin();
      return;
    }
    moveTo('offline');
  }, [moveTo]);

  const check = useCallback(() => {
    const current = phaseRef.current;
    if (current === 'signing-out' || current === 'offline' || lastUse.current === 0) return;
    const idle = Date.now() - lastUse.current;
    if (idle >= limitMs.current) {
      moveTo('signing-out');
      void attemptSignOut();
      return;
    }
    const left = limitMs.current - idle;
    if (left <= TABLET_IDLE_COUNTDOWN_SECONDS * 1000) {
      setSecondsLeft(Math.ceil(left / 1000));
      if (current !== 'countdown') moveTo('countdown');
    } else if (current === 'countdown') {
      moveTo('watching');
    }
  }, [attemptSignOut, moveTo]);

  // The watch starts now: the time a page opens counts as use.
  useEffect(() => {
    lastUse.current = Date.now();
  }, []);

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

  // Use, the tick, and the moments a sleeping tablet comes back.
  useEffect(() => {
    const onUse = () => {
      const current = phaseRef.current;
      if (current === 'signing-out' || current === 'offline') return;
      lastUse.current = Date.now();
      if (current === 'countdown') moveTo('watching');
    };
    const onWake = () => {
      if (document.visibilityState !== 'hidden') check();
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onUse, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('pageshow', onWake);
    const tick = window.setInterval(check, TICK_MS);
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onUse, { capture: true });
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('pageshow', onWake);
      window.clearInterval(tick);
    };
  }, [check, moveTo]);

  // No connection: keep the cover, keep trying.
  useEffect(() => {
    if (phase !== 'offline') return undefined;
    const retry = () => void attemptSignOut();
    const timer = window.setInterval(retry, RETRY_MS);
    window.addEventListener('online', retry);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', retry);
    };
  }, [phase, attemptSignOut]);

  const stay = () => {
    lastUse.current = Date.now();
    moveTo('watching');
  };

  return (
    <>
      {showPlate ? (
        <span className="inline-flex min-h-[var(--s6)] items-center rounded-[var(--r-sm)] border border-[color:var(--brass-700)] bg-[rgba(0,0,0,.4)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--brass-200)]">
          Gym tablet
        </span>
      ) : null}
      {phase === 'countdown'
        ? createPortal(
          <div
            data-surface="kiosk"
            role="alert"
            className="mat-leather--raised fixed inset-x-0 bottom-0 z-[1000] border-t-2 border-[color:var(--brass-500)] p-[var(--s5)]"
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
      {phase === 'signing-out' || phase === 'offline'
        ? createPortal(
          <div
            role="alert"
            className="fixed inset-0 z-[1001] flex items-center justify-center bg-[var(--hide-950)] p-[var(--s6)] text-center"
          >
            <p className="t-body max-w-[48ch] text-[length:var(--t-md)] text-[color:var(--bone-100)]">
              {phase === 'signing-out'
                ? 'Signing out…'
                : 'This tablet could not finish signing out: no connection. It keeps trying.'}
            </p>
          </div>,
          document.body,
        )
        : null}
    </>
  );
}
