'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDay } from '@/src/lib/gymTime';

/*
 * Jump test and skill ratings for ONE athlete (map items 7-8).
 *
 * A coach picks an athlete, records a jump (countermovement height or broad
 * jump distance, best of three, in cm) and/or rates any of the twelve skill
 * families 1-5, and reads that athlete's own dated history back.
 *
 * WHAT THIS PAGE DOES NOT SHOW, on purpose: no total or average across skill
 * families, no ranking, no other athlete's numbers, no norm or "good/bad"
 * label. Each rating is one family on one date; each jump is one number on
 * one date. The 1-5 wording is Jason's (2026-10-04, option A).
 */

interface AuthorizedAthlete {
  athlete_id: string;
  full_name: string;
}

interface JumpProtocol {
  protocol_id: string;
  name: string;
  summary: string;
  equipment: string;
}

interface SkillFamily {
  skill_family_id: string;
  name: string;
}

interface RatingLevel {
  level: number;
  label: string;
  description: string;
}

interface HistoryEntry {
  assessment_id: string;
  protocol_id: string;
  kind: 'jump' | 'skill_rating';
  administered_on: string;
  value: number;
  skill_family_id: string | null;
  note: string;
}

interface AssessmentPayload {
  jump_protocols: JumpProtocol[];
  skill_families: SkillFamily[];
  rating_levels: RatingLevel[];
  history: HistoryEntry[];
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'unavailable';

export default function CoachAssessmentsPage() {
  const [athletes, setAthletes] = useState<AuthorizedAthlete[]>([]);
  const [rosterState, setRosterState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [athleteId, setAthleteId] = useState('');
  const [data, setData] = useState<AssessmentPayload | null>(null);
  const [dataState, setDataState] = useState<LoadState>('idle');

  const [jumpProtocol, setJumpProtocol] = useState('ppbf-jump-cmj-height');
  const [jumpValue, setJumpValue] = useState('');
  const [jumpDate, setJumpDate] = useState('');
  const [jumpNote, setJumpNote] = useState('');
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [ratingDate, setRatingDate] = useState('');
  const [ratingNote, setRatingNote] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/athletes`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('roster');
        const payload = (await response.json()) as { items?: AuthorizedAthlete[] };
        setAthletes(payload.items ?? []);
        setRosterState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setAthletes([]);
        setRosterState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  const loadAthlete = useCallback(async (id: string) => {
    if (!id) {
      setData(null);
      setDataState('idle');
      return;
    }
    setDataState('loading');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/assessments?athlete_id=${encodeURIComponent(id)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('assessments');
      setData((await response.json()) as AssessmentPayload);
      setDataState('loaded');
    } catch {
      setData(null);
      setDataState('unavailable');
    }
  }, []);

  function selectAthlete(id: string) {
    setAthleteId(id);
    setRatings({});
    setMessage(null);
    void loadAthlete(id);
  }

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/assessments`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setMessage({ tone: 'error', text: payload.error ?? 'Not saved. Try again.' });
        return false;
      }
      await loadAthlete(athleteId);
      return true;
    } catch {
      setMessage({ tone: 'error', text: 'Not saved: the server could not be reached.' });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitJump(event: FormEvent) {
    event.preventDefault();
    const value = Number(jumpValue);
    if (!jumpValue || !Number.isFinite(value)) {
      setMessage({ tone: 'error', text: 'Enter the best result in centimetres.' });
      return;
    }
    const ok = await post({
      kind: 'jump',
      protocol_id: jumpProtocol,
      value_cm: value,
      administered_on: jumpDate || undefined,
      note: jumpNote,
    });
    if (ok) {
      setJumpValue('');
      setJumpNote('');
      setMessage({ tone: 'ok', text: 'Jump saved.' });
    }
  }

  async function submitRatings(event: FormEvent) {
    event.preventDefault();
    const entries = Object.entries(ratings).map(([skill_family_id, level]) => ({ skill_family_id, level }));
    if (entries.length === 0) {
      setMessage({ tone: 'error', text: 'Rate at least one skill family.' });
      return;
    }
    const ok = await post({
      kind: 'skill_ratings',
      ratings: entries,
      administered_on: ratingDate || undefined,
      note: ratingNote,
    });
    if (ok) {
      setRatings({});
      setRatingNote('');
      setMessage({ tone: 'ok', text: `${entries.length} rating${entries.length === 1 ? '' : 's'} saved.` });
    }
  }

  const athleteName = athletes.find((a) => a.athlete_id === athleteId)?.full_name ?? '';
  const levelLabel = (level: number) => data?.rating_levels.find((l) => l.level === level)?.label ?? '';
  const day = (iso: string) => formatGymDay(iso) ?? iso;

  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/assessments"
      allowedRoles={['coach', 'admin']}
      room="floor"
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Testing</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Jump Test and Skill Ratings</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Record one athlete&apos;s jump and your 1-5 rating for each skill family, and see their own
            history by date. Nothing here is added up, ranked or compared with anyone else.
          </p>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <h2 className="t-eyebrow">Athlete</h2>
          <div className="field">
            <label htmlFor="assessAthlete" className="t-label">Which athlete</label>
            <select
              id="assessAthlete"
              value={athleteId}
              onChange={(event) => selectAthlete(event.target.value)}
              disabled={rosterState !== 'loaded' || athletes.length === 0}
              className="select"
            >
              <option value="">{rosterState === 'loading' ? 'Loading your athletes...' : 'Choose an athlete'}</option>
              {athletes.map((item) => (
                <option key={item.athlete_id} value={item.athlete_id}>{item.full_name}</option>
              ))}
            </select>
          </div>
          {rosterState === 'unavailable' && (
            <p role="alert" className="t-body text-[color:var(--restricted-ink)]">
              Your athletes could not be loaded. This is not a statement that you have none — reload and try again.
            </p>
          )}
          {rosterState === 'loaded' && athletes.length === 0 && (
            <p className="t-body text-[color:var(--bone-300)]">
              You are not the coach of record for any athlete and hold no active coverage.
            </p>
          )}
          {dataState === 'loading' && <p className="t-body">Loading…</p>}
          {dataState === 'unavailable' && (
            <p role="alert" className="t-body text-[color:var(--restricted-ink)]">
              This athlete&apos;s tests could not be loaded. Nothing was changed.
            </p>
          )}
          {message && (
            <p
              role={message.tone === 'error' ? 'alert' : 'status'}
              className={`t-body ${message.tone === 'error' ? 'text-[color:var(--restricted-ink)]' : ''}`}
            >
              {message.text}
            </p>
          )}
        </section>

        {athleteId && data && dataState === 'loaded' && (
          <>
            <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
              <h2 className="t-eyebrow">Jump test{athleteName ? ` for ${athleteName}` : ''}</h2>
              <form onSubmit={submitJump} className="space-y-[var(--s4)]">
                <fieldset className="space-y-[var(--s2)]">
                  <legend className="t-label">Test</legend>
                  {data.jump_protocols.map((p) => (
                    <label key={p.protocol_id} className="flex items-start gap-[var(--s2)]">
                      <input
                        type="radio"
                        name="jumpProtocol"
                        value={p.protocol_id}
                        checked={jumpProtocol === p.protocol_id}
                        onChange={() => setJumpProtocol(p.protocol_id)}
                      />
                      <span>
                        <span className="font-semibold">{p.name}</span>
                        <span className="block text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                          {p.summary} Needs: {p.equipment}.
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="grid gap-[var(--s4)] sm:grid-cols-2">
                  <div className="field">
                    <label htmlFor="jumpValue" className="t-label">Best of 3 (cm)</label>
                    <input
                      id="jumpValue"
                      type="number"
                      inputMode="decimal"
                      step="0.1"
                      min="0"
                      value={jumpValue}
                      onChange={(event) => setJumpValue(event.target.value)}
                      className="input"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="jumpDate" className="t-label">Test date (blank = today)</label>
                    <input
                      id="jumpDate"
                      type="date"
                      value={jumpDate}
                      onChange={(event) => setJumpDate(event.target.value)}
                      className="input"
                    />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="jumpNote" className="t-label">Note (optional)</label>
                  <input
                    id="jumpNote"
                    value={jumpNote}
                    maxLength={500}
                    onChange={(event) => setJumpNote(event.target.value)}
                    className="input"
                    placeholder="App or mat used, conditions"
                  />
                </div>
                <button type="submit" className="btn" disabled={saving}>Save jump</button>
              </form>
            </section>

            <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
              <h2 className="t-eyebrow">Skill ratings{athleteName ? ` for ${athleteName}` : ''}</h2>
              <ol className="space-y-[var(--s1)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                {data.rating_levels.map((l) => (
                  <li key={l.level}><span className="font-semibold">{l.level} {l.label}:</span> {l.description}</li>
                ))}
              </ol>
              <form onSubmit={submitRatings} className="space-y-[var(--s4)]">
                <div className="grid gap-[var(--s3)] sm:grid-cols-2">
                  {data.skill_families.map((family) => (
                    <div key={family.skill_family_id} className="field">
                      <label htmlFor={`rate-${family.skill_family_id}`} className="t-label">{family.name}</label>
                      <select
                        id={`rate-${family.skill_family_id}`}
                        value={ratings[family.skill_family_id] ?? ''}
                        onChange={(event) => {
                          const next = { ...ratings };
                          if (event.target.value) next[family.skill_family_id] = Number(event.target.value);
                          else delete next[family.skill_family_id];
                          setRatings(next);
                        }}
                        className="select"
                      >
                        <option value="">Not rated</option>
                        {data.rating_levels.map((l) => (
                          <option key={l.level} value={l.level}>{l.level} {l.label}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="grid gap-[var(--s4)] sm:grid-cols-2">
                  <div className="field">
                    <label htmlFor="ratingDate" className="t-label">Rating date (blank = today)</label>
                    <input
                      id="ratingDate"
                      type="date"
                      value={ratingDate}
                      onChange={(event) => setRatingDate(event.target.value)}
                      className="input"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="ratingNote" className="t-label">Note (optional)</label>
                    <input
                      id="ratingNote"
                      value={ratingNote}
                      maxLength={500}
                      onChange={(event) => setRatingNote(event.target.value)}
                      className="input"
                    />
                  </div>
                </div>
                <button type="submit" className="btn" disabled={saving}>Save ratings</button>
              </form>
            </section>

            <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
              <h2 className="t-eyebrow">History{athleteName ? ` for ${athleteName}` : ''}</h2>
              {data.history.length === 0 ? (
                <p className="t-body text-[color:var(--bone-300)]">Nothing recorded yet.</p>
              ) : (
                <>
                  {data.jump_protocols.map((p) => {
                    const rows = data.history.filter((h) => h.protocol_id === p.protocol_id);
                    if (rows.length === 0) return null;
                    return (
                      <div key={p.protocol_id}>
                        <h3 className="t-label">{p.name}</h3>
                        <ul className="mt-[var(--s1)] space-y-[var(--s1)]">
                          {rows.map((h) => (
                            <li key={h.assessment_id}>
                              {day(h.administered_on)}: <span className="font-semibold">{h.value} cm</span>
                              {h.note ? <span className="text-[color:var(--bone-300)]"> — {h.note}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                  {data.skill_families.map((family) => {
                    const rows = data.history.filter((h) => h.skill_family_id === family.skill_family_id);
                    if (rows.length === 0) return null;
                    return (
                      <div key={family.skill_family_id}>
                        <h3 className="t-label">{family.name}</h3>
                        <ul className="mt-[var(--s1)] space-y-[var(--s1)]">
                          {rows.map((h) => (
                            <li key={h.assessment_id}>
                              {day(h.administered_on)}: <span className="font-semibold">{h.value} {levelLabel(h.value)}</span>
                              {h.note ? <span className="text-[color:var(--bone-300)]"> — {h.note}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </RoleStandaloneView>
  );
}
