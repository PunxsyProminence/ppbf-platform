"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

const TRACKED_WAIVER_TYPES = ['general', 'medical_release', 'photo_media', 'travel'] as const;
type TrackedWaiverType = (typeof TRACKED_WAIVER_TYPES)[number];

const WAIVER_TYPE_LABEL: Record<TrackedWaiverType, string> = {
  general: 'General',
  medical_release: 'Medical release',
  photo_media: 'Photo & media',
  travel: 'Travel',
};

type WaiverStatus = 'signed' | 'declined' | 'withdrawn' | 'missing';

interface AthleteWaiverRow {
  athlete_id: string;
  athlete_name: string;
  active_flag: boolean;
  waivers: Record<TrackedWaiverType, WaiverStatus>;
}

type Filter = 'incomplete' | 'complete' | 'all';

function isComplete(row: AthleteWaiverRow): boolean {
  return TRACKED_WAIVER_TYPES.every((type) => row.waivers[type] === 'signed');
}

export default function WaiverComplianceAuditPage() {
  const [items, setItems] = useState<AthleteWaiverRow[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [filter, setFilter] = useState<Filter>('incomplete');
  const [activeOnly, setActiveOnly] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/waiver-status`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { items?: AthleteWaiverRow[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load waiver status.');
      }
      setItems(payload.items ?? []);
      setErrorMessage('');
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load waiver status.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const isLoading = items === null;

  const visible = useMemo(() => {
    if (isLoading) return [];
    return items
      .filter((row) => (activeOnly ? row.active_flag : true))
      .filter((row) => (filter === 'all' ? true : filter === 'complete' ? isComplete(row) : !isComplete(row)));
  }, [items, isLoading, filter, activeOnly]);

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--clinic min-h-screen">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          {/* Room DNA (clinic): cabinetry, the green banker's shade, and the
              blackletter reserved for the clinic masthead at display size only.
              The eyebrow states --brass-200 because --brass-400 is 3.34:1 on
              .mat-wood's lit edge; full note on /coach/sports-medicine. */}
          <i aria-hidden="true" className="lamp lamp--green right-[8%]" />
          <header className="mat-wood rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow text-[color:var(--brass-200)]">Admin Workspace</p>
            <h1
              className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]"
              style={{ fontSize: 'var(--t-2xl)' }}
            >
              Waiver Compliance
            </h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.waivers</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Every athlete in the organization against every tracked waiver type -- general, medical release,
              photo &amp; media, travel -- so a missing waiver is visible without looking up athletes one at a
              time. Photo &amp; media consent has its own dedicated audit with guardian-level detail; that link
              is below.
            </p>
            {/* A failed read is a network fact. --locked red is what this room
                says when a clinician or a safeguarding decision has stopped
                something, so it does not carry this. --restricted does, keeping
                the glyph and gaining the uppercase label Law 3 asks for. */}
            {errorMessage ? (
              <div role="alert" className="alert alert--warning mt-[var(--s3)]">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title">Attention</p>
                  <p className="alert-msg">{errorMessage}</p>
                </div>
              </div>
            ) : null}
          </header>

          <div className="mt-[var(--s5)] flex flex-wrap items-center gap-[var(--s3)]">
            {(['incomplete', 'complete', 'all'] as Filter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`btn ${filter === value ? '' : 'btn--ghost'}`}
              >
                {value === 'incomplete' ? 'Missing a waiver' : value === 'complete' ? 'All signed' : 'All athletes'}
              </button>
            ))}
            <label className="t-body ml-[var(--s3)] flex items-center gap-[var(--s2)]">
              <input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} />
              Active athletes only
            </label>
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
                    {TRACKED_WAIVER_TYPES.map((type) => (
                      <th key={type} className="px-[var(--s4)] py-[var(--s3)]">{WAIVER_TYPE_LABEL[type]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.athlete_id} className="border-b border-[color:var(--hide-800)] last:border-b-0">
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">{row.athlete_name}</td>
                      {TRACKED_WAIVER_TYPES.map((type) => {
                        const status = row.waivers[type];
                        const ok = status === 'signed';
                        return (
                          <td key={type} className="px-[var(--s4)] py-[var(--s3)]">
                            <span className={`badge ${ok ? 'badge--cleared' : 'badge--restricted'}`}>
                              <i>{ok ? '✓' : '▲'}</i>
                              {status === 'signed' ? 'Signed' : status === 'declined' ? 'Declined' : status === 'withdrawn' ? 'Withdrawn' : 'Missing'}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/admin/athlete-consent" className="btn btn--ghost">
              Photo &amp; Media Consent Audit
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
