'use client';

import React, { useEffect, useMemo, useState } from 'react';

import PrintableCertificate from './PrintableCertificate';
import PrintableFightCard from './PrintableFightCard';
import PrintSheet from './PrintSheet';
import type { FightCardPayload } from './profileClient';
import {
  earnedMilestoneKeys,
  milestoneByKey,
  type Milestone,
} from '@/src/shared/achievementPaths';
import { apiBase } from '@/lib/apiBase';

/**
 * /print — the paper the platform makes.
 *
 * Two artifacts on two sheets of US Letter: the member's card, then a
 * certificate for something they did. The controls at the top are SCREEN ONLY
 * (the design system's print block hides every button), so what comes out of
 * the printer is two clean sheets with no app chrome on them.
 *
 * WHOSE PAPER. The athlete this prints for is `?athlete_id=` when one is given
 * and the signed-in member otherwise. Nothing here decides whether that is
 * allowed: /api/pilot/profile/card runs the profile gate and
 * /api/pilot/achievements/milestones runs assertActorCanAccessAthlete, so an
 * athlete id belonging to another family produces a 404 and this page renders
 * the honest failure. There is no second copy of the boundary in this file.
 *
 * A PRINTED NAME IS NOT A WALL NAME. The Wall of Names renders initials because
 * it is a shared surface with an unknown audience. This is the opposite: one
 * sheet, produced by a person who has already been permitted to read this
 * member's card, handed to that member's own family. Applying the wall's
 * consent gate here would print "M.R." on a child's certificate, which is not
 * privacy -- it is a broken artifact. The gate that matters here is the one on
 * the reads, and it has already run.
 */

interface MilestoneAwardRow {
  milestone_key: string;
  awarded_by_role: string;
  awarded_at: string;
}

interface AchievementPayload {
  ok?: boolean;
  program?: string | null;
  completed_sessions?: number;
  items?: MilestoneAwardRow[];
}

type LoadState = 'loading' | 'ready' | 'denied' | 'failed';

/**
 * The athlete this sheet is for, from the query string.
 *
 * window.location rather than useSearchParams: this page is a leaf client
 * component and the router's search-params hook would force a Suspense
 * boundary around a page whose whole job is to be one printable document. Read
 * inside the loading effect rather than mirrored into state, so there is no
 * setState in an effect body and no second render before the fetch starts.
 *
 * The value is never trusted. It goes to the server, which re-runs the profile
 * gate and assertActorCanAccessAthlete before it answers.
 */
function athleteIdFromQuery(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('athlete_id');
  return raw && raw.trim() ? raw.trim() : null;
}

