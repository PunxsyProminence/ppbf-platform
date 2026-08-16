'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Community service tracker (module 128): service hours already recorded
// in the activity log, read back per person. Verified and unverified
// hours are shown as two separate figures and never added together --
// anything a school, court, or scholarship relies on is the verified
// figure alone, and this page refuses to blur that line.

interface ServiceEntry {
  activity_id: string;
  activity_type: string;
  occurred_on: string;
  duration_minutes: number;
  what_was_worked_on: string;
  verified: boolean;
}

interface ServiceTotals {
  person_account_id: string;
  verified_minutes: number;
  unverified_minutes: number;
  entry_count: number;
  entries: ServiceEntry[];
}

const hours = (minutes: number) => Math.floor(minutes / 60);

export default function CommunityServicePage() {
  const [items, setItems] = useState<ServiceTotals[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [openPerson, setOpenPerson] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/community-service`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unable to load community service records.');
        const payload = (await response.json()) as { items?: ServiceTotals[] };
        if (controller.signal.aborted) return;
        setItems(payload.items ?? []);
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load community service records.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Admin</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Community Service</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Service hours recorded in the activity log, per person. Verified and unverified hours
              are kept apart and never added together — if a school, court, or scholarship needs a
              number, it is the verified figure. Hours round down, never up.
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

          {loading ? (
            <div className="flex justify-center py-[var(--s6)]">
              <span className="working">Loading service records...</span>
            </div>
          ) : items.length === 0 && !errorMessage ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No community service recorded</div>
                <p className="empty-msg mx-auto">
                  Service is recorded through the activity log, where this domain requires a verifier.
                </p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s2)]">
              {items.map((person) => {
                const open = openPerson === person.person_account_id;
                return (
                  <li key={person.person_account_id} className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">
                        {person.person_account_id}
                      </span>
                      <span className="badge badge--cleared">
                        <i aria-hidden="true">✓</i>{hours(person.verified_minutes)}h verified
                      </span>
                      {person.unverified_minutes > 0 && (
                        <span className="badge badge--monitor">
                          <i aria-hidden="true">◉</i>{hours(person.unverified_minutes)}h awaiting verification
                        </span>
                      )}
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                        {person.entry_count} {person.entry_count === 1 ? 'entry' : 'entries'}
                      </span>
                      <button type="button" className="btn btn--ghost"
                        onClick={() => setOpenPerson(open ? null : person.person_account_id)}>
                        {open ? 'Hide entries' : 'Show entries'}
                      </button>
                    </div>

                    {open && (
                      <ul className="mt-[var(--s3)] space-y-[var(--s1)]">
                        {person.entries.map((entry) => (
                          <li key={entry.activity_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                            {entry.occurred_on} · {entry.activity_type.replaceAll('_', ' ')} ·{' '}
                            {entry.duration_minutes} min ·{' '}
                            {entry.verified ? 'verified' : 'awaiting verification'}
                            {entry.what_was_worked_on ? ` — ${entry.what_was_worked_on}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
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
