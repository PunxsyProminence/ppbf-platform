'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

import SleepTrend, { type SleepTrendItem } from './SleepTrend';

// Two read-only views of ONE athlete the coach has deliberately selected in
// CoachWorkspace (map items 20 and 10). Each fetches its own route, which
// decides server-side whether this staff member may see this athlete; a 403
// keeps its own sentence and is never shown as "nothing recorded".

type Read<T> =
  | { status: 'loading' }
  | { status: 'no_access' }
  | { status: 'unavailable' }
  | { status: 'loaded'; items: T[] };

function useAthleteRead<T>(path: string, athleteId: string, attempt: number): Read<T> {
  // Each answer is tagged with the request it answers, so a different athlete
  // or a retry reads as loading until its own answer lands -- never as the
  // previous athlete's records.
  const requestKey = `${path}|${athleteId}|${attempt}`;
  const [answer, setAnswer] = useState<{ key: string; read: Read<T> } | null>(null);
  const read: Read<T> = answer && answer.key === requestKey ? answer.read : { status: 'loading' };

  useEffect(() => {
    const controller = new AbortController();
    const setRead = (value: Read<T>) => setAnswer({ key: requestKey, read: value });
    (async () => {
      try {
        const response = await fetch(
          `${apiBase()}${path}?athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include', signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (response.status === 403) {
          setRead({ status: 'no_access' });
          return;
        }
        if (!response.ok) throw new Error(`read failed: ${response.status}`);
        const payload = (await response.json()) as { items?: unknown };
        if (controller.signal.aborted) return;
        if (!Array.isArray(payload?.items)) throw new Error('response unreadable');
        setRead({ status: 'loaded', items: payload.items as T[] });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error({ event: 'coach-athlete-record-load-failed', path, error });
        setRead({ status: 'unavailable' });
      }
    })();
    return () => controller.abort();
  }, [path, athleteId, requestKey]);

  return read;
}

const NO_ACCESS = 'You don’t have access to this athlete’s records. They are shown to coaches and organization admins in the athlete’s own organization.';
const READ_FAILED = 'This could not be loaded. That is not a statement that nothing is recorded -- try again in a minute.';

function ReadState({ read, onRetry, label }: { read: Read<unknown>; onRetry: () => void; label: string }) {
  if (read.status === 'loading') return <p className="t-muted">Loading {label}...</p>;
  if (read.status === 'no_access') return <p className="t-body">{NO_ACCESS}</p>;
  if (read.status === 'unavailable') {
    return (
      <div className="space-y-[var(--s2)]">
        <p className="t-body">{READ_FAILED}</p>
        <button type="button" className="btn btn--ghost" onClick={onRetry} aria-label={`Try loading ${label} again`}>
          Try again
        </button>
      </div>
    );
  }
  return null;
}

export function CoachSleepTrend({ athleteId, athleteName }: { athleteId: string; athleteName: string }) {
  const [attempt, setAttempt] = useState(0);
  const read = useAthleteRead<SleepTrendItem>('/api/pilot/coach/athlete-sleep-trend', athleteId, attempt);
  if (read.status !== 'loaded') {
    return <ReadState read={read} onRetry={() => setAttempt((n) => n + 1)} label="the sleep trend" />;
  }
  return <SleepTrend items={read.items} heading={`Sleep on recent check-ins: ${athleteName}`} />;
}

export interface BoutHistoryItem {
  entry_id: string;
  competition_name: string;
  competition_date: string;
  competition_status: 'planned' | 'completed' | 'cancelled';
  location: string;
  sanctioning_body: string;
  result: 'won' | 'lost' | 'draw' | 'no_contest' | null;
  lesson_note: string;
}

const RESULT_TEXT: Record<NonNullable<BoutHistoryItem['result']>, string> = {
  won: 'Won',
  lost: 'Lost',
  draw: 'Draw',
  no_contest: 'No contest',
};

export function boutOutcomeText(item: BoutHistoryItem): string {
  if (item.result) return RESULT_TEXT[item.result];
  if (item.competition_status === 'cancelled') return 'Competition cancelled';
  if (item.competition_status === 'planned') return 'Entered, not yet fought';
  return 'No result recorded';
}

export function CoachBoutHistory({ athleteId, athleteName }: { athleteId: string; athleteName: string }) {
  const [attempt, setAttempt] = useState(0);
  const read = useAthleteRead<BoutHistoryItem>('/api/pilot/coach/athlete-competition-history', athleteId, attempt);

  return (
    <section
      aria-labelledby="coach-bout-history-heading"
      className="md:col-span-2 mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s3)]"
    >
      <h3 id="coach-bout-history-heading" className="t-eyebrow">Bout History: {athleteName}</h3>
      {read.status !== 'loaded' ? (
        <ReadState read={read} onRetry={() => setAttempt((n) => n + 1)} label="the bout history" />
      ) : read.items.length === 0 ? (
        <p className="t-muted">No competition entries recorded for this athlete.</p>
      ) : (
        <ul className="space-y-[var(--s3)]">
          {read.items.map((item) => (
            <li
              key={item.entry_id}
              className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] space-y-[var(--s1)]"
            >
              <p className="t-data">
                {item.competition_date} · {item.competition_name}
                {item.location ? ` · ${item.location}` : ''}
                {item.sanctioning_body ? ` · ${item.sanctioning_body}` : ''}
              </p>
              <p className="t-body font-semibold">{boutOutcomeText(item)}</p>
              {item.lesson_note.trim() !== '' && (
                <p className="t-body whitespace-pre-wrap">Lesson: {item.lesson_note}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Both views for the athlete the coach selected, outside the wellness panel. */
export function CoachAthleteHistory({ athleteId, athleteName }: { athleteId: string; athleteName: string }) {
  return (
    <>
      <section
        aria-labelledby="coach-sleep-trend-heading"
        className="md:col-span-2 mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s3)]"
      >
        <h3 id="coach-sleep-trend-heading" className="t-eyebrow">Sleep Trend</h3>
        <CoachSleepTrend athleteId={athleteId} athleteName={athleteName} />
      </section>
      <CoachBoutHistory athleteId={athleteId} athleteName={athleteName} />
    </>
  );
}
