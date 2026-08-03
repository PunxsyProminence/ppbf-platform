'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';
import { GYM_STATUS_CHOICES } from '@/src/shared/athleteConstants';

/** A row of pilot.athletes as GET /api/pilot/athletes/list returns it. */
interface RosterAthlete {
  athlete_id: string;
  full_name: string;
  dob: string;
  weight_class: string;
  gym_status: string;
  emergency_contact: string;
  active_flag: boolean;
  coach_id: string;
  created_at: string;
  updated_at: string;
}

interface CoachOption {
  account_id: string;
  login_email: string | null;
}

type RosterLoadState = 'loading' | 'loaded' | 'unavailable';

type AuditLoadState = 'idle' | 'loading' | 'loaded' | 'unavailable';

/**
 * The last correction made to one athlete record, as the audit trail holds it.
 *
 * `changed_fields` is field NAMES only. Audit details for athlete records never
 * carry values -- these are minors, and the details are mirrored into SHADOW's
 * event stream -- so this panel can show what moved but never what it moved to.
 */
interface AuditSummary {
  actor: string;
  when: string;
  changedFields: string[];
  activeFlagChange: string | null;
}

/** Field name as stored in the audit trail -> what an operator calls it. */
const AUDIT_FIELD_LABELS: Record<string, string> = {
  full_name: 'name',
  dob: 'date of birth',
  weight_class: 'weight class',
  gym_status: 'gym status',
  emergency_contact: 'emergency contact',
  coach_id: 'coach',
};

function auditFieldLabel(field: string): string {
  return AUDIT_FIELD_LABELS[field] ?? field;
}

function normalizeAuditSummary(row: unknown): AuditSummary | null {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const record = row as Record<string, unknown>;
  const details = (record.details && typeof record.details === 'object' ? record.details : {}) as Record<string, unknown>;
  const when = readString(record.created_at);
  if (!when) {
    return null;
  }

  const rawFields = Array.isArray(details.changed_fields) ? details.changed_fields : [];

  return {
    actor: readString(record.actor_account_id) || 'someone whose account is no longer readable',
    when,
    changedFields: rawFields.filter((field): field is string => typeof field === 'string'),
    activeFlagChange: typeof details.active_flag_change === 'string' ? details.active_flag_change : null,
  };
}

/**
 * pilot.audit_events.created_at is a timestamp, so unlike a date of birth it IS
 * an instant and is correct to render in the reader's local zone.
 */
function formatAuditTimestamp(raw: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * pilot.athletes.dob is a `date` column and node-postgres hands it back as a
 * timestamp, which <input type="date"> silently discards rather than reject.
 * On this screen a discarded date of birth would look like a blank one, and
 * blanking it is exactly the mistake this screen exists to undo.
 */
function toDateInputValue(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }

  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return match ? match[1] : '';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A row that cannot be read is counted, never quietly dropped: a child missing
 * from this list is a child whose record nobody can correct, and a shorter
 * list is indistinguishable from a smaller gym.
 */
function normalizeRosterAthlete(row: unknown): RosterAthlete | null {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const record = row as Record<string, unknown>;
  const athleteId = readString(record.athlete_id).trim();
  const createdAt = readString(record.created_at);
  const dob = toDateInputValue(record.dob);

  if (!athleteId || !createdAt || !dob) {
    return null;
  }

  return {
    athlete_id: athleteId,
    full_name: readString(record.full_name),
    dob,
    weight_class: readString(record.weight_class),
    gym_status: readString(record.gym_status),
    emergency_contact: readString(record.emergency_contact),
    active_flag: record.active_flag === true,
    coach_id: readString(record.coach_id),
    created_at: createdAt,
    updated_at: readString(record.updated_at),
  };
}

/**
 * Shown when someone reaches this page whose role cannot use it -- in practice
 * a platform owner arriving by bookmark or typed URL. Every route behind this
 * console is organization-scoped and rejects a platform owner by design:
 * correcting a gym's athlete records belongs to that gym's admin.
 */
function WrongRoleNotice() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
      <div className="mx-auto max-w-xl space-y-5 text-center">
        <p className="text-xs font-mono uppercase tracking-[0.3em] text-[color:var(--brass-800)]">Different Console</p>
        <h1 className="font-display text-3xl font-black">Athlete records are managed per gym</h1>
        <p className="text-sm leading-7 text-[var(--gray-dark)]">
          This console corrects one organization&apos;s athlete records. As platform owner you create organizations
          and appoint their admins, and they take it from there.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/admin/organizations"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border-2 border-[color:var(--brass-600)] bg-[var(--brass-800)] px-6 text-sm font-black uppercase tracking-[0.12em] text-white transition hover:bg-[var(--red-highlight)]"
          >
            Organization Provisioning
          </Link>
          <Link
            href="/admin"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-6 text-sm font-black uppercase tracking-[0.12em] transition hover:bg-[var(--canvas-tan)]"
          >
            Admin Home
          </Link>
        </div>
      </div>
    </main>
  );
}

