'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/**
 * THE WALL OF NAMES.
 *
 * Everyone who has come through this gym, in the year the gym first wrote them
 * down, and still up after they have gone. A current athlete scrolling past
 * nine years of people to find their own name is the entire point: it makes
 * them the newest part of something rather than the latest row in a table.
 *
 * WHAT IT IS NOT. It is not a roster, not a leaderboard, and not a directory.
 * There is no per-person number anywhere on it -- no session count, no years
 * served, no milestone tally -- because a shared board that puts 233 beside one
 * child and 3 beside another ranks children against each other, which this
 * platform forbids itself everywhere else (achievementPaths.ts, rule 2). There
 * is no contact detail, no photograph, and no way to click through to a person.
 *
 * NAMES. How much of a name goes up is decided server-side by the same consent
 * gate the gym's television uses (wallDisplay.ts), imported rather than
 * reimplemented. Today that resolves to initials for everybody, and the surface
 * says so in words rather than letting a room of initials read as a bug.
 */

type Standing = 'training' | 'came_through';

interface WallEntry {
  key: string;
  name: string;
  visibility: 'initials' | 'first_name' | 'full_name';
  standing: Standing;
}

interface WallYear {
  year: number | null;
  entries: WallEntry[];
}

interface WallBoard {
  generated_at: string;
  name_mode: 'off' | 'initials' | 'consent';
  total_people: number;
  total_training: number;
  first_year: number | null;
  last_year: number | null;
  years: WallYear[];
  truncated: boolean;
}

type LoadState = 'loading' | 'ready' | 'failed';

export default function WallOfNames() {
  const [board, setBoard] = useState<WallBoard | null>(null);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/wall-of-names`, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('unavailable');
        const payload = (await response.json()) as { ok?: boolean; board?: WallBoard };
        if (payload.ok !== true || !payload.board) throw new Error('unavailable');
        setBoard(payload.board);
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setBoard(null);
        setState('failed');
      }
    })();

    return () => controller.abort();
  }, []);

  const span = board && board.first_year !== null && board.last_year !== null
    ? board.first_year === board.last_year
      ? String(board.first_year)
      : `${board.first_year}–${board.last_year}`
    : null;

  return (
    <main className="wall-names room room--floor min-h-screen">
      <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s7)]">
        <header className="wall-names-head">
          <p className="wall-names-eyebrow">Punxsy Prominence Boxing &amp; Fitness</p>
          <h1 className="wall-names-title">The Wall of Names</h1>
          <p className="wall-names-blurb">
            Everybody who has come through this gym. Nobody comes off it. If you trained here for one week in
            2019 and never came back, you are on this wall, and you stay on it.
          </p>
        </header>

        {state === 'loading' && (
          <p className="wall-names-quiet" role="status">
            Reading the wall...
          </p>
        )}

        {state === 'failed' && (
          <div className="wall-names-empty" role="alert">
            <p className="wall-names-empty-title">The wall did not load</p>
            <p className="wall-names-quiet">
              Nothing is lost — this is a read of records that are still there. Reload the page, or come back in a
              minute.
            </p>
          </div>
        )}

        {state === 'ready' && board && (
          <>
            <dl className="wall-names-tally">
              <div>
                <dt>People on this wall</dt>
                <dd>{board.total_people}</dd>
              </div>
              <div>
                <dt>Training right now</dt>
                <dd>{board.total_training}</dd>
              </div>
              <div>
                <dt>Years covered</dt>
                <dd>{span ?? 'Not recorded'}</dd>
              </div>
            </dl>

            {/* The one honest sentence this surface cannot do without. A wall of
                initials with no explanation reads as broken software; the same
                wall with this line under it reads as a gym that did not publish
                children's names without being asked. */}
            <p className="wall-names-note">
              {board.name_mode === 'consent'
                ? 'Names appear in full only where a guardian signed a release naming a display surface. Everyone else is initials.'
                : board.name_mode === 'off'
                  ? 'Names are switched off on this gym’s display settings, so the wall is a count and a span of years. The records behind it are unchanged.'
                  : 'Everyone shows as initials. Putting a young person’s full name on a shared screen needs a signed release naming that screen, and this gym has not collected one yet — so the wall shows what it is entitled to show.'}
            </p>

            {board.total_people === 0 ? (
              /* Day one. A gym with no records yet is not a broken page, and
                 this is written to be true on the day the wall is hung. */
              <div className="wall-names-empty">
                <p className="wall-names-empty-title">Nobody is on the wall yet</p>
                <p className="wall-names-quiet">
                  The first name goes up when the first athlete is entered. After that it never comes down.
                </p>
              </div>
            ) : (
              <div className="wall-names-years">
                {board.years.map((group) => (
                  <section key={group.year ?? 'undated'} className="wall-names-year">
                    <h2 className="wall-names-year-plate">{group.year ?? 'Year not recorded'}</h2>
                    <ul className="wall-names-list">
                      {group.entries.map((entry) => (
                        <li key={entry.key} className="wall-names-item" data-standing={entry.standing}>
                          <span className="wall-names-name">{entry.name}</span>
                          {/* Law 3: never colour alone. The word is the signal
                              and the tint is decoration on top of it. */}
                          <span className="wall-names-standing">
                            {entry.standing === 'training' ? 'Training now' : 'Came through'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}

            {board.truncated && (
              <p className="wall-names-quiet">
                This wall is longer than one page will hold. The oldest {board.total_people} are shown.
              </p>
            )}

            {/* What the year actually means. Said out loud rather than left for
                somebody to infer, because the platform genuinely does not know
                the day anybody first walked in. */}
            <p className="wall-names-footnote">
              A person is filed under the year the gym first entered them into this platform. That is not always the
              year they first walked in — plenty of people trained here long before any of this existed, and their
              year is the year somebody typed their name.
            </p>
          </>
        )}

        <p className="wall-names-back">
          <Link href="/dashboard" className="btn btn--ghost">
            Back
          </Link>
        </p>
      </div>
    </main>
  );
}
