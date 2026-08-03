'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { RosterAthlete } from './CoachRecognitionPad';
import { apiBase } from '@/lib/apiBase';
import {
  DEFAULT_PROGRAM,
  isProgram,
  pathProgress,
  type Program,
} from '@/src/shared/achievementPaths';

/**
 * MARKING SOMETHING A COACH WATCHED HAPPEN.
 *
 * Most of the non-fight catalogue is coach-marked: a first full round without
 * stopping, footwork that holds when somebody is tired, a kid taking a newer
 * one through the warm-up. An athlete can log their own mile and their own
 * plank, and should — but without this panel two thirds of the path would be
 * unreachable and the "complete progression" would be a promise the platform
 * could not keep.
 *
 * IT SHOWS ONLY WHAT IS AHEAD, and only for the tracks that athlete's programme
 * includes. A coach marking a fitness member is not shown a competition track,
 * for the same reason the athlete is not: it is absent, not greyed out.
 *
 * IT SHOWS WHAT IS ALREADY HELD, so a coach can see the shape of somebody's
 * progress. As a LIST OF NAMES, never a total held up against anybody else's —
 * there is no other athlete on this screen to compare against, and no read in
 * the API that could put one there.
 *
 * MARKING IS IDEMPOTENT AND CANNOT BE UNDONE. There is no unmark button and no
 * DELETE behind it. A thing that happened is not undone by a later opinion of
 * it, and a milestone that could be taken away is a milestone that can be used
 * as a threat.
 */

interface AwardRow {
  milestone_key: string;
  awarded_at: string;
}

export interface CoachMilestoneMarkerProps {
  roster: readonly RosterAthlete[];
}

export default function CoachMilestoneMarker({ roster }: CoachMilestoneMarkerProps) {
  const [athleteId, setAthleteId] = useState('');
  const [program, setProgram] = useState<Program>(DEFAULT_PROGRAM);
  const [completedSessions, setCompletedSessions] = useState(0);
  const [awards, setAwards] = useState<AwardRow[]>([]);
  const [message, setMessage] = useState('');
  const [busyKey, setBusyKey] = useState('');

  const named = useMemo(
    () => [...roster].sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '')),
    [roster],
  );

  const load = useCallback(async (id: string) => {
    if (!id) {
      setAwards([]);
      return;
    }
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/achievements/milestones?athlete_id=${encodeURIComponent(id)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('unavailable');
      const body = (await response.json()) as {
        program?: string;
        completed_sessions?: number;
        items?: AwardRow[];
      };
      setProgram(isProgram(body.program) ? body.program : DEFAULT_PROGRAM);
      setCompletedSessions(Number(body.completed_sessions) || 0);
      setAwards(body.items ?? []);
    } catch {
      setAwards([]);
      setMessage('That did not load.');
    }
  }, []);

  useEffect(() => {
    // Deferred behind an await so no state is set while the effect body runs.
    void (async () => {
      await load(athleteId);
    })();
  }, [athleteId, load]);

  const tracks = useMemo(
    () => pathProgress(program, {
      completedSessions,
      awardedKeys: awards.map((award) => award.milestone_key),
    }),
    [program, completedSessions, awards],
  );

  const mark = useCallback(async (milestoneKey: string) => {
    if (!athleteId || busyKey) return;
    setBusyKey(milestoneKey);
    setMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/achievements/milestones`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, milestone_key: milestoneKey }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setMessage(payload.error || 'That did not save.');
        return;
      }
      setMessage('Marked. It is on their record and it stays there.');
      await load(athleteId);
    } catch {
      setMessage('That did not save.');
    } finally {
      setBusyKey('');
    }
  }, [athleteId, busyKey, load]);

  return (
    <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]" aria-label="Mark a milestone">
      <header>
        <h2 className="t-command text-[length:var(--t-lg)]">Something you watched happen</h2>
        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
          The first full round, the footwork that held, the kid who took somebody new through the
          warm-up. Athletes log their own mile and their own plank; these are the ones that need
          somebody watching.
        </p>
      </header>

      <div className="field mt-[var(--s4)]">
        <label htmlFor="milestone-athlete" className="t-label">Who</label>
        <select
          id="milestone-athlete"
          value={athleteId}
          onChange={(event) => setAthleteId(event.target.value)}
          className="select input--kiosk"
        >
          <option value="">Pick somebody</option>
          {named.map((athlete) => (
            <option key={athlete.athlete_id} value={athlete.athlete_id}>
              {athlete.full_name || athlete.athlete_id}
            </option>
          ))}
        </select>
      </div>

      {message && (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-200)]" role="status">{message}</p>
      )}

      {athleteId && tracks.map((track) => {
        // Count-derived milestones are not a coach's to mark -- they land when
        // the ledger says so, and a button beside one would imply otherwise.
        const markable = track.ahead.filter((milestone) => milestone.evidence !== 'session_count');
        if (markable.length === 0 && track.earned.length === 0) {
          return null;
        }

        return (
          <div key={track.track} className="mt-[var(--s5)]">
            <h3 className="t-label">{track.meta.label}</h3>

            {markable.length > 0 && (
              <div className="mt-[var(--s3)] grid gap-[var(--s2)] md:grid-cols-2">
                {markable.map((milestone) => (
                  <button
                    key={milestone.key}
                    type="button"
                    disabled={busyKey === milestone.key}
                    onClick={() => void mark(milestone.key)}
                    className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-md)] border-2 border-[color:rgba(212,175,74,.28)] bg-[rgba(0,0,0,.26)] px-[var(--s4)] py-[var(--s3)] text-left text-[length:var(--t-sm)] text-[color:var(--bone-200)] transition hover:border-[color:var(--brass-400)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] disabled:opacity-60"
                  >
                    {milestone.label}
                  </button>
                ))}
              </div>
            )}

            {track.earned.length > 0 && (
              /* Named, not counted. A total per athlete is the one figure on
                 this screen that could be lined up against another athlete's. */
              <p className="tcard-sub mt-[var(--s3)]">
                Already has: {track.earned.map((milestone) => milestone.label).join(' · ')}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
