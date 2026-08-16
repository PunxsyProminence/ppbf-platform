'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// The attempt log (owner decision 2026-08-16): quick entry for every
// attempt -- made OR failed -- because the failed ones are the point. "One
// hard-fought loss is worth a thousand easy victories": the edge where an
// athlete fails is their current capacity, and this is where it gets
// written down.
//
// No leaderboards, no cross-athlete comparison, ever. One athlete at a
// time, their own edge, their own history.

interface AttemptRow {
  attempt_id: string;
  athlete_name: string;
  context_type: string;
  metric_kind: string;
  direction: string;
  target_value: string | null;
  achieved_value: string;
  made: boolean | null;
  note: string;
  attempted_at: string;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

const METRICS: Array<{ kind: string; label: string; unit: string }> = [
  { kind: 'reps', label: 'Reps', unit: 'reps' },
  { kind: 'time_seconds', label: 'Time', unit: 's' },
  { kind: 'distance_m', label: 'Distance', unit: 'm' },
  { kind: 'load_kg', label: 'Load', unit: 'kg' },
  { kind: 'rounds', label: 'Rounds', unit: 'rounds' },
  { kind: 'hold_seconds', label: 'Hold', unit: 's' },
];

// Where the attempt happened -- sparring contexts are distinct on purpose:
// holding in sparring drills and breaking in open sparring is a transfer
// fact worth recording.
const CONTEXTS: Array<{ value: string; label: string }> = [
  { value: 'open_floor', label: 'Open floor' },
  { value: 'session', label: 'Session' },
  { value: 'drill_assignment', label: 'Drill assignment' },
  { value: 'assessment', label: 'Assessment' },
  { value: 'film_study', label: 'Film study' },
  { value: 'technical_sparring', label: 'Technical sparring' },
  { value: 'sparring_games', label: 'Sparring games' },
  { value: 'sparring_drills', label: 'Sparring drills' },
  { value: 'open_sparring', label: 'Open sparring' },
];

export default function AttemptLogPage() {
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [athleteId, setAthleteId] = useState('');
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ metric_kind: 'reps', context_type: 'open_floor', target_value: '', achieved_value: '', note: '' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { items?: AthleteOption[] };
        if (controller.signal.aborted) return;
        setAthletes(payload.items ?? []);
      } catch {
        // Silent: the picker degrades to empty.
      }
    })();
    return () => controller.abort();
  }, []);

  const reloadAttempts = useCallback(async (id: string, signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/training-attempts?athlete_id=${encodeURIComponent(id)}`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load attempts.');
    const payload = (await response.json()) as { items?: AttemptRow[] };
    setAttempts(payload.items ?? []);
  }, []);

  // The loading flag is raised in the change handler that picks the
  // athlete, not here (react-hooks/set-state-in-effect); the effect only
  // loads and lowers it.
  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        await reloadAttempts(athleteId, controller.signal);
        if (controller.signal.aborted) return;
        setErrorMessage(null);
        setListLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load attempts.');
        setListLoading(false);
      }
    })();
    return () => controller.abort();
  }, [athleteId, reloadAttempts]);

  const handleRecord = async () => {
    if (!athleteId) {
      setErrorMessage('Pick an athlete first.');
      return;
    }
    const achieved = Number(form.achieved_value);
    if (form.achieved_value.trim() === '' || !Number.isFinite(achieved) || achieved < 0) {
      setErrorMessage('Achieved must be a non-negative number.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/training-attempts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: athleteId,
          metric_kind: form.metric_kind,
          context_type: form.context_type,
          target_value: form.target_value.trim() === '' ? null : Number(form.target_value),
          achieved_value: achieved,
          note: form.note,
        }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Record failed (${response.status})`);
      }
      setForm((f) => ({ ...f, target_value: '', achieved_value: '', note: '' }));
      await reloadAttempts(athleteId);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to record the attempt.');
    } finally {
      setBusy(false);
    }
  };

  const unitFor = (kind: string) => METRICS.find((m) => m.kind === kind)?.unit ?? '';

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Attempt Log</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Every attempt, made or missed — the misses are the point. The edge where an athlete
              fails is their current capacity, and this is where it gets written down. One athlete
              at a time; no comparisons, ever.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          <section className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            <div className="grid gap-[var(--s3)] md:grid-cols-2">
              <div className="field md:col-span-2">
                <label className="t-label" htmlFor="attempt-athlete">Athlete</label>
                <select id="attempt-athlete" className="select" value={athleteId}
                  onChange={(e) => { setListLoading(e.target.value !== ''); setAthleteId(e.target.value); }}>
                  <option value="">Select an athlete…</option>
                  {athletes.map((athlete) => (
                    <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="t-label" htmlFor="attempt-metric">Metric</label>
                <select id="attempt-metric" className="select" value={form.metric_kind}
                  onChange={(e) => setForm((f) => ({ ...f, metric_kind: e.target.value }))}>
                  {METRICS.map((metric) => (
                    <option key={metric.kind} value={metric.kind}>{metric.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="t-label" htmlFor="attempt-context">Context (where it happened)</label>
                <select id="attempt-context" className="select" value={form.context_type}
                  onChange={(e) => setForm((f) => ({ ...f, context_type: e.target.value }))}>
                  {CONTEXTS.map((context) => (
                    <option key={context.value} value={context.value}>{context.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="t-label" htmlFor="attempt-target">Target (optional — no target means a measurement)</label>
                <input id="attempt-target" className="input" inputMode="decimal" value={form.target_value}
                  onChange={(e) => setForm((f) => ({ ...f, target_value: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="attempt-achieved">Achieved</label>
                <input id="attempt-achieved" className="input" inputMode="decimal" value={form.achieved_value}
                  onChange={(e) => setForm((f) => ({ ...f, achieved_value: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="attempt-note">Note (what broke, what held)</label>
                <input id="attempt-note" className="input" value={form.note}
                  onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
              </div>
            </div>
            <div className="mt-[var(--s4)]">
              <button type="button" className="btn" disabled={busy} onClick={() => void handleRecord()}>
                {busy ? 'Recording…' : 'Record attempt'}
              </button>
            </div>
          </section>

          {athleteId && (
            listLoading ? (
              <div className="flex justify-center py-[var(--s6)]">
                <span className="working">Loading attempts...</span>
              </div>
            ) : attempts.length === 0 && !errorMessage ? (
              <div className="mat-leather rounded-[var(--r-lg)]">
                <div className="empty">
                  <div className="empty-title">No attempts on record</div>
                  <p className="empty-msg mx-auto">Every attempt lands here — the misses matter most.</p>
                </div>
              </div>
            ) : (
              <ul className="space-y-[var(--s2)]">
                {attempts.map((attempt) => (
                  <li key={attempt.attempt_id} className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      {attempt.made === null ? (
                        <span className="badge badge--monitor"><i aria-hidden="true">◉</i>measured</span>
                      ) : attempt.made ? (
                        <span className="badge badge--cleared"><i aria-hidden="true">✓</i>made</span>
                      ) : (
                        <span className="badge badge--locked"><i aria-hidden="true">✕</i>missed</span>
                      )}
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">
                        {attempt.achieved_value}{unitFor(attempt.metric_kind)}
                        {attempt.target_value ? ` / target ${attempt.target_value}${unitFor(attempt.metric_kind)}` : ''}
                      </span>
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                        {attempt.metric_kind.replaceAll('_', ' ')} · {attempt.context_type.replaceAll('_', ' ')} · {attempt.attempted_at.slice(0, 10)}
                      </span>
                    </div>
                    {attempt.note ? (
                      <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{attempt.note}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
