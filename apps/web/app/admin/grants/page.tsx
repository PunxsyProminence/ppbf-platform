'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric, GYM_TIME_ZONE } from '@/src/lib/gymTime';

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

/** Today as YYYY-MM-DD on the gym's wall clock, not UTC's. */
function gymToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: GYM_TIME_ZONE }).format(new Date());
}

function isOverdue(row: ObligationRow): boolean {
  // 'submitted' counts as settled here for the same reason the server stamps
  // completed_at on it: the work left the building; the funder's clock is
  // running now, not ours.
  if (row.status === 'submitted' || row.status === 'complete' || row.status === 'waived') return false;
  return row.due_date < gymToday();
}

type ReportState = 'open' | 'settled' | 'all';

const SETTLED = new Set(['submitted', 'complete', 'waived']);

/*
 * THE OBLIGATIONS REPORT (RP-03). Internal, for the organization admin. A
 * summary grouped by grant and funder for the chosen state and due range,
 * counted from the ledger this page already read; Print prints only this
 * section; Download CSV asks the server for the same rows as a dated file
 * (no notes). Overdue is a display fact, as on the list below.
 */
function GrantReport({ items }: Readonly<{ items: readonly ObligationRow[] }>) {
  const [state, setState] = useState<ReportState>('all');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const groups = useMemo(() => {
    const chosen = items.filter((row) => {
      const settled = SETTLED.has(row.status);
      if (state === 'open' && settled) return false;
      if (state === 'settled' && !settled) return false;
      if (dueFrom && row.due_date < dueFrom) return false;
      if (dueTo && row.due_date > dueTo) return false;
      return true;
    });
    const byGrant = new Map<string, { key: string; grant: string; funder: string; total: number; open: number; settled: number; overdue: number }>();
    for (const row of chosen) {
      const key = `${row.grant_name}\u0000${row.funder_name}`;
      const group = byGrant.get(key) ?? { key, grant: row.grant_name, funder: row.funder_name, total: 0, open: 0, settled: 0, overdue: 0 };
      group.total += 1;
      if (SETTLED.has(row.status)) group.settled += 1;
      else group.open += 1;
      if (isOverdue(row)) group.overdue += 1;
      byGrant.set(key, group);
    }
    return [...byGrant.values()].sort((a, b) => a.grant.localeCompare(b.grant) || a.funder.localeCompare(b.funder));
  }, [items, state, dueFrom, dueTo]);

  async function download() {
    if (busyRef.current) return;
    setFailure('');
    if (dueFrom && dueTo && dueFrom > dueTo) {
      setFailure('Choose a From date on or before the To date.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const params = new URLSearchParams({ format: 'csv', state });
      if (dueFrom) params.set('from', dueFrom);
      if (dueTo) params.set('to', dueTo);
      const response = await fetch(`${apiBase()}/api/pilot/admin/grant-obligations?${params}`, { credentials: 'include' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'The report could not be made.');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `grant-obligations_${state}_${gymToday()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Released after the click has handed the file over.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : 'The report could not be made.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-label="Obligations report" className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
      <p className="t-eyebrow">Report</p>
      <p className="t-body mt-[var(--s2)]">
        By grant and funder, as of {gymToday()} (gym day). Overdue means open or in progress past its due date.
      </p>
      <div className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)] print:hidden">
        <label className="field">
          <span className="t-label">Show</span>
          <select className="select" value={state} onChange={(event) => { setFailure(''); setState(event.target.value as ReportState); }}>
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="settled">Settled</option>
          </select>
        </label>
        <label className="field">
          <span className="t-label">Due from</span>
          <input type="date" className="input" value={dueFrom} onChange={(event) => { setFailure(''); setDueFrom(event.target.value); }} />
        </label>
        <label className="field">
          <span className="t-label">Due to</span>
          <input type="date" className="input" value={dueTo} onChange={(event) => { setFailure(''); setDueTo(event.target.value); }} />
        </label>
        <button type="button" className="btn btn--ghost" onClick={() => window.print()}>Print</button>
        <button type="button" className="btn" onClick={() => void download()} disabled={busy}>
          {busy ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>
      {failure ? (
        <div role="alert" className="alert alert--critical mt-[var(--s3)]">
          <span className="alert-icon" aria-hidden="true">✕</span>
          <div className="alert-body">
            <p className="alert-title">Download failed</p>
            <p className="alert-msg">{failure}</p>
          </div>
        </div>
      ) : null}
      {groups.length === 0 ? (
        <p className="t-muted mt-[var(--s3)]">No obligations match.</p>
      ) : (
        <table className="mt-[var(--s3)] w-full text-left">
          <thead>
            <tr className="t-eyebrow">
              <th scope="col" className="py-[var(--s2)]">Grant</th>
              <th scope="col" className="py-[var(--s2)]">Funder</th>
              <th scope="col" className="py-[var(--s2)]">Obligations</th>
              <th scope="col" className="py-[var(--s2)]">Open</th>
              <th scope="col" className="py-[var(--s2)]">Settled</th>
              <th scope="col" className="py-[var(--s2)]">Overdue</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.key} className="t-body">
                <td className="py-[var(--s2)]">{group.grant}</td>
                <td className="py-[var(--s2)]">{group.funder || '—'}</td>
                <td className="py-[var(--s2)]">{group.total}</td>
                <td className="py-[var(--s2)]">{group.open}</td>
                <td className="py-[var(--s2)]">{group.settled}</td>
                <td className="py-[var(--s2)]">{group.overdue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function GrantObligationsPage() {
  const [items, setItems] = useState<ObligationRow[]>([]);
  const [loading, setLoading] = useState(true);
  // True once a read of the list has come back. Until then an empty list is
  // not a record of none, so the empty sentence stays hidden.
  const [listRead, setListRead] = useState(false);
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

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/grant-obligations`, {
        method: 'GET',
        credentials: 'include',
        signal,
      });
      if (!response.ok) throw new Error('Unable to load grant obligations.');
      const payload = (await response.json()) as { items?: ObligationRow[] };
      setItems(payload.items ?? []);
      setListRead(true);
    } catch (error) {
      // A failed re-read after a write leaves the list stale: rows on screen
      // stay, but an empty list is no longer a record of none.
      setListRead(false);
      throw error;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reload(controller.signal);
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load grant obligations.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
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
      <main className="room room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Grant Compliance</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Grant Obligations</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)] print:hidden">
              The organization&rsquo;s commitments to funders — reports, deliverables, renewals, filings —
              soonest due first. Internal records only: nothing here reads or discloses athlete data.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical print:hidden" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          {listRead && items.length > 0 ? <GrantReport items={items} /> : null}

          <div className="mb-[var(--s4)] print:hidden">
            <button type="button" className="btn" onClick={() => setShowForm((current) => !current)}>
              {showForm ? 'Close form' : 'Add obligation'}
            </button>
          </div>

          {showForm && (
            <section className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)] print:hidden">
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
          ) : !listRead && items.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">Obligations could not be read</div>
                <p className="empty-msg mx-auto">This is not a record of none. Reload the page to try again.</p>
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No obligations on record</div>
                <p className="empty-msg mx-auto">When the gym takes a grant, its deadlines get filed here.</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s3)] print:hidden">
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