export default function PrintRoom() {
  const [card, setCard] = useState<FightCardPayload | null>(null);
  const [awards, setAwards] = useState<MilestoneAwardRow[]>([]);
  const [completedSessions, setCompletedSessions] = useState(0);
  const [state, setState] = useState<LoadState>('loading');
  const [chosenKey, setChosenKey] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        // Who this is for. An explicit athlete_id wins; otherwise the session's
        // own, which is the common case (an athlete printing their own card).
        let subject = athleteIdFromQuery();
        if (!subject) {
          const sessionResponse = await fetch(`${apiBase()}/api/pilot/auth/session`, {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
          });
          if (sessionResponse.ok) {
            const payload = (await sessionResponse.json()) as { athlete_id?: string | null };
            subject = payload.athlete_id ?? null;
          }
        }

        const cardUrl = subject
          ? `${apiBase()}/api/pilot/profile/card?athlete_id=${encodeURIComponent(subject)}`
          : `${apiBase()}/api/pilot/profile/card`;

        const cardResponse = await fetch(cardUrl, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });

        if (cardResponse.status === 404 || cardResponse.status === 403) {
          setState('denied');
          return;
        }
        if (!cardResponse.ok) throw new Error('unavailable');

        const cardBody = (await cardResponse.json()) as { ok?: boolean; card?: FightCardPayload };
        if (cardBody.ok !== true || !cardBody.card) throw new Error('unavailable');
        setCard(cardBody.card);

        // Milestones are athlete-scoped. Staff members have no athlete record,
        // so there is simply no certificate half for them and the sheet says so
        // rather than asking the server a question it cannot answer.
        if (subject) {
          const achievementResponse = await fetch(
            `${apiBase()}/api/pilot/achievements/milestones?athlete_id=${encodeURIComponent(subject)}`,
            { method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal },
          );
          if (achievementResponse.ok) {
            const body = (await achievementResponse.json()) as AchievementPayload;
            setAwards(body.items ?? []);
            setCompletedSessions(body.completed_sessions ?? 0);
          }
        }

        setState('ready');
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setState('failed');
      }
    })();

    return () => controller.abort();
    // Once. The query string cannot change without a navigation, which
    // remounts this component.
  }, []);

  /**
   * Everything this athlete has actually earned, count-derived and coach-marked
   * together, in catalogue order. The catalogue is the authority on which keys
   * are real; an award row naming a key that no longer exists is dropped rather
   * than printed as a blank certificate.
   */
  const earned: readonly Milestone[] = useMemo(() => {
    const keys = earnedMilestoneKeys({
      completedSessions,
      awardedKeys: awards.map((row) => row.milestone_key),
    });
    return keys.map((key) => milestoneByKey(key)).filter((m): m is Milestone => m !== null);
  }, [awards, completedSessions]);

  const chosen = useMemo(() => {
    if (earned.length === 0) return null;
    const byKey = chosenKey ? earned.find((m) => m.key === chosenKey) : null;
    if (byKey) return byKey;
    // Default to the most recently marked one, because that is the thing
    // somebody came here to print. Count-derived milestones have no award row,
    // so they fall through to the last one in catalogue order.
    const newestAward = [...awards].sort((a, b) => Date.parse(b.awarded_at) - Date.parse(a.awarded_at))[0];
    return (newestAward && earned.find((m) => m.key === newestAward.milestone_key)) ?? earned[earned.length - 1];
  }, [awards, chosenKey, earned]);

  const chosenAward = chosen ? awards.find((row) => row.milestone_key === chosen.key) ?? null : null;

  return (
    <main className="print-room on-canvas min-h-screen">
      {/* Screen only. Buttons and nav are display:none in the design system's
          print rules, and this bar is marked as well so it cannot survive by
          accident if that ever changes. */}
      <div className="print-room-bar screen-only">
        <div>
          <p className="t-eyebrow">Print</p>
          <h1 className="print-room-title">Something to take home</h1>
          <p className="t-body">
            Two sheets: the member card, and a certificate for one thing they did. Letter paper. Print it, or save
            it as a PDF from the same dialog.
          </p>
        </div>

        <div className="print-room-controls">
          {earned.length > 1 && (
            <label className="print-room-pick">
              <span className="t-label">Which one</span>
              <select
                className="input"
                value={chosen?.key ?? ''}
                onChange={(event) => setChosenKey(event.target.value)}
              >
                {earned.map((milestone) => (
                  <option key={milestone.key} value={milestone.key}>
                    {milestone.family}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn"
            disabled={state !== 'ready'}
            onClick={() => {
              if (typeof window !== 'undefined') window.print();
            }}
          >
            Print these
          </button>
        </div>
      </div>

      {state === 'loading' && (
        <p className="print-room-status screen-only" role="status">
          Getting the details...
        </p>
      )}

      {state === 'denied' && (
        <p className="print-room-status screen-only" role="alert">
          There is nothing here to print for that person. If you were expecting a card, you may not be the one who
          can print it — ask a coach.
        </p>
      )}

      {state === 'failed' && (
        <p className="print-room-status screen-only" role="alert">
          That did not load, so nothing has been printed. Reload and try again.
        </p>
      )}

      {state === 'ready' && card && (
        <div className="print-stack">
          <PrintableFightCard card={card} />

          {chosen ? (
            <PrintableCertificate
              athleteName={card.displayName}
              milestone={chosen}
              awardedAt={chosenAward?.awarded_at ?? null}
              awardedByRole={chosenAward?.awarded_by_role ?? null}
            />
          ) : (
            /* The day-one sheet. It still prints, and it still looks like
               something from this gym, because a blank second page would read
               as a bug and a missing second page would make the "two sheets"
               promise a lie. */
            <PrintSheet
              eyebrow="Nothing yet"
              title="No certificate to print"
              footNote="Certificates print themselves once there is something to record. Nothing is missing and nothing is late."
            >
              <p className="print-cert-lead">
                Nothing has been marked for {card.displayName} yet. The first one usually turns up the week somebody
                walks through the door for the fifth time.
              </p>
            </PrintSheet>
          )}
        </div>
      )}
    </main>
  );
}
