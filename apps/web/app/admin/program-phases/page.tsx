'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Program phases (module 129): which block each program is in, declared
// by a human. Starting a new phase closes the current one -- the old
// phase stays on the record with its dates, so past sessions keep the
// context they actually happened in. Nothing here decides anything about
// an athlete.

interface PhaseRow {
  phase_id: string;
  program_name: string;
  phase_name: string;
  focus: string;
  started_on: string;
  ended_on: string | null;
  notes: string;
}

const EMPTY_FORM = { program_name: '', phase_name: '', focus: '', started_on: '', notes: '' };

export default function ProgramPhasesPage() {
  const [items, setItems] = useState<PhaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [endingPhase, setEndingPhase] = useState<string | null>(null);
  const [endDate, setEndDate] = useState('');

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/admin/program-phases`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load program phases.');
    const payload = (await response.json()) as { items?: PhaseRow[] };
    setItems(payload.items ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reload(controller.signal);
        if (controller.signal.aborted) return;
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load program phases.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  const handleStart = async () => {
    if (!form.program_name.trim() || !form.phase_name.trim() || !form.started_on) {
      setErrorMessage('A phase needs a program, a name, and a start date.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/program-phases`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Start failed (${response.status})`);
      }
      setForm(EMPTY_FORM);
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to start the phase.');
    } finally {
      setBusy(false);
    }
  };

  const handleEnd = async (phaseId: string) => {
    if (!endDate) {
      setErrorMessage('Pick the date the phase ended.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/program-phases`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase_id: phaseId, ended_on: endDate }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `End failed (${response.status})`);
      }
      setEndingPhase(null);
      setEndDate('');
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to end the phase.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Admin</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Program Phases</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Which block each program is in, stated by a person — foundation, competition prep,
              off season. Starting a new phase closes the current one and keeps it on the record,
              so past work keeps the context it actually happened in. A phase decides nothing about
              any athlete.
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
            <h2 className="t-label mb-[var(--s3)]">Start a phase</h2>
            <div className="grid gap-[var(--s3)] md:grid-cols-2">
              <div className="field">
                <label className="t-label" htmlFor="phase-program">Program</label>
                <input id="phase-program" className="input" value={form.program_name}
                  onChange={(e) => setForm((f) => ({ ...f, program_name: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="phase-name">Phase name</label>
                <input id="phase-name" className="input" value={form.phase_name}
                  onChange={(e) => setForm((f) => ({ ...f, phase_name: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="phase-start">Starts on</label>
                <input id="phase-start" type="date" className="input" value={form.started_on}
                  onChange={(e) => setForm((f) => ({ ...f, started_on: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="phase-focus">Focus (optional)</label>
                <input id="phase-focus" className="input" value={form.focus}
                  onChange={(e) => setForm((f) => ({ ...f, focus: e.target.value }))} />
              </div>
              <div className="field md:col-span-2">
                <label className="t-label" htmlFor="phase-notes">Notes (optional)</label>
                <input id="phase-notes" className="input" value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            <div className="mt-[var(--s4)]">
              <button type="button" className="btn" disabled={busy} onClick={() => void handleStart()}>
                {busy ? 'Starting…' : 'Start phase'}
              </button>
            </div>
          </section>

          {loading ? (
            <div className="flex justify-center py-[var(--s6)]">
              <span className="working">Loading phases...</span>
            </div>
          ) : items.length === 0 && !errorMessage ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No phases declared</div>
                <p className="empty-msg mx-auto">A program with no declared phase is an honest blank, not a default.</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s2)]">
              {items.map((phase) => (
                <li key={phase.phase_id} className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                  <div className="flex flex-wrap items-center gap-[var(--s3)]">
                    {phase.ended_on === null ? (
                      <span className="badge badge--cleared"><i aria-hidden="true">●</i>current</span>
                    ) : (
                      <span className="badge badge--filed"><i aria-hidden="true">▣</i>closed</span>
                    )}
                    <span className="t-body font-semibold text-[color:var(--bone-100)]">
                      {phase.program_name} — {phase.phase_name}
                    </span>
                    <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                      {phase.started_on} → {phase.ended_on ?? 'open'}
                    </span>
                    {phase.ended_on === null && endingPhase !== phase.phase_id && (
                      <button type="button" className="btn btn--ghost" disabled={busy}
                        onClick={() => setEndingPhase(phase.phase_id)}>
                        End phase
                      </button>
                    )}
                  </div>
                  {phase.focus ? (
                    <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>Focus: {phase.focus}</p>
                  ) : null}
                  {phase.notes ? (
                    <p className="t-body mt-[var(--s1)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>{phase.notes}</p>
                  ) : null}

                  {endingPhase === phase.phase_id && (
                    <div className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s2)]">
                      <div className="field">
                        <label className="t-label" htmlFor={`end-${phase.phase_id}`}>Ended on</label>
                        <input id={`end-${phase.phase_id}`} type="date" className="input" value={endDate}
                          onChange={(e) => setEndDate(e.target.value)} />
                      </div>
                      <button type="button" className="btn" disabled={busy}
                        onClick={() => void handleEnd(phase.phase_id)}>
                        Record end
                      </button>
                      <button type="button" className="btn btn--ghost" disabled={busy}
                        onClick={() => { setEndingPhase(null); setEndDate(''); }}>
                        Cancel
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/admin" className="btn btn--ghost">Back to Admin</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
