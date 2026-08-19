'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// /staff-credentials -- credential STATUS, broadly visible.
//
// The product owner asked for this by name: parents and athletes should be
// able to see the gym's staff are trained and certified. Matching the house
// precedent for a broadly-visible page (/names -- see its own header on why
// every signed-in role reads it), this page is behind a session but open to
// every role that can sign in, not gated to admin or coach.
//
// It shows STATUS only. It never shows or links to a document -- there is
// no download control on this page at all, on purpose. Reviewing an actual
// document is /admin/credentials's job.

interface CredentialBadge {
  clearance_type_id: string;
  clearance_name: string;
  band: string;
  expires_on: string | null;
}

interface StaffRow {
  account_id: string;
  display_name: string;
  role: string;
  credentials: CredentialBadge[];
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

const ROLE_LABEL: Record<string, string> = {
  coach: 'Coach', admin: 'Administrator', organization_admin: 'Administrator', staff: 'Staff', volunteer: 'Volunteer',
};

function StaffCredentialsBoard() {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/staff-credentials`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unable to load staff credentials.');
        const payload = (await response.json()) as { staff?: StaffRow[] };
        if (!controller.signal.aborted) {
          setStaff(payload.staff ?? []);
          setLoading(false);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load staff credentials.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-4xl">
        <header className="mb-[var(--s5)]">
          <p className="t-eyebrow">Staff Credentials</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Certified &amp; Cleared</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            The training and clearance status this gym&rsquo;s coaches and staff hold, verified by an
            administrator against the document each person submitted. This page shows status only --
            never the documents themselves.
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
            <span className="working">Loading staff credentials...</span>
          </div>
        ) : staff.length === 0 ? (
          <p className="empty-msg">No staff credential records yet.</p>
        ) : (
          <ul className="space-y-[var(--s3)]">
            {staff.map((person) => (
              <li key={person.account_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                  <span className="t-body font-semibold text-[color:var(--bone-100)]">{person.display_name}</span>
                  <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                    {ROLE_LABEL[person.role] ?? person.role}
                  </span>
                </div>
                <ul className="mt-[var(--s2)] flex flex-wrap gap-[var(--s2)]">
                  {person.credentials.map((credential) => {
                    const badge = bandBadge(credential.band);
                    return (
                      <li key={credential.clearance_type_id} className={`badge ${badge.className}`}>
                        <i aria-hidden="true">▣</i>
                        {credential.clearance_name}: {badge.label}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-[var(--s5)]">
          <Link href="/" className="btn btn--ghost">Back</Link>
        </div>
      </div>
    </main>
  );
}

export default function StaffCredentialsPage() {
  return (
    <RoleSessionGate
      allowedRoles={[
        'athlete',
        'coach',
        'parent',
        'admin',
        'platform_owner',
        'staff',
        'volunteer',
        'board',
      ]}
    >
      <StaffCredentialsBoard />
    </RoleSessionGate>
  );
}
