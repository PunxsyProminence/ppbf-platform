'use client';

import Link from 'next/link';
import React, { useMemo, useState } from 'react';

import ArmedButton from './ArmedButton';
import { FocusBadgeMark, type FocusFeed, type FocusItem } from './CoachFloorFocus';
import { handOffArrivalAthlete } from './decisionLoopArrival';

/**
 * NEEDS YOU NOW: THE COACH HOME'S STRIP (lane 6C7, AS-7 step 7b).
 *
 * The approved stage 2 home (section 3.4 row 11, quoted by Overwatch on #2043)
 * keeps the floor board's "Needs you now" pager and widens it into a strip at the
 * top of the home: "Home strip, opening the one Who needs you list. Kept,
 * widened". Q6 = A: the strip replaces the board's card. The one Who needs you
 * list does not exist yet (AS-11), so each count opens the list that holds those
 * items today, on this page, and cards to verify open Cards (CF-12).
 *
 * WHAT MOVED, AND WHAT DID NOT. The pager below the counts is the board's card,
 * moved whole: one thing at a time, Open, the armed Acknowledge (UXB-01), "Record
 * what you did" handing its athlete to the Decision Loop in page memory (#1474
 * item 5), the failed-feed items with Try again, the all-clear line and the Morning
 * Read link. Nothing it did is dropped, and it does nothing more: it reads nothing
 * of its own, and the only write it can reach is the escalation acknowledge it is
 * handed. "Next" changes no record.
 *
 * A READ THAT FAILED IS NEVER "NOTHING NEEDS YOU", AND NEVER 0. A count whose read
 * failed or was refused shows "?" and "not checked"; one still loading shows "…"
 * and "checking"; a list that returned fewer than matched shows "n+". A failed or
 * loading feed is itself an item at the front of the pager, and the all-clear
 * line only appears when every feed answered and none had anything.
 *
 * NO MARK HERE IS THE MEDICAL STOP. --locked means a medical stop and nothing
 * else (OD-2026-09-29-001); a pain report is not one at any severity
 * (OD-2026-10-03-017). The safety counts wear the restricted ▲ with a word, so
 * colour is never the only channel.
 */

export interface NeedsYouCount {
  /** Stable key, also the test id. */
  readonly key: string;
  /** "Safety escalations", "Pain reports", "Family barrier reports", "Cards to verify". */
  readonly label: string;
  readonly state: 'loading' | 'error' | 'loaded';
  readonly count: number;
  /** The read returned fewer than matched: the count is a floor, not a total. */
  readonly floor?: boolean;
  /** Where the full list is: an anchor on this page, or a page. */
  readonly href: string;
  /** Safety and pain: drawn with the restricted mark when anything is waiting. */
  readonly safety: boolean;
  /** Its items are in the pager below. Cards to verify are not: they are a count and a link only. */
  readonly inPager: boolean;
}

export interface CoachNeedsYouStripProps {
  readonly counts: readonly NeedsYouCount[];
  readonly items: readonly FocusItem[];
  readonly feeds: readonly FocusFeed[];
  /** The pain feed's window, so the all-clear line says no more than it read. */
  readonly painWindowDays?: number | null;
}

function countValue(count: NeedsYouCount): string {
  if (count.state === 'loading') return '…';
  if (count.state === 'error') return '?';
  return count.floor ? `${count.count}+` : String(count.count);
}

function countWord(count: NeedsYouCount): string {
  if (count.state === 'loading') return 'checking';
  if (count.state === 'error') return 'not checked';
  return count.count === 0 ? 'none' : 'waiting';
}

function CountLink({ count }: { readonly count: NeedsYouCount }) {
  const waiting = count.state === 'loaded' && count.count > 0;
  const unknown = count.state !== 'loaded';
  const className = [
    'btn btn--ghost coach-floor-focus__btn h-full w-full flex-col items-start gap-[var(--s1)] text-left',
    count.safety && (waiting || unknown) ? 'border-[color:var(--restricted)]' : '',
  ].join(' ');
  const content = (
    <>
      <span className="flex items-center gap-[var(--s2)]">
        {count.safety && (waiting || unknown) ? (
          <i aria-hidden="true" className="not-italic text-[var(--restricted-ink)]">▲</i>
        ) : null}
        <span className="text-[length:var(--t-xl)] font-black" data-needs-count-value>
          {countValue(count)}
        </span>
        <span className="t-data">{countWord(count)}</span>
      </span>
      <span>{count.label}</span>
    </>
  );
  // An anchor on this page is a plain link; a page is a router link.
  return count.href.startsWith('#') ? (
    <a href={count.href} className={className} data-needs-count={count.key}>
      {content}
    </a>
  ) : (
    <Link href={count.href} className={className} data-needs-count={count.key}>
      {content}
    </Link>
  );
}

