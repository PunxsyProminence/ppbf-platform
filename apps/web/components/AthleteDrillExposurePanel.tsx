'use client';

import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import type { AthleteDrillExposure, ExposureBucket } from '@/src/server/pilot/athleteDrillExposure';

// ONE ATHLETE'S DRILL EXPOSURE, AS RAW TOTALS.
//
// Reads GET coach/athlete-drill-exposure. Shows counts and sums only: no score, no ranking against
// other athletes, no "too much" line. Planned minutes are labelled planned because nothing records
// minutes actually done. Group class sessions are not counted per athlete, and the panel says so,
// because a missing number must not read as a zero.

const CONTEXT_LABELS: Record<string, string> = {
  session: 'Session',
  drill_assignment: 'Drill assignment',
  assessment: 'Assessment',
  film_study: 'Film study',
  open_floor: 'Open floor',
  technical_sparring: 'Technical sparring',
  sparring_games: 'Sparring games',
  sparring_drills: 'Sparring drills',
  open_sparring: 'Open sparring',
};

function repsCell(bucket: ExposureBucket): string {
  if (bucket.sessionsWithReps === 0) return 'not recorded';
  const suffix = bucket.sessionsWithReps < bucket.sessions
    ? ` (${bucket.sessionsWithReps} of ${bucket.sessions} sessions)` : '';
  return `${bucket.reps}${suffix}`;
}

function minutesCell(bucket: ExposureBucket): string {
  if (bucket.sessionsWithPlannedMinutes === 0) return 'not set';
  const suffix = bucket.sessionsWithPlannedMinutes < bucket.sessions
    ? ` (${bucket.sessionsWithPlannedMinutes} of ${bucket.sessions} sessions)` : '';
  return `${bucket.plannedMinutes}${suffix}`;
}

function BucketTable({ caption, firstColumn, buckets }: {
  caption: string;
  firstColumn: string;
  buckets: ExposureBucket[];
}) {
  return (
    <div className="mt-[var(--s3)] overflow-x-auto">
      <table className="ledger">
        <caption className="text-left">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{firstColumn}</th>
            <th scope="col">Sessions</th>
            <th scope="col">Reps</th>
            <th scope="col">Planned minutes</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.key}>
              <th scope="row">{bucket.label}</th>
              <td>{bucket.sessions}</td>
              <td>{repsCell(bucket)}</td>
              <td>{minutesCell(bucket)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AthleteDrillExposurePanel({ athleteId }: { athleteId: string }) {
  // `requested` is what the coach asked for (blank = the server's default window); `shown` is what
  // the inputs display, filled from the window the server actually used so a blank input never
  // hides which days the totals cover.
  const [requested, setRequested] = useState({ from: '', to: '' });
  const [shown, setShown] = useState({ from: '', to: '' });
  const [data, setData] = useState<AthleteDrillExposure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const change = (end: 'from' | 'to', value: string) => {
    const next = { ...shown, [end]: value };
    setShown(next);
    setRequested(next);
    setError(null);
    // Loading starts here rather than in the effect; a new athlete remounts the panel (keyed by
    // athlete on the page), so the first read starts from the initial loading state.
    setLoading(true);
  };

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const params = new URLSearchParams({ athlete_id: athleteId });
        if (requested.from) params.set('from', requested.from);
        if (requested.to) params.set('to', requested.to);
        const response = await fetch(`${apiBase()}/api/pilot/coach/athlete-drill-exposure?${params}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok || !payload?.drillSessions) {
          const message = typeof payload?.error === 'string' ? payload.error : null;
          throw new Error(message ?? 'This athlete’s drill exposure could not be read.');
        }
        setData(payload as AthleteDrillExposure);
        setError(null);
        setShown(payload.window);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof Error ? caught.message : 'This athlete’s drill exposure could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [athleteId, requested]);

  const sessions = data?.drillSessions;

  return (
    <section aria-labelledby="drill-exposure-heading" className="mt-[var(--s5)]">
      <h2 id="drill-exposure-heading" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
        Drill exposure
      </h2>
      <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
        Totals from this athlete&rsquo;s own completed drill assignments and logged rounds. Counts
        only: nothing here scores, ranks or sets a limit.
      </p>

      <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
        <div className="field">
          <label className="t-label" htmlFor="exposure-from">From</label>
          <input id="exposure-from" type="date" className="input" value={shown.from}
            onChange={(event) => change('from', event.target.value)} />
        </div>
        <div className="field">
          <label className="t-label" htmlFor="exposure-to">To</label>
          <input id="exposure-to" type="date" className="input" value={shown.to}
            onChange={(event) => change('to', event.target.value)} />
        </div>
      </div>

      {error && (
        <div className="mat-leather mt-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]" role="alert">
          <p className="t-body font-semibold text-[color:var(--bone-100)]">{error}</p>
        </div>
      )}

      {loading && !error && <p className="working mt-[var(--s3)]">Reading drill exposure...</p>}

      {!loading && sessions && data && (
        <>
          {sessions.total.sessions === 0 ? (
            <p className="t-body mt-[var(--s3)]" data-testid="no-drill-sessions">
              No completed drill sessions recorded in this window.
            </p>
          ) : (
            <>
              <BucketTable caption="By contact level" firstColumn="Contact level"
                buckets={[...sessions.byContactLevel, sessions.total]} />
              <BucketTable caption="By skill family" firstColumn="Skill family"
                buckets={sessions.bySkillFamily} />
            </>
          )}
          {(sessions.pendingVerification > 0 || sessions.disputedExcluded > 0) && (
            <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
              {sessions.pendingVerification > 0
                && `${sessions.pendingVerification} counted session(s) are not yet verified by a coach. `}
              {sessions.disputedExcluded > 0
                && `${sessions.disputedExcluded} disputed session(s) are left out.`}
            </p>
          )}

          <h3 className="t-label mt-[var(--s4)]">Rounds logged</h3>
          {data.rounds.attempts === 0 ? (
            <p className="t-body mt-[var(--s2)]">No rounds counted in this window.</p>
          ) : (
            <ul className="mt-[var(--s2)] space-y-[var(--s1)]" data-testid="rounds">
              {data.rounds.byContext.map((row) => (
                <li key={row.contextType} className="t-body">
                  {CONTEXT_LABELS[row.contextType] ?? row.contextType}: {row.rounds} rounds
                  ({row.attempts} {row.attempts === 1 ? 'entry' : 'entries'})
                </li>
              ))}
              <li className="t-body font-semibold">Total: {data.rounds.total} rounds</li>
            </ul>
          )}
          {data.rounds.disputedExcluded > 0 && (
            <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }} data-testid="rounds-disputed">
              {data.rounds.disputedExcluded} disputed round {data.rounds.disputedExcluded === 1 ? 'entry is' : 'entries are'} left out.
            </p>
          )}

          <p className="t-body mt-[var(--s3)]" style={{ fontSize: 'var(--t-sm)' }} data-testid="group-sessions-note">
            Group class sessions are not included: a class run records how many athletes were
            there, not which ones.
          </p>
        </>
      )}
    </section>
  );
}
