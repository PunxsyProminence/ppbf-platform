'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Transfer check (module 053): the honesty check on gains. A rep that
// holds in drills and vanishes in sparring is not progress yet. Every flag
// shows its raw counts -- the coach sees the same facts the rule saw and
// is free to disagree. Nothing here is a score, and nothing compares one
// athlete to another.

interface ReadoutRow {
  metric_kind: string;
  controlled_makes: number;
  controlled_misses: number;
  live_makes: number;
  live_misses: number;
  state: 'not_transferring' | 'untested_live' | 'transferring' | 'insufficient_evidence';
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

const STATE_DISPLAY: Record<ReadoutRow['state'], { className: string; glyph: string; label: string; copy: string }> = {
  not_transferring: {
    className: 'badge badge--locked', glyph: '✕', label: 'not transferring',
    copy: 'Strong in practice, breaking down live — the gain has not transferred yet. Worth designing live exposure for.',
  },
  untested_live: {
    className: 'badge badge--monitor', glyph: '◉', label: 'untested live',
    copy: 'Strong in practice but never attempted in a live context — untested, not failing. Unknown is not clear.',
  },
  transferring: {
    className: 'badge badge--cleared', glyph: '✓', label: 'transferring',
    copy: 'Holding up under live conditions.',
  },
  insufficient_evidence: {
    className: 'badge badge--filed', glyph: '▣', label: 'insufficient evidence',
    copy: 'Not enough targeted attempts to say anything either way. No flag is made from a thin record.',
  },
};

export default function TransferCheckPage() {
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [athleteId, setAthleteId] = useState('');
  const [items, setItems] = useState<ReadoutRow[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
        if (!controller.signal.aborted) setAthletes(payload.items ?? []);
      } catch {
        // Silent: the picker degrades to empty.
      }
    })();
    return () => controller.abort();
  }, []);

  const reload = useCallback(async (id: string, signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/coach/transfer-check?athlete_id=${encodeURIComponent(id)}`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load the transfer check.');
    const payload = (await response.json()) as { items?: ReadoutRow[] };
    setItems(payload.items ?? []);
  }, []);

  // Loading flag raised in the change handler, lowered here
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        await reload(athleteId, controller.signal);
        if (controller.signal.aborted) return;
        setErrorMessage(null);
        setListLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the transfer check.');
        setListLoading(false);
      }
    })();
    return () => controller.abort();
  }, [athleteId, reload]);

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Transfer Check</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              The honesty check on gains: does what holds in practice hold live? Deterministic
              flags from the last 60 days of targeted attempts, raw counts shown with every one.
              A flag is a reason to look, never a verdict — and one athlete at a time, always.
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

          <div className="field mb-[var(--s5)] md:max-w-sm">
            <label className="t-label" htmlFor="transfer-athlete">Athlete</label>
            <select id="transfer-athlete" className="select" value={athleteId}
              onChange={(e) => { setListLoading(e.target.value !== ''); setAthleteId(e.target.value); }}>
              <option value="">Select an athlete…</option>
              {athletes.map((athlete) => (
                <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
              ))}
            </select>
          </div>

          {athleteId && (
            listLoading ? (
              <div className="flex justify-center py-[var(--s6)]">
                <span className="working">Reading attempts...</span>
              </div>
            ) : items.length === 0 && !errorMessage ? (
              <div className="mat-leather rounded-[var(--r-lg)]">
                <div className="empty">
                  <div className="empty-title">No targeted attempts in the window</div>
                  <p className="empty-msg mx-auto">
                    Transfer needs attempts with targets, in practice and live, to say anything.
                  </p>
                </div>
              </div>
            ) : (
              <ul className="space-y-[var(--s2)]">
                {items.map((row) => {
                  const display = STATE_DISPLAY[row.state];
                  return (
                    <li key={row.metric_kind} className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                      <div className="flex flex-wrap items-center gap-[var(--s3)]">
                        <span className={display.className}><i aria-hidden="true">{display.glyph}</i>{display.label}</span>
                        <span className="t-body font-semibold text-[color:var(--bone-100)]">
                          {row.metric_kind.replaceAll('_', ' ')}
                        </span>
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                          practice: {row.controlled_makes} of {row.controlled_makes + row.controlled_misses} made
                          {' · '}live: {row.live_makes} of {row.live_makes + row.live_misses} made
                        </span>
                      </div>
                      <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{display.copy}</p>
                    </li>
                  );
                })}
              </ul>
            )
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach/attempt-log" className="btn btn--ghost">Attempt Log</Link>{' '}
            <Link href="/coach" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
