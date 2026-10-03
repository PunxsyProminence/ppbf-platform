'use client';

import Link from 'next/link';
import React, { useMemo, useState } from 'react';

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
 * IT READS NOTHING AND WRITES NOTHING OF ITS OWN. Every value arrives as a prop
 * from CoachWorkspace, which already loads it through its own calls and role
 * gates. The only write reachable from here is the escalation acknowledge the
 * workspace already performs, passed in as a callback. "Next" moves the view to
 * the next item and changes no record: nothing is marked seen, nothing is
 * stored. coachFloorFocus.test.tsx pins both.
 *
 * A READ THAT FAILED IS NEVER "NOTHING NEEDS YOU". A feed that could not be
 * read, or is still loading, is itself an item at the front of the queue, and
 * the all-clear line only appears when every feed answered and none had
 * anything. The gauges keep the same rule: a count that was not read shows "?"
 * and says why, never 0.
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

export type FocusTone = 'cleared' | 'monitor' | 'restricted' | 'locked' | 'neutral';

const TONE_GLYPH: Record<FocusTone, string> = {
  cleared: '✓',
  monitor: '◉',
  restricted: '▲',
  locked: '✕',
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
  /** Pain and safety items wear the locked band the panels below wear. */
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
  readonly link?: { readonly href: string; readonly label: string };
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
  /** false when the roster names this athlete but this coach is not theirs. */
  readonly isMine?: boolean;
}

export interface CoachFloorFocusProps {
  readonly athletes: readonly FocusAthlete[];
  readonly athletesState: 'loading' | 'error' | 'loaded';
  readonly athletesError?: string | null;
  readonly onSelectAthlete: (athleteId: string) => void;
  readonly items: readonly FocusItem[];
  readonly feeds: readonly FocusFeed[];
  /** Whether the readiness feed answered. A failed read is not "0 readings". */
  readonly readinessState: 'loading' | 'error' | 'loaded';
  /** The pain feed's window, so the all-clear line says no more than it read. */
  readonly painWindowDays?: number | null;
  readonly sessionStatus: string;
  /** Whether the live-run read answered. A failed read is not "no session". */
  readonly sessionState: 'loading' | 'error' | 'loaded';
  readonly sessionLive: boolean;
  readonly sessionPaused?: boolean;
  readonly sessionMode: 'Group' | 'One-on-One';
  readonly onSessionMode: (mode: 'Group' | 'One-on-One') => void;
  /** Where the rest of the dashboard starts, for the "everything else" link. */
  readonly everythingElseHref: string;
}

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

function readinessMark(athlete: FocusAthlete): FocusBadge {
  return athlete.readiness === 'UNKNOWN' && athlete.unvalidatedReading ? UNVALIDATED_MARK : READINESS_MARK[athlete.readiness];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return `${first}${last}`.toUpperCase();
}

