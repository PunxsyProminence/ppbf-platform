"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

/*
 * LABEL AGREEMENT. Where two coaches labelled the same clip differently.
 *
 * ONE SENTENCE FIRST. The owner's instruction for this screen was "It needs to
 * be simpler to use", so the page opens on a plain statement of how many clips
 * were compared and what the two labellers disagreed on most, and everything
 * else sits behind one button. A gym with one study never sees a picker.
 *
 * IT MEASURES THE LABELLING, NOT A PERSON. Nothing here names a coach or an
 * athlete, and the route sends nothing that could. The page says so, because a
 * table of disagreements reads as a scoreboard unless it is told not to.
 *
 * BODY POINTS ARE NOT IN IT YET, AND THE PAGE SAYS THAT TOO
 * (OD-2026-10-02-008). The owner has asked for elbow, shoulder, hip, knee and
 * foot labels; this report knows only today's punch and defense labels, and a
 * reader must not take silence about body points for agreement on them.
 *
 * Wire shapes are declared here rather than imported from the calibration
 * modules, which would pull the Postgres driver into the browser bundle.
 */

interface Study {
  calibration_project_id: string;
  name: string;
}

interface Rate {
  count: number;
  denominator: number;
  denominatorKind: string;
  rate: number | null;
}

interface DeltaSummary {
  count: number;
  medianAbsoluteMs: number | null;
}

interface AgreementPayload {
  project_name: string;
  status: 'available' | 'insufficient_data';
  comparison_count: number;
  minimum_comparisons: number;
  report: {
    disagreementCounts: Record<string, number>;
    disagreementRates: Record<string, Rate>;
    boundaryDeltas: Record<'start_ms' | 'contact_ms' | 'end_ms', DeltaSummary>;
    unknownRate: Rate;
    hedgedCertaintyRate: Rate;
    adjudicationRate: Rate;
  } | null;
  clip_progress: {
    total_clips: number;
    still_to_do_count: number;
    left_out_count: number;
  } | null;
  error?: string;
}

/** What each disagreement type means in words a coach would use. The keys are
 * comparison.ts's DISAGREEMENT_CATEGORIES; an unlisted one falls back to its
 * own name rather than vanishing. */
const PLAIN: Record<string, string> = {
  EVENT_MISSED: 'whether an action happened at all',
  BOUNDARY: 'the timing',
  PUNCH_TYPE: 'which punch it was',
  PHYSICAL_HAND: 'left or right hand',
  HAND_ROLE: 'lead or rear hand',
  STANCE: 'the stance',
  TARGET: 'where it was aimed',
  CONTACT_RESULT: 'how it landed',
  CONTACT_ZONE: 'where it landed',
  DEFENSE_TYPE: 'which defense it was',
  COMBINATION: 'which actions belonged together',
  COUNTER: 'what it answered, as a counter or a defense',
  VISIBILITY: 'how clearly it could be seen',
  CERTAINTY: 'how sure the coach was',
  OTHER: 'something else',
};

function plain(category: string): string {
  return PLAIN[category] ?? category.toLowerCase().replace(/_/g, ' ');
}

function times(count: number): string {
  return count === 1 ? 'once' : `${count} times`;
}

function clips(count: number): string {
  return count === 1 ? '1 clip' : `${count} clips`;
}

/** One action can differ on its timing in up to four places, and on its
 * combination or counter in two, so these are counted per difference and can
 * outnumber the pairs they are counted across. A share of them would read as
 * "200% of pairs", so they are given as a count and never as a percentage. */
const SEVERAL_PER_PAIR = new Set(['BOUNDARY', 'COMBINATION', 'COUNTER']);

function percent(rate: Rate): string {
  if (rate.rate === null) return '—';
  const rounded = Math.round(rate.rate * 100);
  return rate.count > 0 && rounded === 0 ? 'under 1%' : `${rounded}%`;
}

function howOften(category: string, rate: Rate): string {
  return SEVERAL_PER_PAIR.has(category)
    ? `${rate.count} ${rate.count === 1 ? 'difference' : 'differences'} across ${rate.denominator} ${rate.denominatorKind}`
    : `${rate.count} of ${rate.denominator} ${rate.denominatorKind}`;
}

/** The one sentence. Never states a percentage, so it cannot outrun the
 * minimum, and always says how many clips it is talking about. */
