'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Intervention executions (module 026 slice 2): what was ACTUALLY
// delivered against a protocol. The planned column is a snapshot from the
// protocol at start time and nothing on this page can edit it -- actual
// facts are recorded beside it, and the gap between the two is displayed,
// never smoothed. Adherence is an explicit state; there is no percentage
// slider and no difficulty score anywhere here.

interface ExecutionRow {
  execution_id: string;
  lineage_id: string;
  version: number;
  athlete_id: string;
  athlete_name: string | null;
  protocol_id: string;
  protocol_version: number;
  protocol_title: string | null;
  status: 'in_progress' | 'completed' | 'stopped' | 'superseded';
  session_run_id: string | null;
  planned_exposure: Record<string, number>;
  planned_task_context: string;
  actual_exposure: Record<string, number>;
  trained_context: string;
  adherence: string;
  deviations: string;
  stop_change_reason: string;
  notes: string;
  correction_reason: string;
  created_at: string;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

interface ProtocolOption {
  protocol_id: string;
  title: string;
  version: number;
  athlete_id: string | null;
  status: string;
}

const EXPOSURE_DIMENSIONS: Array<{ key: string; label: string }> = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'rounds', label: 'Rounds' },
  { key: 'minutes', label: 'Minutes' },
  { key: 'repetitions', label: 'Repetitions' },
  { key: 'live_opportunities', label: 'Live opportunities' },
  { key: 'constrained_opportunities', label: 'Constrained opportunities' },
  { key: 'cue_exposures', label: 'Cue exposures' },
  { key: 'task_exposures', label: 'Task exposures' },
];

const ADHERENCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'unknown', label: 'Unknown (honest default)' },
  { value: 'delivered_as_planned', label: 'Delivered as planned' },
  { value: 'delivered_with_deviations', label: 'Delivered with deviations' },
  { value: 'under_delivered', label: 'Under-delivered' },
  { value: 'not_delivered', label: 'Not delivered' },
];

const CONTEXT_OPTIONS = ['unknown', 'controlled', 'constrained_live', 'live'];

function exposureText(exposure: Record<string, number>): string {
  const entries = Object.entries(exposure);
  if (entries.length === 0) return 'none recorded';
  return entries.map(([dimension, amount]) => `${dimension.replaceAll('_', ' ')}: ${amount}`).join(' · ');
}

