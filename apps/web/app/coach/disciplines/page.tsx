'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import type {
  AthleteDisciplineParticipationRow,
  DisciplineRow,
  GrapplingExposureRow,
} from '@/src/server/pilot/multidiscipline';

// The arts the gym runs, and one athlete's grappling exposure history.
//
// READ ONLY. Recording an exposure is not done here: what a coach is prompted
// to enter at the moment a choke was completed on a child is a decision about
// safeguarding practice, and it belongs to the gym, not to a form inferred
// from a table. The route publishes no write verb either.
//
// BOXING AND GRAPPLING DO NOT SHARE A RISK MODEL. Striking exposure is counted
// in head contact; grappling exposure is counted in neck and joint. They are
// separate tables for that reason, and this page never totals them together.

type Discipline = DisciplineRow;
type Exposure = GrapplingExposureRow;
type Participation = AthleteDisciplineParticipationRow;

// Exposures a coach should be able to pick out of a long list without reading
// every row. Everything else renders plainly rather than being colour-coded
// into a severity it was never assigned.
const ATTENTION_NECK = new Set(['choke_completed', 'unclear']);
const ATTENTION_JOINT = new Set(['joint_lock_completed', 'unclear']);

function needsAttention(row: Exposure): boolean {
  return ATTENTION_NECK.has(row.neck_exposure)
    || ATTENTION_JOINT.has(row.joint_exposure)
    || row.impact_to_head === 'repeated'
    || row.stopped_early
    || (row.athlete_presentation !== null && row.athlete_presentation !== 'normal');
}