function AthleteRecordsConsoleContent() {
  const [roster, setRoster] = useState<RosterAthlete[]>([]);
  const [unreadableRows, setUnreadableRows] = useState(0);
  const [rosterLoad, setRosterLoad] = useState<RosterLoadState>('loading');
  const [coaches, setCoaches] = useState<CoachOption[]>([]);
  const [coachesAvailable, setCoachesAvailable] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [confirmingStatusChange, setConfirmingStatusChange] = useState(false);

  const [draftFullName, setDraftFullName] = useState('');
  const [draftDob, setDraftDob] = useState('');
  const [draftWeightClass, setDraftWeightClass] = useState('');
  const [draftGymStatus, setDraftGymStatus] = useState('');
  const [draftEmergencyContact, setDraftEmergencyContact] = useState('');
  const [draftCoachId, setDraftCoachId] = useState('');

  // "Who last touched this record, and what did they move" -- the question an
  // operator opening a child's record to correct it asks first, and the one the
  // audit trail could already answer but no screen was reading. Null while
  // loading or when the trail could not be read, which is reported rather than
  // rendered as "never corrected": a silently empty history on a record that
  // has been edited is worse than saying the trail is unavailable.
  const [lastCorrection, setLastCorrection] = useState<AuditSummary | null>(null);
  const [lastCorrectionState, setLastCorrectionState] = useState<AuditLoadState>('idle');

  const load = useCallback(async () => {
    setError('');

    const [rosterResult, staffResult] = await Promise.allSettled([
      fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' }),
      fetch(`${apiBase()}/api/pilot/admin/staff`, { method: 'GET', credentials: 'include' }),
    ]);

    if (rosterResult.status !== 'fulfilled' || !rosterResult.value.ok) {
      setRoster([]);
      setUnreadableRows(0);
      setRosterLoad('unavailable');
    } else {
      const payload = (await rosterResult.value.json().catch(() => ({}))) as { items?: unknown[] };
      const rows = payload.items ?? [];
      const readable = rows
        .map(normalizeRosterAthlete)
        .filter((athlete): athlete is RosterAthlete => athlete !== null);

      setRoster(readable);
      setUnreadableRows(rows.length - readable.length);
      setRosterLoad('loaded');
    }

    // The coach directory only decides whether the assignment can be changed
    // here. Losing it must not cost the admin the ability to fix a name or a
    // date of birth, and it must never reassign the athlete by default.
    if (staffResult.status !== 'fulfilled' || !staffResult.value.ok) {
      setCoachesAvailable(false);
      return;
    }

    const staffPayload = (await staffResult.value.json().catch(() => ({}))) as {
      ok?: boolean;
      members?: Array<{ account_id?: string; login_email?: string | null; role?: string; active_flag?: boolean; membership_active?: boolean }>;
    };

    if (staffPayload.ok !== true) {
      setCoachesAvailable(false);
      return;
    }

    setCoaches(
      (staffPayload.members ?? [])
        .filter((member) => member.role === 'coach' && member.active_flag !== false && member.membership_active !== false)
        .map((member) => ({ account_id: readString(member.account_id), login_email: member.login_email ?? null }))
        .filter((coach) => coach.account_id.length > 0),
    );
    setCoachesAvailable(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const selected = useMemo(
    () => roster.find((athlete) => athlete.athlete_id === selectedId) ?? null,
    [roster, selectedId],
  );

  const loadLastCorrection = useCallback(async (athleteId: string) => {
    setLastCorrectionState('loading');
    setLastCorrection(null);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/audit/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ entity_type: 'athlete', entity_id: athleteId, limit: 1 }),
      });

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; events?: unknown[] };
      if (!response.ok || !payload.ok || !Array.isArray(payload.events)) {
        setLastCorrectionState('unavailable');
        return;
      }

      setLastCorrection(payload.events.length > 0 ? normalizeAuditSummary(payload.events[0]) : null);
      setLastCorrectionState('loaded');
    } catch {
      setLastCorrectionState('unavailable');
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setLastCorrection(null);
      setLastCorrectionState('idle');
      return;
    }
    void loadLastCorrection(selectedId);
  }, [selectedId, loadLastCorrection]);

  const visibleRoster = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return roster;
    return roster.filter((athlete) =>
      athlete.full_name.toLowerCase().includes(needle) || athlete.athlete_id.toLowerCase().includes(needle));
  }, [roster, filter]);

  // A coach who has since been deactivated is still this athlete's coach, and
  // a picker that omitted them would reassign the child to whoever happened to
  // sort first the next time anyone saved.
  const coachChoices = useMemo(() => {
    if (!selected) return coaches;
    return coaches.some((coach) => coach.account_id === selected.coach_id)
      ? coaches
      : [{ account_id: selected.coach_id, login_email: null }, ...coaches];
  }, [coaches, selected]);

  function openRecord(athlete: RosterAthlete) {
    setSelectedId(athlete.athlete_id);
    setConfirmingStatusChange(false);
    setError('');
    setNotice('');
    setDraftFullName(athlete.full_name);
    setDraftDob(athlete.dob);
    setDraftWeightClass(athlete.weight_class);
    setDraftGymStatus(athlete.gym_status);
    setDraftEmergencyContact(athlete.emergency_contact);
    setDraftCoachId(athlete.coach_id);
  }

  const hasUnsavedEdits = Boolean(selected) && (
    draftFullName !== selected?.full_name
    || draftDob !== selected?.dob
    || draftWeightClass !== selected?.weight_class
    || draftGymStatus !== selected?.gym_status
    || draftEmergencyContact !== selected?.emergency_contact
    || draftCoachId !== selected?.coach_id
  );

  // Every field is `not null` server-side and a blank one comes back as a
  // generic 500, so the save stays down until they are all filled.
  const draftComplete = Boolean(
    draftFullName.trim()
    && draftDob
    && draftWeightClass.trim()
    && draftGymStatus
    && draftEmergencyContact.trim()
    && draftCoachId,
  );

  /**
   * Sends the whole record. validateAthletePayload rejects a payload with a
   * missing key as hard as one with an extra key, so all ten fields go every
   * time, and created_at is the stored one -- this is a correction to an
   * existing record, not a new one.
   */
  async function submitRecord(record: RosterAthlete, changes: Partial<RosterAthlete>, successNotice: string) {
    setBusy(true);
    setError('');
    setNotice('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/athletes/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          athlete_id: record.athlete_id,
          full_name: changes.full_name ?? record.full_name,
          dob: changes.dob ?? record.dob,
          weight_class: changes.weight_class ?? record.weight_class,
          gym_status: changes.gym_status ?? record.gym_status,
          emergency_contact: changes.emergency_contact ?? record.emergency_contact,
          active_flag: changes.active_flag ?? record.active_flag,
          coach_id: changes.coach_id ?? record.coach_id,
          created_at: record.created_at,
          updated_at: new Date().toISOString(),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error || 'That correction was not saved.');
      }

      setNotice(successNotice);
      setConfirmingStatusChange(false);
      await load();
      // The correction just written is the newest audit entry, so the panel
      // would otherwise still be showing the one before it.
      void loadLastCorrection(record.athlete_id);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'That correction was not saved.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveCorrection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;

    await submitRecord(
      selected,
      {
        full_name: draftFullName.trim(),
        dob: draftDob,
        weight_class: draftWeightClass.trim(),
        gym_status: draftGymStatus,
        emergency_contact: draftEmergencyContact.trim(),
        coach_id: draftCoachId,
      },
      `${draftFullName.trim()} (${selected.athlete_id}) is saved. Their sessions, goals and reviews are untouched.`,
    );
  }

  async function toggleActive() {
    if (!selected) return;

    const deactivating = selected.active_flag;
    await submitRecord(
      selected,
      { active_flag: !selected.active_flag },
      deactivating
        ? `${selected.full_name} (${selected.athlete_id}) is marked inactive. Everything on their record is still there.`
        : `${selected.full_name} (${selected.athlete_id}) is marked active again.`,
    );
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)] sm:px-6">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="rounded-2xl border border-[rgba(0,0,0,0.16)] bg-white p-6 shadow-[var(--shadow-md)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--brass-800)]">Athlete Records</p>
              <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Correct An Athlete Record</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Fix anything that was typed wrong when the athlete was added, reassign their coach, and mark an
                athlete inactive when they leave the gym. Nothing here deletes anything.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/admin/people"
                className="inline-flex min-h-[44px] items-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-5 text-sm font-bold uppercase tracking-[0.1em] transition hover:bg-[var(--canvas-tan)]"
              >
                People
              </Link>
              <Link
                href="/admin"
                className="inline-flex min-h-[44px] items-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-5 text-sm font-bold uppercase tracking-[0.1em] transition hover:bg-[var(--canvas-tan)]"
              >
                Admin Home
              </Link>
            </div>
          </div>
        </header>

        {error && (
          <p role="alert" className="rounded-xl border border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_6%,white)] px-4 py-3 text-sm font-semibold text-[var(--safety-locked)]">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-xl border border-[rgba(16,120,40,0.5)] bg-[rgba(16,120,40,0.08)] px-4 py-3 text-sm font-semibold text-[var(--cleared-deep)]">
            {notice}
          </p>
        )}

        <section className="space-y-4 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-sm)]">
          <h2 className="text-lg font-black">Choose an athlete</h2>

          {rosterLoad === 'loading' ? (
            <p className="text-sm text-[var(--gray-dark)]">Loading your athlete records...</p>
          ) : rosterLoad === 'unavailable' ? (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-[color:var(--brass-800)]">
                Your athlete records could not be read. That is a problem reaching the app, not a sign that your gym
                has none, so nothing is listed below.
              </p>
              <button
                type="button"
                onClick={() => void load()}
                className="min-h-[44px] rounded-xl border-2 border-[color:var(--brass-600)] bg-white px-4 text-xs font-black uppercase tracking-[0.1em] text-[color:var(--brass-800)]"
              >
                Try Again
              </button>
            </div>
          ) : roster.length === 0 ? (
            <p className="text-sm text-[var(--gray-dark)]">
              There are no athlete records in your gym yet. Add one on the People screen first.
            </p>
          ) : (
            <>
              {unreadableRows > 0 && (
                <p className="rounded-xl border border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_6%,white)] px-4 py-3 text-sm font-semibold text-[var(--safety-locked)]">
                  {unreadableRows} record{unreadableRows === 1 ? '' : 's'} could not be read and {unreadableRows === 1 ? 'is' : 'are'} not
                  listed below. They still exist — this screen cannot correct them.
                </p>
              )}

              <div>
                <label htmlFor="athlete-filter" className="block text-sm font-semibold">
                  Find an athlete
                </label>
                <input
                  id="athlete-filter"
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Name or record ID"
                  className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>

              {visibleRoster.length === 0 ? (
                <p className="text-sm text-[var(--gray-dark)]">
                  No athlete matches “{filter.trim()}”. All {roster.length} records are still there — clear the box to
                  see them.
                </p>
              ) : (
                <ul className="divide-y divide-[rgba(0,0,0,0.08)] overflow-hidden rounded-xl border border-[rgba(0,0,0,0.12)]">
                  {visibleRoster.map((athlete) => (
                    <li key={athlete.athlete_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{athlete.full_name}</p>
                        <p className="mt-1 font-mono text-xs text-[var(--gray-dark)]">
                          {athlete.athlete_id} · born {athlete.dob} · coach {athlete.coach_id}
                        </p>
                        {!athlete.active_flag && (
                          <p className="mt-1 text-xs font-bold uppercase tracking-[0.1em] text-[var(--gray-dark)]">
                            Inactive
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => openRecord(athlete)}
                        className="min-h-[44px] shrink-0 rounded-xl border-2 border-[var(--accent)] bg-white px-4 text-xs font-black uppercase tracking-[0.1em] text-[var(--accent-quiet)] transition hover:bg-[color-mix(in_srgb,var(--accent)_6%,white)]"
                      >
                        {selectedId === athlete.athlete_id ? 'Editing' : 'Correct Record'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        {selected && (
          <>
            <form onSubmit={saveCorrection} className="space-y-5 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-sm)]">
              <div>
                <h2 className="text-lg font-black">{selected.full_name}</h2>
                <p className="mt-1 font-mono text-xs text-[var(--gray-dark)]">Record ID {selected.athlete_id}</p>
                <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                  The record ID is permanent — every session, goal and review hangs off it, so it cannot be changed
                  here. Everything else can.
                </p>

                {/* Field names only, never values. The audit trail for an
                    athlete record deliberately stores no values -- these are
                    minors and the details are mirrored into SHADOW -- so this
                    can say a date of birth was corrected but never to what. */}
                {lastCorrectionState === 'loaded' && lastCorrection && (
                  <p className="mt-3 rounded-xl border border-[rgba(0,0,0,0.12)] bg-[var(--canvas-tan-light)] px-3 py-2 text-xs leading-5 text-[var(--gray-dark)]">
                    Last corrected by <span className="font-semibold text-[var(--black)]">{lastCorrection.actor}</span> on{' '}
                    {formatAuditTimestamp(lastCorrection.when)}
                    {lastCorrection.changedFields.length > 0 && (
                      <> — changed {lastCorrection.changedFields.map(auditFieldLabel).join(', ')}</>
                    )}
                    {lastCorrection.activeFlagChange && (
                      <>
                        {lastCorrection.changedFields.length > 0 ? '; ' : ' — '}
                        {lastCorrection.activeFlagChange === 'deactivated' ? 'marked inactive' : 'marked active again'}
                      </>
                    )}
                    .
                  </p>
                )}

                {lastCorrectionState === 'unavailable' && (
                  <p className="mt-3 text-xs text-[var(--gray-dark)]">
                    The correction history for this record could not be read, so this panel cannot say who last changed
                    it.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="correct-full-name" className="block text-sm font-semibold">
                  Full name
                </label>
                <input
                  id="correct-full-name"
                  type="text"
                  required
                  value={draftFullName}
                  onChange={(event) => setDraftFullName(event.target.value)}
                  className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="correct-dob" className="block text-sm font-semibold">
                    Date of birth
                  </label>
                  <input
                    id="correct-dob"
                    type="date"
                    required
                    value={draftDob}
                    onChange={(event) => setDraftDob(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  />
                  <p className="mt-1 text-xs text-[var(--gray-dark)]">Currently stored as {selected.dob}.</p>
                </div>

                <div>
                  <label htmlFor="correct-weight-class" className="block text-sm font-semibold">
                    Weight class
                  </label>
                  <input
                    id="correct-weight-class"
                    type="text"
                    required
                    value={draftWeightClass}
                    onChange={(event) => setDraftWeightClass(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="correct-gym-status" className="block text-sm font-semibold">
                  Status in the gym
                </label>
                <select
                  id="correct-gym-status"
                  required
                  value={draftGymStatus}
                  onChange={(event) => setDraftGymStatus(event.target.value)}
                  className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                >
                  {/* A stored value outside the documented vocabulary is kept
                      as an option rather than replaced, so opening a record
                      never silently rewrites it on the next save. */}
                  {!GYM_STATUS_CHOICES.some((option) => option.value === selected.gym_status) && (
                    <option value={selected.gym_status}>{selected.gym_status} (as stored)</option>
                  )}
                  {GYM_STATUS_CHOICES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="correct-emergency-contact" className="block text-sm font-semibold">
                  Emergency contact
                </label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">Who to call, and the number.</p>
                <input
                  id="correct-emergency-contact"
                  type="text"
                  required
                  value={draftEmergencyContact}
                  onChange={(event) => setDraftEmergencyContact(event.target.value)}
                  className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>

              <div>
                <label htmlFor="correct-coach" className="block text-sm font-semibold">
                  Coach
                </label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">
                  {coachesAvailable
                    ? 'A coach only sees the athletes assigned to them, so moving an athlete here moves what their old coach can read.'
                    : 'Your coach list could not be read, so the only choice offered is the coach already on this record. Everything else on this form still saves.'}
                </p>
                <select
                  id="correct-coach"
                  required
                  value={draftCoachId}
                  onChange={(event) => setDraftCoachId(event.target.value)}
                  disabled={!coachesAvailable}
                  className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] disabled:opacity-70"
                >
                  {coachChoices.map((coach) => (
                    <option key={coach.account_id} value={coach.account_id}>
                      {coach.login_email || coach.account_id}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={busy || !hasUnsavedEdits || !draftComplete}
                className="min-h-[50px] w-full rounded-xl border-2 border-[color:var(--brass-600)] bg-[var(--brass-800)] px-4 text-sm font-black uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Saving...' : hasUnsavedEdits ? 'Save Correction' : 'Nothing To Save'}
              </button>
            </form>

            <section className="space-y-4 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-sm)]">
              <div>
                <h2 className="text-lg font-black">
                  {selected.active_flag ? 'This athlete has left the gym' : 'This athlete is back'}
                </h2>
                <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                  {selected.active_flag
                    ? 'Marking them inactive keeps their whole record — every session, goal, review and pain report stays exactly where it is. It can be undone here at any time.'
                    : 'This record is marked inactive. Marking them active again puts them back on the roster as they were.'}
                </p>
                <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                  Two things it does not do: it does not switch off their sign-in, and it does not take them off their
                  coach&apos;s lists. Turn the sign-in off on the People screen.
                </p>
              </div>

              {hasUnsavedEdits ? (
                <p className="rounded-xl border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] px-4 py-3 text-sm text-[var(--gray-dark)]">
                  Save or discard the corrections above first — this button writes the record as it is stored now, not
                  as the form currently reads.
                </p>
              ) : confirmingStatusChange ? (
                <div className="space-y-3">
                  <p className="text-sm font-semibold">
                    {selected.active_flag
                      ? `Mark ${selected.full_name} inactive?`
                      : `Mark ${selected.full_name} active again?`}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void toggleActive()}
                      className="min-h-[48px] flex-1 rounded-xl border-2 border-[color:var(--brass-600)] bg-[var(--brass-800)] px-4 text-sm font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                    >
                      {busy ? 'Saving...' : 'Yes, Save It'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmingStatusChange(false)}
                      className="min-h-[48px] flex-1 rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-sm font-black uppercase tracking-[0.12em] disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingStatusChange(true)}
                  className="min-h-[48px] w-full rounded-xl border-2 border-[var(--accent)] bg-white px-4 text-sm font-black uppercase tracking-[0.12em] text-[var(--accent-quiet)]"
                >
                  {selected.active_flag ? 'Deactivate Athlete' : 'Reactivate Athlete'}
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function AthleteRecordsRoleSwitch() {
  const session = usePilotSession();

  if (session.loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <p className="text-sm text-[var(--gray-dark)]">Loading...</p>
      </main>
    );
  }

  // RoleSessionGate already proved the caller is some flavour of admin; this
  // narrows further, because 'admin' there also covers platform owners.
  if (!isOrganizationAdminSessionRole(session.role)) {
    return <WrongRoleNotice />;
  }

  return <AthleteRecordsConsoleContent />;
}

export default function AthleteRecordsPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <AthleteRecordsRoleSwitch />
    </RoleSessionGate>
  );
}
