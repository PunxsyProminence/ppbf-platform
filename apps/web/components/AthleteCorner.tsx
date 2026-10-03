'use client';

import Link from 'next/link';
import React from 'react';

/**
 * MY CORNER: THE ATHLETE'S DAY, AT THE TOP OF THE SCREEN.
 *
 * This is the "Today" section of My Dashboard, moved to the top of the
 * workspace and set in the canvas-and-leather look Jason chose from his Canva
 * references ("Look into canva again for one that has cotton old brown leather
 * cartoonist gages and buttons", 2026-10-03). It used to sit about 1,900px
 * down a 390px phone, under the fight card, the notices, the chalkboard and the
 * tab rail; the pain report sat 2,800px down.
 *
 * IT READS NOTHING AND WRITES NOTHING OF ITS OWN. Every value is a prop from
 * AthleteWorkspace, and every button calls a handler the workspace already
 * had: Start check-in is the Session Log's own handleCheckIn, and the two
 * "Open" buttons switch tabs. athleteCorner.test.tsx pins that it fetches
 * nothing.
 *
 * REPORT PAIN IS FIRST, ONE TAP, AND IT IS THE SAME REPORT. First so that on a
 * 390px phone it is on the opening screen without a scroll. The pain report needs a
 * body location before it can open (its form is headed by that location), so
 * this button does not open a second report: it takes the athlete to the
 * existing Pain/Soreness Report card and puts the cursor in its location
 * picker. The card, its form and its endpoint are untouched. It never waits on
 * a read. A training hold, when there is one, renders directly AFTER it (the
 * afterPain slot) rather than above the corner, where a full hold notice
 * pushed it off a phone's first screen.
 *
 * CHECKED IN ONLY WHEN THE READ SAYS SO. "Checked in" comes from the session
 * read the Session Log uses. While that read is in flight the corner says it
 * is checking, and if it failed the corner says it could not tell -- never
 * "not checked in" (which invites a second check-in) and never "checked in".
 * Start check-in is offered only when the read answered and found no open
 * session.
 *
 * NOT HERE, ON PURPOSE: the mock-up's "CLEARED" (the workspace reads no
 * clearance) and "Next session" (it reads no schedule; the Schedule tab hands
 * off to the unified scheduler). The athlete's name is on the fight card below.
 */

export type CornerCountRead =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'read'; readonly count: number };

export interface AthleteCornerProps {
  /** The session read: 'unavailable' means it could not be asked, not "none". */
  readonly sessionState: 'loading' | 'loaded' | 'unavailable';
  /** Whether the athlete is signed in as an athlete at all. */
  readonly identityState: 'loading' | 'resolved' | 'unavailable';
  /** Gym-time stamp of today's open session, or null when none is open. */
  readonly checkedInAt: string | null;
  readonly checkingIn: boolean;
  readonly onCheckIn: () => void;
  readonly onRetrySession: () => void;
  readonly coachWork: CornerCountRead;
  readonly onOpenFloor: () => void;
  readonly goals: CornerCountRead;
  readonly onOpenGoals: () => void;
  readonly onReportPain: () => void;
  readonly onAskShadow: () => void;
  /** Today's session was already checked out of (no session open now). */
  readonly checkedOutToday?: boolean;
  /** The last check-in attempt failed; its full explanation is further down. */
  readonly checkInFailed?: boolean;
  /** Rendered right after the pain panel, full width: the training-hold notice. */
  readonly afterPain?: React.ReactNode;
}

function countLine(read: CornerCountRead, none: string, some: (count: number) => string): string {
  if (read.status === 'unavailable') return 'Not available right now.';
  if (read.status === 'loading') return 'Checking...';
  return read.count === 0 ? none : some(read.count);
}