export default function InterventionExecutionsPage() {
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [protocols, setProtocols] = useState<ProtocolOption[]>([]);
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [athleteId, setAthleteId] = useState('');
  const [protocolId, setProtocolId] = useState('');
  const [closing, setClosing] = useState<string | null>(null);
  const [closeForm, setCloseForm] = useState({
    outcome: 'completed', adherence: 'unknown', trained_context: 'unknown',
    deviations: '', deviation_reason: '', stop_change_reason: '', notes: '',
  });
  const [closeExposure, setCloseExposure] = useState<Record<string, string>>({});

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-executions`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load executions.');
    const payload = (await response.json()) as { items?: ExecutionRow[] };
    setExecutions(payload.items ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [, athleteResponse, protocolResponse] = await Promise.all([
          reload(controller.signal),
          fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include', signal: controller.signal }),
          fetch(`${apiBase()}/api/pilot/coach/intervention-protocols`, { credentials: 'include', signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (athleteResponse.ok) {
          const payload = (await athleteResponse.json()) as { items?: AthleteOption[] };
          if (!controller.signal.aborted) setAthletes(payload.items ?? []);
        }
        if (protocolResponse.ok) {
          const payload = (await protocolResponse.json()) as { items?: ProtocolOption[] };
          if (!controller.signal.aborted) {
            setProtocols((payload.items ?? []).filter((p) => p.status === 'active'));
          }
        }
        setLoaded(true);
      } catch {
        if (controller.signal.aborted) return;
        setErrorMessage('Unable to load executions.');
        setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  const handleStart = async () => {
    if (!athleteId || !protocolId) {
      setErrorMessage('Pick an athlete and a protocol first.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-executions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, protocol_id: protocolId }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Start failed (${response.status})`);
      }
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to start the execution.');
    } finally {
      setBusy(false);
    }
  };

  const handleClose = async (executionId: string) => {
    const actualExposure: Record<string, number> = {};
    for (const [dimension, raw] of Object.entries(closeExposure)) {
      if (raw.trim() === '') continue;
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount <= 0) {
        setErrorMessage(`${dimension.replaceAll('_', ' ')} must be a positive number.`);
        return;
      }
      actualExposure[dimension] = amount;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-executions`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'close',
          execution_id: executionId,
          outcome: closeForm.outcome,
          adherence: closeForm.adherence,
          trained_context: closeForm.trained_context,
          deviations: closeForm.deviations,
          deviation_reason: closeForm.deviation_reason,
          stop_change_reason: closeForm.stop_change_reason,
          notes: closeForm.notes,
          actual_exposure: actualExposure,
        }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Close failed (${response.status})`);
      }
      setClosing(null);
      setCloseForm({
        outcome: 'completed', adherence: 'unknown', trained_context: 'unknown',
        deviations: '', deviation_reason: '', stop_change_reason: '', notes: '',
      });
      setCloseExposure({});
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to close the execution.');
    } finally {
      setBusy(false);
    }
  };

  const adherenceBadge = (row: ExecutionRow) => {
    if (row.adherence === 'delivered_as_planned') {
      return <span className="badge badge--cleared"><i aria-hidden="true">✓</i>as planned</span>;
    }
    if (row.adherence === 'unknown') {
      return <span className="badge badge--monitor"><i aria-hidden="true">◉</i>adherence unknown</span>;
    }
    return <span className="badge badge--locked"><i aria-hidden="true">△</i>{row.adherence.replaceAll('_', ' ')}</span>;
  };

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>The Work</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              What actually got delivered against each protocol. The plan is frozen when work
              starts; what happened is recorded beside it — deviations named, stops explained,
              nothing smoothed over. A decision is not evidence the work happened. This is.
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
            <h2 className="t-label mb-[var(--s3)]">Start an execution</h2>
            <div className="grid gap-[var(--s3)] md:grid-cols-2">
              <div className="field">
                <label className="t-label" htmlFor="exec-athlete">Athlete</label>
                <select id="exec-athlete" className="select" value={athleteId}
                  onChange={(e) => setAthleteId(e.target.value)}>
                  <option value="">Select an athlete…</option>
                  {athletes.map((athlete) => (
                    <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="t-label" htmlFor="exec-protocol">Protocol (its intended exposure becomes the frozen plan)</label>
                <select id="exec-protocol" className="select" value={protocolId}
                  onChange={(e) => setProtocolId(e.target.value)}>
                  <option value="">Select a protocol…</option>
                  {protocols.map((protocol) => (
                    <option key={protocol.protocol_id} value={protocol.protocol_id}>
                      {protocol.title} (v{protocol.version})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-[var(--s4)]">
              <button type="button" className="btn" disabled={busy} onClick={() => void handleStart()}>
                {busy ? 'Starting…' : 'Start execution'}
              </button>
            </div>
          </section>

          {loaded && (
            executions.length === 0 && !errorMessage ? (
              <div className="mat-leather rounded-[var(--r-lg)]">
                <div className="empty">
                  <div className="empty-title">No executions on record</div>
                  <p className="empty-msg mx-auto">Intent without delivery is just a plan — the work lands here.</p>
                </div>
              </div>
            ) : (
              <ul className="space-y-[var(--s2)]">
                {executions.map((row) => (
                  <li key={row.execution_id} className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      {row.status === 'in_progress' ? (
                        <span className="badge badge--monitor"><i aria-hidden="true">▶</i>in progress</span>
                      ) : row.status === 'stopped' ? (
                        <span className="badge badge--locked"><i aria-hidden="true">◼</i>stopped</span>
                      ) : (
                        <span className="badge badge--cleared"><i aria-hidden="true">✓</i>completed</span>
                      )}
                      {adherenceBadge(row)}
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">
                        {row.protocol_title ?? row.protocol_id} (v{row.protocol_version})
                      </span>
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                        {row.athlete_name ?? row.athlete_id} · {row.created_at.slice(0, 10)}
                        {row.version > 1 ? ` · corrected (v${row.version})` : ''}
                      </span>
                      {row.session_run_id && (
                        <span className="t-label" title={row.session_run_id}>Logged during a live session</span>
                      )}
                    </div>

                    <div className="mt-[var(--s2)] grid gap-[var(--s2)] md:grid-cols-2">
                      <p className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        <strong>Planned:</strong> {exposureText(row.planned_exposure)}
                      </p>
                      <p className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        <strong>Actual:</strong> {exposureText(row.actual_exposure)}
                      </p>
                    </div>
                    {row.deviations ? (
                      <p className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>
                        <strong>Deviations:</strong> {row.deviations}
                      </p>
                    ) : null}
                    {row.stop_change_reason ? (
                      <p className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>
                        <strong>Stopped/changed because:</strong> {row.stop_change_reason}
                      </p>
                    ) : null}
                    {row.notes ? (
                      <p className="t-body mt-[var(--s1)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>{row.notes}</p>
                    ) : null}

                    {row.status === 'in_progress' && closing !== row.execution_id && (
                      <div className="mt-[var(--s2)]">
                        <button type="button" className="btn btn--ghost" disabled={busy}
                          onClick={() => setClosing(row.execution_id)}>
                          Close out
                        </button>
                      </div>
                    )}

                    {closing === row.execution_id && (
                      <div className="mt-[var(--s3)] border-t border-[color:var(--hide-800)] pt-[var(--s3)]">
                        <div className="grid gap-[var(--s2)] md:grid-cols-3">
                          <div className="field">
                            <label className="t-label" htmlFor={`close-outcome-${row.execution_id}`}>Outcome</label>
                            <select id={`close-outcome-${row.execution_id}`} className="select" value={closeForm.outcome}
                              onChange={(e) => setCloseForm((f) => ({ ...f, outcome: e.target.value }))}>
                              <option value="completed">Completed</option>
                              <option value="stopped">Stopped early</option>
                            </select>
                          </div>
                          <div className="field">
                            <label className="t-label" htmlFor={`close-adherence-${row.execution_id}`}>Adherence</label>
                            <select id={`close-adherence-${row.execution_id}`} className="select" value={closeForm.adherence}
                              onChange={(e) => setCloseForm((f) => ({ ...f, adherence: e.target.value }))}>
                              {ADHERENCE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="field">
                            <label className="t-label" htmlFor={`close-context-${row.execution_id}`}>Trained context</label>
                            <select id={`close-context-${row.execution_id}`} className="select" value={closeForm.trained_context}
                              onChange={(e) => setCloseForm((f) => ({ ...f, trained_context: e.target.value }))}>
                              {CONTEXT_OPTIONS.map((context) => (
                                <option key={context} value={context}>{context.replaceAll('_', ' ')}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <fieldset className="mt-[var(--s2)]">
                          <legend className="t-label" style={{ fontSize: 'var(--t-xs)' }}>Actual exposure delivered — per dimension, real units</legend>
                          <div className="mt-[var(--s1)] grid gap-[var(--s2)] md:grid-cols-4">
                            {EXPOSURE_DIMENSIONS.map((dimension) => (
                              <div className="field" key={dimension.key}>
                                <label className="t-label" htmlFor={`close-exposure-${dimension.key}-${row.execution_id}`} style={{ fontSize: 'var(--t-xs)' }}>
                                  {dimension.label}
                                </label>
                                <input id={`close-exposure-${dimension.key}-${row.execution_id}`} className="input" inputMode="decimal"
                                  value={closeExposure[dimension.key] ?? ''}
                                  onChange={(e) => setCloseExposure((x) => ({ ...x, [dimension.key]: e.target.value }))} />
                              </div>
                            ))}
                          </div>
                        </fieldset>
                        <div className="mt-[var(--s2)] grid gap-[var(--s2)] md:grid-cols-2">
                          <div className="field">
                            <label className="t-label" htmlFor={`close-deviations-${row.execution_id}`}>Deviations (required if you claimed any)</label>
                            <input id={`close-deviations-${row.execution_id}`} className="input" value={closeForm.deviations}
                              onChange={(e) => setCloseForm((f) => ({ ...f, deviations: e.target.value }))} />
                          </div>
                          <div className="field">
                            <label className="t-label" htmlFor={`close-stop-${row.execution_id}`}>Stop/change reason (required if stopped)</label>
                            <input id={`close-stop-${row.execution_id}`} className="input" value={closeForm.stop_change_reason}
                              onChange={(e) => setCloseForm((f) => ({ ...f, stop_change_reason: e.target.value }))} />
                          </div>
                          <div className="field md:col-span-2">
                            <label className="t-label" htmlFor={`close-notes-${row.execution_id}`}>Notes</label>
                            <input id={`close-notes-${row.execution_id}`} className="input" value={closeForm.notes}
                              onChange={(e) => setCloseForm((f) => ({ ...f, notes: e.target.value }))} />
                          </div>
                        </div>
                        <div className="mt-[var(--s2)] flex gap-[var(--s2)]">
                          <button type="button" className="btn" disabled={busy}
                            onClick={() => void handleClose(row.execution_id)}>
                            {busy ? 'Recording…' : 'Record close-out'}
                          </button>
                          <button type="button" className="btn btn--ghost" disabled={busy}
                            onClick={() => setClosing(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach/intervention-protocols" className="btn btn--ghost">Protocols</Link>{' '}
            <Link href="/coach" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
