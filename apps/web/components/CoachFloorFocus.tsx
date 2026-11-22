'use client';

import Link from 'next/link';
import React, { useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { startClassSession } from '@/src/client/startClassSession';
import { defaultClassChoice } from '@/src/shared/sessionClassChoice';
import { fetchTieableClasses } from './SessionClassPicker';

/**
 * THE FLOOR, AS A COMMAND BOARD.
 *
 * The coach dashboard used to open on three stacked report panels, a summary
 * strip, a mode toggle, nine tabs and nine quick actions -- about two and a half
 * screens before the roster. This board sits at the top of the dashboard and
 * answers, on one screen of a gym tablet: who is on today, what needs me right
 * now, and how do I start the session. Layout is Jason's call of 2026-10-03:
 * the Canva Command Center panel board ("B": gauges along the top, three
 * columns below), after he had first asked to get away from columns.
 *
 * IT READS AND WRITES ONLY ONE THING OF ITS OWN: Start a session (#1523). On a
 * tap with no live session it reads the gym's plan list and, when there are
 * none, starts a plain session through the runs route -- the same route and role
 * gate the session page uses. Every other value arrives as a prop from
 * CoachWorkspace, which loads it through its own calls and role gates.
 * coachFloorFocus.test.tsx pins all of it.
 *
 * THE "NEEDS YOU NOW" CARD LEFT THE BOARD (lane 6C7, AS-7 step 7b): it is the
 * home's strip now, at the top of the page (CoachNeedsYouStrip.tsx; stage 2
 * section 3.4 row 11, "Kept, widened"; Q6 = A), with its counts. The board's
 * "Needs you" gauge went with it: the strip's counts say the same, per list.
 *
 * NOTHING HERE REPEATS A SENTENCE OR A HEADING THE PANELS BELOW ALREADY SAY:
 * the session line lives in the panel and the Session gauge says none /
 * running / paused; a waiting or failed feed is named in a label over a
 * generic heading, so no heading here carries a panel's name. A coach seeing
 * the same line twice is noise, and coach-journey.spec.ts finds each once.
 *
 * A READ THAT FAILED IS NEVER 0. A gauge whose count was not read shows "?" and
 * says why, never 0 (the strip keeps the same rule for its counts).
 *
 * NO GAUGE INVENTS A VALUE. Each one is a count the workspace already holds.
 * The only dial with a needle is readings-out-of-roster, the one gauge that
 * has a real scale; the others are counters.
 *
 * READINESS, NOT CLEARANCE. The roster marks are the readiness the dashboard
 * already reads (a fresh, validated check-in). UNKNOWN is shown as "no reading",
 * never as fine. Medical clearance is not on this screen: the dashboard does not
 * read it, and showing it would need a read this view is not allowed to add.
 */

export type FocusTone = 'cleared' | 'monitor' | 'restricted' | 'neutral';

const TONE_GLYPH: Record<FocusTone, string> = {
  cleared: '✓',
  monitor: '◉',
  restricted: '▲',
  neutral: '◌',
};

export interface FocusBadge {
  readonly tone: FocusTone;
  readonly label: string;
}

export interface FocusDetail {
  readonly label: string;
  readonly value: string;
  /** Rendered quieter: a value that is absent or unknown rather than recorded. */
  readonly muted?: boolean;
}

export interface FocusItem {
  readonly id: string;
  /** What kind of thing this is, as the coach reads it: "Pain report". */
  readonly kind: string;
  /** Pain and safety items are marked urgent (the rust edge); their badge tone is set per item. */
  readonly urgent: boolean;
  readonly title: string;
  readonly meta: string;
  readonly badge?: FocusBadge;
  readonly details: readonly FocusDetail[];
  readonly body?: string;
  readonly note?: string;
  /** The real acknowledge, where the backend has one. Absent otherwise. */
  readonly acknowledge?: {
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly onAcknowledge: () => void;
    readonly error?: string;
  };
  /** athleteId: the athlete the page behind the link should open on, handed
      over in page memory and never put in the address (decisionLoopArrival.ts). */
  readonly link?: { readonly href: string; readonly label: string; readonly athleteId?: string };
}

export interface FocusFeed {
  /** "Pain reports", "Safety escalations", "Family barrier reports". */
  readonly name: string;
  readonly state: 'loading' | 'error' | 'loaded';
  readonly error?: string;
  /** What a failed read must not be taken to mean. */
  readonly failureMeaning?: string;
  readonly onRetry?: () => void;
  readonly truncatedNote?: string;
}

export interface FocusAthlete {
  readonly id: string;
  readonly name: string;
  readonly readiness: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  /** A fresh check-in exists but its method is not validated, so it carries
   *  no band. Said as "Not validated", never as no reading and never as fine. */
  readonly unvalidatedReading?: boolean;
  /** The athlete's own check-in for the gym's today exists. A self-report is a
   *  reading for the count, said as "Checked in", and carries no band. */
  readonly checkedInToday?: boolean;
  /** false when the roster names this athlete but this coach is not theirs. */
  readonly isMine?: boolean;
  /** An admin marked this athlete inactive. They stay on the roster and in the
   *  count; the row says so rather than looking like everyone else. */
  readonly isInactive?: boolean;
}

export interface CoachFloorFocusProps {
  readonly athletes: readonly FocusAthlete[];
  readonly athletesState: 'loading' | 'error' | 'loaded';
  readonly athletesError?: string | null;
  readonly onSelectAthlete: (athleteId: string) => void;
  /** Whether the readiness feed answered. A failed read is not "0 readings". */
  readonly readinessState: 'loading' | 'error' | 'loaded';
  /** Whether the live-run read answered. A failed read is not "no session". */
  readonly sessionState: 'loading' | 'error' | 'loaded';
  readonly sessionLive: boolean;
  readonly sessionPaused?: boolean;
  /** Where the rest of the dashboard starts, for the "everything else" link. */
  readonly everythingElseHref: string;
  /** Where Start a session goes to pick a plan. Defaults to the session page; tests pass a spy. */
  readonly onGoToSessions?: () => void;
  /**
   * Where Start a session goes once a session is live (lane U2-6a): the class screen, told when the
   * session was already running so it says it was restored, not restarted. Tests pass a spy.
   */
  readonly onGoToClass?: (restored: boolean) => void;
}

const SESSIONS_HREF = '/coach/session-scripts';
/** The class screen, where a live session runs (lane U2-6a, Overwatch Q5 = A). */
const CLASS_HREF = '/coach/class';

/* The band, in the workspace's own words (the roster says "Readiness:
   GREEN"). Not "Ready": a readiness band is not clearance, and a word that
   sounds like clearance on a child's row is a false statement. */
const READINESS_MARK: Record<FocusAthlete['readiness'], FocusBadge> = {
  GREEN: { tone: 'cleared', label: 'Green' },
  YELLOW: { tone: 'monitor', label: 'Yellow' },
  RED: { tone: 'restricted', label: 'Red' },
  UNKNOWN: { tone: 'neutral', label: 'No reading' },
};
const UNVALIDATED_MARK: FocusBadge = { tone: 'neutral', label: 'Not validated' };
const CHECKED_IN_MARK: FocusBadge = { tone: 'neutral', label: 'Checked in' };

function readinessMark(athlete: FocusAthlete): FocusBadge {
  if (athlete.readiness !== 'UNKNOWN') return READINESS_MARK[athlete.readiness];
  if (athlete.unvalidatedReading) return UNVALIDATED_MARK;
  if (athlete.checkedInToday) return CHECKED_IN_MARK;
  return READINESS_MARK.UNKNOWN;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return `${first}${last}`.toUpperCase();
}

/** A focus badge: its glyph and its word, never colour alone. The strip draws its items' badges with it. */
export function FocusBadgeMark({ badge }: { readonly badge: FocusBadge }) {
  const cls = `${badge.tone === 'neutral' ? 'badge badge--filed' : `badge badge--${badge.tone}`} coach-floor-focus__badge`;
  return (
    <span className={cls}>
      <i aria-hidden="true">{TONE_GLYPH[badge.tone]}</i>
      {badge.label}
    </span>
  );
}

type GaugeState = 'ok' | 'alert' | 'unknown';

interface GaugeReading {
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly state: GaugeState;
  /** 0..1, only where the gauge has a real denominator. */
  readonly fill?: number;
}

function Gauge({ gauge }: { readonly gauge: GaugeReading }) {
  return (
    <div className="coach-floor-focus__gauge" data-gauge-state={gauge.state}>
      <dt className="coach-floor-focus__gauge-label">{gauge.label}</dt>
      <dd className="coach-floor-focus__gauge-value">{gauge.value}</dd>
      {gauge.fill !== undefined && (
        <dd className="coach-floor-focus__dial" aria-hidden="true">
          <span className="coach-floor-focus__needle" style={{ '--turn': gauge.fill } as React.CSSProperties} />
        </dd>
      )}
      <dd className="coach-floor-focus__gauge-sub">{gauge.sub}</dd>
    </div>
  );
}

export default function CoachFloorFocus({
  athletes,
  athletesState,
  athletesError,
  onSelectAthlete,
  readinessState,
  sessionState,
  sessionLive,
  sessionPaused = false,
  everythingElseHref,
  // A full page load, not the router: this component renders outside the app router in many
  // workspace tests, and the session page reads its live run on load either way.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  onGoToSessions = () => window.location.assign(SESSIONS_HREF),
  onGoToClass = (restored) => window.location.assign(restored ? `${CLASS_HREF}?restored=1` : CLASS_HREF),
}: CoachFloorFocusProps) {
  /* START A SESSION, ONE TAP (Jason 2026-10-12, "allow a plain session"; issue #1523, Q2 A).
     With no live session, the tap asks which plans the gym has: none, and it starts a plain
     session (no plan: the clock, pause, TV and finish) and goes to it; some, and it goes to the
     session page to pick one or start plain there. A failed read or start says so and leaves the
     page link beside it, so the coach is never stuck.
     THE CLASS (D4, OD-2026-10-21-002): the plain start is tied to today's class only when exactly
     one class of the coach's is under way (sessionClassChoice.ts); with no free class today (none,
     or each run by another live session) it starts as open gym; otherwise the session page asks. */
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  // One start per press. `starting` disables the button only after a render; two taps landing
  // before it would both start, so the in-flight mark is a ref (review 1 of #1523 PR 2).
  const inFlight = useRef(false);
  async function startSession() {
    if (inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setStartError('');
    // Busy until the page changes: a navigation in flight is not a reason to offer the tap again.
    let leaving = false;
    let refusal = '';
    try {
      const list = await fetch(`${apiBase()}/api/pilot/session-scripts`, { credentials: 'include' });
      if (!list.ok) throw new Error('list');
      const payload = (await list.json()) as { scripts?: unknown[] };
      // Plans to pick from, or today's classes unreadable: the session page asks.
      const classes = (payload.scripts ?? []).length > 0 ? null : await fetchTieableClasses().catch(() => null);
      const choice = classes ? defaultClassChoice(classes, Date.now()) : undefined;
      if (choice === undefined) {
        leaving = true;
        onGoToSessions();
        return;
      }
      // The shared start (src/client/startClassSession.ts, lane U2-6a). Started, or already live
      // (a double tap, another tab): the class screen shows the live session (Overwatch Q5 = A).
      const outcome = await startClassSession({ scriptId: null, classId: choice });
      if (outcome.kind === 'started' || outcome.kind === 'already_live') {
        leaving = true;
        onGoToClass(outcome.kind === 'already_live');
        return;
      }
      // A class refusal is worded by the route (another live session runs the class, and so on).
      refusal = outcome.kind === 'refused' && outcome.message ? ` ${outcome.message}` : '';
      throw new Error('start');
    } catch {
      setStartError(`No session was started.${refusal} Open the session page to start one.`);
    } finally {
      if (!leaving) {
        inFlight.current = false;
        setStarting(false);
      }
    }
  }

  const withReading = athletes.filter(
    (athlete) => athlete.readiness !== 'UNKNOWN' || athlete.unvalidatedReading || athlete.checkedInToday,
  ).length;
  // Staff readings that carry no band; an athlete's own check-in is not one.
  const notValidatedReadings = athletes.filter(
    (athlete) => athlete.readiness === 'UNKNOWN' && athlete.unvalidatedReading,
  ).length;

  const gauges: GaugeReading[] = [
    athletesState === 'loaded'
      ? { label: 'Athletes', value: String(athletes.length), sub: 'on the roster', state: 'ok' }
      : athletesState === 'loading'
        ? { label: 'Athletes', value: '…', sub: 'Loading roster', state: 'unknown' }
        : { label: 'Athletes', value: '?', sub: 'Roster not read', state: 'unknown' },
    athletesState !== 'loaded'
      ? athletesState === 'loading'
        ? { label: 'Readings', value: '…', sub: 'Loading roster', state: 'unknown' }
        : { label: 'Readings', value: '?', sub: 'Roster not read', state: 'unknown' }
      : readinessState === 'error'
        ? { label: 'Readings', value: '?', sub: 'Readiness not read', state: 'unknown' }
        : readinessState === 'loading'
          ? { label: 'Readings', value: '…', sub: 'Checking readiness', state: 'unknown' }
          : {
              label: 'Readings',
              value: `${withReading} of ${athletes.length}`,
              sub: notValidatedReadings === 0 ? 'fresh check-ins' : `fresh check-ins, ${notValidatedReadings} not validated`,
              state: 'ok',
              fill: athletes.length === 0 ? undefined : withReading / athletes.length,
            },
    sessionState === 'loaded'
      ? {
          label: 'Session',
          value: sessionLive ? (sessionPaused ? 'Paused' : 'Running') : 'None',
          sub: sessionLive ? 'Live delivery' : 'Nothing running',
          state: 'ok',
        }
      : sessionState === 'loading'
        ? { label: 'Session', value: '…', sub: 'Checking', state: 'unknown' }
        : { label: 'Session', value: '?', sub: 'Could not check', state: 'unknown' },
  ];

  return (
    <section aria-label="The floor" className="coach-floor-focus rounded-[var(--r-lg)]">
      <header className="coach-floor-focus__head">
        <h2 className="coach-floor-focus__title">The Floor</h2>
      </header>

      <dl aria-label="Today at a glance" className="coach-floor-focus__gauges">
        {gauges.map((gauge) => (
          <Gauge key={gauge.label} gauge={gauge} />
        ))}
      </dl>

      {/* Two patches now that the card is the home's strip: the design
          system's three-track grid (ppbf-golden-era.css) is overridden here, on
          the same 600px container step, rather than leave an empty track. */}
      <div className="coach-floor-focus__columns @min-[600px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]!">
        <section aria-labelledby="coach-floor-athletes" className="coach-floor-focus__panel">
          <h3 id="coach-floor-athletes" className="coach-floor-focus__panel-title">Roster</h3>
          {athletesState === 'loading' && <p>Loading the roster...</p>}
          {athletesState === 'error' && (
            <p role="alert" className="coach-floor-focus__alert">
              {athletesError || 'Your roster could not be loaded.'} The athletes below this panel may be incomplete.
            </p>
          )}
          {athletesState === 'loaded' && athletes.length === 0 && <p>No athletes are on the roster.</p>}
          {athletesState === 'loaded' && athletes.length > 0 && (
            <ul className="coach-floor-focus__athletes">
              {athletes.map((athlete) => {
                const mark = readinessMark(athlete);
                return (
                  <li key={athlete.id}>
                    <button
                      type="button"
                      onClick={() => onSelectAthlete(athlete.id)}
                      aria-label={`${athlete.name}${athlete.isInactive ? ' (inactive)' : ''}: readiness ${mark.label}`}
                      className="coach-floor-focus__athlete"
                    >
                      <span className="coach-floor-focus__medal" data-readiness={athlete.readiness} aria-hidden="true">
                        {initials(athlete.name)}
                      </span>
                      <span className="coach-floor-focus__athlete-name">{athlete.name}</span>
                      <FocusBadgeMark badge={mark} />
                      {athlete.isInactive && <span className="coach-floor-focus__quiet">Inactive</span>}
                      {athlete.isMine === false && <span className="coach-floor-focus__quiet">Not your athlete</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="coach-floor-actions" className="coach-floor-focus__panel">
          <h3 id="coach-floor-actions" className="coach-floor-focus__panel-title">Run the room</h3>
          {sessionState === 'loaded' && !sessionLive ? (
            <>
              <button
                type="button"
                className="btn coach-floor-focus__btn"
                onClick={() => void startSession()}
                disabled={starting}
              >
                {starting ? 'Starting...' : 'Start or pick a session'}
              </button>
              {startError ? (
                <p role="alert" className="coach-floor-focus__alert">
                  {startError} <Link href={SESSIONS_HREF}>Open the session page</Link>
                </p>
              ) : null}
            </>
          ) : (
            /* A live session runs on the class screen (lane U2-6a); an unread state still opens Session Plans. */
            <Link href={sessionState !== 'loaded' ? SESSIONS_HREF : CLASS_HREF} className="btn coach-floor-focus__btn">
              {sessionState !== 'loaded' ? 'Open Session Plans' : 'Return to live delivery'}
            </Link>
          )}
          <Link href="/coach/decision-loop" className="btn coach-floor-focus__btn btn--ghost">
            Open Decision Loop
          </Link>
          <a href={everythingElseHref} className="btn coach-floor-focus__btn btn--ghost">
            Everything else on the dashboard ↓
          </a>
        </section>
      </div>
    </section>
  );
}
