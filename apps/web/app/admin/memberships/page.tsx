'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// Program memberships and scholarships (radar rows "Membership Tracking" and
// "Scholarship Tracking"). A scholarship is a stored DISCOUNT on a real
// membership -- 100% for a full scholarship -- never a bypass: the athlete
// has a membership row like everyone else, and when charging arrives the fee
// computes from this record. Nothing on this page bills anyone.
//
// Membership rows carry athlete links; names come from the org-scoped
// athlete read. Admin-only, both directions (the API enforces it).

interface MembershipRow {
  membership_id: string;
  athlete_id: string;
  athlete_name: string;
  program_name: string;
  status: string;
  started_on: string;
  ended_on: string | null;
  scholarship_percent: number;
  scholarship_note: string;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

const STATUS_BADGE: Record<string, { className: string; glyph: string }> = {
  active: { className: 'badge badge--cleared', glyph: '✓' },
  lapsed: { className: 'badge badge--restricted', glyph: '▲' },
  ended: { className: 'badge badge--filed', glyph: '▣' },
};

const NEXT_ACTIONS: Record<string, Array<{ status: string; label: string }>> = {
  active: [{ status: 'lapsed', label: 'Mark lapsed' }, { status: 'ended', label: 'End membership' }],
  lapsed: [{ status: 'active', label: 'Reactivate' }, { status: 'ended', label: 'End membership' }],
  ended: [],
};

const SCHOLARSHIP_LEVELS = [0, 25, 50, 75, 100];

export default function MembershipsPage() {
  const [items, setItems] = useState<MembershipRow[]>([]);
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ athlete_id: '', program_name: '', started_on: '', scholarship_percent: 0 });

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/admin/memberships`, {
      method: 'GET',
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load memberships.');
    const payload = (await response.json()) as { items?: MembershipRow[] };
    setItems(payload.items ?? []);
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
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load memberships.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

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
        // Silent: the picker degrades to empty; the list still renders.
      }
    })();
    return () => controller.abort();
  }, []);

  const patch = async (membershipId: string, body: Record<string, unknown>) => {
    setBusyId(membershipId);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/memberships`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ membership_id: membershipId, ...body }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Update failed (${response.status})`);
      }
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to update the membership.');
    } finally {
      setBusyId(null);
    }
  };

  const handleCreate = async () => {
    setBusyId('new');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/memberships`, {
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
      setForm({ athlete_id: '', program_name: '', started_on: '', scholarship_percent: 0 });
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create the membership.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Revenue</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Program Memberships</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Who is enrolled in what, with scholarships recorded as discounts — a full scholarship
              is 100%, never an athlete waved invisibly past the system. No billing happens here;
              fees arrive with the payment lanes and will read these records.
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
              {showForm ? 'Close form' : 'Enroll athlete'}
            </button>
          </div>

          {showForm && (
            <section className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
              <div className="grid gap-[var(--s3)] md:grid-cols-2">
                <div className="field">
                  <label className="t-label" htmlFor="membership-athlete">Athlete</label>
                  <select id="membership-athlete" className="select" value={form.athlete_id}
                    onChange={(e) => setForm((f) => ({ ...f, athlete_id: e.target.value }))}>
                    <option value="">Select an athlete…</option>
                    {athletes.map((athlete) => (
                      <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="program-name">Program</label>
                  <input id="program-name" className="input" value={form.program_name}
                    onChange={(e) => setForm((f) => ({ ...f, program_name: e.target.value }))} />
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="started-on">Start date</label>
                  <input id="started-on" type="date" className="input" value={form.started_on}
                    onChange={(e) => setForm((f) => ({ ...f, started_on: e.target.value }))} />
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="scholarship-percent">Scholarship</label>
                  <select id="scholarship-percent" className="select" value={form.scholarship_percent}
                    onChange={(e) => setForm((f) => ({ ...f, scholarship_percent: Number(e.target.value) }))}>
                    {SCHOLARSHIP_LEVELS.map((level) => (
                      <option key={level} value={level}>{level === 0 ? 'None' : `${level}% discount`}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-[var(--s4)]">
                <button type="button" className="btn" disabled={busyId === 'new'} onClick={() => void handleCreate()}>
                  {busyId === 'new' ? 'Saving…' : 'Save membership'}
                </button>
              </div>
            </section>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading memberships...</span>
            </div>
          ) : items.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No memberships on record</div>
                <p className="empty-msg mx-auto">When an athlete enrolls in a program, it gets filed here.</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s3)]">
              {items.map((row) => {
                const badge = STATUS_BADGE[row.status] ?? STATUS_BADGE.active;
                return (
                  <li key={row.membership_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">{row.athlete_name}</span>
                      <span className="t-label">{row.program_name}</span>
                      <span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{row.status}</span>
                      {row.scholarship_percent > 0 ? (
                        <span className="badge badge--monitor"><i aria-hidden="true">◉</i>{row.scholarship_percent}% scholarship</span>
                      ) : null}
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                        since {formatGymDateNumeric(row.started_on)}
                        {row.ended_on ? ` — ended ${formatGymDateNumeric(row.ended_on)}` : ''}
                      </span>
                    </div>
                    <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s2)]">
                      {(NEXT_ACTIONS[row.status] ?? []).map((action) => (
                        <button key={action.status} type="button" className="btn btn--ghost"
                          disabled={busyId === row.membership_id}
                          onClick={() => void patch(row.membership_id, { status: action.status })}>
                          {action.label}
                        </button>
                      ))}
                      {row.status !== 'ended' && (
                        <label className="t-label flex items-center gap-[var(--s2)]" htmlFor={`scholarship-${row.membership_id}`}>
                          Scholarship
                          <select id={`scholarship-${row.membership_id}`} className="select" value={row.scholarship_percent}
                            disabled={busyId === row.membership_id}
                            onChange={(e) => void patch(row.membership_id, { scholarship_percent: Number(e.target.value) })}>
                            {SCHOLARSHIP_LEVELS.map((level) => (
                              <option key={level} value={level}>{level === 0 ? 'None' : `${level}%`}</option>
                            ))}
                          </select>
                        </label>
                      )}
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