function CoachDisciplines() {
  const [disciplines, setDisciplines] = useState<Discipline[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [athleteId, setAthleteId] = useState('');
  const [exposure, setExposure] = useState<Exposure[] | null>(null);
  const [participation, setParticipation] = useState<Participation[]>([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/multidiscipline`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('The disciplines could not be loaded.');
      const payload = (await response.json()) as { disciplines?: Discipline[] };
      setDisciplines(payload.disciplines ?? []);
      setLoadError('');
    } catch (error) {
      setDisciplines([]);
      setLoadError(error instanceof Error ? error.message : 'The disciplines could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const lookUp = useCallback(async (id: string) => {
    const trimmed = id.trim();
    if (trimmed === '') return;

    setExposure(null);
    setParticipation([]);
    setLookupError('');
    setLookupLoading(true);
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/multidiscipline?athlete_id=${encodeURIComponent(trimmed)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('That athlete could not be looked up.');
      const payload = (await response.json()) as {
        exposure?: Exposure[];
        participation?: Participation[];
      };
      setExposure(payload.exposure ?? []);
      setParticipation(payload.participation ?? []);
    } catch (error) {
      setExposure(null);
      setParticipation([]);
      setLookupError(error instanceof Error ? error.message : 'That athlete could not be looked up.');
    } finally {
      setLookupLoading(false);
    }
  }, []);

  return (
    <main className="room--office min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Disciplines</h1>
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            Boxing and grappling are not scored the same way. Striking exposure is counted in head
            contact; grappling exposure is counted in neck and joint. Nothing on this page adds them
            together.
          </p>
          <Link href="/coach/cohorts" className="btn btn--ghost mt-[var(--s4)]">
            Back to cohorts
          </Link>
        </header>

        <section className="mt-[var(--s6)]">
          <h2 className="t-command text-[length:var(--t-lg)]">What the gym runs</h2>

          {loading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}

          {!loading && loadError && (
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">{loadError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to load, not an empty list of disciplines.
              </p>
            </div>
          )}

          {!loading && !loadError && disciplines.length === 0 && (
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No disciplines defined yet.</p>
          )}

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            {disciplines.map((discipline) => (
              <article key={discipline.discipline} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-baseline justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{discipline.display_name}</h3>
                  <span className="plaque">{discipline.exposure_model.replace(/_/g, ' ')}</span>
                </div>
                <p className="t-label mt-[var(--s2)]">{discipline.lane.replace(/_/g, ' ')}</p>
                {discipline.governing_body && (
                  <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                    Governed by {discipline.governing_body}
                  </p>
                )}
                <p className="t-body mt-[var(--s3)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                  {discipline.youth_permitted ? 'Youth permitted' : 'Adults only'}
                  {discipline.mixed_age_permitted ? ' -- mixed-age sessions permitted' : ''}
                </p>
                {/* The age policy is shown with its source, never as a bare
                    permission: an age rule with no cited authority is the thing
                    the schema refuses elsewhere. */}
                {discipline.age_policy_source && (
                  <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                    Age policy: {discipline.age_policy_source}
                  </p>
                )}
                {discipline.evidence_note.trim() !== '' && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{discipline.evidence_note}</p>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="mat-leather mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command text-[length:var(--t-lg)]">Grappling exposure history</h2>
          <div className="mt-[var(--s4)] flex flex-wrap items-end gap-[var(--s3)]">
            <div className="field">
              <label htmlFor="athlete-id" className="t-label">Athlete id</label>
              <input
                id="athlete-id"
                value={athleteId}
                onChange={(event) => setAthleteId(event.target.value)}
                className="input"
                placeholder="ath_..."
              />
            </div>
            <button
              type="button"
              onClick={() => void lookUp(athleteId)}
              disabled={lookupLoading || athleteId.trim() === ''}
              className="btn disabled:cursor-not-allowed disabled:opacity-60"
            >
              {lookupLoading ? 'Looking up...' : 'Look up'}
            </button>
          </div>

          {lookupError && (
            <p role="alert" className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
              {lookupError}
            </p>
          )}

          {participation.length > 0 && (
            <ul className="mt-[var(--s4)] flex flex-wrap gap-[var(--s2)]">
              {participation.map((row) => (
                <li
                  key={row.participation_id}
                  className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]"
                >
                  {row.discipline}: {row.participation_level.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
          )}

          {exposure !== null && exposure.length === 0 && (
            <p className="t-body mt-[var(--s4)] text-[color:var(--bone-300)]">
              No grappling exposure recorded for this athlete.
            </p>
          )}

          {exposure !== null && exposure.length > 0 && (
            <ul className="mt-[var(--s4)] flex flex-col gap-[var(--s3)]">
              {exposure.map((row) => (
                <li
                  key={row.exposure_id}
                  className={`rounded-[var(--r-md)] border-2 bg-[rgba(0,0,0,.28)] p-[var(--s4)] ${
                    needsAttention(row) ? 'border-[var(--locked)]' : 'border-[color:rgba(212,175,74,.22)]'
                  }`}
                >
                  <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                    <span className="plaque">Segment {row.segment_number}</span>
                    <h3 className="t-command text-[length:var(--t-sm)]">{row.round_type.replace(/_/g, ' ')}</h3>
                    <span className="t-label">{row.duration_sec}s</span>
                    <span className="t-label">{row.coach_observed_intensity}</span>
                  </div>

                  <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                    Neck: {row.neck_exposure.replace(/_/g, ' ')} -- Joint: {row.joint_exposure.replace(/_/g, ' ')}
                    {' '}-- Head impact: {row.impact_to_head.replace(/_/g, ' ')}
                  </p>

                  {row.athlete_presentation !== null && row.athlete_presentation !== 'normal' && (
                    <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">
                      Athlete presented {row.athlete_presentation.replace(/_/g, ' ')}.
                    </p>
                  )}

                  {row.stopped_early && (
                    <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">
                      Stopped early{row.stop_reason ? `: ${row.stop_reason}` : '.'}
                    </p>
                  )}

                  {/* A completed choke always carries a coach note -- the module
                      refuses to record one without it -- so it is always shown,
                      never collapsed into the exposure label. */}
                  {row.coach_note.trim() !== '' && (
                    <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{row.coach_note}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

export default function CoachDisciplinesPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <CoachDisciplines />
    </RoleSessionGate>
  );
}
