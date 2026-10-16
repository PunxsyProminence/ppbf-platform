'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { recognitionPhrase } from '@/src/shared/achievementPaths';
import { formatGymDateNumeric } from '@/src/lib/gymTime';
import type { RosterAthlete } from './CoachRecognitionPad';

/**
 * WHAT HAS BEEN SAID TO ONE ATHLETE -- recognition read back for a coach
 * (audit finding F-071: a sent recognition could not be read anywhere by the
 * coach who sent it).
 *
 * One athlete at a time, picked here, through the route's one-athlete read:
 * there is no route that reads more than one athlete's recognitions, and the
 * pad's roster stays names only (CoachRecognitionPad's header), so nothing on
 * this page ranks or counts athletes against each other. The list is exactly
 * what the athlete already reads on their own wall: the sentence, the coach's
 * word, who said it, and the day. A failed read says so and offers Check
 * again; it is never shown as "nothing sent".
 */

export interface SentRecognition {
  recognition_id: string;
  athlete_id: string;
  coach_display_name: string;
  kind: string;
  note: string;
  created_at: string;
}

/** More than a coach reads between rounds; the route keeps every one. */
const SHOWN = 20;

type Reading =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; items: SentRecognition[]; more: boolean };

function isRecognitionOf(entry: unknown, athleteId: string): entry is SentRecognition {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const row = entry as Record<string, unknown>;
  return (
    row.athlete_id === athleteId
    && typeof row.recognition_id === 'string'
    && typeof row.kind === 'string'
    && typeof row.created_at === 'string'
    && typeof row.coach_display_name === 'string'
    && typeof row.note === 'string'
  );
}

export default function SentRecognitions({
  roster,
  rosterState = 'ready',
  reloadKey,
}: {
  roster: readonly RosterAthlete[];
  /** Whether the page's roster read succeeded: a failed one is not an empty gym. */
  rosterState?: 'loading' | 'ready' | 'unavailable';
  /** Changes after the pad sends one, so the open athlete's list reads again. */
  reloadKey?: number;
}) {
  const [athleteId, setAthleteId] = useState('');
  const [reading, setReading] = useState<Reading>({ state: 'idle' });
  const readSeq = useRef(0);

  // `quiet`: a re-read after a send keeps the list on screen until the new
  // answer lands, rather than blanking it to "Reading".
  const read = useCallback(async (id: string, quiet = false) => {
    const seq = ++readSeq.current;
    if (!id) {
      setReading({ state: 'idle' });
      return;
    }
    if (!quiet) setReading({ state: 'loading' });
    try {
      const response = await fetch(
        // One more than is shown, so "older ones are kept" is said only when there is one.
        `${apiBase()}/api/pilot/achievements/recognition?athlete_id=${encodeURIComponent(id)}&limit=${SHOWN + 1}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('unreadable');
      const payload = (await response.json()) as { ok?: unknown; items?: unknown } | null;
      if (
        !payload
        || payload.ok !== true
        || !Array.isArray(payload.items)
        || !payload.items.every((entry) => isRecognitionOf(entry, id))
      ) {
        throw new Error('unreadable');
      }
      const items = payload.items as SentRecognition[];
      if (readSeq.current === seq) setReading({ state: 'loaded', items: items.slice(0, SHOWN), more: items.length > SHOWN });
    } catch {
      if (readSeq.current === seq) setReading({ state: 'failed' });
    }
  }, []);

  const lastKey = useRef(reloadKey);
  useEffect(() => {
    if (lastKey.current === reloadKey) return;
    lastKey.current = reloadKey;
    // A fetch, whose answer is set after it lands (same as FinishedSessions).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (athleteId) void read(athleteId, true);
  }, [reloadKey, athleteId, read]);

  const sorted = [...roster].sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''));
  const name = roster.find((athlete) => athlete.athlete_id === athleteId)?.full_name || 'This athlete';

  return (
    <section
      className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]"
      aria-labelledby="sent-recognition-heading"
    >
      <h2 id="sent-recognition-heading" className="t-command text-[length:var(--t-lg)]">What has been said to them</h2>
      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
        Pick an athlete to read back the recognition sent to them, newest first.
      </p>

      {rosterState === 'unavailable' ? (
        <p role="alert" className="t-body mt-[var(--s3)] font-semibold">
          The athlete list could not be read, so there is nobody to pick. Reload the page to try again.
        </p>
      ) : null}
      {rosterState === 'ready' && roster.length === 0 ? (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No athletes on your roster.</p>
      ) : null}

      <div className="field mt-[var(--s4)]">
        <label htmlFor="sent-recognition-athlete" className="t-label">Athlete</label>
        <select
          id="sent-recognition-athlete"
          className="select"
          value={athleteId}
          onChange={(event) => {
            setAthleteId(event.target.value);
            void read(event.target.value);
          }}
        >
          <option value="">Choose an athlete</option>
          {sorted.map((athlete) => (
            <option key={athlete.athlete_id} value={athlete.athlete_id}>
              {athlete.full_name || 'Unnamed athlete'}
            </option>
          ))}
        </select>
      </div>

      {reading.state === 'loading' ? (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]" role="status">Reading what was sent…</p>
      ) : null}

      {reading.state === 'failed' ? (
        <div role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
          <p className="t-body font-semibold">
            What was sent could not be read just now. This is not a statement that nothing was sent.
          </p>
          <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => void read(athleteId)}>
            Check again
          </button>
        </div>
      ) : null}

      {reading.state === 'loaded' && reading.items.length === 0 ? (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Nothing has been sent to {name} yet.</p>
      ) : null}

      {reading.state === 'loaded' && reading.items.length > 0 ? (
        <>
          <ul className="mt-[var(--s3)] space-y-[var(--s2)]" aria-label={`Recognition sent to ${name}, newest first`}>
            {reading.items.map((item) => (
              <li
                key={item.recognition_id}
                className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]"
              >
                <p className="t-body font-semibold">
                  {recognitionPhrase(item.kind)?.said ?? 'A recognition this screen does not have words for.'}
                </p>
                {item.note.trim() ? <p className="t-body mt-[var(--s1)]">“{item.note}”</p> : null}
                <p className="t-data mt-[var(--s1)] text-[color:var(--bone-300)]">
                  {item.coach_display_name || 'A coach'} · {formatGymDateNumeric(item.created_at) ?? 'date not known'}
                </p>
              </li>
            ))}
          </ul>
          {reading.more ? (
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-400)]">
              Only the newest {SHOWN} are shown here. Older ones are kept.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
