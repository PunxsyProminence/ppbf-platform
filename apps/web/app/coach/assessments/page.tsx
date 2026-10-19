'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDay } from '@/src/lib/gymTime';
import BackHome from '@/components/BackHome';

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
 *
 * RETEST QUEUE (work order N7-01), headed "Open test and rating requests"
 * because a request may be a first test as well as a retest. The open
 * data-collection requests for the chosen athlete, from
 * GET /api/pilot/data-collection-requests, kept to the two kinds this page
 * records (a physical test, a skill rubric). Rows keep the
 * server's order (priority, then due date, then oldest first) and show the
 * stored due date as it is: the server gives no overdue flag, so this page
 * labels nothing overdue (N7-01-Q1, default C). Read-only: saving a jump here
 * does not close a request, so nothing here says it does.
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
  kind: 'jump' | 'skill_rating' | 'shuttle';
  administered_on: string;
  value: number;
  /** Shuttle only: the shuttle within the level in `value`. */
  shuttle?: number | null;
  skill_family_id: string | null;
  note: string;
}

interface AssessmentPayload {
  jump_protocols: JumpProtocol[];
  skill_families: SkillFamily[];
  rating_levels: RatingLevel[];
  history: HistoryEntry[];
  history_truncated?: boolean;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'unavailable';

/** The fields of a DataCollectionRequestRow this page reads. */
interface RetestRequest {
  request_id: string;
  athlete_id: string | null;
  request_kind: string;
  prompt_text: string;
  capture_hint: string;
  due_on: string | null;
  priority: string;
}

const RETEST_KINDS = new Set(['physical_test', 'skill_rubric']);

export default function CoachAssessmentsPage() {
  const [athletes, setAthletes] = useState<AuthorizedAthlete[]>([]);
  const [rosterState, setRosterState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [athleteId, setAthleteId] = useState('');
  const [data, setData] = useState<AssessmentPayload | null>(null);
  const [dataState, setDataState] = useState<LoadState>('idle');
  const [queue, setQueue] = useState<RetestRequest[]>([]);
  const [queueState, setQueueState] = useState<LoadState>('idle');

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

  // The athlete whose data is on screen. A response for anyone else (a slow
  // load for an athlete the coach has since switched away from) is dropped,
  // so one athlete's history can never render under another's name.
  const currentAthlete = useRef('');

  const loadAthlete = useCallback(async (id: string): Promise<boolean> => {
    if (!id) {
      setData(null);
      setDataState('idle');
      return true;
    }
    setDataState('loading');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/assessments?athlete_id=${encodeURIComponent(id)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('assessments');
      const payload = (await response.json()) as AssessmentPayload;
      if (currentAthlete.current !== id) return false;
      setData(payload);
      setDataState('loaded');
      return true;
    } catch {
      if (currentAthlete.current !== id) return false;
      setData(null);
      setDataState('unavailable');
      return false;
    }
  }, []);

  // Each queue load is numbered; only the latest may set state, so a late
  // answer to an earlier selection (even of the same athlete) is dropped.
  const latestQueue = useRef(0);

  const loadQueue = useCallback(async (id: string) => {
    const request = ++latestQueue.current;
    const stale = () => latestQueue.current !== request;
    setQueue([]);
    if (!id) {
      setQueueState('idle');
      return;
    }
    setQueueState('loading');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/data-collection-requests?athlete_id=${encodeURIComponent(id)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (stale()) return;
      if (!response.ok) throw new Error('queue');
      const payload = (await response.json()) as { requests?: RetestRequest[] };
      if (stale()) return;
      setQueue((payload.requests ?? []).filter((r) => r.athlete_id === id && RETEST_KINDS.has(r.request_kind)));
      setQueueState('loaded');
    } catch {
      if (stale()) return;
      setQueueState('unavailable');
    }
  }, []);

  function selectAthlete(id: string) {
    currentAthlete.current = id;
    setAthleteId(id);
    setData(null);
    // Every draft belongs to the athlete it was typed for.
    setJumpValue('');
    setJumpDate('');
    setJumpNote('');
    setRatings({});
    setRatingDate('');
    setRatingNote('');
    setMessage(null);
    void loadAthlete(id);
    void loadQueue(id);
  }

  /** Returns null when not saved, otherwise whether the history reload worked. */
  // A save that finishes after the coach has switched athlete must not touch
  // the new athlete's drafts or message: its result belongs to the old one.
  async function post(body: Record<string, unknown>): Promise<{ reloaded: boolean } | null> {
    const forAthlete = athleteId;
    const stillCurrent = () => currentAthlete.current === forAthlete;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/assessments`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_id: forAthlete, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        if (stillCurrent()) setMessage({ tone: 'error', text: payload.error ?? 'Not saved. Try again.' });
        return null;
      }
      if (!stillCurrent()) return null;
      const reloaded = await loadAthlete(forAthlete);
      return stillCurrent() ? { reloaded } : null;
    } catch {
      if (stillCurrent()) setMessage({ tone: 'error', text: 'Not saved: the server could not be reached.' });
      return null;
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
      setMessage({ tone: 'ok', text: ok.reloaded ? 'Jump saved.' : 'Jump saved. The history could not be reloaded; refresh to see it.' });
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
      const saved = `${entries.length} rating${entries.length === 1 ? '' : 's'} saved.`;
      setMessage({ tone: 'ok', text: ok.reloaded ? saved : `${saved} The history could not be reloaded; refresh to see it.` });
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
          <div className="mt-[var(--s3)]"><BackHome /></div>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Record one athlete&apos;s jump and your 1-5 rating for each skill family, and see their own
            history by date. Nothing here is added up, ranked or compared with anyone else.
          </p>
          <p className="t-body mt-[var(--s2)]">
            <Link href="/coach/test-day" className="underline">Test day: record the group&apos;s height, jumps and 20-m shuttle</Link>
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
              There are no active athletes in your gym yet.
            </p>
          )}
          {dataState === 'loading' && <p className="t-body">Loading…</p>}
          {dataState === 'unavailable' && (
            <p role="alert" className="t-body text-[color:var(--restricted-ink)]">
              This athlete&apos;s tests could not be loaded.
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

        {athleteId && queueState !== 'idle' && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s3)]">
            <h2 className="t-eyebrow">Open test and rating requests{athleteName ? ` for ${athleteName}` : ''}</h2>
            {queueState === 'loading' && <p className="t-body">Loading…</p>}
            {queueState === 'unavailable' && (
              <p role="alert" className="t-body text-[color:var(--restricted-ink)]">
                The open requests could not be loaded. Open requests may exist that are not shown here.
              </p>
            )}
            {queueState === 'loaded' && queue.length === 0 && (
              <p className="t-body text-[color:var(--bone-300)]">No open test or rating requests for this athlete.</p>
            )}
            {queueState === 'loaded' && queue.length > 0 && (
              <ol className="space-y-[var(--s2)]">
                {queue.map((r) => (
                  <li key={r.request_id}>
                    <span className="font-semibold">{r.prompt_text}</span>
                    <span className="block text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                      {r.due_on ? `Due ${day(r.due_on)}` : 'No due date'} · priority {r.priority}
                      {r.capture_hint ? ` · ${r.capture_hint}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

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
              {data.history_truncated && (
                <p className="t-body text-[color:var(--bone-300)]">
                  Showing the newest {data.history.length} entries. Older entries exist and are not shown here.
                </p>
              )}
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
                  {data.history.some((h) => h.kind === 'shuttle') && (
                    <div>
                      <h3 className="t-label">20-m shuttle run</h3>
                      <ul className="mt-[var(--s1)] space-y-[var(--s1)]">
                        {data.history.filter((h) => h.kind === 'shuttle').map((h) => (
                          <li key={h.assessment_id}>
                            {day(h.administered_on)}: <span className="font-semibold">Level {h.value}, shuttle {h.shuttle}</span>
                            {h.note ? <span className="text-[color:var(--bone-300)]"> — {h.note}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
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
