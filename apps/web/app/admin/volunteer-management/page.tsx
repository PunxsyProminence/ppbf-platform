"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

interface VolunteerRecord {
  volunteer_id: string;
  full_name: string;
  role_focus: string;
  availability: string;
  certification_status: string;
  background_check_status: string;
  status: VolunteerStatus;
  notes: string | null;
}

const volunteerStatuses = ['active', 'pending', 'inactive'] as const;
type VolunteerStatus = (typeof volunteerStatuses)[number];

// Law 3: a volunteer's roster state carries a glyph and an uppercase label,
// never colour alone. Rungs are queue outcomes: active is cleared, pending is
// restricted (awaiting checks), inactive is monitor (tracked, not serving).
const VOLUNTEER_STATUS_BADGE: Record<VolunteerStatus, { rung: string; glyph: string }> = {
  active: { rung: 'badge--cleared', glyph: '✓' },
  pending: { rung: 'badge--restricted', glyph: '▲' },
  inactive: { rung: 'badge--monitor', glyph: '◉' },
};

interface VolunteerCardProps {
  item: VolunteerRecord;
  onStatusChange: (volunteerId: string, status: VolunteerStatus) => void;
}

function VolunteerCard(props: Readonly<VolunteerCardProps>) {
  const { item, onStatusChange } = props;
  const badge = VOLUNTEER_STATUS_BADGE[item.status];
  return (
    <article className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
        <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{item.full_name}</h2>
        <span className={`badge ${badge.rung}`}><i>{badge.glyph}</i>{item.status}</span>
      </div>
      <p className="t-body mt-[var(--s3)]">{item.role_focus}</p>
      <p className="t-body">Availability: {item.availability}</p>
      <p className="t-body">Certification: {item.certification_status}</p>
      <p className="t-body">Background Check: {item.background_check_status}</p>
      {item.notes ? <p className="t-muted mt-[var(--s3)]">{item.notes}</p> : null}
      <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
        {volunteerStatuses.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => onStatusChange(item.volunteer_id, status)}
            className="btn--lever min-h-[44px]"
          >
            {status}
          </button>
        ))}
      </div>
    </article>
  );
}