function headline(payload: AgreementPayload): string {
  if (payload.comparison_count === 0) {
    // Not "nobody has labelled": a clip two coaches finished can still be
    // waiting on a third, or on its pair being settled.
    return 'No clips can be compared yet. A clip is compared once two coaches have both finished labelling it.';
  }
  const compared = `${clips(payload.comparison_count)} compared.`;
  if (!payload.report) return compared;

  // EVERY KIND, NAMED, IN THE VOCABULARY'S OWN ORDER, AND NOT RANKED. The
  // counts are not on one scale -- an action can differ on its timing in four
  // places and on its punch type once -- so sorting them, or calling any of
  // them "top", would be a comparison the numbers cannot support. The counts
  // are in the detail, each beside what it was counted across.
  const kinds = Object.entries(payload.report.disagreementCounts)
    .filter(([, count]) => count > 0)
    .map(([category]) => plain(category));

  // Never "they agreed": no recorded disagreement is also what two empty sets
  // of labels produce.
  return kinds.length === 0
    ? `${compared} No disagreements were recorded on them.`
    : `${compared} The two coaches differed on: ${kinds.join(', ')}.`;
}

export default function LabelAgreementPage() {
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [studyId, setStudyId] = useState('');
  const [payload, setPayload] = useState<AgreementPayload | null>(null);
  const [error, setError] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  // The study most recently asked for. An answer for any other is dropped, so
  // a slow first study cannot paint its figures under the second one's name.
  const wanted = useRef('');

  const loadStudies = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/calibration/projects`, {
        credentials: 'include',
      });
      const body = (await response.json().catch(() => ({}))) as { projects?: Study[]; error?: string };
      if (!response.ok) throw new Error(body.error || 'The studies could not be read.');
      // A missing list is an error, not an empty gym.
      if (!body.projects) throw new Error('This page could not be loaded.');
      setStudies(body.projects);
      if (body.projects.length === 1) setStudyId(body.projects[0].calibration_project_id);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'This page could not be loaded.');
      setStudies([]);
    }
  }, []);

  const loadAgreement = useCallback(async (id: string) => {
    setPayload(null);
    setError('');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/calibration/qa-report?calibration_project_id=${encodeURIComponent(id)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      const body = (await response.json().catch(() => ({}))) as Partial<AgreementPayload>;
      if (!response.ok) throw new Error(body.error || 'The agreement figures could not be read.');
      if (
        typeof body.comparison_count !== 'number'
        || (body.report && !(body.report.disagreementRates && body.report.boundaryDeltas && body.report.unknownRate))
      ) {
        throw new Error('The agreement figures could not be read.');
      }
      if (wanted.current === id) setPayload(body as AgreementPayload);
    } catch (readError) {
      if (wanted.current !== id) return;
      setError(readError instanceof Error ? readError.message : 'The agreement figures could not be read.');
    }
  }, []);

  useEffect(() => {
    void (async () => { await loadStudies(); })();
  }, [loadStudies]);

  useEffect(() => {
    wanted.current = studyId;
    void (async () => {
      if (studyId) await loadAgreement(studyId);
      else setPayload(null);
    })();
  }, [studyId, loadAgreement]);

  const belowMinimum = payload?.status === 'insufficient_data' && payload.comparison_count > 0;
  const progress = payload?.clip_progress;
  const waiting = progress?.still_to_do_count ?? 0;
  const leftOut = progress?.left_out_count ?? 0;
  const rows = payload?.report
    ? Object.entries(payload.report.disagreementRates).filter(([, rate]) => rate.count > 0)
    : [];

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="mx-auto w-full max-w-3xl px-[var(--s4)] py-[var(--s5)]">
        <p className="t-eyebrow">Teach Shadow</p>
        <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-2xl)' }}>Label agreement</h1>

        {error ? (
          <div role="alert" className="alert alert--warning mt-[var(--s4)]">
            <span className="alert-icon" aria-hidden="true">&#9650;</span>
            <div className="alert-body">
              <p className="alert-title">Attention</p>
              <p className="alert-msg">{error}</p>
            </div>
          </div>
        ) : null}

        {studies === null ? <p className="t-body mt-[var(--s4)]">Reading studies&hellip;</p> : null}

        {studies && studies.length === 0 && !error ? (
          <p className="t-body mt-[var(--s4)]">
            There is no study yet. <Link href="/teach-shadow/cut" className="underline">Cut a study clip</Link> to start one.
          </p>
        ) : null}

        {studies && studies.length > 1 ? (
          <>
            <label className="t-eyebrow mt-[var(--s4)] block" htmlFor="study">Study</label>
            <select
              id="study"
              className="input mt-[var(--s2)]"
              value={studyId}
              onChange={(event) => { setStudyId(event.target.value); setShowDetail(false); }}
            >
              <option value="">Choose a study&hellip;</option>
              {studies.map((study) => (
                <option key={study.calibration_project_id} value={study.calibration_project_id}>
                  {study.name}
                </option>
              ))}
            </select>
          </>
        ) : null}

        {studyId && !payload && !error ? <p className="t-body mt-[var(--s4)]">Reading&hellip;</p> : null}

        {payload ? (
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <p className="t-eyebrow">{payload.project_name}</p>
            <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }} data-testid="headline">
              {headline(payload)}
            </p>

            {belowMinimum ? (
              <p className="t-body mt-[var(--s3)]" data-testid="below-minimum">
                Not enough clips yet for percentages: {payload.comparison_count} of the{' '}
                {payload.minimum_comparisons} needed.
              </p>
            ) : null}

            {progress && waiting > 0 ? (
              <p className="t-body mt-[var(--s3)]" data-testid="whats-left">
                Still to do: {waiting} of {clips(progress.total_clips)} not yet labelled by two coaches.
              </p>
            ) : null}

            {leftOut > 0 ? (
              <p className="t-body mt-[var(--s3)]" data-testid="left-out">
                {clips(leftOut)} not counted yet: a third coach is part-way through, the pair to
                compare has not been settled, or the labels use a different version of the vocabulary.
              </p>
            ) : null}

            <p className="t-body mt-[var(--s4)] max-w-2xl" data-testid="scope-note">
              This measures the labelling, not a coach and not an athlete. Body-point labels (elbow,
              shoulder, hips, knees, feet) are not included yet.
            </p>

            {payload.report && payload.comparison_count > 0 ? (
              <button
                type="button"
                className="btn mt-[var(--s4)]"
                aria-expanded={showDetail}
                onClick={() => { setShowDetail((open) => !open); }}
              >
                {showDetail ? 'Hide detail' : 'Show detail'}
              </button>
            ) : null}

            {showDetail && payload.report ? (
              <div className="mt-[var(--s4)]" data-testid="detail">
                {rows.length === 0 ? (
                  <p className="t-body">No disagreements recorded.</p>
                ) : (
                  <table className="w-full text-left">
                    <thead>
                      <tr>
                        <th scope="col" className="t-eyebrow">Disagreed on</th>
                        <th scope="col" className="t-eyebrow">How often</th>
                        <th scope="col" className="t-eyebrow">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(([category, rate]) => (
                        <tr key={category}>
                          <td className="t-body">{plain(category)}</td>
                          <td className="t-body">{howOften(category, rate)}</td>
                          <td className="t-body">{SEVERAL_PER_PAIR.has(category) ? '—' : percent(rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <ul className="t-body mt-[var(--s4)]">
                  {(['start_ms', 'contact_ms', 'end_ms'] as const).map((field) => {
                    const delta = payload.report?.boundaryDeltas[field];
                    if (!delta || delta.medianAbsoluteMs === null) return null;
                    const label = { start_ms: 'start', contact_ms: 'contact', end_ms: 'end' }[field];
                    return (
                      <li key={field}>
                        When they differed on the {label} of an action ({times(delta.count)}), the typical gap
                        was {delta.medianAbsoluteMs} ms.
                      </li>
                    );
                  })}
                  <li>
                    Marked &ldquo;could not tell&rdquo;: {payload.report.unknownRate.count} of{' '}
                    {payload.report.unknownRate.denominator} values ({percent(payload.report.unknownRate)}).
                  </li>
                  <li>
                    Marked &ldquo;probably&rdquo; or &ldquo;not sure&rdquo;: {payload.report.hedgedCertaintyRate.count} of{' '}
                    {payload.report.hedgedCertaintyRate.denominator} actions ({percent(payload.report.hedgedCertaintyRate)}).
                  </li>
                  <li>
                    Actions with a disagreement: {payload.report.adjudicationRate.denominator}. Reviewed by an
                    administrator so far: {payload.report.adjudicationRate.count}.
                  </li>
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}

        <p className="mt-[var(--s5)]">
          <Link href="/teach-shadow" className="underline">Back to Teach Shadow</Link>
        </p>
      </main>
    </RoleSessionGate>
  );
}
