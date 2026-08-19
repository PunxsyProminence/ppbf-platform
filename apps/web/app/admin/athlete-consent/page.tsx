"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

interface OrganizationConsentRow {
  athlete_id: string;
  athlete_name: string;
  consent_ok: boolean;
  guardian_count: number;
  missing_guardian_count: number;
}

type Filter = 'all' | 'missing' | 'ok';

export default function AthleteConsentAuditPage() {
  const [items, setItems] = useState<OrganizationConsentRow[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [filter, setFilter] = useState<Filter>('missing');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/athlete-consent`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { items?: OrganizationConsentRow[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load consent status.');
      }
      setItems(payload.items ?? []);
      setErrorMessage('');
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load consent status.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const isLoading = items === null;
  const visible = isLoading
    ? []
    : items.filter((item) => (filter === 'all' ? true : filter === 'missing' ? !item.consent_ok : item.consent_ok));

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room--clinic min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Guardian Media Consent Audit</h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.waivers</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Every athlete in the organization and whether every one of their guardians has a current photo/video
              consent on file. An athlete with no guardians on file cannot have consent verified at all -- that
              shows as missing, not as cleared.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
          </header>

          <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
            {(['missing', 'ok', 'all'] as Filter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`btn ${filter === value ? '' : 'btn--ghost'}`}
              >
                {value === 'missing' ? 'Missing consent' : value === 'ok' ? 'Consent on file' : 'All athletes'}
              </button>
            ))}
          </div>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading…</div>
            </div>
          ) : errorMessage ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">The audit could not be loaded</div>
              <div className="empty-msg">The list above is unavailable, not empty. Reload to retry.</div>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Nothing in this view</div>
              <div className="empty-msg">No athletes match this filter right now.</div>
            </div>
          ) : (
            <section className="mat-leather mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)]">
              <table className="w-full text-left">
                <thead>
                  <tr className="t-eyebrow border-b border-[color:var(--hide-700)]">
                    <th className="px-[var(--s4)] py-[var(--s3)]">Athlete</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Guardians</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <tr key={item.athlete_id} className="border-b border-[color:var(--hide-800)] last:border-b-0">
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">{item.athlete_name}</td>
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">
                        {item.guardian_count === 0
                          ? 'No guardians on file'
                          : `${item.guardian_count - item.missing_guardian_count}/${item.guardian_count} consented`}
                      </td>
                      <td className="px-[var(--s4)] py-[var(--s3)]">
                        <span className={`badge ${item.consent_ok ? 'badge--cleared' : 'badge--restricted'}`}>
                          <i>{item.consent_ok ? '✓' : '▲'}</i>
                          {item.consent_ok ? 'Consent on file' : 'Missing'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/admin/video-compliance" className="btn btn--ghost">
              Video Compliance Review
            </Link>
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