export default function VolunteerManagementPage() {
  const [items, setItems] = useState<VolunteerRecord[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [message, setMessage] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const creatingRef = useRef(false);
  const [draft, setDraft] = useState({
    full_name: '',
    role_focus: 'General Support',
    availability: 'Weekdays',
    certification_status: 'Pending',
    background_check_status: 'Pending',
    notes: '',
  });

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/admin/volunteers`, { credentials: 'include' });
        if (!response.ok) {
          throw new Error('Unable to load volunteer roster.');
        }

        const payload = (await response.json()) as { items?: VolunteerRecord[] };
        setItems(payload.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setItems([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load volunteer roster.');
      }
    })();
  }, []);

  const counts = useMemo(
    () => ({
      active: items.filter((item) => item.status === 'active').length,
      pending: items.filter((item) => item.status === 'pending').length,
      inactive: items.filter((item) => item.status === 'inactive').length,
    }),
    [items],
  );

  async function handleCreateVolunteer() {
    // The insert has no natural key, so a second submit while the first is in
    // flight writes a second volunteer row rather than colliding with it.
    if (creatingRef.current) {
      return;
    }

    const fullName = draft.full_name.trim();
    if (!fullName) {
      setMessage('Enter a full name before creating a volunteer.');
      return;
    }

    creatingRef.current = true;
    setIsCreating(true);

    try {
      const response = await fetch(`${apiBase()}/api/admin/volunteers`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, full_name: fullName }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Unable to create volunteer.');
      }

      const payload = (await response.json()) as { volunteer_id?: string };
      setItems((current) => [
        {
          volunteer_id: payload.volunteer_id ?? crypto.randomUUID(),
          full_name: fullName,
          role_focus: draft.role_focus,
          availability: draft.availability,
          certification_status: draft.certification_status,
          background_check_status: draft.background_check_status,
          status: 'pending',
          notes: draft.notes || null,
        },
        ...current,
      ]);
      setDraft({
        full_name: '',
        role_focus: 'General Support',
        availability: 'Weekdays',
        certification_status: 'Pending',
        background_check_status: 'Pending',
        notes: '',
      });
      setMessage('Volunteer created.');
    } finally {
      creatingRef.current = false;
      setIsCreating(false);
    }
  }

  async function handleStatusUpdate(volunteerId: string, status: VolunteerStatus) {
    try {
      const response = await fetch(`${apiBase()}/api/admin/volunteers`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volunteer_id: volunteerId, status }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string; updated?: boolean };

      if (!response.ok) {
        throw new Error(payload.error || 'Unable to update volunteer status.');
      }

      // The route answers 200 with updated=false when no row matched this
      // organization, so an ok response alone does not mean anything changed.
      if (payload.updated === false) {
        throw new Error('That volunteer is no longer on this roster, so nothing was changed.');
      }

      setItems((current) => current.map((item) => (item.volunteer_id === volunteerId ? { ...item, status } : item)));
      setMessage(`Volunteer status updated to ${status}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to update volunteer status.');
    }
  }

  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Volunteer Management</h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | TABLE-BACKED | BACKEND CONNECTED</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Volunteer roster, status, and availability are now backed by persistent records instead of placeholders.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
          </header>

          <section className="mt-[var(--s5)] grid gap-[var(--s4)] md:grid-cols-3">
            {[
              { label: 'Active', value: counts.active },
              { label: 'Pending', value: counts.pending },
              { label: 'Inactive', value: counts.inactive },
            ].map((item) => (
              <article key={item.label} className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] px-[var(--s4)] py-[var(--s4)]">
                <p className="t-eyebrow">{item.label}</p>
                <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{item.value}</p>
              </article>
            ))}
          </section>

          <section className="mat-leather mt-[var(--s5)] space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Add Volunteer</h2>
            <label className="field">
              <span className="t-label">Full name</span>
              <input value={draft.full_name} onChange={(event) => setDraft((current) => ({ ...current, full_name: event.target.value }))} placeholder="Full name" className="input" />
            </label>
            <div className="grid gap-[var(--s4)] md:grid-cols-2">
              <label className="field">
                <span className="t-label">Role focus</span>
                <input value={draft.role_focus} onChange={(event) => setDraft((current) => ({ ...current, role_focus: event.target.value }))} placeholder="Role focus" className="input" />
              </label>
              <label className="field">
                <span className="t-label">Availability</span>
                <input value={draft.availability} onChange={(event) => setDraft((current) => ({ ...current, availability: event.target.value }))} placeholder="Availability" className="input" />
              </label>
            </div>
            <div className="grid gap-[var(--s4)] md:grid-cols-2">
              <label className="field">
                <span className="t-label">Certification status</span>
                <input value={draft.certification_status} onChange={(event) => setDraft((current) => ({ ...current, certification_status: event.target.value }))} placeholder="Certification status" className="input" />
              </label>
              <label className="field">
                <span className="t-label">Background check status</span>
                <input value={draft.background_check_status} onChange={(event) => setDraft((current) => ({ ...current, background_check_status: event.target.value }))} placeholder="Background check status" className="input" />
              </label>
            </div>
            <label className="field">
              <span className="t-label">Notes</span>
              <textarea value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Notes" className="textarea min-h-[89px]" />
            </label>
            <button
              type="button"
              disabled={isCreating || !draft.full_name.trim()}
              onClick={() => void handleCreateVolunteer().catch((error) => setMessage(error instanceof Error ? error.message : 'Unable to create volunteer.'))}
              className="btn disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreating ? 'Creating...' : 'Create Volunteer'}
            </button>
          </section>

          <section className="mt-[var(--s5)] grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <VolunteerCard key={item.volunteer_id} item={item} onStatusChange={(volunteerId, status) => void handleStatusUpdate(volunteerId, status)} />
            ))}
          </section>

          {message ? <p className="t-body mt-[var(--s5)] font-semibold text-[color:var(--brass-300)]">{message}</p> : null}

          <div className="mt-[var(--s6)]">
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
