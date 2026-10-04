'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/src/lib/apiBase';
import { formatGymDay, gymDayIso } from '@/src/lib/gymTime';

/*
 * Coach floor entry for sparring exposure: what the coach SAW during one
 * sparring segment, for one athlete, and that athlete's recent entries.
 *
 * COUNTS ONLY. No damage score, no risk index, no recommended limit, no
 * clearance -- the sparring migration's own refusal and Jason's. The summary
 * below the form is the route's raw counts (segments, a plain sum of time,
 * segments by type) and nothing computed from them. The coach reads it and
 * decides.
 *
 * A FAILED READ IS NEVER "NO SPARRING". If the entries cannot be loaded the
 * page says so in words; an empty list only ever means the read succeeded and
 * found nothing in the window.
 *
 * The athlete picker is GET /api/pilot/coach/athletes, the same access set
 * the sparring route enforces, so the picker never offers a child the route
 * would refuse.
 */

const SPARRING_TYPES = [
  ['technical', 'Technical'],
  ['play', 'Play'],
  ['conditioned', 'Conditioned'],
  ['game', 'Game'],
  ['hard', 'Hard'],
] as const;
const INTENSITIES = [['light', 'Light'], ['moderate', 'Moderate'], ['firm', 'Firm'], ['unclear', 'Unclear']] as const;
const HEAD_CONTACT = [
  ['none', 'None'], ['incidental', 'Incidental'], ['regular', 'Regular'], ['frequent', 'Frequent'], ['unclear', 'Unclear'],
] as const;
const PRESENTATIONS = [
  ['normal', 'Normal'], ['slowed', 'Slowed'], ['unsteady', 'Unsteady'], ['withdrawn', 'Withdrawn'], ['other_concern', 'Other concern'],
] as const;
const WINDOWS = [7, 28, 90] as const;

const label = (pairs: ReadonlyArray<readonly [string, string]>, value: string | null) =>
  pairs.find(([key]) => key === value)?.[1] ?? value ?? '—';

interface AuthorizedAthlete { athlete_id: string; full_name: string }
interface StopRule { universal_rule_id: string; ordinal: number; condition_text: string }
interface Entry {
  exposure_id: string;
  sparring_day: string;
  segment_number: number;
  sparring_type: string;
  time_under_impact_sec: number;
  round_equivalent: string | null;
  headgear_worn: boolean | null;
  glove_oz: number | null;
  coach_observed_intensity: string;
  coach_observed_head_contact: string;
  athlete_presentation: string | null;
  coach_note: string;
  stopped_early: boolean;
  stop_reason: string | null;
}
interface Counts {
  total_segments: number;
  total_time_under_impact_sec: number;
  segments_by_type: Record<string, number>;
}
interface Recent { entries: Entry[]; entries_truncated: boolean; counts: Counts; stop_rules: StopRule[] }

const minSec = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const EMPTY_FORM = {
  sessionDate: '',
  sparringType: '',
  minutes: '',
  seconds: '',
  rounds: '',
  intensity: '',
  headContact: '',
  presentation: '',
  headgear: '',
  gloveOz: '',
  stoppedEarly: false,
  stopRuleId: '',
  stopReason: '',
  note: '',
};

