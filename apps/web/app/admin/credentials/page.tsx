'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Admin verification queue for staff credentials. This is also where
// "alerts" live -- there is no cron in this codebase (trainingHolds.ts's
// house style), so expiry is a read-time sweep: the route recomputes each
// row's band from today's date on every GET, and this page just styles what
// it is handed. Verifying is the only path that can move a submission to
// 'current'; a self-upload never does.

interface QueueRow {
  clearance_id: string;
  person_account_id: string;
  person_display_name: string;
  person_role: string;
  clearance_type_id: string;
  clearance_name: string;
  issuing_authority: string;
  validity_months: number | null;
  status: string;
  band: string;
  issued_on: string | null;
  expires_on: string | null;
  has_document: boolean;
  verified_by_account_id: string | null;
  verified_at: string | null;
  verification_note: string | null;
}

function addMonths(dateStr: string, months: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
  return result.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

export default function AdminCredentialsPage() {
  const [items, setItems] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifyForms, setVerifyForms] = useState<Record<string, { issued_on: string; expires_on: string; note: string }>>({});
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});

  const rowKey = (row: Pick<QueueRow, 'person_account_id' | 'clearance_type_id'>) =>
    `${row.person_account_id}::${row.clearance_type_id}`;

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/admin/credentials`, { credentials: 'include', signal });
    if (!response.ok) throw new Error('Unable to load the credential queue.');
    const payload = (await response.json()) as { items?: QueueRow[] };
    setItems(payload.items ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reload(controller.signal);
        if (!controller.signal.aborted) setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the credential queue.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  const post = async (body: Record<string, unknown>, failure: string) => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/credentials`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `${failure} (${response.status})`);
      }
      setErrorMessage(null);
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : failure);
      return false;
    }
  };

  const handleVerify = async (row: QueueRow) => {
    const key = rowKey(row);
    const form = verifyForms[key] ?? { issued_on: today(), expires_on: '', note: '' };
    if (!form.issued_on) {
      setErrorMessage('Verifying needs the date you confirmed this clearance was issued.');
      return;
    }
    setBusyKey(key);
    const ok = await post({
      action: 'verify',
      person_account_id: row.person_account_id,
      clearance_type_id: row.clearance_type_id,
      issued_on: form.issued_on,
      expires_on: form.expires_on || undefined,
      note: form.note || undefined,
    }, 'Unable to verify this credential.');
    if (ok) {
      setNotice(`${row.person_display_name}'s ${row.clearance_name} is now current.`);
      setVerifyForms((f) => { const next = { ...f }; delete next[key]; return next; });
      await reload();
    }
    setBusyKey(null);
  };

  const handleReject = async (row: QueueRow) => {
    const key = rowKey(row);
    const note = rejectNotes[key]?.trim();
    if (!note) {
      setErrorMessage('A rejection needs a note so the person knows what to fix.');
      return;
    }
    setBusyKey(key);
    const ok = await post({
      action: 'reject',
      person_account_id: row.person_account_id,
      clearance_type_id: row.clearance_type_id,
      note,
    }, 'Unable to reject this submission.');
    if (ok) {
      setNotice(`${row.person_display_name}'s ${row.clearance_name} was sent back for resubmission.`);
      setRejectNotes((f) => { const next = { ...f }; delete next[key]; return next; });
      await reload();
    }
    setBusyKey(null);
  };

  const alertRowClass = (band: string) =>
    band === 'expired' || band === 'revoked' ? 'alert alert--critical'
      : band === 'expiring_soon' ? 'alert alert--warning'
        : '';

  const bandLabel: Record<string, string> = {
    current: 'Current', expiring_soon: 'Expiring soon', expired: 'Expired', submitted: 'Awaiting review',
    revoked: 'Revoked', not_required: 'Not required', missing: 'Not on file',
  };

  const needsAttention = items.filter((row) => ['submitted', 'expired', 'expiring_soon', 'revoked'].includes(row.band));
  const others = items.filter((row) => !['submitted', 'expired', 'expiring_soon', 'revoked'].includes(row.band));

  const renderRow = (row: QueueRow) => {
    const key = rowKey(row);
    const busy = busyKey === key;
    const isReviewable = row.status === 'submitted' || row.band === 'expired' || row.band === 'expiring_soon';
    const form = verifyForms[key] ?? { issued_on: today(), expires_on: '', note: '' };
    const suggestedExpiry = form.issued_on && row.validity_months
      ? addMonths(form.issued_on, row.validity_months)
      : '';

    const wrapperClass = alertRowClass(row.band);

    return (
      <li key={key} className={wrapperClass ? `${wrapperClass} mb-[var(--s3)]` : 'mat-leather mb-[var(--s3)] rounded-[var(--r-lg)] p-[var(--s4)]'}>
        {wrapperClass && <span className="alert-icon" aria-hidden="true">{row.band === 'expiring_soon' ? '!' : '✕'}</span>}
        <div className={wrapperClass ? 'alert-body' : ''}>
          <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
            <span className="t-body font-semibold text-[color:var(--bone-100)]">{row.person_display_name}</span>
            <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{row.person_role}</span>
            <span className="t-body font-semibold">{row.clearance_name}</span>
            <span className="badge badge--filed"><i aria-hidden="true">▣</i>{bandLabel[row.band] ?? row.band}</span>
          </div>
          <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
            {row.issuing_authority}
            {row.expires_on ? ` — ${row.band === 'expired' ? 'expired' : 'expires'} ${row.expires_on}` : ''}
          </p>
          {row.verification_note && (
            <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>Note: {row.verification_note}</p>
          )}
          {row.has_document && (
            <p className="mt-[var(--s2)]">
              <a
                className="btn btn--ghost"
                href={`${apiBase()}/api/pilot/credentials/document/${row.person_account_id}/${row.clearance_type_id}`}
                target="_blank"
                rel="noreferrer"
              >
                View document
              </a>
            </p>
          )}

          {isReviewable && (
            <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-3">
              <div className="field">
                <label className="t-label" htmlFor={`issued-${key}`}>Issued on</label>
                <input
                  id={`issued-${key}`}
                  type="date"
                  className="input"
                  value={form.issued_on}
                  onChange={(e) => setVerifyForms((f) => ({ ...f, [key]: { ...form, issued_on: e.target.value } }))}
                />
              </div>
              <div className="field">
                <label className="t-label" htmlFor={`expires-${key}`}>Expires on{suggestedExpiry ? ` (suggested ${suggestedExpiry})` : ''}</label>
                <input
                  id={`expires-${key}`}
                  type="date"
                  className="input"
                  placeholder={suggestedExpiry}
                  value={form.expires_on}
                  onChange={(e) => setVerifyForms((f) => ({ ...f, [key]: { ...form, expires_on: e.target.value } }))}
                />
              </div>
              <div className="field">
                <label className="t-label" htmlFor={`note-${key}`}>Note (optional)</label>
                <input
                  id={`note-${key}`}
                  className="input"
                  value={form.note}
                  onChange={(e) => setVerifyForms((f) => ({ ...f, [key]: { ...form, note: e.target.value } }))}
                />
              </div>
            </div>
          )}

          {isReviewable && (
            <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
              <button type="button" className="btn" disabled={busy} onClick={() => void handleVerify(row)}>
                {busy ? 'Verifying…' : 'Verify'}
              </button>
              <input
                className="input"
                placeholder="Reason for rejecting (required)"
                value={rejectNotes[key] ?? ''}
                onChange={(e) => setRejectNotes((f) => ({ ...f, [key]: e.target.value }))}
              />
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void handleReject(row)}>
                Reject
              </button>
            </div>
          )}
        </div>
      </li>
    );
  };

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Admin Console</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Staff Credentials</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Review submitted documents and confirm issue/expiry dates. Verifying is the only thing that
              moves a submission to &ldquo;current&rdquo; -- an upload never does that on its own. Expired
              and revoked credentials are flagged critical; anything expiring within 30 days is flagged for
              attention. There is no automatic notification here -- this page recomputes on every load.
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

          {notice && (
            <div className="alert alert--success" role="status">
              <span className="alert-icon" aria-hidden="true">✓</span>
              <div className="alert-body">
                <p className="alert-title">Recorded</p>
                <p className="alert-msg">{notice}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s6)]">
              <span className="working">Loading the credential queue...</span>
            </div>
          ) : items.length === 0 ? (
            <p className="empty-msg">No staff credential records yet.</p>
          ) : (
            <>
              <h2 className="t-label mb-[var(--s3)]">Needs attention</h2>
              {needsAttention.length === 0 ? (
                <p className="t-body mb-[var(--s4)]">Nothing needs review right now.</p>
              ) : (
                <ul className="mb-[var(--s5)]">{needsAttention.map(renderRow)}</ul>
              )}

              {others.length > 0 && (
                <>
                  <h2 className="t-label mb-[var(--s3)]">Everything else</h2>
                  <ul>{others.map(renderRow)}</ul>
                </>
              )}
            </>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/admin" className="btn btn--ghost">Back to Admin Console</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
