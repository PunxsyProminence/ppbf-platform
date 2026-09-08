'use client';

import React, { type FormEvent, useCallback, useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateTime } from '@/src/lib/gymTime';

/*
 * BASE-05 Slice 1: the athlete's own attempt log.
 *
 * One surface over the existing training-attempts ledger (owner decision
 * 2026-08-16: every attempt, made or missed -- the misses are the point). It
 * reads and writes ONLY /api/pilot/training-attempts, always for the athlete
 * the session handed it. There is no athlete picker here, no local copy of
 * the list, and no verdict computed on this side: `made` is the server's
 * answer from target + direction, and the list shown is whatever the server
 * returned last. Who may touch which athlete is decided at the API route by
 * the standing access check, not filtered here.
 *
 * No leaderboard, ranking or cross-athlete comparison may be built on this
 * surface -- failure data describes training, never the child.
 */

type MetricKind = 'reps' | 'time_seconds' | 'distance_m' | 'load_kg' | 'rounds' | 'hold_seconds';

const METRIC_OPTIONS: { value: MetricKind; label: string; unit: string }[] = [
  { value: 'reps', label: 'Reps', unit: 'reps' },
  { value: 'time_seconds', label: 'Time (seconds)', unit: 's' },
  { value: 'distance_m', label: 'Distance (metres)', unit: 'm' },
  { value: 'load_kg', label: 'Load (kg)', unit: 'kg' },
  { value: 'rounds', label: 'Rounds', unit: 'rounds' },
  { value: 'hold_seconds', label: 'Hold (seconds)', unit: 's' },
];

// The one context this surface records in. An athlete logging their own
// work on the floor is exactly what open_floor names; the richer contexts
// (assignment, assessment, sparring) belong to the coach's log.
const CONTEXT_TYPE = 'open_floor';

export interface AthleteAttemptRecord {
  attempt_id: string;
  athlete_id: string;
  context_type: string;
  metric_kind: string;
  target_value: string | null;
  achieved_value: string;
  made: boolean | null;
  note: string;
  attempted_at: string;
  // BASE-06: the coach's current review of this attempt, read-only here. The
  // athlete sees what a coach said about their attempt but has no review
  // controls -- reviewing is a coaching action, and the fields below are just
  // the current disposition the server computed.
  review_state?: 'confirmed' | 'corrected' | 'disputed' | null;
  corrected_target_value?: string | null;
  corrected_achieved_value?: string | null;
  corrected_made?: boolean | null;
  review_reason?: string | null;
}

interface Props {
  /** The session's athlete record. Null while unknown, or for an account with none. */
  readonly athleteId: string | null;
}