export default function AthleteCorner({
  sessionState,
  identityState,
  checkedInAt,
  checkingIn,
  onCheckIn,
  onRetrySession,
  coachWork,
  onOpenFloor,
  goals,
  onOpenGoals,
  onReportPain,
  onAskShadow,
  checkedOutToday = false,
  checkInFailed = false,
  afterPain,
}: AthleteCornerProps) {
  const sessionKnown = identityState === 'resolved' && sessionState === 'loaded';

  let checkInLine: string;
  if (identityState === 'unavailable') {
    checkInLine = 'A check-in needs an athlete sign-in. Sign in again, then check in.';
  } else if (identityState === 'loading' || sessionState === 'loading') {
    checkInLine = 'Checking whether you are checked in...';
  } else if (sessionState === 'unavailable') {
    checkInLine = 'Could not tell whether you are checked in. Try again before you check in a second time.';
  } else if (checkedInAt) {
    checkInLine = `Checked in ${checkedInAt}.`;
  } else if (checkedOutToday) {
    checkInLine = 'Checked out today. Check in again if you are back on the floor.';
  } else {
    checkInLine = 'You have not checked in today.';
  }

  return (
    <section aria-label="My corner" className="athlete-corner rounded-[var(--r-lg)]">
      <h2 className="athlete-corner__title">My Corner</h2>

      <div className="athlete-corner__grid">
        <div className="athlete-corner__panel athlete-corner__panel--pain" data-section="pain">
          <p className="athlete-corner__label">Hurt or sore?</p>
          <p>Tell your coach before you train. Pick where it hurts and what it feels like.</p>
          <button type="button" onClick={onReportPain} className="btn athlete-corner__btn athlete-corner__pain">
            Report pain or soreness
          </button>
        </div>

        {afterPain ? <div className="athlete-corner__wide">{afterPain}</div> : null}

        <div className="athlete-corner__panel" data-section="check-in">
          <p className="athlete-corner__label">Check in</p>
          <p
            className={sessionState === 'unavailable' && identityState === 'resolved' ? 'athlete-corner__alert' : undefined}
            role={sessionState === 'unavailable' && identityState === 'resolved' ? 'alert' : undefined}
          >
            {checkInLine}
          </p>
          {sessionKnown && !checkedInAt && checkInFailed && (
            <p role="alert" className="athlete-corner__alert">
              That check-in did not save. Try again, or tell a coach you are here.
            </p>
          )}
          {sessionKnown && !checkedInAt && (
            <button
              type="button"
              onClick={onCheckIn}
              disabled={checkingIn}
              className="btn athlete-corner__btn disabled:opacity-50 disabled:grayscale"
            >
              {checkingIn ? 'Checking in...' : 'Start check-in'}
            </button>
          )}
          {identityState === 'resolved' && sessionState === 'unavailable' && (
            <button type="button" onClick={onRetrySession} className="btn btn--ghost athlete-corner__btn">
              Try again
            </button>
          )}
        </div>

        <div className="athlete-corner__panel" data-section="coach-work">
          <p className="athlete-corner__label">From your coach</p>
          <p>{countLine(coachWork, 'No assigned work recorded.', (count) => `${count} still to do.`)}</p>
          <button type="button" onClick={onOpenFloor} className="btn btn--ghost athlete-corner__btn">
            Open the floor
          </button>
        </div>

        <div className="athlete-corner__panel" data-section="goals">
          <p className="athlete-corner__label">Your goals</p>
          <p>{countLine(goals, 'No active goals recorded.', (count) => `${count} active.`)}</p>
          <button type="button" onClick={onOpenGoals} className="btn btn--ghost athlete-corner__btn">
            Open goals
          </button>
        </div>
      </div>

      <div className="athlete-corner__row">
        <Link href="/schedule" className="btn btn--ghost athlete-corner__btn">
          Open Scheduler
        </Link>
        <button type="button" onClick={onAskShadow} className="btn btn--ghost athlete-corner__btn">
          Ask SHADOW
        </button>
      </div>
    </section>
  );
}