function Badge({ badge }: { readonly badge: FocusBadge }) {
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
  items,
  feeds,
  readinessState,
  painWindowDays = null,
  sessionStatus,
  sessionState,
  sessionLive,
  sessionPaused = false,
  sessionMode,
  onSessionMode,
  everythingElseHref,
}: CoachFloorFocusProps) {
  /* THE VIEW FOLLOWS AN ITEM, NOT A POSITION. The queue changes underneath
     the coach -- an acknowledged escalation leaves it, a refreshed feed goes
     back to loading and jumps to the front -- and a position would then point
     at a different child's item, still open, with its Acknowledge button
     where the coach just tapped. So the view holds the KEY of the item it is
     showing and which key is open; anything else that slides into place
     arrives closed. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [ackedItem, setAckedItem] = useState<{ readonly key: string; readonly title: string } | null>(null);

  const unanswered = useMemo(() => feeds.filter((feed) => feed.state !== 'loaded'), [feeds]);
  const queueKeys = [...unanswered.map((feed) => `feed:${feed.name}`), ...items.map((item) => `item:${item.id}`)];
  const queueLength = queueKeys.length;
  const selectedIndex = selectedKey === null ? -1 : queueKeys.indexOf(selectedKey);
  const position = selectedIndex >= 0 ? selectedIndex : 0;
  const currentKey = queueKeys[position] ?? null;
  const open = currentKey !== null && openKey === currentKey;

  const currentFeed = position < unanswered.length ? unanswered[position] : null;
  const currentItem = currentFeed ? null : items[position - unanswered.length] ?? null;

  // An acknowledged escalation leaves the queue; say so until the coach moves on.
  const ackLanded = ackedItem !== null && !queueKeys.includes(ackedItem.key);

  const next = () => {
    setOpenKey(null);
    setAckedItem(null);
    setSelectedKey(queueLength === 0 ? null : queueKeys[(position + 1) % queueLength]);
  };

  const validatedReadings = athletes.filter((athlete) => athlete.readiness !== 'UNKNOWN').length;
  const withReading = athletes.filter((athlete) => athlete.readiness !== 'UNKNOWN' || athlete.unvalidatedReading).length;
  const anyFeedFailed = feeds.some((feed) => feed.state === 'error');
  const anyFeedLoading = feeds.some((feed) => feed.state === 'loading');
  // A feed that returned fewer than matched makes the count a floor, not a total.
  const anyFeedTruncated = feeds.some((feed) => feed.state === 'loaded' && Boolean(feed.truncatedNote));

  const gauges: GaugeReading[] = [
    athletesState === 'loaded'
      ? { label: 'Athletes', value: String(athletes.length), sub: 'on the roster', state: 'ok' }
      : athletesState === 'loading'
        ? { label: 'Athletes', value: '…', sub: 'Loading roster', state: 'unknown' }
        : { label: 'Athletes', value: '?', sub: 'Roster not read', state: 'unknown' },
    anyFeedFailed
      ? { label: 'Needs you', value: '?', sub: 'A read failed', state: 'unknown' }
      : anyFeedLoading
        ? { label: 'Needs you', value: '…', sub: 'Still checking', state: 'unknown' }
        : {
            label: 'Needs you',
            value: anyFeedTruncated ? `${items.length}+` : String(items.length),
            sub: items.length === 0 ? 'Nothing reported' : 'Waiting on you',
            state: items.length === 0 ? 'ok' : 'alert',
          },
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
              sub: withReading === validatedReadings ? 'fresh check-ins' : `fresh check-ins, ${withReading - validatedReadings} not validated`,
              state: 'ok',
              fill: athletes.length === 0 ? undefined : withReading / athletes.length,
            },
    sessionState === 'loaded'
      ? {
          label: 'Session',
          value: sessionLive ? (sessionPaused ? 'Paused' : 'Running') : 'None',
          sub: `Your mode: ${sessionMode}`,
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
        <p role="status">{sessionStatus}</p>
      </header>

      <dl aria-label="Today at a glance" className="coach-floor-focus__gauges">
        {gauges.map((gauge) => (
          <Gauge key={gauge.label} gauge={gauge} />
        ))}
      </dl>

      <div className="coach-floor-focus__columns">
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
                      aria-label={`${athlete.name}: readiness ${mark.label}`}
                      className="coach-floor-focus__athlete"
                    >
                      <span className="coach-floor-focus__medal" data-readiness={athlete.readiness} aria-hidden="true">
                        {initials(athlete.name)}
                      </span>
                      <span className="coach-floor-focus__athlete-name">{athlete.name}</span>
                      <Badge badge={mark} />
                      {athlete.isMine === false && <span className="coach-floor-focus__quiet">Not your athlete</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="coach-floor-focus__panel coach-floor-focus__card" aria-live="polite">
          <h3 className="coach-floor-focus__panel-title">
            {queueLength > 0 ? `Needs you now · ${position + 1} of ${queueLength}` : 'Needs you now'}
          </h3>

          {ackLanded && (
            <p className="coach-floor-focus__label" role="status">
              Acknowledged: {ackedItem.title}. It stays listed under Safety Escalations below.
            </p>
          )}

          {currentFeed && (
            <div className="coach-floor-focus__item" data-focus-kind="feed">
              <h4 className="t-command">
                {currentFeed.state === 'loading' ? `Checking ${currentFeed.name.toLowerCase()}...` : `${currentFeed.name} could not be read`}
              </h4>
              {currentFeed.state === 'error' && (
                <p role="alert" className="coach-floor-focus__alert">
                  {currentFeed.error} {currentFeed.failureMeaning}
                </p>
              )}
              {currentFeed.state === 'error' && currentFeed.onRetry && (
                <button type="button" className="btn coach-floor-focus__btn btn--ghost" onClick={currentFeed.onRetry}>
                  Try again
                </button>
              )}
            </div>
          )}

          {currentItem && (
            <article className="coach-floor-focus__item" data-focus-kind={currentItem.urgent ? 'urgent' : 'item'}>
              <p className="coach-floor-focus__label">{currentItem.kind}</p>
              <h4 className="t-command">{currentItem.title}</h4>
              <p className="coach-floor-focus__quiet">{currentItem.meta}</p>
              {currentItem.badge && <Badge badge={currentItem.badge} />}

              {open && (
                <div className="coach-floor-focus__details">
                  {currentItem.details.length > 0 && (
                    <dl>
                      {currentItem.details.map((detail) => (
                        <div key={detail.label}>
                          <dt className="coach-floor-focus__label">{detail.label}</dt>
                          <dd className={detail.muted ? 'coach-floor-focus__quiet' : undefined}>{detail.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {currentItem.body && <p>{currentItem.body}</p>}
                  {currentItem.note && <p className="coach-floor-focus__quiet">{currentItem.note}</p>}
                  {currentItem.acknowledge?.error && (
                    <p role="alert" className="coach-floor-focus__alert">{currentItem.acknowledge.error}</p>
                  )}
                </div>
              )}

              <div className="coach-floor-focus__row">
                {!open && (
                  <button
                    type="button"
                    className="btn coach-floor-focus__btn"
                    onClick={() => {
                      setSelectedKey(currentKey);
                      setOpenKey(currentKey);
                    }}
                  >
                    Open
                  </button>
                )}
                {open && currentItem.acknowledge && (
                  <button
                    type="button"
                    className="btn coach-floor-focus__btn disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={currentItem.acknowledge.disabled}
                    onClick={() => {
                      if (currentKey) setAckedItem({ key: currentKey, title: currentItem.title });
                      currentItem.acknowledge?.onAcknowledge();
                    }}
                  >
                    {currentItem.acknowledge.busy ? 'Acknowledging...' : 'Acknowledge'}
                  </button>
                )}
                {open && currentItem.link && (
                  <Link href={currentItem.link.href} className="btn coach-floor-focus__btn">
                    {currentItem.link.label}
                  </Link>
                )}
              </div>
            </article>
          )}

          {queueLength === 0 && (
            <div className="coach-floor-focus__item" data-focus-kind="clear">
              <h4 className="t-command">Nothing needs you right now</h4>
              <p>
                No pain report{painWindowDays ? ` in the last ${painWindowDays} days` : ''}, open escalation or
                family barrier report for your athletes. That means nothing has been reported, not that everyone is
                fine.
              </p>
            </div>
          )}

          {queueLength > 1 && (
            <button type="button" className="btn coach-floor-focus__btn btn--ghost" onClick={next}>
              Next →
            </button>
          )}

          {feeds.filter((feed) => feed.state === 'loaded' && feed.truncatedNote).map((feed) => (
            <p key={feed.name} className="coach-floor-focus__quiet">{feed.truncatedNote}</p>
          ))}
        </section>

        <section aria-labelledby="coach-floor-actions" className="coach-floor-focus__panel">
          <h3 id="coach-floor-actions" className="coach-floor-focus__panel-title">Run the room</h3>
          <Link href="/coach/session-scripts" className="btn coach-floor-focus__btn">
            {sessionState !== 'loaded' ? 'Open Session Scripts' : sessionLive ? 'Return to live delivery' : 'Start a session'}
          </Link>
          <div role="group" aria-label="Session mode" className="coach-floor-focus__row">
            {(['Group', 'One-on-One'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={sessionMode === mode}
                onClick={() => onSessionMode(mode)}
                className={sessionMode === mode ? 'btn coach-floor-focus__btn' : 'btn btn--ghost coach-floor-focus__btn'}
              >
                {sessionMode === mode && <span aria-hidden="true">✓ </span>}
                {mode}
              </button>
            ))}
          </div>
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