function metricLabel(kind: string): string {
  return METRIC_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function metricUnit(kind: string): string {
  return METRIC_OPTIONS.find((option) => option.value === kind)?.unit ?? '';
}

function resultLabel(made: boolean | null): string {
  if (made === null) return 'Measurement';
  return made ? 'Made' : 'Missed';
}

// Gym time, never the viewer's: an attempt happened on the gym floor, and the
// day it happened must not move for a device set to another timezone.
function formatWhen(iso: string): string {
  return formatGymDateTime(iso) ?? iso;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof payload?.error === 'string' && payload.error.trim() !== '' ? payload.error : fallback;
}

// The coach's current review, shown to the athlete read-only. A correction
// never hides the athlete's own numbers -- those stay on the row above; this
// only adds what the coach said. A dispute shows the disagreement, not a
// verdict, because a disputed attempt has no effective verdict.
function CoachReviewNote({ item }: { item: AthleteAttemptRecord }) {
  const state = item.review_state ?? null;
  if (!state) return null;
  if (state === 'confirmed') {
    return (
      <p className="t-muted text-[length:var(--t-xs)]" role="status">Coach confirmed this attempt.</p>
    );
  }
  if (state === 'corrected') {
    const target = item.corrected_target_value;
    return (
      <p className="t-muted text-[length:var(--t-xs)]" role="status">
        Coach correction: {item.corrected_achieved_value}{target !== null && target !== undefined ? ` / ${target}` : ''} {metricUnit(item.metric_kind)} · {resultLabel(item.corrected_made ?? null)}
        {item.review_reason ? ` — ${item.review_reason}` : ''}
      </p>
    );
  }
  return (
    <p className="alert-title text-[length:var(--t-xs)]" role="status">
      Coach disputed this attempt{item.review_reason ? ` — ${item.review_reason}` : ''}
    </p>
  );
}

export default function AthleteAttemptLog({ athleteId }: Props) {
  const [items, setItems] = useState<AthleteAttemptRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [metricKind, setMetricKind] = useState<MetricKind>('reps');
  const [achieved, setAchieved] = useState('');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!athleteId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/training-attempts?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) {
        // Always the same fixed sentence, with the server's reason attached
        // when it gave one -- never the reason alone, which could read as if
        // the list were the problem rather than the read.
        const reason = await readError(response, '');
        throw new Error(reason ? `Could not load your attempts (${reason})` : 'Could not load your attempts');
      }
      const payload = (await response.json().catch(() => null)) as { items?: unknown } | null;
      if (!payload || !Array.isArray(payload.items)) {
        throw new Error('Could not load your attempts');
      }
      setItems(payload.items as AthleteAttemptRecord[]);
    } catch (error) {
      setItems([]);
      setLoadError(error instanceof Error && error.message ? error.message : 'Could not load your attempts');
    } finally {
      setLoading(false);
    }
  }, [athleteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!athleteId || saving) return;
    setSaveError(null);
    setSaved(false);

    const achievedValue = Number(achieved);
    if (achieved.trim() === '' || !Number.isFinite(achievedValue) || achievedValue < 0) {
      setSaveError('Enter what you got as a number of 0 or more.');
      return;
    }
    let targetValue: number | null = null;
    if (target.trim() !== '') {
      targetValue = Number(target);
      if (!Number.isFinite(targetValue) || targetValue <= 0) {
        setSaveError('Target must be a number above 0, or leave it blank for a measurement.');
        return;
      }
    }

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        athlete_id: athleteId,
        metric_kind: metricKind,
        context_type: CONTEXT_TYPE,
        target_value: targetValue,
        achieved_value: achievedValue,
      };
      const trimmedNote = note.trim();
      if (trimmedNote !== '') body.note = trimmedNote;

      const response = await fetch(`${apiBase()}/api/pilot/training-attempts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await readError(response, 'Attempt was not saved'));
      }
      setAchieved('');
      setTarget('');
      setNote('');
      setSaved(true);
      // The list is the server's. Re-read it rather than appending locally.
      await load();
    } catch (error) {
      setSaveError(error instanceof Error && error.message ? error.message : 'Attempt was not saved');
    } finally {
      setSaving(false);
    }
  }, [achieved, athleteId, load, metricKind, note, saving, target]);

  const canRecord = Boolean(athleteId) && !saving && !loading;

  return (
    <section className="space-y-[var(--s5)]" aria-labelledby="athlete-attempt-log-heading">
      <div className="space-y-[var(--s2)]">
        <h3 id="athlete-attempt-log-heading" className="t-label">Attempt Log</h3>
        <p className="t-muted text-[length:var(--t-sm)]">
          Open-floor attempts you record yourself. Every attempt, made or missed — the misses are the point. Write down what you went for and what you got.
        </p>
      </div>

      {!athleteId && (
        <p className="t-muted text-[length:var(--t-sm)]" role="status">
          This account is not linked to an athlete record yet, so there is nothing to log against.
        </p>
      )}

      <form onSubmit={submit} className="space-y-[var(--s4)]" aria-label="Record an attempt">
        <div className="space-y-[var(--s2)]">
          <label className="t-label block" htmlFor="athlete-attempt-metric">What you measured</label>
          <select
            id="athlete-attempt-metric"
            className="select"
            value={metricKind}
            onChange={(event) => setMetricKind(event.target.value as MetricKind)}
            disabled={!canRecord}
          >
            {METRIC_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-[var(--s2)]">
          <label className="t-label block" htmlFor="athlete-attempt-achieved">What you got</label>
          <input
            id="athlete-attempt-achieved"
            className="input input--kiosk"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={achieved}
            onChange={(event) => setAchieved(event.target.value)}
            disabled={!canRecord}
          />
        </div>

        <div className="space-y-[var(--s2)]">
          <label className="t-label block" htmlFor="athlete-attempt-target">
            Target (optional — no target means a measurement)
          </label>
          <input
            id="athlete-attempt-target"
            className="input input--kiosk"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            disabled={!canRecord}
          />
        </div>

        <div className="space-y-[var(--s2)]">
          <label className="t-label block" htmlFor="athlete-attempt-note">Note (optional)</label>
          <textarea
            id="athlete-attempt-note"
            className="input input--kiosk"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={!canRecord}
          />
        </div>

        {saveError && (
          <p className="alert-title" role="alert">{saveError}</p>
        )}
        {saved && !saveError && (
          <p className="t-muted text-[length:var(--t-sm)]" role="status">Attempt saved.</p>
        )}

        <button type="submit" className="btn btn--kiosk disabled:opacity-50 disabled:grayscale" disabled={!canRecord}>
          {saving ? 'Recording…' : 'Record attempt'}
        </button>
      </form>

      <div className="space-y-[var(--s3)] pt-[var(--s4)] border-t-2 border-[color:var(--brass-700)]">
        <h4 className="t-label">Your attempts</h4>
        {loading && <p className="t-muted text-[length:var(--t-sm)]">Loading your attempts…</p>}
        {loadError && !loading && (
          <p className="alert-title" role="alert">{loadError}</p>
        )}
        {!loading && !loadError && athleteId && items.length === 0 && (
          <p className="t-muted">No attempts recorded yet</p>
        )}
        {!loading && !loadError && items.length > 0 && (
          <ul className="space-y-[var(--s3)]">
            {items.map((item) => (
              <li key={item.attempt_id} className="space-y-[var(--s1)]">
                <div className="flex flex-wrap items-baseline gap-x-[var(--s3)]">
                  <span className="t-data">
                    {item.achieved_value}{item.target_value !== null ? ` / ${item.target_value}` : ''} {metricUnit(item.metric_kind)}
                  </span>
                  <span className="t-label">{metricLabel(item.metric_kind)}</span>
                  <span className="t-label">{resultLabel(item.made)}</span>
                </div>
                <div className="t-muted text-[length:var(--t-xs)]">
                  <span>{formatWhen(item.attempted_at)}</span>
                  {item.note !== '' && <span> · {item.note}</span>}
                </div>
                <CoachReviewNote item={item} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