export default function CoachSparringExposurePage() {
  const [athletes, setAthletes] = useState<AuthorizedAthlete[]>([]);
  const [rosterState, setRosterState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [athleteId, setAthleteId] = useState('');
  const [windowDays, setWindowDays] = useState<number>(28);
  const [recent, setRecent] = useState<Recent | null>(null);
  const [recentState, setRecentState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');
  const [form, setForm] = useState({ ...EMPTY_FORM, sessionDate: gymDayIso() ?? '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/athletes`, {
          method: 'GET', credentials: 'include', signal: controller.signal,
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

  const fetchRecent = useCallback(async (id: string, days: number, signal?: AbortSignal): Promise<Recent> => {
    const response = await fetch(
      `${apiBase()}/api/pilot/coach/sparring-exposure?athlete_id=${encodeURIComponent(id)}&days=${days}`,
      { method: 'GET', credentials: 'include', signal },
    );
    if (!response.ok) throw new Error('recent');
    return (await response.json()) as Recent;
  }, []);

  // 'loading' is set by whoever changed the athlete or window; this only
  // lands the answer. The abort keeps a slow read for the previous athlete
  // from arriving under the next one.
  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await fetchRecent(athleteId, windowDays, controller.signal);
        setRecent(data);
        setRecentState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setRecent(null);
        setRecentState('unavailable');
      }
    })();
    return () => controller.abort();
  }, [athleteId, windowDays, fetchRecent]);

  const set = (patch: Partial<typeof EMPTY_FORM>) => setForm((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !ready) return;
    setMessage(null);
    const body: Record<string, unknown> = {
      athlete_id: athleteId,
      session_date: form.sessionDate,
      sparring_type: form.sparringType,
      time_under_impact_sec: seconds,
      coach_observed_intensity: form.intensity,
      coach_observed_head_contact: form.headContact,
      athlete_presentation: form.presentation,
    };
    if (form.rounds) body.round_equivalent = Number(form.rounds);
    if (form.headgear) body.headgear_worn = form.headgear === 'yes';
    if (form.gloveOz) body.glove_oz = Number(form.gloveOz);
    if (form.note.trim()) body.coach_note = form.note;
    if (form.stoppedEarly) {
      body.stopped_early = true;
      body.stop_reason = form.stopReason;
      if (form.stopRuleId) body.stop_rule_id = form.stopRuleId;
    }

    setSaving(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/sparring-exposure`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setMessage({ kind: 'error', text: payload.error ?? 'Not saved. Try again.' });
        return;
      }
      setMessage({ kind: 'ok', text: 'Saved.' });
      // Keep the day and the gear for the next round; clear what was observed.
      setForm((current) => ({
        ...EMPTY_FORM, sessionDate: current.sessionDate, headgear: current.headgear, gloveOz: current.gloveOz,
      }));
      try {
        setRecent(await fetchRecent(athleteId, windowDays));
        setRecentState('loaded');
      } catch {
        setRecent(null);
        setRecentState('unavailable');
      }
    } catch {
      setMessage({ kind: 'error', text: 'Not saved: the server could not be reached. Try again.' });
    } finally {
      setSaving(false);
    }
  }

  // Whole minutes and seconds, 0:01 to 30:00 -- the route's 1-1800 s.
  const minutes = Number(form.minutes || 0);
  const secondsPart = Number(form.seconds || 0);
  const seconds = minutes * 60 + secondsPart;
  const timeValid = Number.isInteger(minutes) && Number.isInteger(secondsPart) && minutes >= 0
    && secondsPart >= 0 && secondsPart <= 59 && seconds >= 1 && seconds <= 1800;
  const ready = Boolean(athleteId && form.sessionDate && form.sparringType && form.intensity && form.headContact
    && form.presentation && timeValid && (!form.stoppedEarly || form.stopReason.trim()));

  const choice = (id: string, text: string, value: string, pairs: ReadonlyArray<readonly [string, string]>,
    onChange: (value: string) => void) => (
    <div className="field">
      <label htmlFor={id} className="t-label">{text}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className="select">
        <option value="">Choose</option>
        {pairs.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select>
    </div>
  );

  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/sparring-exposure"
      allowedRoles={['coach', 'admin']}
      room="floor"
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Sparring</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Sparring Record</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Record what you saw in one sparring segment. The app counts and shows it. It does not score it, set a
            limit, or clear anyone. You decide.
          </p>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <div className="field">
            <label htmlFor="sparAthlete" className="t-label">Which athlete</label>
            <select
              id="sparAthlete"
              value={athleteId}
              onChange={(event) => {
                // Clear the previous athlete's entries before the new read
                // lands, so one child's record is never shown under another.
                setRecent(null);
                setRecentState(event.target.value ? 'loading' : 'idle');
                setAthleteId(event.target.value);
                setMessage(null);
                // What was observed belongs to the athlete it was observed on;
                // keep only the day and the gear.
                setForm((current) => ({
                  ...EMPTY_FORM, sessionDate: current.sessionDate, headgear: current.headgear, gloveOz: current.gloveOz,
                }));
              }}
              // Locked while a save is in flight, so its result (and the
              // re-read after it) cannot land under a different athlete.
              disabled={saving || rosterState !== 'loaded' || athletes.length === 0}
              className="select"
            >
              <option value="">{rosterState === 'loading' ? 'Loading your athletes...' : 'Choose an athlete'}</option>
              {athletes.map((item) => <option key={item.athlete_id} value={item.athlete_id}>{item.full_name}</option>)}
            </select>
          </div>
          {rosterState === 'unavailable' && (
            <p role="alert" className="text-[var(--restricted-ink)]">Your athlete list could not be loaded. Reload to try again.</p>
          )}
          {rosterState === 'loaded' && athletes.length === 0 && <p>No athletes are available to you.</p>}
        </section>

        {athleteId && (
          <form onSubmit={submit} className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
            <h2 className="t-eyebrow">One segment</h2>
            <div className="field">
              <label htmlFor="sparDay" className="t-label">Day</label>
              <input id="sparDay" type="date" value={form.sessionDate} max={gymDayIso() ?? undefined} required
                onChange={(event) => set({ sessionDate: event.target.value })} className="input" />
            </div>
            {choice('sparType', 'Type of sparring', form.sparringType, SPARRING_TYPES, (v) => set({ sparringType: v }))}
            <fieldset className="field">
              <legend className="t-label">Time in live exchanges (head contact possible) — not round length</legend>
              <div className="flex gap-[var(--s3)]">
                <input aria-label="Minutes" type="number" min={0} max={30} inputMode="numeric" value={form.minutes}
                  onChange={(event) => set({ minutes: event.target.value })} className="input" placeholder="min" />
                <input aria-label="Seconds" type="number" min={0} max={59} inputMode="numeric" value={form.seconds}
                  onChange={(event) => set({ seconds: event.target.value })} className="input" placeholder="sec" />
              </div>
              {(form.minutes || form.seconds) && !timeValid && (
                <p className="text-[var(--restricted-ink)]">Whole minutes and seconds, from 0:01 up to 30:00.</p>
              )}
            </fieldset>
            <div className="field">
              <label htmlFor="sparRounds" className="t-label">Rounds (optional)</label>
              <input id="sparRounds" type="number" min={0.25} max={99} step={0.25} inputMode="decimal" value={form.rounds}
                onChange={(event) => set({ rounds: event.target.value })} className="input" />
            </div>
            {choice('sparIntensity', 'Intensity you saw', form.intensity, INTENSITIES, (v) => set({ intensity: v }))}
            {choice('sparHead', 'Head contact you saw', form.headContact, HEAD_CONTACT, (v) => set({ headContact: v }))}
            {choice('sparAfter', 'After sparring, the athlete looked', form.presentation, PRESENTATIONS,
              (v) => set({ presentation: v }))}
            {choice('sparHeadgear', 'Headgear (optional)', form.headgear, [['yes', 'Yes'], ['no', 'No']],
              (v) => set({ headgear: v }))}
            <div className="field">
              <label htmlFor="sparGloves" className="t-label">Glove oz (optional)</label>
              <input id="sparGloves" type="number" min={8} max={20} inputMode="numeric" value={form.gloveOz}
                onChange={(event) => set({ gloveOz: event.target.value })} className="input" />
            </div>
            <label className="flex items-center gap-[var(--s3)]">
              <input type="checkbox" checked={form.stoppedEarly}
                onChange={(event) => set({ stoppedEarly: event.target.checked, stopRuleId: '', stopReason: '' })} />
              <span className="t-label">Stopped early</span>
            </label>
            {form.stoppedEarly && (
              <>
                {recent && recent.stop_rules.length > 0 && choice('sparStopRule', 'Stop rule (optional)', form.stopRuleId,
                  recent.stop_rules.map((rule) => [rule.universal_rule_id, rule.condition_text] as const),
                  (v) => set({ stopRuleId: v }))}
                {recentState === 'unavailable' && (
                  <p>The gym&apos;s stop rules could not be loaded. Describe what ended it below.</p>
                )}
                <div className="field">
                  <label htmlFor="sparStopReason" className="t-label">What ended it</label>
                  <textarea id="sparStopReason" value={form.stopReason} maxLength={500}
                    onChange={(event) => set({ stopReason: event.target.value })} className="input" />
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="sparNote" className="t-label">Note (optional)</label>
              <textarea id="sparNote" value={form.note} maxLength={2000}
                onChange={(event) => set({ note: event.target.value })} className="input" />
            </div>
            <button type="submit" disabled={!ready || saving} className="btn disabled:cursor-not-allowed disabled:opacity-60">
              {saving ? 'Saving...' : 'Save segment'}
            </button>
            {message && (
              <p role={message.kind === 'error' ? 'alert' : 'status'}
                className={message.kind === 'error' ? 'text-[var(--restricted-ink)]' : undefined}>
                {message.text}
              </p>
            )}
          </form>
        )}

        {athleteId && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
            <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
              <h2 className="t-eyebrow">Recent sparring</h2>
              <select aria-label="Window" value={windowDays} disabled={saving}
                onChange={(event) => { setRecentState('loading'); setWindowDays(Number(event.target.value)); }}
                className="select">
                {WINDOWS.map((days) => <option key={days} value={days}>Last {days} days</option>)}
              </select>
            </div>
            {recentState === 'loading' && <p>Loading...</p>}
            {recentState === 'unavailable' && (
              <p role="alert" className="text-[var(--restricted-ink)]">
                Recent sparring could not be loaded. This does not mean there was none.
              </p>
            )}
            {recentState === 'loaded' && recent && (
              <>
                <p data-testid="spar-counts">
                  {recent.counts.total_segments} segments, {minSec(recent.counts.total_time_under_impact_sec)} in live
                  exchanges.{' '}
                  {SPARRING_TYPES.filter(([key]) => recent.counts.segments_by_type[key])
                    .map(([key, name]) => `${name}: ${recent.counts.segments_by_type[key]}`).join(', ')}
                </p>
                {recent.entries.length === 0 && <p>No sparring recorded in this window.</p>}
                {recent.entries_truncated && <p>Showing the latest {recent.entries.length} entries.</p>}
                <ul className="space-y-[var(--s3)]">
                  {recent.entries.map((entry) => (
                    <li key={entry.exposure_id} className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s3)]">
                      <p className="font-semibold">
                        {formatGymDay(entry.sparring_day) ?? entry.sparring_day} · segment {entry.segment_number} ·{' '}
                        {label(SPARRING_TYPES, entry.sparring_type)} · {minSec(entry.time_under_impact_sec)}
                        {entry.round_equivalent ? ` · ${Number(entry.round_equivalent)} rounds` : ''}
                      </p>
                      <p>
                        Intensity {label(INTENSITIES, entry.coach_observed_intensity)} · head contact{' '}
                        {label(HEAD_CONTACT, entry.coach_observed_head_contact)} · after:{' '}
                        {label(PRESENTATIONS, entry.athlete_presentation)}
                        {entry.headgear_worn !== null ? ` · headgear ${entry.headgear_worn ? 'yes' : 'no'}` : ''}
                        {entry.glove_oz ? ` · ${entry.glove_oz} oz` : ''}
                      </p>
                      {entry.stopped_early && <p>Stopped early: {entry.stop_reason}</p>}
                      {entry.coach_note && <p className="text-[color:var(--bone-300)]">{entry.coach_note}</p>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    </RoleStandaloneView>
  );
}
