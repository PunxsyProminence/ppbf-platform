"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

interface PendingPortrait {
  account_id: string;
  full_name: string;
  athlete_id: string | null;
  uploaded_at: string;
}

type Decision = 'approve' | 'reject';

function formatDate(value: string): string {
  return formatGymDateTimeShort(value) ?? value;
}

export default function PortraitReviewPage() {
  const [items, setItems] = useState<PendingPortrait[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  // A set, not a single id -- an admin can start a decision on one row while
  // another row's request is still in flight, and each row's own button must
  // only re-enable when THAT row's request resolves.
  const [pendingAccountIds, setPendingAccountIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/portrait-review`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { portraits?: PendingPortrait[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load the portrait review queue.');
      }
      setItems(payload.portraits ?? []);
      setErrorMessage('');
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load the portrait review queue.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function decide(accountId: string, decision: Decision) {
    // A reject deletes the photo bytes -- the review row stays for the audit
    // trail, but the confirm is here because that half is not reversible.
    if (decision === 'reject') {
      const confirmed = window.confirm(
        'Reject this portrait? The photo is deleted; a record of the decision stays in the audit trail.',
      );
      if (!confirmed) return;
    }
    setPendingAccountIds((prev) => new Set(prev).add(accountId));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/portrait-review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, decision }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Unable to record the decision.');
      }
      setActionMessage(decision === 'approve' ? 'Portrait approved.' : 'Portrait rejected.');
      await load();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Unable to record the decision.');
    } finally {
      setPendingAccountIds((prev) => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  }

  const isLoading = items === null;

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Portrait Review</h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.account_profiles</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Every uploaded photo starts here and is visible to nobody but its uploader until an admin decides.
              Approving releases it under the platform&rsquo;s usual visibility rules; rejecting deletes the photo and
              keeps the record for the audit trail.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
            {actionMessage ? <p className="t-body mt-[var(--s3)] font-semibold text-[color:var(--brass-300)]">{actionMessage}</p> : null}
          </header>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading the review queue…</div>
            </div>
          ) : errorMessage ? (
            // A failed load must not wear the empty state's clothes: "Nothing
            // pending" is a claim about the data, and after an error there is
            // no data to make claims about.
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">The queue could not be loaded</div>
              <div className="empty-msg">The list above is unavailable, not empty. Reload to retry.</div>
            </div>
          ) : items.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Nothing pending</div>
              <div className="empty-msg">No portraits are waiting for review right now.</div>
            </div>
          ) : (
            <section className="mat-leather mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)]">
              <table className="w-full text-left">
                <thead>
                  <tr className="t-eyebrow border-b border-[color:var(--hide-700)]">
                    <th className="px-[var(--s4)] py-[var(--s3)]">Name</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Uploaded</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.account_id} className="border-b border-[color:var(--hide-800)] last:border-b-0 align-top">
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">{item.full_name}</td>
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">{formatDate(item.uploaded_at)}</td>
                      <td className="px-[var(--s4)] py-[var(--s3)]">
                        <div className="flex flex-col gap-[var(--s2)]">
                          <button
                            type="button"
                            disabled={pendingAccountIds.has(item.account_id)}
                            onClick={() => void decide(item.account_id, 'approve')}
                            className="btn--lever min-h-[44px] disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={pendingAccountIds.has(item.account_id)}
                            onClick={() => void decide(item.account_id, 'reject')}
                            className="btn--lever min-h-[44px] disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
