'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import RoleSessionGate from '@/components/RoleSessionGate';
import type { ClubRole } from '@/components/roleRoutes';
import { ui } from '@/components/uiStyles';

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
  created_at: string;
};

type SchedulerAttendance = {
  attendance_id: string;
  class_id: string;
  athlete_id: string;
  status: 'present' | 'absent' | 'excused';
  method: 'self' | 'coach_override' | 'admin_override';
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
  const [attendanceStatus, setAttendanceStatus] = useState<'present' | 'absent' | 'excused'>('present');
  const [attendanceNote, setAttendanceNote] = useState('');

  const athleteMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const athlete of athletes) {
      map.set(athlete.athlete_id, athlete.full_name ?? athlete.athlete_id);
    }
    return map;
  }, [athletes]);

  const loadSchedulerState = useCallback(async () => {
    setLoading(true);
    setErrorMessage('');

    try {
      const authRes = await fetch('/api/pilot/auth/session', { method: 'POST', credentials: 'include' });
      const auth = (await authRes.json()) as { authenticated?: boolean; role?: SchedulerRole; athlete_id?: string | null };
      if (!authRes.ok || !auth.authenticated || !auth.role) {
        throw new Error('Authentication required');
      }

      setRole(auth.role);
      setAthleteId(auth.athlete_id ?? '');

      const schedulerRes = await fetch('/api/pilot/scheduler', { method: 'GET', credentials: 'include' });
      const scheduler = (await schedulerRes.json()) as SchedulerResponse & { error?: string };
      if (!schedulerRes.ok || !scheduler.ok) {
        throw new Error(scheduler.error || 'Failed to load scheduler state');
      }

      setClasses(scheduler.classes || []);
      setRegistrations(scheduler.registrations || []);
      setCoachingRequests(scheduler.coaching_requests || []);
      setAttendance(scheduler.attendance || []);

      if (scheduler.classes.length > 0 && !selectedClassId) {
        setSelectedClassId(scheduler.classes[0].class_id);
      }

      if (auth.role === 'parent' || auth.role === 'coach' || auth.role === 'admin' || auth.role === 'organization_admin') {
        const athletesRes = await fetch('/api/pilot/athletes/list', { method: 'GET', credentials: 'include' });
        const athletesPayload = (await athletesRes.json()) as { items?: AthleteRow[]; error?: string };
        if (!athletesRes.ok) {
          throw new Error(athletesPayload.error || 'Failed to load athletes');
        }
        const rows = athletesPayload.items || [];
        setAthletes(rows);
        if (rows.length > 0 && !selectedAthleteId) {
          setSelectedAthleteId(rows[0].athlete_id);
        }
      } else {
        setAthletes([]);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load scheduler state');
    } finally {
      setLoading(false);
    }
  }, [selectedClassId, selectedAthleteId]);

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
      const response = await fetch('/api/pilot/scheduler', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Action failed');
      }

      setActionMessage(successMessage);
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
      <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)]">
        <div className="mx-auto w-full max-w-7xl space-y-6">
          <header className="border-b-2 border-[var(--black)] pb-5">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">Unified Scheduler</p>
            <h1 className="mt-2 text-3xl font-black md:text-4xl">Class Registration and Attendance</h1>
            <p className="mt-2 text-sm text-[var(--gray-dark)]">
              Members register for classes, request individual coaching, coaches schedule and cover classes, parents review, and attendance supports coach/admin override.
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-mono uppercase tracking-[0.1em]">
              <span className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-2 py-1 text-[var(--gray-dark)]">Role: {role || 'loading'}</span>
              <Link href="/operations" className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-2 py-1 text-[var(--gray-dark)] hover:border-[var(--red-primary)]">
                Back to Operations
              </Link>
            </div>
          </header>

          {errorMessage ? <div className={ui.errorContainer}>{errorMessage}</div> : null}
          {actionMessage ? <div className="border-2 border-[var(--status-ready)] bg-[var(--status-ready)]/10 p-4 text-sm text-[var(--status-ready)]">{actionMessage}</div> : null}

          {loading ? (
            <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 text-sm text-[var(--gray-dark)]">Loading scheduler...</div>
          ) : (
            <>
              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h2 className="text-lg font-bold text-[var(--red-primary)]">Class Schedule</h2>
                {classes.length === 0 ? (
                  <p className="mt-2 text-sm text-[var(--gray-dark)]">No classes scheduled yet.</p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {classes.map((item) => (
                      <div key={item.class_id} className="flex flex-wrap items-center justify-between gap-3 border border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                        <div>
                          <p className="font-semibold text-[var(--black)]">{item.title}</p>
                          <p className="text-xs text-[var(--gray-dark)]">
                            {new Date(item.start_at).toLocaleString()} - {new Date(item.end_at).toLocaleTimeString()} | {item.location}
                          </p>
                          <p className="text-xs text-[var(--gray-dark)]">
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
                            className="tactical-btn min-h-[40px] px-3 text-xs disabled:opacity-50"
                          >
                            Register
                          </button>
                          {roleCanManageClasses(role) ? (
                            <button
                              type="button"
                              onClick={() => void runAction({ action: 'cover_class', class_id: item.class_id }, 'Coach cover assignment updated.')}
                              disabled={actionInFlight}
                              className="tactical-btn-ghost min-h-[40px] border-2 border-[var(--black)] px-3 text-xs font-bold uppercase tracking-[0.08em] disabled:opacity-50"
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
                  <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 space-y-3">
                    <h3 className="font-bold text-[var(--red-primary)]">Schedule New Class</h3>
                    <input
                      value={newClassTitle}
                      onChange={(e) => setNewClassTitle(e.target.value)}
                      placeholder="Class title"
                      className="tactical-input"
                    />
                    <div className="grid gap-2 md:grid-cols-2">
                      <input
                        type="datetime-local"
                        value={newClassStartAt}
                        onChange={(e) => setNewClassStartAt(e.target.value)}
                        className="tactical-input"
                      />
                      <input
                        type="datetime-local"
                        value={newClassEndAt}
                        onChange={(e) => setNewClassEndAt(e.target.value)}
                        className="tactical-input"
                      />
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <input
                        value={newClassLocation}
                        onChange={(e) => setNewClassLocation(e.target.value)}
                        placeholder="Location"
                        className="tactical-input"
                      />
                      <input
                        type="number"
                        min={1}
                        max={200}
                        value={newClassCapacity}
                        onChange={(e) => setNewClassCapacity(Number.parseInt(e.target.value, 10) || 16)}
                        className="tactical-input"
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
                      className="tactical-btn min-h-[42px] px-4 text-xs disabled:opacity-50"
                    >
                      Schedule Class
                    </button>
                  </article>
                ) : null}

                <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 space-y-3">
                  <h3 className="font-bold text-[var(--red-primary)]">Request Individual Coaching</h3>

                  {(role === 'parent' || roleCanManageClasses(role)) && athletes.length > 0 ? (
                    <select
                      value={selectedAthleteId}
                      onChange={(e) => setSelectedAthleteId(e.target.value)}
                      className="tactical-input"
                    >
                      {athletes.map((item) => (
                        <option key={item.athlete_id} value={item.athlete_id}>
                          {item.full_name || item.athlete_id}
                        </option>
                      ))}
                    </select>
                  ) : null}

                  <input
                    type="datetime-local"
                    value={coachingPreferredAt}
                    onChange={(e) => setCoachingPreferredAt(e.target.value)}
                    className="tactical-input"
                  />
                  <textarea
                    value={coachingGoals}
                    onChange={(e) => setCoachingGoals(e.target.value)}
                    placeholder="Goals and focus areas"
                    className="tactical-input h-24"
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
                    className="tactical-btn min-h-[42px] px-4 text-xs disabled:opacity-50"
                  >
                    Submit Request
                  </button>
                </article>
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 space-y-3">
                  <h3 className="font-bold text-[var(--red-primary)]">Attendance Check-In</h3>
                  <select
                    value={selectedClassId}
                    onChange={(e) => setSelectedClassId(e.target.value)}
                    className="tactical-input"
                  >
                    {classes.map((item) => (
                      <option key={item.class_id} value={item.class_id}>
                        {item.title} ({new Date(item.start_at).toLocaleDateString()})
                      </option>
                    ))}
                  </select>

                  {(roleCanOverrideAttendance(role) || role === 'parent') && athletes.length > 0 ? (
                    <select
                      value={selectedAthleteId}
                      onChange={(e) => setSelectedAthleteId(e.target.value)}
                      className="tactical-input"
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
                    className="tactical-input"
                  >
                    <option value="present">Present</option>
                    <option value="absent">Absent</option>
                    <option value="excused">Excused</option>
                  </select>

                  <textarea
                    value={attendanceNote}
                    onChange={(e) => setAttendanceNote(e.target.value)}
                    placeholder="Attendance notes"
                    className="tactical-input h-20"
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
                    className="tactical-btn min-h-[42px] px-4 text-xs disabled:opacity-50"
                  >
                    {role === 'athlete' ? 'Check In' : 'Update Attendance'}
                  </button>
                </article>

                <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                  <h3 className="font-bold text-[var(--red-primary)]">Parent Review and Records</h3>
                  <div className="mt-3 space-y-2 max-h-[340px] overflow-y-auto">
                    {registrations.length === 0 && attendance.length === 0 ? (
                      <p className="text-sm text-[var(--gray-dark)]">No registration or attendance records visible for your role.</p>
                    ) : null}

                    {registrations.map((item) => (
                      <div key={item.registration_id} className="border border-[var(--black)] bg-[var(--canvas-tan)] p-2 text-xs">
                        <p className="font-semibold text-[var(--black)]">
                          Registration: {athleteMap.get(item.athlete_id) || item.athlete_id} {' -> '} {classes.find((x) => x.class_id === item.class_id)?.title || item.class_id}
                        </p>
                        <p className="text-[var(--gray-dark)]">Status: {item.status} | Parent Reviewed: {item.parent_reviewed ? 'Yes' : 'No'}</p>
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
                            className="tactical-btn mt-1 min-h-[34px] px-2 text-[11px] disabled:opacity-50"
                          >
                            Mark Parent Reviewed
                          </button>
                        ) : null}
                      </div>
                    ))}

                    {attendance.map((item) => (
                      <div key={item.attendance_id} className="border border-[var(--black)] bg-[var(--canvas-tan)] p-2 text-xs">
                        <p className="font-semibold text-[var(--black)]">
                          Attendance: {athleteMap.get(item.athlete_id) || item.athlete_id} {' -> '} {classes.find((x) => x.class_id === item.class_id)?.title || item.class_id}
                        </p>
                        <p className="text-[var(--gray-dark)]">{item.status.toUpperCase()} via {item.method}</p>
                        <p className="text-[var(--gray-dark)]">{new Date(item.checked_in_at).toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                </article>
              </section>

              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h3 className="font-bold text-[var(--red-primary)]">Coaching Requests</h3>
                <div className="mt-3 space-y-2">
                  {coachingRequests.length === 0 ? <p className="text-sm text-[var(--gray-dark)]">No coaching requests yet.</p> : null}
                  {coachingRequests.map((item) => (
                    <div key={item.request_id} className="border border-[var(--black)] bg-[var(--canvas-tan)] p-2 text-xs">
                      <p className="font-semibold text-[var(--black)]">{athleteMap.get(item.athlete_id) || item.athlete_id}</p>
                      <p className="text-[var(--gray-dark)]">Preferred: {new Date(item.preferred_at).toLocaleString()} | Status: {item.status}</p>
                      <p className="text-[var(--gray-dark)]">{item.goals}</p>
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
