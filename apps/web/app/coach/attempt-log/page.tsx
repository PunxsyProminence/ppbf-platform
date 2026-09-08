'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { getRoleSessionSnapshot, subscribeRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';

// The attempt log (owner decision 2026-08-16): quick entry for every
// attempt -- made OR failed -- because the failed ones are the point. "One
// hard-fought loss is worth a thousand easy victories": the edge where an
// athlete fails is their current capacity, and this is where it gets
// written down.
//
// No leaderboards, no cross-athlete comparison, ever. One athlete at a
// time, their own edge, their own history.
//
// BASE-06: a coach CONFIRMS, CORRECTS or DISPUTES an attempt. The athlete's
// source numbers stay on the row exactly as recorded; a review is shown
// beside them, never over them. The corrected verdict is the server's, and a
// dispute shows the disagreement rather than flipping the result.

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
  recorded_by_role: string | null;
  review_state: 'confirmed' | 'corrected' | 'disputed' | null;
  corrected_target_value: string | null;
  corrected_achieved_value: string | null;
  corrected_made: boolean | null;
  review_reason: string | null;
}

interface ReviewRow {
  review_id: string;
  review_state: 'confirmed' | 'corrected' | 'disputed';
  corrected_target_value: string | null;
  corrected_achieved_value: string | null;
  corrected_made: boolean | null;
  reason: string;
  reviewed_at: string;
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

const unitFor = (kind: string) => METRICS.find((m) => m.kind === kind)?.unit ?? '';

function verdictLabel(made: boolean | null): string {
  if (made === null) return 'measurement';
  return made ? 'made' : 'missed';
}

function recorderLabel(role: string | null): string {
  if (role === 'athlete') return 'Recorded by athlete';
  if (role === 'coach') return 'Recorded by coach';
  if (role === 'organization_admin' || role === 'admin') return 'Recorded by staff';
  return 'Recorded';
}

// One attempt: its athlete-source facts, the coach's current review beside
// them (never over them), the confirm/correct/dispute controls, and the
// review history so disagreement stays visible.
function AttemptCard({ attempt, canReview, onReviewed }: { attempt: AttemptRow; canReview: boolean; onReviewed: () => Promise<void> }) {
  const [mode, setMode] = useState<'idle' | 'correct' | 'dispute'>('idle');
  const [reason, setReason] = useState('');
  const [correctedAchieved, setCorrectedAchieved] = useState('');
  const [correctedTarget, setCorrectedTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReviewRow[] | null>(null);

  const submit = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/training-attempts/review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempt_id: attempt.attempt_id, ...body }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Review failed (${response.status})`);
      }
      setMode('idle');
      setReason('');
      setCorrectedAchieved('');
      setCorrectedTarget('');
      setHistory(null);
      await onReviewed();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save the review.');
    } finally {
      setBusy(false);
    }
  }, [attempt.attempt_id, onReviewed]);

  const confirm = () => void submit({ review_state: 'confirmed' });

  const saveCorrection = () => {
    const achieved = Number(correctedAchieved);
    if (correctedAchieved.trim() === '' || !Number.isFinite(achieved) || achieved < 0) {
      setError('Corrected achieved must be a non-negative number.');
      return;
    }
    if (reason.trim().length < 10) {
      setError('A correction needs a reason of at least 10 characters.');
      return;
    }
    // A blank target is an intentional target-less measurement. A non-blank
    // target must parse to a finite number above 0 (the server's own target
    // rule) BEFORE it is sent -- relying on JSON to turn NaN into null would
    // silently drop a mistyped target and make the correction a measurement.
    let correctedTargetValue: number | null = null;
    if (correctedTarget.trim() !== '') {
      correctedTargetValue = Number(correctedTarget);
      if (!Number.isFinite(correctedTargetValue) || correctedTargetValue <= 0) {
        setError('Corrected target must be a number above 0, or leave it blank for a measurement.');
        return;
      }
    }
    void submit({
      review_state: 'corrected',
      corrected_achieved_value: achieved,
      corrected_target_value: correctedTargetValue,
      reason: reason.trim(),
    });
  };

  const saveDispute = () => {
    if (reason.trim().length < 10) {
      setError('A dispute needs a reason of at least 10 characters.');
      return;
    }
    void submit({ review_state: 'disputed', reason: reason.trim() });
  };

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/training-attempts/review?attempt_id=${encodeURIComponent(attempt.attempt_id)}`,
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error('Unable to load review history.');
      const payload = (await response.json()) as { items?: ReviewRow[] };
      setHistory(payload.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load review history.');
    }
  }, [attempt.attempt_id]);

  const unit = unitFor(attempt.metric_kind);

  return (
    <li className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
      {/* ATHLETE SOURCE — the athlete's own numbers, never overwritten. */}
      <div className="flex flex-wrap items-center gap-[var(--s3)]">
        {attempt.made === null ? (
          <span className="badge badge--monitor"><i aria-hidden="true">◉</i>measured</span>
        ) : attempt.made ? (
          <span className="badge badge--cleared"><i aria-hidden="true">✓</i>made</span>
        ) : (
          <span className="badge badge--locked"><i aria-hidden="true">✕</i>missed</span>
        )}
        <span className="t-body font-semibold text-[color:var(--bone-100)]">
          {attempt.achieved_value}{unit}
          {attempt.target_value ? ` / target ${attempt.target_value}${unit}` : ''}
        </span>
        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
          {attempt.metric_kind.replaceAll('_', ' ')} · {attempt.context_type.replaceAll('_', ' ')} · {attempt.attempted_at.slice(0, 10)}
        </span>
        <span className="t-muted" style={{ fontSize: 'var(--t-xs)' }}>{recorderLabel(attempt.recorded_by_role)}</span>
      </div>
      {attempt.note ? (
        <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{attempt.note}</p>
      ) : null}

      {/* COACH REVIEW — current disposition, beside the source, not over it. */}
      {attempt.review_state === 'confirmed' && (
        <p className="t-muted mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }} role="status">Coach confirmed this attempt.</p>
      )}
      {attempt.review_state === 'corrected' && (
        <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }} role="status">
          Coach correction: {attempt.corrected_achieved_value}{unit}
          {attempt.corrected_target_value ? ` / target ${attempt.corrected_target_value}${unit}` : ''} — {verdictLabel(attempt.corrected_made)}
          {attempt.review_reason ? ` — ${attempt.review_reason}` : ''}
        </p>
      )}
      {attempt.review_state === 'disputed' && (
        <p className="alert-title mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }} role="status">
          Coach disputed this attempt{attempt.review_reason ? ` — ${attempt.review_reason}` : ''}
        </p>
      )}

      {error && <p className="alert-title mt-[var(--s2)]" role="alert">{error}</p>}

      {/* CONTROLS. The whole review surface -- confirm/correct/dispute AND the
          history read -- is coach-only at the server (the review route requires
          the coach role for both its POST and its GET), so none of it is
          offered to a role that cannot use it. An admin keeps read-only access
          to the attempt and its current disposition, which render above
          regardless of role. Client hiding is not the security boundary -- the
          coach-only review route is. */}
      {mode === 'idle' && canReview && (
        <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={confirm}>Confirm</button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setError(null); setMode('correct'); }}>Correct</button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setError(null); setMode('dispute'); }}>Dispute</button>
          <button type="button" className="btn btn--ghost" onClick={() => void loadHistory()}>History</button>
        </div>
      )}

      {mode === 'correct' && (
        <div className="mt-[var(--s3)] space-y-[var(--s2)]">
          <div className="field">
            <label className="t-label" htmlFor={`corrected-achieved-${attempt.attempt_id}`}>Corrected achieved</label>
            <input id={`corrected-achieved-${attempt.attempt_id}`} className="input" inputMode="decimal"
              value={correctedAchieved} onChange={(e) => setCorrectedAchieved(e.target.value)} />
          </div>
          <div className="field">
            <label className="t-label" htmlFor={`corrected-target-${attempt.attempt_id}`}>Corrected target (optional)</label>
            <input id={`corrected-target-${attempt.attempt_id}`} className="input" inputMode="decimal"
              value={correctedTarget} onChange={(e) => setCorrectedTarget(e.target.value)} />
          </div>
          <div className="field">
            <label className="t-label" htmlFor={`correct-reason-${attempt.attempt_id}`}>Reason</label>
            <input id={`correct-reason-${attempt.attempt_id}`} className="input"
              value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="flex gap-[var(--s2)]">
            <button type="button" className="btn" disabled={busy} onClick={saveCorrection}>Save correction</button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setMode('idle'); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'dispute' && (
        <div className="mt-[var(--s3)] space-y-[var(--s2)]">
          <div className="field">
            <label className="t-label" htmlFor={`dispute-reason-${attempt.attempt_id}`}>Reason</label>
            <input id={`dispute-reason-${attempt.attempt_id}`} className="input"
              value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="flex gap-[var(--s2)]">
            <button type="button" className="btn" disabled={busy} onClick={saveDispute}>Save dispute</button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setMode('idle'); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {history && (
        <div className="mt-[var(--s3)]">
          <p className="t-label">Review history</p>
          {history.length === 0 ? (
            <p className="t-muted" style={{ fontSize: 'var(--t-xs)' }}>No reviews yet.</p>
          ) : (
            <ul className="mt-[var(--s1)] space-y-[var(--s1)]">
              {history.map((review) => (
                <li key={review.review_id} className="t-muted" style={{ fontSize: 'var(--t-xs)' }}>
                  {review.reviewed_at.slice(0, 10)} · {review.review_state}
                  {review.review_state === 'corrected'
                    ? `: ${review.corrected_achieved_value}${unit}${review.corrected_target_value ? ` / ${review.corrected_target_value}${unit}` : ''} — ${verdictLabel(review.corrected_made)}`
                    : ''}
                  {review.reason ? ` — ${review.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export default function AttemptLogPage() {
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [athleteId, setAthleteId] = useState('');
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ metric_kind: 'reps', context_type: 'open_floor', target_value: '', achieved_value: '', note: '' });

  // The authoritative normalized role for the signed-in actor, from the same
  // session store the admin pages read. BASE-06 authorizes the review mutation
  // for a coach only, so only a coach is offered the mutation controls; an
  // admin keeps read-only access to attempts and review state.
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const canReview = session?.role === 'coach';

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

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Attempt Log</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Every attempt, made or missed — the misses are the point. The edge where an athlete
              fails is their current capacity, and this is where it gets written down. One athlete
              at a time; no comparisons, ever. Confirm, correct or dispute an attempt without ever
              overwriting what the athlete recorded.
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
                  <AttemptCard
                    key={attempt.attempt_id}
                    attempt={attempt}
                    canReview={canReview}
                    onReviewed={() => reloadAttempts(athleteId)}
                  />
                ))}
              </ul>
            )
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach/environment/intake-router" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
