'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import RoleSessionGate from '@/components/RoleSessionGate';
import type { ClubRole } from '@/components/roleRoutes';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric, formatGymStamp, formatGymTimeOfDay } from '@/src/lib/gymTime';
import OperationsLink from '@/components/OperationsLink';

type SchedulerRole = 'athlete' | 'coach' | 'parent' | 'organization_admin' | 'admin';

type AthleteRow = {
  athlete_id: string;
  full_name?: string;
};

type SchedulerClass = {
  class_id: string;
  title: string;
  start_at: string;
  end_at: string;
  location: string;
  capacity: number;
  coach_account_id: string;
  covering_coach_account_id?: string;
  status: 'open' | 'full' | 'cancelled';
  registered_count?: number;
};

type SchedulerRegistration = {
  registration_id: string;
  class_id: string;
  athlete_id: string;
  requested_by_role: SchedulerRole;
  parent_reviewed: boolean;
  status: 'registered' | 'waitlisted' | 'cancelled';
  created_at: string;
};

type SchedulerCoachingRequest = {
  request_id: string;
  athlete_id: string;
  preferred_at: string;
  goals: string;
  status: 'pending' | 'approved' | 'declined';
  assigned_coach_account_id?: string | null;
  created_at: string;
};

type MembershipFlag = {
  membership_id: string;
  program_name: string;
  status: string;
};

type SchedulerAttendance = {
  attendance_id: string;
  class_id: string;
  athlete_id: string;
  status: 'present' | 'absent' | 'excused';
  method: 'self' | 'parent' | 'coach_override' | 'admin_override';
  note: string;
  checked_in_at: string;
};

type SchedulerResponse = {
  ok: boolean;
  role: SchedulerRole;
  athlete_id?: string | null;
  classes: SchedulerClass[];
  registrations: SchedulerRegistration[];
  coaching_requests: SchedulerCoachingRequest[];
  attendance: SchedulerAttendance[];
};

const allowedRoles: ClubRole[] = ['athlete', 'coach', 'parent', 'admin'];

function roleCanManageClasses(role: SchedulerRole | null): boolean {
  return role === 'coach' || role === 'admin' || role === 'organization_admin';
}

function roleCanManageParents(role: SchedulerRole | null): boolean {
  return role === 'parent' || role === 'admin' || role === 'organization_admin';
}

function roleCanOverrideAttendance(role: SchedulerRole | null): boolean {
  return role === 'coach' || role === 'admin' || role === 'organization_admin';
}

// Deliberately narrower than roleCanManageClasses: resolving a 1:1 coaching
// request is org-admin-only (owner policy, 2026-08-14). A coach may not
// approve, decline, or claim a request -- the server refuses it too; this
// just keeps the controls off a screen where they could never work.
function roleCanResolveCoachingRequests(role: SchedulerRole | null): boolean {
  return role === 'admin' || role === 'organization_admin';
}

