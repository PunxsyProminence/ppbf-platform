'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';

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

/**
 * pilot.athletes.gym_status is plain `text` with no database constraint, so
 * the vocabulary is only held together by convention: these are the values the
 * seed importer documents, the gate scripts write, and the roster-create form
 * offers, and the coach workspace displays verbatim as an athlete's track. A
 * free-text box here would fragment all of them.
 */
const GYM_STATUS_OPTIONS = [
  { value: 'active', label: 'Active - training and competing' },
  { value: 'training', label: 'Training - in the gym, not competing yet' },
  { value: 'inactive', label: 'Inactive - on the roster but not attending' },
];

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
    <main className="room--office grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-xl space-y-[var(--s5)] text-center">
        <p className="t-eyebrow">Different Console</p>
        <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Athlete records are managed per gym</h1>
        <p className="t-body">
          This console corrects one organization&apos;s athlete records. As platform owner you create organizations
          and appoint their admins, and they take it from there.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-[var(--s3)]">
          <Link href="/admin/organizations" className="btn">
            Organization Provisioning
          </Link>
          <Link href="/admin" className="btn btn--ghost">
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
  // Best-effort, independent of the roster load above: attendance rollup is
  // a separate reporting surface (attendanceReporting.ts) that a
  // platform_owner viewing this page cannot read at all (org-private data),
  // and a coach can only read their own classes' athletes. A missing or
  // partial map here must never block or blank the roster itself -- it only
  // means the rate column reads as "no data" for whichever athletes it
  // could not resolve.
  const [attendanceRateByAthlete, setAttendanceRateByAthlete] = useState<Record<string, number | null>>({});
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

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/scheduler/attendance-summary`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) return;
        const payload = (await response.json().catch(() => ({}))) as {
          athletes?: Array<{ athlete_id?: string; attendance_rate?: number | null }>;
        };
        const byAthlete: Record<string, number | null> = {};
        for (const row of payload.athletes ?? []) {
          if (typeof row.athlete_id === 'string') {
            byAthlete[row.athlete_id] = row.attendance_rate ?? null;
          }
        }
        setAttendanceRateByAthlete(byAthlete);
      } catch {
        // No attendance column is a smaller loss than a broken roster page.
      }
    })();
  }, []);

  const selected = useMemo(
    () => roster.find((athlete) => athlete.athlete_id === selectedId) ?? null,
    [roster, selectedId],
  );

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
    <main className="room--office min-h-screen bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s6)] text-[color:var(--bone-200)] sm:px-[var(--s5)]">
      <div className="mx-auto w-full max-w-5xl space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <div className="flex flex-wrap items-start justify-between gap-[var(--s4)]">
            <div>
              <p className="t-eyebrow">Athlete Records</p>
              <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Correct An Athlete Record</h1>
              <p className="t-body mt-[var(--s3)]">
                Fix anything that was typed wrong when the athlete was added, reassign their coach, and mark an
                athlete inactive when they leave the gym. Nothing here deletes anything.
              </p>
            </div>
            <div className="flex flex-wrap gap-[var(--s3)]">
              <Link href="/admin/attendance" className="btn btn--ghost">
                Attendance
              </Link>
              <Link href="/admin/people" className="btn btn--ghost">
                People
              </Link>
              <Link href="/admin" className="btn btn--ghost">
                Admin Home
              </Link>
            </div>
          </div>
        </header>

        {error && (
          <div role="alert" className="alert alert--critical">
            <span className="alert-icon" aria-hidden="true">✕</span>
            <div className="alert-body">
              <p className="alert-msg">{error}</p>
            </div>
          </div>
        )}
        {notice && (
          <div className="alert alert--success">
            <span className="alert-icon" aria-hidden="true">✓</span>
            <div className="alert-body">
              <p className="alert-msg">{notice}</p>
            </div>
          </div>
        )}

        <section className="frame">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          <div className="frame-in mat-leather space-y-[var(--s4)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Choose an athlete</h2>

          {rosterLoad === 'loading' ? (
            <p className="t-body">Loading your athlete records...</p>
          ) : rosterLoad === 'unavailable' ? (
            <div className="space-y-[var(--s3)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--restricted-ink)]">
                ▲ Your athlete records could not be read. That is a problem reaching the app, not a sign that your gym
                has none, so nothing is listed below.
              </p>
              <button
                type="button"
                onClick={() => void load()}
                className="btn btn--ghost"
              >
                Try Again
              </button>
            </div>
          ) : roster.length === 0 ? (
            <p className="t-body">
              There are no athlete records in your gym yet. Add one on the People screen first.
            </p>
          ) : (
            <>
              {unreadableRows > 0 && (
                <p className="rounded-[var(--r-md)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[color:var(--locked-ink)]">
                  ▲ {unreadableRows} record{unreadableRows === 1 ? '' : 's'} could not be read and {unreadableRows === 1 ? 'is' : 'are'} not
                  listed below. They still exist — this screen cannot correct them.
                </p>
              )}

              <div className="field">
                <label htmlFor="athlete-filter" className="t-label">
                  Find an athlete
                </label>
                <input
                  id="athlete-filter"
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Name or record ID"
                  className="input"
                />
              </div>

              {visibleRoster.length === 0 ? (
                <p className="t-body">
                  No athlete matches “{filter.trim()}”. All {roster.length} records are still there — clear the box to
                  see them.
                </p>
              ) : (
                <ul className="divide-y divide-[color:var(--hide-700)] overflow-hidden rounded-[var(--r-md)] border border-[color:var(--hide-700)]">
                  {visibleRoster.map((athlete) => {
                    const attendanceRate = attendanceRateByAthlete[athlete.athlete_id];
                    return (
                    <li key={athlete.athlete_id} className="flex flex-wrap items-center justify-between gap-[var(--s3)] px-[var(--s4)] py-[var(--s3)]">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{athlete.full_name}</p>
                        <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                          {athlete.athlete_id} · born {athlete.dob} · coach {athlete.coach_id}
                          {typeof attendanceRate === 'number' && (
                            <> · attendance {Math.round(attendanceRate * 100)}%</>
                          )}
                        </p>
                        {!athlete.active_flag && (
                          <p className="mt-[var(--s2)]">
                            <span className="badge badge--locked"><i>✕</i>Inactive</span>
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => openRecord(athlete)}
                        className={`shrink-0 ${selectedId === athlete.athlete_id ? 'btn' : 'btn btn--ghost'}`}
                      >
                        {selectedId === athlete.athlete_id ? 'Editing' : 'Correct Record'}
                      </button>
                    </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
          </div>
        </section>

        {selected && (
          <>
            <form onSubmit={saveCorrection} className="mat-leather space-y-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
              <div>
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>{selected.full_name}</h2>
                <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">Record ID {selected.athlete_id}</p>
                <p className="t-body mt-[var(--s3)]">
                  The record ID is permanent — every session, goal and review hangs off it, so it cannot be changed
                  here. Everything else can.
                </p>
              </div>

              <div className="field">
                <label htmlFor="correct-full-name" className="t-label">
                  Full name
                </label>
                <input
                  id="correct-full-name"
                  type="text"
                  required
                  value={draftFullName}
                  onChange={(event) => setDraftFullName(event.target.value)}
                  className="input"
                />
              </div>

              <div className="grid gap-[var(--s4)] sm:grid-cols-2">
                <div className="field">
                  <label htmlFor="correct-dob" className="t-label">
                    Date of birth
                  </label>
                  <input
                    id="correct-dob"
                    type="date"
                    required
                    value={draftDob}
                    onChange={(event) => setDraftDob(event.target.value)}
                    className="input"
                  />
                  <p className="t-muted mt-[var(--s2)]">Currently stored as {selected.dob}.</p>
                </div>

                <div className="field">
                  <label htmlFor="correct-weight-class" className="t-label">
                    Weight class
                  </label>
                  <input
                    id="correct-weight-class"
                    type="text"
                    required
                    value={draftWeightClass}
                    onChange={(event) => setDraftWeightClass(event.target.value)}
                    className="input"
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="correct-gym-status" className="t-label">
                  Status in the gym
                </label>
                <select
                  id="correct-gym-status"
                  required
                  value={draftGymStatus}
                  onChange={(event) => setDraftGymStatus(event.target.value)}
                  className="select"
                >
                  {/* A stored value outside the documented vocabulary is kept
                      as an option rather than replaced, so opening a record
                      never silently rewrites it on the next save. */}
                  {!GYM_STATUS_OPTIONS.some((option) => option.value === selected.gym_status) && (
                    <option value={selected.gym_status}>{selected.gym_status} (as stored)</option>
                  )}
                  {GYM_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="correct-emergency-contact" className="t-label">
                  Emergency contact
                </label>
                <p className="t-muted mb-[var(--s2)]">Who to call, and the number.</p>
                <input
                  id="correct-emergency-contact"
                  type="text"
                  required
                  value={draftEmergencyContact}
                  onChange={(event) => setDraftEmergencyContact(event.target.value)}
                  className="input"
                />
              </div>

              <div className="field">
                <label htmlFor="correct-coach" className="t-label">
                  Coach
                </label>
                <p className="t-muted mb-[var(--s2)]">
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
                  className="select disabled:opacity-70"
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
                className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Saving...' : hasUnsavedEdits ? 'Save Correction' : 'Nothing To Save'}
              </button>
            </form>

            <section className="mat-leather space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
              <div>
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                  {selected.active_flag ? 'This athlete has left the gym' : 'This athlete is back'}
                </h2>
                <p className="t-body mt-[var(--s3)]">
                  {selected.active_flag
                    ? 'Marking them inactive keeps their whole record — every session, goal, review and pain report stays exactly where it is. It can be undone here at any time.'
                    : 'This record is marked inactive. Marking them active again puts them back on the roster as they were.'}
                </p>
                <p className="t-body mt-[var(--s3)]">
                  Two things it does not do: it does not switch off their sign-in, and it does not take them off their
                  coach&apos;s lists. Turn the sign-in off on the People screen.
                </p>
              </div>

              {hasUnsavedEdits ? (
                <p className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                  Save or discard the corrections above first — this button writes the record as it is stored now, not
                  as the form currently reads.
                </p>
              ) : confirmingStatusChange ? (
                <div className="space-y-[var(--s3)]">
                  <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">
                    {selected.active_flag
                      ? `Mark ${selected.full_name} inactive?`
                      : `Mark ${selected.full_name} active again?`}
                  </p>
                  <div className="flex flex-wrap gap-[var(--s3)]">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void toggleActive()}
                      className="btn flex-1 disabled:opacity-50"
                    >
                      {busy ? 'Saving...' : 'Yes, Save It'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmingStatusChange(false)}
                      className="btn btn--ghost flex-1 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingStatusChange(true)}
                  className="btn btn--ghost w-full"
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
      <main className="room--office grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <p className="t-body">Loading...</p>
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
