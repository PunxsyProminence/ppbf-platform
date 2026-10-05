'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import type {
  AthleteCohortReport,
  CohortDefinitionRow,
  CompetenceLevelRow,
} from '@/src/server/pilot/competenceCohorts';

// Which room an athlete stands in, and why.
//
// A cohort is a RULE, not a roster. Nothing here writes a membership row: an
// athlete moves rooms the moment their assessed level or logged hours change,
// so there is no list to keep in sync and no stale membership to correct.
//
// AGE IS NOT A GROUPING AXIS. Athletes group by competence and time in the
// programme. Where a room does carry an age bound it is a regulatory one, and
// this page always shows it next to the rulebook that imposes it -- a bare age
// number with no citation is an invented age band, which is the thing the
// schema constraint exists to reject.

type Level = CompetenceLevelRow;
type Cohort = CohortDefinitionRow;
type Report = AthleteCohortReport;
type AthleteChoice = { athlete_id: string; full_name: string };

// A copy, because the server module's own list sits beside database code a
// client bundle must not pull in. page.test.tsx asserts the rendered options
// equal COMPETENCE_DOMAINS, so the two cannot drift.
const LEVEL_DOMAINS = [
  'stance_base',
  'footwork',
  'offense',
  'defense',
  'distance_timing',
  'decision_making',
  'composure',
  'conditioning',
  'ring_craft',
  'partner_control',
] as const;

function levelRange(cohort: Cohort): string {
  const { min_level_ordinal: min, max_level_ordinal: max } = cohort;
  if (min === null && max === null) return 'Any level';
  if (min === null) return `Up to level ${max}`;
  if (max === null) return `Level ${min} and above`;
  return `Levels ${min}-${max}`;
}

