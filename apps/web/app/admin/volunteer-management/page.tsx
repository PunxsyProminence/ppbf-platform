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

interface VolunteerCardProps {
  item: VolunteerRecord;
  onStatusChange: (volunteerId: string, status: VolunteerStatus) => void;
}

function VolunteerCard(props: Readonly<VolunteerCardProps>) {
  const { item, onStatusChange } = props;
  return (
    <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
      <h2 className="text-sm font-bold uppercase tracking-[0.08em]">{item.full_name}</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{item.role_focus}</p>
      <p className="text-sm leading-6 text-[var(--gray-dark)]">Availability: {item.availability}</p>
      <p className="text-sm leading-6 text-[var(--gray-dark)]">Certification: {item.certification_status}</p>
      <p className="text-sm leading-6 text-[var(--gray-dark)]">Background Check: {item.background_check_status}</p>
      <p className="text-sm font-mono uppercase tracking-[0.08em] text-[var(--accent-quiet)]">Status: {item.status}</p>
      {item.notes ? <p className="mt-2 text-sm text-[var(--gray-dark)]">{item.notes}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {volunteerStatuses.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => onStatusChange(item.volunteer_id, status)}
            className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-bold uppercase tracking-[0.08em]"
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
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">
          <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
            <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--accent-quiet)]">Admin Workspace</p>
            <h1 className="font-display text-4xl font-black">Volunteer Management</h1>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[var(--accent-quiet)]">LIVE | TABLE-BACKED | BACKEND CONNECTED</p>
            <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
              Volunteer roster, status, and availability are now backed by persistent records instead of placeholders.
            </p>
            {errorMessage ? <p className="text-sm text-[var(--safety-locked)]">{errorMessage}</p> : null}
          </header>

          <section className="mt-6 grid gap-4 md:grid-cols-3">
            {[
              { label: 'Active', value: counts.active },
              { label: 'Pending', value: counts.pending },
              { label: 'Inactive', value: counts.inactive },
            ].map((item) => (
              <article key={item.label} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h2 className="text-sm font-bold uppercase tracking-[0.08em]">{item.label}</h2>
                <p className="mt-2 text-3xl font-black">{item.value}</p>
              </article>
            ))}
          </section>

          <section className="mt-6 space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
            <h2 className="text-lg font-bold">Add Volunteer</h2>
            <input value={draft.full_name} onChange={(event) => setDraft((current) => ({ ...current, full_name: event.target.value }))} placeholder="Full name" className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3" />
            <div className="grid gap-3 md:grid-cols-2">
              <input value={draft.role_focus} onChange={(event) => setDraft((current) => ({ ...current, role_focus: event.target.value }))} placeholder="Role focus" className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3" />
              <input value={draft.availability} onChange={(event) => setDraft((current) => ({ ...current, availability: event.target.value }))} placeholder="Availability" className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <input value={draft.certification_status} onChange={(event) => setDraft((current) => ({ ...current, certification_status: event.target.value }))} placeholder="Certification status" className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3" />
              <input value={draft.background_check_status} onChange={(event) => setDraft((current) => ({ ...current, background_check_status: event.target.value }))} placeholder="Background check status" className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3" />
            </div>
            <textarea value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Notes" className="h-24 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2" />
            <button
              type="button"
              disabled={isCreating || !draft.full_name.trim()}
              onClick={() => void handleCreateVolunteer().catch((error) => setMessage(error instanceof Error ? error.message : 'Unable to create volunteer.'))}
              className="h-11 border-2 border-[var(--black)] bg-[var(--accent-strong)] px-4 text-sm font-black uppercase tracking-[0.12em] text-[var(--accent-ink)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreating ? 'Creating...' : 'Create Volunteer'}
            </button>
          </section>

          <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <VolunteerCard key={item.volunteer_id} item={item} onStatusChange={(volunteerId, status) => void handleStatusUpdate(volunteerId, status)} />
            ))}
          </section>

          {message ? <p className="mt-6 text-sm font-semibold text-[var(--black)]">{message}</p> : null}

          <div className="mt-8">
            <Link
              href="/operations"
              className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]"
            >
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