export default function CoachNeedsYouStrip({ counts, items, feeds, painWindowDays = null }: CoachNeedsYouStripProps) {
  /* THE VIEW FOLLOWS AN ITEM, NOT A POSITION (moved from the board with the card).
     The queue changes underneath the coach -- an acknowledged escalation leaves
     it, a refreshed feed goes back to loading and jumps to the front -- and a
     position would then point at a different child's item, still open, with its
     Acknowledge button where the coach just tapped. So the view holds the KEY of
     the item it is showing and which key is open; anything else that slides into
     place arrives closed. */
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

  /* The all-clear speaks for the pager's feeds only. A count outside the pager
     (cards to verify) that is waiting, or was not read, keeps it from saying
     "nothing" needs you. */
  const outsideStillOpen = counts.some((count) => !count.inPager && (count.state !== 'loaded' || count.count > 0));

  const next = () => {
    setOpenKey(null);
    setAckedItem(null);
    setSelectedKey(queueLength === 0 ? null : queueKeys[(position + 1) % queueLength]);
  };

  return (
    <section
      aria-labelledby="coach-needs-you-heading"
      aria-live="polite"
      className="coach-floor-focus__panel coach-floor-focus__card text-[length:var(--t-md)]"
    >
      <h2 id="coach-needs-you-heading" className="coach-floor-focus__panel-title">
        {queueLength > 0 ? `Needs you now · ${position + 1} of ${queueLength}` : 'Needs you now'}
      </h2>

      {/* The counts: each opens the list that holds those items today. */}
      <ul aria-label="What is waiting" className="grid grid-cols-2 gap-[var(--s3)] md:grid-cols-4">
        {counts.map((count) => (
          <li key={count.key} className="h-full">
            <CountLink count={count} />
          </li>
        ))}
      </ul>

      {/* The full list behind this card (lane U2; Jason 2026-10-17, "A:
          Cross-link now"): The Morning Read is every read, most urgent
          first. Copy PROPOSED. */}
      <p className="coach-floor-focus__label">
        <Link href="/coach/intelligence" className="underline">More reads: The Morning Read</Link>
      </p>

      {ackLanded && (
        <p className="coach-floor-focus__label" role="status">
          Acknowledged: {ackedItem.title}. It stays listed under Safety Escalations below.
        </p>
      )}

      {currentFeed && (
        <div className="coach-floor-focus__item" data-focus-kind="feed">
          <p className="coach-floor-focus__label">{currentFeed.name}</p>
          <h3 className="t-command">{currentFeed.state === 'loading' ? 'Still checking' : 'Could not be read'}</h3>
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
          <h3 className="t-command">{currentItem.title}</h3>
          <p className="coach-floor-focus__quiet">{currentItem.meta}</p>
          {currentItem.badge && <FocusBadgeMark badge={currentItem.badge} />}

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
            {/* Drawn in the row where Open was. A double tap on Open that
                lands here does not even arm it, and an armed one needs a
                second, deliberate press (UXB-01). */}
            {open && currentItem.acknowledge && (
              <ArmedButton
                className="btn coach-floor-focus__btn disabled:cursor-not-allowed disabled:opacity-60"
                armKey={currentKey ?? ''}
                disabled={currentItem.acknowledge.disabled}
                busy={currentItem.acknowledge.busy}
                busyLabel="Acknowledging..."
                armedLabel={`Press again: acknowledge ${currentItem.title}`}
                onConfirm={() => {
                  if (currentKey) setAckedItem({ key: currentKey, title: currentItem.title });
                  currentItem.acknowledge?.onAcknowledge();
                }}
              >
                Acknowledge
              </ArmedButton>
            )}
            {open && currentItem.link && (
              <Link
                href={currentItem.link.href}
                className="btn coach-floor-focus__btn"
                onClick={(event) => {
                  // A plain click only: a modified click opens another
                  // tab, which would leave the hand-off waiting here for
                  // whatever this tab opens next.
                  const athleteId = currentItem.link?.athleteId;
                  const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
                  if (athleteId && plain) handOffArrivalAthlete(athleteId);
                }}
              >
                {currentItem.link.label}
              </Link>
            )}
          </div>
        </article>
      )}

      {queueLength === 0 && (
        <div className="coach-floor-focus__item" data-focus-kind="clear">
          <h3 className="t-command">{outsideStillOpen ? 'No report needs you right now' : 'Nothing needs you right now'}</h3>
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
  );
}