export default function SchedulerPage() {
  const [role, setRole] = useState<SchedulerRole | null>(null);
  const [athleteId, setAthleteId] = useState<string>('');
  const [athletes, setAthletes] = useState<AthleteRow[]>([]);

  const [classes, setClasses] = useState<SchedulerClass[]>([]);
  const [registrations, setRegistrations] = useState<SchedulerRegistration[]>([]);
  const [coachingRequests, setCoachingRequests] = useState<SchedulerCoachingRequest[]>([]);
  const [attendance, setAttendance] = useState<SchedulerAttendance[]>([]);

  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [actionInFlight, setActionInFlight] = useState(false);

  const [newClassTitle, setNewClassTitle] = useState('');
  const [newClassStartAt, setNewClassStartAt] = useState('');
  const [newClassEndAt, setNewClassEndAt] = useState('');
  const [newClassLocation, setNewClassLocation] = useState('');
  const [newClassCapacity, setNewClassCapacity] = useState<number>(16);

  const [selectedClassId, setSelectedClassId] = useState('');
  const [selectedAthleteId, setSelectedAthleteId] = useState('');
  const [coachingPreferredAt, setCoachingPreferredAt] = useState('');
  const [coachingGoals, setCoachingGoals] = useState('');
  // Per-request, keyed by request_id: two pending requests must not share
  // one coach field, or approving the second silently reuses the first's
  // coach.
  const [assignCoachInputs, setAssignCoachInputs] = useState<Record<string, string>>({});
  const [attendanceStatus, setAttendanceStatus] = useState<'present' | 'absent' | 'excused'>('present');
  const [attendanceNote, setAttendanceNote] = useState('');

  const athleteMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const athlete of athletes) {
      map.set(athlete.athlete_id, athlete.full_name ?? athlete.athlete_id);
    }
    return map;
  }, [athletes]);

  // Default selections are applied functionally rather than read out of a
  // closure so this loader keeps a stable identity: depending on the current
  // selection would re-run the whole fetch, and blank the page behind
  // "Loading scheduler...", every time a dropdown changes.
  const loadSchedulerState = useCallback(async () => {
    setLoading(true);
    setErrorMessage('');

    try {
      const authRes = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST', credentials: 'include' });
      const auth = (await authRes.json()) as { authenticated?: boolean; role?: SchedulerRole; athlete_id?: string | null };
      if (!authRes.ok || !auth.authenticated || !auth.role) {
        throw new Error('Authentication required');
      }

      setRole(auth.role);
      setAthleteId(auth.athlete_id ?? '');

      const schedulerRes = await fetch(`${apiBase()}/api/pilot/scheduler`, { method: 'GET', credentials: 'include' });
      const scheduler = (await schedulerRes.json()) as SchedulerResponse & { error?: string };
      if (!schedulerRes.ok || !scheduler.ok) {
        throw new Error(scheduler.error || 'Failed to load scheduler state');
      }

      setClasses(scheduler.classes || []);
      setRegistrations(scheduler.registrations || []);
      setCoachingRequests(scheduler.coaching_requests || []);
      setAttendance(scheduler.attendance || []);

      if (scheduler.classes.length > 0) {
        const firstClassId = scheduler.classes[0].class_id;
        setSelectedClassId((current) => current || firstClassId);
      }

      if (auth.role === 'parent' || auth.role === 'coach' || auth.role === 'admin' || auth.role === 'organization_admin') {
        const athletesRes = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const athletesPayload = (await athletesRes.json()) as { items?: AthleteRow[]; error?: string };
        if (!athletesRes.ok) {
          throw new Error(athletesPayload.error || 'Failed to load athletes');
        }
        const rows = athletesPayload.items || [];
        setAthletes(rows);
        if (rows.length > 0) {
          const firstAthleteId = rows[0].athlete_id;
          setSelectedAthleteId((current) => current || firstAthleteId);
        }
      } else {
        setAthletes([]);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load scheduler state');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSchedulerState().catch((err) => console.error('Failed to load scheduler state:', err));
  }, [loadSchedulerState]);

  async function runAction(payload: Record<string, unknown>, successMessage: string) {
    // Guards every scheduler action (register, cover, create, request,
    // check-in, review) against double-submit -- a second click before the
    // first request resolves used to be able to reach the server as two
    // concurrent register_class calls.
    if (actionInFlight) {
      return;
    }

    setActionInFlight(true);
    setActionMessage('');
    setErrorMessage('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/scheduler`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        membership_flags?: MembershipFlag[];
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Action failed');
      }

      // Non-blocking membership flag (capability-network audit finding):
      // registration never refuses a lapsed/ended membership -- only a
      // training hold blocks -- but a coach/admin acting here should still
      // see it, so it rides along on the success message instead of being
      // silently dropped.
      if (result.membership_flags && result.membership_flags.length > 0) {
        const summary = result.membership_flags
          .map((flag) => `${flag.program_name} (${flag.status})`)
          .join(', ');
        setActionMessage(
          `${successMessage} Note: this athlete's membership is not active -- ${summary}. `
            + 'Registration was NOT blocked; please follow up with the family.',
        );
      } else {
        setActionMessage(successMessage);
      }
      await loadSchedulerState();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setActionInFlight(false);
    }
  }

  const targetAthleteForAthleteRole = athleteId;
  const targetAthleteForOthers = selectedAthleteId;

  return (
    <RoleSessionGate allowedRoles={allowedRoles}>
      {/* data-surface="kiosk" -- Law 5, and the same one-attribute device
          app/athlete/layout.tsx uses. This is a CHECK-IN surface: an athlete
          taps "Check In" on it in gloves or wraps, and a parent taps it on a
          phone in a loud room. It reads as an athlete screen and behaves like
          one, but it lives outside /athlete/*, so the 55px floor stopped at
          its door and every one of its controls sat at the 44px desk number.
          The attribute is on the element the whole page already passes
          through, so it covers what is here now and whatever gets added next.

          The globals.css floor covers button / select / the named input types.
          It deliberately does not reach `a` or `textarea`, so those state
          min-h-[var(--tap)] at the call site, the way
          CoachRecognitionPad.tsx already does. */}
      {/* ge-scheduler -- GOLDEN ERA 005, THE SCHEDULE BOARD. One class, on the
          element the whole page already passes through, and the only markup
          change in that pass: the material identity itself lives in
          design-system/current/ppbf-golden-era.css, scoped to this class.
          Nothing about the control set, the roles, or the actions moves. */}
      <main data-surface="kiosk" className="ge-scheduler room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s6)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-7xl space-y-[var(--s5)]">
          <header className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)]">
            <p className="t-eyebrow">Unified Scheduler</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
              Class Registration and Attendance
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-[80ch]">
              Members register for classes, request individual coaching, coaches schedule and cover classes, parents review, and attendance supports coach/admin override.
            </p>
            <div className="mt-[var(--s4)] flex flex-wrap items-center gap-[var(--s3)]">
              {/* Role is identity, not a safety claim, so it wears patina brass
                  rather than any rung of the status ladder (Laws 1 and 2). */}
              <span className="mat-brass--patina inline-flex min-h-[var(--s6)] items-center rounded-[var(--r-sm)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--hide-950)]">
                Role: {role || 'loading'}
              </span>
              {roleCanOverrideAttendance(role) ? (
                <Link href="/admin/attendance" className="btn btn--ghost btn--tap">
                  Attendance Dashboard
                </Link>
              ) : null}
              <OperationsLink className="btn btn--ghost btn--tap">
                Back to Operations
              </OperationsLink>
            </div>
          </header>

          {/* These two were Tailwind's stock red-700/green-700 with no glyph:
              off the status ladder entirely, and colour as the only channel,
              which Law 3 forbids. They are queue outcomes, so they get the
              badge component and the ladder's own rungs.

              The failure rung is --restricted, not --locked. #A81E22 /
              --locked is reserved for MEDICALLY_NOT_ALLOWED (owner decision
              2026-08-19), and a scheduler request that did not go through is
              not a medical restriction on a child -- dressing it in the
              medical channel is exactly the confusion the reservation exists
              to prevent. Success keeps the cleared rung. */}
          {errorMessage ? (
            <div className="rounded-[var(--r-md)] border-2 border-[color:var(--restricted)] bg-[rgba(192,90,30,0.10)] p-[var(--s4)]" role="alert">
              <span className="badge badge--restricted"><i>▲</i>Failed</span>
              <p className="t-body mt-[var(--s3)]">{errorMessage}</p>
            </div>
          ) : null}
          {actionMessage ? (
            <div className="rounded-[var(--r-md)] border-2 border-[color:var(--cleared)] bg-[rgba(63,125,78,0.10)] p-[var(--s4)]" role="status">
              <span className="badge badge--cleared"><i>✓</i>Done</span>
              <p className="t-body mt-[var(--s3)]">{actionMessage}</p>
            </div>
          ) : null}

          {loading ? (
            <div className="mat-leather rounded-[var(--r-md)] p-[var(--s5)]">
              <p className="t-muted">Loading scheduler…</p>
            </div>
          ) : (
            <>
              <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Class Schedule</h2>
                {classes.length === 0 ? (
                  <p className="t-muted mt-[var(--s3)]">No classes scheduled yet.</p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {classes.map((item) => (
                      <div key={item.class_id} className="flex flex-wrap items-center justify-between gap-[var(--s4)] rounded-[var(--r-md)] mat-leather--raised p-[var(--s4)]">
                        <div>
                          <p className="t-command" style={{ fontSize: 'var(--t-sm)' }}>{item.title}</p>
                          <p className="t-muted">
                            {formatGymStamp(item.start_at)} - {formatGymTimeOfDay(item.end_at)} | {item.location}
                          </p>
                          <p className="t-data">
                            Seats: {item.registered_count ?? 0}/{item.capacity} | Coach: {item.coach_account_id}
                            {item.covering_coach_account_id ? ` | Cover: ${item.covering_coach_account_id}` : ''}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedClassId(item.class_id);
                              const targetAthlete = role === 'athlete' ? targetAthleteForAthleteRole : targetAthleteForOthers;
                              if (!targetAthlete) {
                                setErrorMessage('Select an athlete first before registering.');
                                return;
                              }
                              void runAction(
                                { action: 'register_class', class_id: item.class_id, athlete_id: targetAthlete },
                                'Class registration submitted.',
                              );
                            }}
                            disabled={actionInFlight}
                            className="btn disabled:opacity-60 disabled:grayscale"
                          >
                            Register
                          </button>
                          {roleCanManageClasses(role) ? (
                            <button
                              type="button"
                              onClick={() => void runAction({ action: 'cover_class', class_id: item.class_id }, 'Coach cover assignment updated.')}
                              disabled={actionInFlight}
                              className="btn btn--ghost disabled:opacity-60"
                            >
                              Cover Class
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                {roleCanManageClasses(role) ? (
                  <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)] space-y-[var(--s4)]">
                    <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Schedule New Class</h3>
                    <input
                      value={newClassTitle}
                      onChange={(e) => setNewClassTitle(e.target.value)}
                      placeholder="Class title"
                      className="input"
                    />
                    <div className="grid gap-2 md:grid-cols-2">
                      <div>
                        <label htmlFor="new-class-start-at" className="t-label">
                          Class starts
                        </label>
                        <input
                          id="new-class-start-at"
                          type="datetime-local"
                          value={newClassStartAt}
                          onChange={(e) => setNewClassStartAt(e.target.value)}
                          className="input"
                        />
                      </div>
                      <div>
                        <label htmlFor="new-class-end-at" className="t-label">
                          Class ends
                        </label>
                        <input
                          id="new-class-end-at"
                          type="datetime-local"
                          value={newClassEndAt}
                          onChange={(e) => setNewClassEndAt(e.target.value)}
                          className="input"
                        />
                      </div>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <input
                        value={newClassLocation}
                        onChange={(e) => setNewClassLocation(e.target.value)}
                        placeholder="Location"
                        className="input"
                      />
                      <input
                        type="number"
                        min={1}
                        max={200}
                        value={newClassCapacity}
                        onChange={(e) => setNewClassCapacity(Number.parseInt(e.target.value, 10) || 16)}
                        className="input"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void runAction(
                          {
                            action: 'create_class',
                            title: newClassTitle,
                            start_at: newClassStartAt,
                            end_at: newClassEndAt,
                            location: newClassLocation,
                            capacity: newClassCapacity,
                          },
                          'Class scheduled successfully.',
                        )
                      }
                      disabled={actionInFlight}
                      className="btn disabled:opacity-60 disabled:grayscale"
                    >
                      Schedule Class
                    </button>
                  </article>
                ) : null}

                <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)] space-y-[var(--s4)]">
                  <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Request Individual Coaching</h3>

                  {(role === 'parent' || roleCanManageClasses(role)) && athletes.length > 0 ? (
                    <select
                      value={selectedAthleteId}
                      onChange={(e) => setSelectedAthleteId(e.target.value)}
                      className="select"
                    >
                      {athletes.map((item) => (
                        <option key={item.athlete_id} value={item.athlete_id}>
                          {item.full_name || item.athlete_id}
                        </option>
                      ))}
                    </select>
                  ) : null}

                  <div>
                    <label htmlFor="coaching-preferred-at" className="t-label">
                      Preferred coaching time
                    </label>
                    <input
                      id="coaching-preferred-at"
                      type="datetime-local"
                      value={coachingPreferredAt}
                      onChange={(e) => setCoachingPreferredAt(e.target.value)}
                      className="input"
                    />
                  </div>
                  <textarea
                    value={coachingGoals}
                    onChange={(e) => setCoachingGoals(e.target.value)}
                    placeholder="Goals and focus areas"
                    className="textarea min-h-[var(--tap)] h-[89px]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const targetAthlete = role === 'athlete' ? targetAthleteForAthleteRole : targetAthleteForOthers;
                      if (!targetAthlete) {
                        setErrorMessage('Select an athlete first.');
                        return;
                      }
                      void runAction(
                        {
                          action: 'request_coaching',
                          athlete_id: targetAthlete,
                          preferred_at: coachingPreferredAt,
                          goals: coachingGoals,
                        },
                        'Coaching request submitted.',
                      );
                    }}
                    disabled={actionInFlight}
                    className="btn disabled:opacity-60 disabled:grayscale"
                  >
                    Submit Request
                  </button>
                </article>
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)] space-y-[var(--s4)]">
                  <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Attendance Check-In</h3>
                  <select
                    value={selectedClassId}
                    onChange={(e) => setSelectedClassId(e.target.value)}
                    className="input"
                  >
                    {classes.map((item) => (
                      <option key={item.class_id} value={item.class_id}>
                        {item.title} ({formatGymDateNumeric(item.start_at)})
                      </option>
                    ))}
                  </select>

                  {(roleCanOverrideAttendance(role) || role === 'parent') && athletes.length > 0 ? (
                    <select
                      value={selectedAthleteId}
                      onChange={(e) => setSelectedAthleteId(e.target.value)}
                      className="select"
                    >
                      {athletes.map((item) => (
                        <option key={item.athlete_id} value={item.athlete_id}>
                          {item.full_name || item.athlete_id}
                        </option>
                      ))}
                    </select>
                  ) : null}

                  <select
                    value={attendanceStatus}
                    onChange={(e) => setAttendanceStatus(e.target.value as 'present' | 'absent' | 'excused')}
                    className="input"
                  >
                    <option value="present">Present</option>
                    <option value="absent">Absent</option>
                    <option value="excused">Excused</option>
                  </select>

                  {/* This was a bare textarea with a hand-rolled border and
                      no minimum height of any kind -- 80px of box on the one
                      control a coach writes in standing up. The same file
                      already uses .textarea correctly a few dozen lines above;
                      @layer base does not floor a textarea, so the tap height
                      is stated here. */}
                  <textarea
                    value={attendanceNote}
                    onChange={(e) => setAttendanceNote(e.target.value)}
                    placeholder="Attendance notes"
                    className="textarea min-h-[var(--tap)] h-[89px]"
                  />

                  <button
                    type="button"
                    onClick={() => {
                      const targetAthlete = role === 'athlete' ? targetAthleteForAthleteRole : targetAthleteForOthers;
                      if (!targetAthlete) {
                        setErrorMessage('Select an athlete first.');
                        return;
                      }

                      void runAction(
                        {
                          action: 'attendance_checkin',
                          class_id: selectedClassId,
                          athlete_id: targetAthlete,
                          status: attendanceStatus,
                          note: attendanceNote,
                        },
                        role === 'athlete' ? 'Self check-in submitted.' : 'Attendance updated with override.',
                      );
                    }}
                    disabled={actionInFlight}
                    className="btn disabled:opacity-60 disabled:grayscale"
                  >
                    {role === 'athlete' ? 'Check In' : 'Update Attendance'}
                  </button>
                </article>

                <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
                  <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Parent Review and Records</h3>
                  <div className="mt-3 space-y-2 max-h-[340px] overflow-y-auto">
                    {registrations.length === 0 && attendance.length === 0 ? (
                      <p className="t-muted">No registration or attendance records visible for your role.</p>
                    ) : null}

                    {registrations.map((item) => (
                      <div key={item.registration_id} className="input">
                        <p className="t-command" style={{ fontSize: 'var(--t-sm)' }}>
                          Registration: {athleteMap.get(item.athlete_id) || item.athlete_id} {' -> '} {classes.find((x) => x.class_id === item.class_id)?.title || item.class_id}
                        </p>
                        <p className="text-[color:var(--bone-300)]">Status: {item.status} | Parent Reviewed: {item.parent_reviewed ? 'Yes' : 'No'}</p>
                        {roleCanManageParents(role) && !item.parent_reviewed ? (
                          <button
                            type="button"
                            onClick={() =>
                              void runAction(
                                { action: 'parent_review_registration', registration_id: item.registration_id },
                                'Parent review completed.',
                              )
                            }
                            disabled={actionInFlight}
                            className="mt-1 min-h-[var(--tap)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-2 text-[length:var(--t-xs)] font-bold uppercase tracking-[0.08em] disabled:opacity-50"
                          >
                            Mark Parent Reviewed
                          </button>
                        ) : null}
                      </div>
                    ))}

                    {attendance.map((item) => (
                      <div key={item.attendance_id} className="input">
                        <p className="t-command" style={{ fontSize: 'var(--t-sm)' }}>
                          Attendance: {athleteMap.get(item.athlete_id) || item.athlete_id} {' -> '} {classes.find((x) => x.class_id === item.class_id)?.title || item.class_id}
                        </p>
                        <p className="text-[color:var(--bone-300)]">{item.status.toUpperCase()} via {item.method}</p>
                        <p className="text-[color:var(--bone-400)]">{formatGymStamp(item.checked_in_at)}</p>
                      </div>
                    ))}
                  </div>
                </article>
              </section>

              <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
                <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Coaching Requests</h3>
                <div className="mt-3 space-y-2">
                  {coachingRequests.length === 0 ? <p className="t-muted">No coaching requests yet.</p> : null}
                  {coachingRequests.map((item) => (
                    <div key={item.request_id} className="input">
                      <p className="t-command" style={{ fontSize: 'var(--t-sm)' }}>{athleteMap.get(item.athlete_id) || item.athlete_id}</p>
                      <p className="text-[color:var(--bone-300)]">
                        Preferred: {formatGymStamp(item.preferred_at)} | Status: {item.status}
                        {item.status === 'approved' && item.assigned_coach_account_id
                          ? ` | Coach: ${item.assigned_coach_account_id}`
                          : ''}
                      </p>
                      <p className="text-[color:var(--bone-400)]">{item.goals}</p>
                      {roleCanResolveCoachingRequests(role) && item.status === 'pending' ? (
                        <div className="mt-2 space-y-1">
                          <label htmlFor={`assign-coach-${item.request_id}`} className="t-label">
                            Coach to assign (their coach of record, or a coach holding active coverage)
                          </label>
                          <input
                            id={`assign-coach-${item.request_id}`}
                            type="text"
                            value={assignCoachInputs[item.request_id] ?? ''}
                            onChange={(e) =>
                              setAssignCoachInputs((current) => ({ ...current, [item.request_id]: e.target.value }))
                            }
                            placeholder="coach account id"
                            className="input"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                const coachId = (assignCoachInputs[item.request_id] ?? '').trim();
                                if (!coachId) {
                                  setErrorMessage('Enter the coach account id to assign first.');
                                  return;
                                }
                                void runAction(
                                  {
                                    action: 'review_coaching_request',
                                    request_id: item.request_id,
                                    decision: 'approve',
                                    assigned_coach_account_id: coachId,
                                  },
                                  'Coaching request approved.',
                                );
                              }}
                              disabled={actionInFlight}
                              className="min-h-[var(--tap)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-2 text-[length:var(--t-xs)] font-bold uppercase tracking-[0.08em] disabled:opacity-50"
                            >
                              Approve &amp; Assign
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void runAction(
                                  {
                                    action: 'review_coaching_request',
                                    request_id: item.request_id,
                                    decision: 'decline',
                                  },
                                  'Coaching request declined.',
                                )
                              }
                              disabled={actionInFlight}
                              className="min-h-[var(--tap)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-2 text-[length:var(--t-xs)] font-bold uppercase tracking-[0.08em] disabled:opacity-50"
                            >
                              Decline
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </RoleSessionGate>
  );
}
