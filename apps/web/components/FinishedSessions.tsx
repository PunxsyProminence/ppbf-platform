'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import SessionStaffNotesPanel from '@/components/SessionStaffNotesPanel';
import { formatGymDate, formatGymTimeOfDay, gymDayIso } from '@/src/lib/gymTime';

// The gym's finished sessions, plain and scripted (audit finding F-067).
//
// A plain session has no plan, so the per-plan "Past deliveries" list could never show it once
// it ended, and its end notes with it. This reads GET /api/pilot/session-scripts/runs?finished=true:
// the gym's settled sessions, newest first, each with the coach's end notes, who delivered it, and
// who was marked here. Each athlete marked here has a staff notes box for that session, which any
// coach or organization admin of the gym may read and add to after the session (the session staff
// notes ruling, OD-2026-10-06-025 ruling 4).
//
// STAFF ONLY (OD-2026-10-10-003 items 3 and 4): the route refuses every other role, and this list
// sits on a coach page. Who delivered a session is a display name or "You"; no account id reaches
// the screen.
//
// Times are the gym's (src/lib/gymTime), read from the session's own start and end instants. A
// read that failed is said to have failed, never shown as "no sessions".

interface PresentAthlete {
  athlete_id: string;
  full_name: string;
}

interface FinishedRun {
  run_id: string;
  script_id: string | null;
  script_version: number | null;
  script_name: string | null;
  run_state: 'completed' | 'abandoned';
  started_at: string | null;
  ended_at: string | null;
  athletes_present: number | null;
  blocks_completed: number | null;
  deviation_note: string | null;
  what_worked: string | null;
  what_did_not: string | null;
  delivered_by_name: string;
  delivered_by_me: boolean;
  present: PresentAthlete[];
}

type Reading = { state: 'loading' } | { state: 'unavailable' } | { state: 'loaded'; runs: FinishedRun[] };

// The route answers the newest fifty; saying so keeps "that is all of them" from being read in.
const PAGE = 50;

function isFinishedRun(value: unknown): value is FinishedRun {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.run_id === 'string'
    && (row.run_state === 'completed' || row.run_state === 'abandoned')
    && typeof row.delivered_by_name === 'string'
    && typeof row.delivered_by_me === 'boolean'
    && Array.isArray(row.present)
    && row.present.every((athlete) => !!athlete && typeof athlete === 'object'
      && typeof (athlete as Record<string, unknown>).athlete_id === 'string'
      && typeof (athlete as Record<string, unknown>).full_name === 'string');
}

// A session that ended on a later gym day says that day too. Printing only the end's time of day
// made a run left open overnight read as a few hours on one day (live walkthrough 2026-10-19:
// "1:33 PM to 7:10 PM" for a run that ended the next evening).
function when(run: FinishedRun): string {
  const day = formatGymDate(run.started_at);
  const from = formatGymTimeOfDay(run.started_at);
  const to = formatGymTimeOfDay(run.ended_at);
  if (!day) return 'Date not recorded';
  if (!from || !to) return day;
  const endDay = gymDayIso(run.ended_at) !== gymDayIso(run.started_at) ? formatGymDate(run.ended_at) : null;
  return endDay ? `${day}, ${from} to ${endDay}, ${to}` : `${day}, ${from} to ${to}`;
}

function EndNote({ label, text }: { label: string; text: string | null }) {
  if (!text || text.trim() === '') return null;
  return (
    <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
      <span className="t-label">{label}: </span>{text}
    </p>
  );
}

export default function FinishedSessions() {
  const [reading, setReading] = useState<Reading>({ state: 'loading' });

  const read = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs?finished=true`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => null)) as { runs?: unknown } | null;
      if (!response.ok || !payload || !Array.isArray(payload.runs) || !payload.runs.every(isFinishedRun)) {
        throw new Error('unreadable');
      }
      setReading({ state: 'loaded', runs: payload.runs as FinishedRun[] });
    } catch {
      setReading({ state: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
  }, [read]);

  return (
    <section data-surface="kiosk" className="mt-[var(--s6)]" aria-labelledby="finished-sessions-heading">
      <h2 id="finished-sessions-heading" className="t-command text-[length:var(--t-lg)]">Finished sessions</h2>
      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
        Every session this gym has ended, with or without a plan: the end notes, who ran it and who was
        marked here. Staff only.
      </p>

      {reading.state === 'loading' && (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]" role="status">Loading finished sessions…</p>
      )}

      {reading.state === 'unavailable' && (
        <div role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
          <p>The finished sessions could not be read just now. Sessions may exist that are not shown; this is a failed read, not an empty list.</p>
          <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => { setReading({ state: 'loading' }); void read(); }}>
            Check again
          </button>
        </div>
      )}

      {reading.state === 'loaded' && reading.runs.length === 0 && (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
          No finished sessions yet. A session appears here once it is ended.
        </p>
      )}

      {reading.state === 'loaded' && reading.runs.length > 0 && (
        <>
          <ul className="mt-[var(--s3)] flex flex-col gap-[var(--s3)]" aria-label="Finished sessions, newest first">
            {reading.runs.map((run) => (
              <li
                key={run.run_id}
                className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
              >
                {/* Each session is a heading, so moving by heading tells one from the next. */}
                <h3 className="flex flex-wrap items-baseline gap-[var(--s3)]">
                  <span className="plaque">{when(run)}</span>
                  <span className="t-label">{run.run_state === 'completed' ? 'Completed' : 'Abandoned'}</span>
                </h3>
                <p className="t-body mt-[var(--s2)] font-semibold">
                  {run.script_id === null
                    ? 'Plain session'
                    : `${run.script_name ?? 'A plan'}${run.script_version !== null ? ` (version ${run.script_version})` : ''}`}
                  {' · '}
                  {run.delivered_by_me ? 'You ran it' : `Run by ${run.delivered_by_name}`}
                </p>
                {/* Only what the coach recorded: a count not stated is not shown as zero. */}
                {(run.athletes_present !== null || run.blocks_completed !== null) && (
                  <p className="t-data mt-[var(--s2)] text-[color:var(--bone-300)]">
                    {run.athletes_present !== null
                      && `${run.athletes_present} ${run.athletes_present === 1 ? 'athlete' : 'athletes'} present (the coach's count). `}
                    {run.blocks_completed !== null && `${run.blocks_completed} blocks completed.`}
                  </p>
                )}
                <EndNote label="Deviation" text={run.deviation_note} />
                <EndNote label="Worked" text={run.what_worked} />
                <EndNote label="Did not work" text={run.what_did_not} />

                <h4 className="t-label mt-[var(--s3)]">Marked here</h4>
                {run.present.length === 0 ? (
                  // The list holds only athletes on the gym's current list: one marked and since
                  // removed is not shown, so "nobody was marked" would claim more than is known.
                  <p className="t-body mt-[var(--s1)] text-[color:var(--bone-400)]">No athlete on the gym’s current list was marked here.</p>
                ) : (
                  <ul className="mt-[var(--s2)] space-y-[var(--s2)]" aria-label={`Marked here, ${when(run)}`}>
                    {run.present.map((athlete) => (
                      <li key={athlete.athlete_id}>
                        <span className="t-body">{athlete.full_name}</span>
                        <SessionStaffNotesPanel
                          runId={run.run_id}
                          athleteId={athlete.athlete_id}
                          buttonLabel={`Staff notes on ${athlete.full_name}, ${when(run)}`}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {reading.runs.length >= PAGE && (
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-400)]">
              The newest {PAGE} are shown. Older sessions are kept but are not listed here yet.
            </p>
          )}
        </>
      )}
    </section>
  );
}
