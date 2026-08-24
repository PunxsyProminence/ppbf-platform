'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Self-upload for staff credentials (SafeSport, USA Boxing coach cert,
// background check, CPR/First Aid, ...). Uploading always lands as
// 'submitted' -- an administrator has to look at the document and confirm
// issue/expiry dates before it ever shows as current. This page never shows
// or links to anyone else's document, and never shows its own document back
// either: it shows STATUS, which is what /staff-credentials also shows
// (broadly, to every signed-in person) and /admin/credentials reviews.

interface CredentialItem {
  clearance_type_id: string;
  name: string;
  issuing_authority: string;
  validity_months: number | null;
  status: string;
  band: string;
  issued_on: string | null;
  expires_on: string | null;
  verification_note: string | null;
  has_document: boolean;
}

const BAND_BADGE: Record<string, { className: string; label: string }> = {
  current: { className: 'badge--cleared', label: 'Current' },
  expiring_soon: { className: 'badge--monitor', label: 'Expiring soon' },
  expired: { className: 'badge--restricted', label: 'Expired' },
  submitted: { className: 'badge--monitor', label: 'Awaiting review' },
  revoked: { className: 'badge--restricted', label: 'Revoked' },
  not_required: { className: 'badge--filed', label: 'Not required' },
  missing: { className: 'badge--locked', label: 'Not on file' },
};

function bandBadge(band: string) {
  return BAND_BADGE[band] ?? BAND_BADGE.missing;
}

export default function StaffCredentialsUploadPage() {
  const [items, setItems] = useState<CredentialItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyTypeId, setBusyTypeId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/coach/credentials`, { credentials: 'include', signal });
    if (!response.ok) throw new Error('Unable to load your credentials.');
    const payload = (await response.json()) as { items?: CredentialItem[] };
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
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load your credentials.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  const handleUpload = async (clearanceTypeId: string) => {
    const input = fileInputRefs.current[clearanceTypeId];
    const file = input?.files?.[0];
    if (!file) {
      setErrorMessage('Choose a file (PDF, JPG, or PNG) before uploading.');
      return;
    }

    setBusyTypeId(clearanceTypeId);
    setErrorMessage(null);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append('clearance_type_id', clearanceTypeId);
      formData.append('document', file);

      const response = await fetch(`${apiBase()}/api/pilot/coach/credentials`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Unable to upload the document (${response.status})`);
      }

      if (input) input.value = '';
      await reload();
      setNotice('Uploaded. An administrator verifies it before it shows as current.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to upload the document.');
    } finally {
      setBusyTypeId(null);
    }
  };

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin', 'staff', 'volunteer']}>
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>My Credentials</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Upload your own certification documents -- SafeSport, USA Boxing coach certification,
              background check, CPR/First Aid. An upload sets your status to &ldquo;awaiting review&rdquo;;
              only an administrator can confirm a document and move it to &ldquo;current&rdquo;. Your status
              (not the document itself) is visible to everyone signed in, so parents and athletes can see
              the gym&rsquo;s staff are trained and certified.
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
                <p className="alert-title">Uploaded</p>
                <p className="alert-msg">{notice}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s6)]">
              <span className="working">Loading your credentials...</span>
            </div>
          ) : items.length === 0 ? (
            <p className="t-body">
              No clearance types are set up for this organization yet. Ask an administrator.
            </p>
          ) : (
            <ul className="space-y-[var(--s3)]">
              {items.map((item) => {
                const badge = bandBadge(item.band);
                const busy = busyTypeId === item.clearance_type_id;
                return (
                  <li key={item.clearance_type_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                    <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">{item.name}</span>
                      <span className={`badge ${badge.className}`}>
                        <i aria-hidden="true">▣</i>{badge.label}
                      </span>
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{item.issuing_authority}</span>
                    </div>

                    {item.expires_on && (item.band === 'current' || item.band === 'expiring_soon' || item.band === 'expired') && (
                      <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                        {item.band === 'expired' ? 'Expired' : 'Expires'} {item.expires_on}
                      </p>
                    )}

                    {item.verification_note && (
                      <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                        Note from the office: {item.verification_note}
                      </p>
                    )}

                    <div className="field mt-[var(--s3)]">
                      <label className="t-label" htmlFor={`file-${item.clearance_type_id}`}>
                        {item.has_document ? 'Replace document (PDF, JPG, or PNG)' : 'Upload document (PDF, JPG, or PNG)'}
                      </label>
                      <input
                        id={`file-${item.clearance_type_id}`}
                        className="input"
                        type="file"
                        accept="application/pdf,image/jpeg,image/png"
                        ref={(node) => { fileInputRefs.current[item.clearance_type_id] = node; }}
                      />
                    </div>
                    <div className="mt-[var(--s3)]">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void handleUpload(item.clearance_type_id)}
                      >
                        {busy ? 'Uploading…' : item.has_document ? 'Replace document' : 'Upload document'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach/environment/intake-router" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
