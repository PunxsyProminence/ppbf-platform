'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// The grant-obligation ledger (owner decision 2026-08-15: internal half
// only). Deadlines first: the soonest-due open work leads, overdue is
// flagged, settled rows sink. Nothing on this page touches athlete data --
// the table it reads structurally has none, which is what keeps the parked
// external-disclosure question (BACKLOG-grant-packet) parked.
interface ObligationRow {
  obligation_id: string;
  grant_name: string;
  funder_name: string;
  obligation_type: string;
  description: string;
  due_date: string;
  status: string;
  completed_at: string | null;
  notes: string;
}

const OBLIGATION_TYPES = ['report', 'deliverable', 'renewal', 'filing', 'acknowledgment', 'other'] as const;

const STATUS_BADGE: Record<string, { className: string; glyph: string }> = {
  open: { className: 'badge badge--monitor', glyph: '◉' },
  in_progress: { className: 'badge badge--monitor', glyph: '◉' },
  submitted: { className: 'badge badge--restricted', glyph: '▲' },
  complete: { className: 'badge badge--cleared', glyph: '✓' },
  waived: { className: 'badge badge--cleared', glyph: '✓' },
};

// The advance a row offers next. Reopen stays available on settled rows
// because funders bounce reports; the module enforces the full transition
// table server-side.
const NEXT_ACTIONS: Record<string, Array<{ status: string; label: string }>> = {
  open: [{ status: 'in_progress', label: 'Start' }, { status: 'submitted', label: 'Mark submitted' }],
  in_progress: [{ status: 'submitted', label: 'Mark submitted' }, { status: 'complete', label: 'Mark complete' }],
  submitted: [{ status: 'complete', label: 'Mark complete' }, { status: 'in_progress', label: 'Back to in progress' }],
  complete: [{ status: 'open', label: 'Reopen' }],
  waived: [{ status: 'open', label: 'Reopen' }],
};

function isOverdue(row: ObligationRow): boolean {
  if (row.status === 'complete' || row.status === 'waived') return false;
  return row.due_date < new Date().toISOString().slice(0, 10);
}

export default function GrantObligationsPage() {
  const [items, setItems] = useState<ObligationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    grant_name: '',
    funder_name: '',
    obligation_type: 'report',
    description: '',
    due_date: '',
    notes: '',
  });

  const reload = useCallback(async () => {
    const response = await fetch(`${apiBase()}/api/pilot/admin/grant-obligations`, {
      method: 'GET',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Unable to load grant obligations.');
    const payload = (await response.json()) as { items?: ObligationRow[] };
    setItems(payload.items ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reload();
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load grant obligations.');
      } finally {
        setLoading(false);
      }
    })();
  }, [reload]);

  const handleCreate = async () => {
    setBusyId('new');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/grant-obligations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Create failed (${response.status})`);
      }
      setShowForm(false);
      setForm({ grant_name: '', funder_name: '', obligation_type: 'report', description: '', due_date: '', notes: '' });
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create the obligation.');
    } finally {
      setBusyId(null);
    }
  };

  const handleAdvance = async (row: ObligationRow, status: string) => {
    setBusyId(row.obligation_id);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/grant-obligations`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ obligation_id: row.obligation_id, status }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Update failed (${response.status})`);
      }
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to update the obligation.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Grant Compliance</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Grant Obligations</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              The organization&rsquo;s commitments to funders — reports, deliverables, renewals, filings —
              soonest due first. Internal records only: nothing here reads or discloses athlete data.
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

          <div className="mb-[var(--s4)]">
            <button type="button" className="btn" onClick={() => setShowForm((current) => !current)}>
              {showForm ? 'Close form' : 'Add obligation'}
            </button>
          </div>

          {showForm && (
            <section className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
              <div className="grid gap-[var(--s3)] md:grid-cols-2">
                <div className="field">
                  <label className="t-label" htmlFor="grant-name">Grant</label>
                  <input id="grant-name" className="input" value={form.grant_name}
                    onChange={(e) => setForm((f) => ({ ...f, grant_name: e.target.value }))} />
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="funder-name">Funder</label>
                  <input id="funder-name" className="input" value={form.funder_name}
                    onChange={(e) => setForm((f) => ({ ...f, funder_name: e.target.value }))} />
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="obligation-type">Type</label>
                  <select id="obligation-type" className="select" value={form.obligation_type}
                    onChange={(e) => setForm((f) => ({ ...f, obligation_type: e.target.value }))}>
                    {OBLIGATION_TYPES.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="due-date">Due date</label>
                  <input id="due-date" type="date" className="input" value={form.due_date}
                    onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
                </div>
                <div className="field md:col-span-2">
                  <label className="t-label" htmlFor="description">What is owed</label>
                  <textarea id="description" className="input" rows={2} value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
              <div className="mt-[var(--s4)]">
                <button type="button" className="btn" disabled={busyId === 'new'} onClick={() => void handleCreate()}>
                  {busyId === 'new' ? 'Saving…' : 'Save obligation'}
                </button>
              </div>
            </section>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading obligations...</span>
            </div>
          ) : items.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No obligations on record</div>
                <p className="empty-msg mx-auto">When the gym takes a grant, its deadlines get filed here.</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s3)]">
              {items.map((row) => {
                const badge = STATUS_BADGE[row.status] ?? STATUS_BADGE.open;
                const overdue = isOverdue(row);
                return (
                  <li key={row.obligation_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">{row.grant_name}</span>
                      {row.funder_name ? <span className="t-label">{row.funder_name}</span> : null}
                      <span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{row.status.replaceAll('_', ' ')}</span>
                      {overdue ? <span className="badge badge--locked"><i aria-hidden="true">✕</i>overdue</span> : null}
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                        {row.obligation_type} due {formatGymDateNumeric(row.due_date)}
                      </span>
                    </div>
                    <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{row.description}</p>
                    <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
                      {(NEXT_ACTIONS[row.status] ?? []).map((action) => (
                        <button
                          key={action.status}
                          type="button"
                          className="btn btn--ghost"
                          disabled={busyId === row.obligation_id}
                          onClick={() => void handleAdvance(row, action.status)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
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