function CoachCohorts() {
  const [levels, setLevels] = useState<Level[]>([]);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [athleteId, setAthleteId] = useState('');
  const [athleteChoices, setAthleteChoices] = useState<AthleteChoice[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');

  // Setting a level (OD-2026-10-03-002 section 6). The route decides who may;
  // this form only collects the choice and shows the rooms it now gives.
  const [levelDomain, setLevelDomain] = useState<string>(LEVEL_DOMAINS[0]);
  const [levelKey, setLevelKey] = useState('');
  const [levelNote, setLevelNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');

  // Everything the form holds belongs to one athlete. Cleared whenever the
  // athlete changes, so a note typed about one child (left behind by a failed
  // save) can never be saved against the next.
  const resetLevelForm = useCallback(() => {
    setLevelDomain(LEVEL_DOMAINS[0]);
    setLevelKey('');
    setLevelNote('');
    setSaveError('');
    setSaveMessage('');
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/competence-cohorts`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('The cohort rules could not be loaded.');
      const payload = (await response.json()) as { levels?: Level[]; cohorts?: Cohort[] };
      setLevels(payload.levels ?? []);
      setCohorts(payload.cohorts ?? []);
      setLoadError('');
    } catch (error) {
      setLevels([]);
      setCohorts([]);
      setLoadError(error instanceof Error ? error.message : 'The cohort rules could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          method: 'GET', credentials: 'include',
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { items?: AthleteChoice[] };
        if (Array.isArray(payload.items)) setAthleteChoices(payload.items);
      } catch {
        // The roster is a convenience only. Coaches can still enter an id.
      }
    })();
  }, []);

  const lookUp = useCallback(async (id: string) => {
    const trimmed = id.trim();
    if (trimmed === '') return;

    // Clearing the previous athlete's report and error together: leaving either
    // in place shows one athlete's assessment under another athlete's id.
    setReport(null);
    setReportError('');
    resetLevelForm();
    setReportLoading(true);
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/competence-cohorts?athlete_id=${encodeURIComponent(trimmed)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (response.status === 404) throw new Error('No athlete with that id in this gym.');
      if (!response.ok) throw new Error('That athlete could not be looked up.');
      const payload = (await response.json()) as { report?: Report };
      setReport(payload.report ?? null);
    } catch (error) {
      setReport(null);
      setReportError(error instanceof Error ? error.message : 'That athlete could not be looked up.');
    } finally {
      setReportLoading(false);
    }
  }, [resetLevelForm]);

  const saveLevel = useCallback(async () => {
    if (!report || levelKey === '') return;
    setSaving(true);
    setSaveError('');
    setSaveMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/competence-cohorts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          athlete_id: report.athlete_id,
          domain: levelDomain,
          level_key: levelKey,
          evidence_note: levelNote,
        }),
      });
      if (response.status === 403) throw new Error('You can only set levels for athletes you coach or cover.');
      if (!response.ok) throw new Error('That level could not be saved.');
      const payload = (await response.json()) as { result?: { changed?: boolean }; report?: Report };
      if (payload.report) setReport(payload.report);
      if (payload.result?.changed === false) {
        // Nothing was written, so the note was not recorded either: keep it
        // in the field rather than clearing it as if it had been saved.
        setSaveMessage('No change: that is already the level.');
      } else {
        setLevelNote('');
        setSaveMessage('Saved. The rooms below are updated.');
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'That level could not be saved.');
    } finally {
      setSaving(false);
    }
  }, [report, levelDomain, levelKey, levelNote]);

  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Cohorts</h1>
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            Athletes group by what they can do and how long they have actually trained -- not by age.
            A cohort is a rule, so an athlete moves rooms as soon as their assessed level or logged
            hours change. Nothing here is a saved list.
          </p>
          <Link href="/coach/session-scripts" className="btn btn--ghost mt-[var(--s4)]">
            Back to session scripts
          </Link>
        </header>

        <section className="mat-leather mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command text-[length:var(--t-lg)]">Where does an athlete fit?</h2>
          <div className="mt-[var(--s4)] flex flex-wrap items-end gap-[var(--s3)]">
            <div className="field">
              <label htmlFor="athlete-id" className="t-label">Athlete id</label>
              <input
                id="athlete-id"
                list="cohort-athletes"
                value={athleteId}
                onChange={(event) => {
                  setAthleteId(event.target.value);
                  setReport(null);
                  setReportError('');
                  resetLevelForm();
                }}
                // Also locked while saving: a save that lands after the id
                // changed would put the previous athlete's rooms back on screen.
                disabled={reportLoading || saving}
                className="input"
                placeholder="ath_..."
              />
              <datalist id="cohort-athletes">
                {athleteChoices.map((athlete) => (
                  <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                ))}
              </datalist>
            </div>
            <button
              type="button"
              onClick={() => void lookUp(athleteId)}
              disabled={reportLoading || saving || athleteId.trim() === ''}
              className="btn disabled:cursor-not-allowed disabled:opacity-60"
            >
              {reportLoading ? 'Looking up...' : 'Look up'}
            </button>
          </div>

          {reportError && (
            <p role="alert" className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
              {reportError}
            </p>
          )}

          {report && (
            <div className="mt-[var(--s5)]">
              <p className="t-label">
                {report.tenure
                  ? `${report.tenure.sessions_logged} sessions logged, ${Number(report.tenure.hours_logged).toFixed(1)} hours -- ${report.tenure.tenure_band.replace(/_/g, ' ')}`
                  : 'No logged training yet.'}
              </p>

              {report.competence.length === 0 ? (
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                  No assessed competence levels yet.
                </p>
              ) : (
                <ul className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
                  {report.competence.map((row) => (
                    <li
                      key={row.competence_id}
                      className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]"
                    >
                      {row.domain.replace(/_/g, ' ')}: {row.display_name}
                    </li>
                  ))}
                </ul>
              )}

              {levels.length > 0 && (
                <form
                  className="mt-[var(--s5)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveLevel();
                  }}
                >
                  <h3 className="t-command text-[length:var(--t-md)]">Set a level</h3>
                  <div className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)]">
                    <div className="field">
                      <label htmlFor="level-domain" className="t-label">Area</label>
                      <select
                        id="level-domain"
                        value={levelDomain}
                        onChange={(event) => { setLevelDomain(event.target.value); setSaveMessage(''); }}
                        disabled={saving}
                        className="input"
                      >
                        {LEVEL_DOMAINS.map((domain) => (
                          <option key={domain} value={domain}>{domain.replace(/_/g, ' ')}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="level-key" className="t-label">Level</label>
                      <select
                        id="level-key"
                        value={levelKey}
                        onChange={(event) => { setLevelKey(event.target.value); setSaveMessage(''); }}
                        disabled={saving}
                        className="input"
                      >
                        <option value="">Choose a level</option>
                        {levels.map((level) => (
                          <option key={level.level_key} value={level.level_key}>
                            {level.ordinal}. {level.display_name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field grow">
                      <label htmlFor="level-note" className="t-label">What you saw (optional)</label>
                      <input
                        id="level-note"
                        value={levelNote}
                        onChange={(event) => setLevelNote(event.target.value)}
                        maxLength={500}
                        disabled={saving}
                        className="input"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={saving || levelKey === ''}
                      className="btn disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {saving ? 'Saving...' : 'Save level'}
                    </button>
                  </div>
                  {saveError && (
                    <p role="alert" className="mt-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
                      {saveError}
                    </p>
                  )}
                  {saveMessage && (
                    <p role="status" className="t-body mt-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                      {saveMessage}
                    </p>
                  )}
                </form>
              )}

              <h3 className="t-command mt-[var(--s5)] text-[length:var(--t-md)]">Rooms</h3>
              <ul className="mt-[var(--s3)] flex flex-col gap-[var(--s3)]">
                {report.fits.map((fit) => (
                  <li
                    key={fit.cohort_id}
                    className={`rounded-[var(--r-md)] border-2 bg-[rgba(0,0,0,.28)] p-[var(--s4)] ${
                      fit.eligible ? 'border-[var(--cleared)]' : 'border-[color:rgb(var(--brass-400-rgb)_/_.22)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
                      <h4 className="t-command text-[length:var(--t-sm)]">{fit.cohort_name}</h4>
                      <span className={fit.eligible ? 'text-[var(--cleared-ink)]' : 'text-[color:var(--bone-300)]'}>
                        {fit.eligible ? 'Fits' : 'Not yet'}
                      </span>
                    </div>

                    {fit.eligible && fit.requires_coach_approval && (
                      <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                        Still needs a coach to sign off before this room.
                      </p>
                    )}

                    {fit.unmet.length > 0 && (
                      <ul className="mt-[var(--s2)] flex flex-col gap-[var(--s2)]">
                        {fit.unmet.map((reason) => (
                          <li key={`${fit.cohort_id}-${reason}`} className="t-body text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="mt-[var(--s6)]">
          <h2 className="t-command text-[length:var(--t-lg)]">The rooms</h2>

          {loading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}

          {!loading && loadError && (
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">{loadError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to load, not an empty set of rooms.
              </p>
            </div>
          )}

          {!loading && !loadError && cohorts.length === 0 && (
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No cohorts defined yet.</p>
          )}

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            {cohorts.map((cohort) => (
              <article key={cohort.cohort_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-baseline justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{cohort.cohort_name}</h3>
                  <span className="plaque">{cohort.contact_permitted.replace(/_/g, ' ')}</span>
                </div>
                <p className="t-label mt-[var(--s2)]">{levelRange(cohort)}</p>
                {cohort.required_domains.trim() !== '' && (
                  <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                    Requires: {cohort.required_domains.split(',').map((d) => d.trim().replace(/_/g, ' ')).join(', ')}
                  </p>
                )}
                {cohort.notes.trim() !== '' && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{cohort.notes}</p>
                )}
                {(cohort.min_age_regulatory !== null || cohort.max_age_regulatory !== null) && (
                  // Never rendered without its citation: an age bound with no
                  // cited rulebook is an invented age band.
                  <p className="t-body mt-[var(--s3)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                    Regulatory age bound
                    {cohort.min_age_regulatory !== null ? ` from ${cohort.min_age_regulatory}` : ''}
                    {cohort.max_age_regulatory !== null ? ` to ${cohort.max_age_regulatory}` : ''}
                    {' '}-- {cohort.regulatory_basis}
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>

        {levels.length > 0 && (
          <section className="mt-[var(--s6)]">
            <h2 className="t-command text-[length:var(--t-lg)]">The ladder</h2>
            <ol className="mt-[var(--s4)] flex flex-col gap-[var(--s3)]">
              {levels.map((level) => (
                <li
                  key={level.level_key}
                  className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
                >
                  <div className="flex items-baseline gap-[var(--s3)]">
                    <span className="plaque">{level.ordinal}</span>
                    <h3 className="t-command text-[length:var(--t-sm)]">{level.display_name}</h3>
                  </div>
                  {/* The observable test is the whole point of a level: what a
                      coach must SEE to assign it, rather than a feeling. */}
                  <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{level.observable_test}</p>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </main>
  );
}

export default function CoachCohortsPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <CoachCohorts />
    </RoleSessionGate>
  );
}
