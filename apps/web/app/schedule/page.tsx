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
  // Optional because GET /api/pilot/scheduler withholds every *_account_id
  // from a parent and an athlete: on this platform an account_id is a staff
  // member's login email unless an admin typed something else
  // (staffProvisioning.ts:316), and this list used to print one under
  // "Coach:" to whoever was signed in.
  coach_account_id?: string;
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

// The rest of a training-hold refusal. register_class answers a held athlete
// with a 403 carrying the explanation the coach wrote for the athlete and the
// condition that lifts the hold; this page used to print only the one-line
// error above them, so a family learned registration was paused and neither
// why nor what ends it.
type HoldRefusalDetail = {
  explanation: string;
  liftCondition: string;
};

function holdRefusalDetailFrom(result: { athlete_explanation?: unknown; lift_condition?: unknown }): HoldRefusalDetail | null {
  if (typeof result.athlete_explanation !== 'string' || !result.athlete_explanation.trim()) {
    return null;
  }
  return {
    explanation: result.athlete_explanation.trim(),
    // The column defaults to '' -- a hold may be placed without one. Carried
    // as blank and said so at render time, never filled with a made-up one.
    liftCondition: typeof result.lift_condition === 'string' ? result.lift_condition.trim() : '',
  };
}

// OD-2026-10-06-024 ruling 1 ("Warn only, both places"): a staff check-in whose
// athlete is on an active training hold still succeeds, and its answer carries
// the hold facts for the screen to show beside the action. The scheduler route
// sends this to a coach or organization admin only, so an athlete's or a
// parent's own check-in never gets one. 'unreadable' means the hold could not
// be read -- which is not "no hold".
type CheckInHoldWarning = {
  scope: 'all_training' | 'contact_only' | 'conditioning_only';
  reason_category: string;
  athlete_explanation: string;
  lift_condition_text: string;
};

const HOLD_SCOPE_LABEL: Record<CheckInHoldWarning['scope'], string> = {
  all_training: 'ALL TRAINING',
  contact_only: 'CONTACT WORK',
  conditioning_only: 'CONDITIONING',
};

function checkInHoldWarningFrom(value: unknown): CheckInHoldWarning | 'unreadable' | null {
  // Absent is "not held". Anything PRESENT that this screen cannot read as a
  // hold is not drawn as one, and is not "not held" either: it is unknown.
  if (value === undefined || value === null) return null;
  if (value === 'unreadable' || typeof value !== 'object') return 'unreadable';
  const hold = value as Record<string, unknown>;
  if (
    typeof hold.scope !== 'string' || !Object.hasOwn(HOLD_SCOPE_LABEL, hold.scope)
    || typeof hold.reason_category !== 'string'
    || typeof hold.athlete_explanation !== 'string'
  ) {
    return 'unreadable';
  }
  return {
    scope: hold.scope as CheckInHoldWarning['scope'],
    reason_category: hold.reason_category,
    athlete_explanation: hold.athlete_explanation,
    lift_condition_text: typeof hold.lift_condition_text === 'string' ? hold.lift_condition_text.trim() : '',
  };
}

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
  // True when the scheduler read itself failed: the class, record and request
  // lists are then unread, and must not say "no classes" / "no requests".
  // An action error or a failed athlete list leaves this false.
  const [schedulerFailed, setSchedulerFailed] = useState(false);
  const [errorDetail, setErrorDetail] = useState<HoldRefusalDetail | null>(null);
  // Set by a check-in that went through for an athlete on an active hold,
  // stored WITH the athlete it was returned for and matched against the
  // current selection at render: a response that lands after the coach has
  // moved on to another athlete must never be drawn under that athlete's name.
  // Cleared with every new action, like the messages beside it.
  const [checkInHold, setCheckInHold] = useState<{ athleteId: string; hold: CheckInHoldWarning | 'unreadable' } | null>(null);
  const [actionInFlight, setActionInFlight] = useState(false);

  // Every error write on this page goes through here, so a hold's detail is
  // replaced or cleared together with the message it belongs to and can never
  // linger under a later, unrelated failure.
  const showError = useCallback((message: string, detail: HoldRefusalDetail | null = null) => {
    setErrorMessage(message);
    setErrorDetail(detail);
  }, []);

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
    showError('');
    let schedulerRead = false;

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
      schedulerRead = true;
      setSchedulerFailed(false);

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
      if (!schedulerRead) setSchedulerFailed(true);
      showError(error instanceof Error ? error.message : 'Failed to load scheduler state');
    } finally {
      setLoading(false);
    }
  }, [showError]);

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
    setCheckInHold(null);
    showError('');

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
        athlete_explanation?: unknown;
        lift_condition?: unknown;
        status?: string;
        hold_warning?: unknown;
      };
      if (!response.ok || !result.ok) {
        showError(result.error || 'Action failed', holdRefusalDetailFrom(result));
        return;
      }

      // Non-blocking membership flag (capability-network audit finding):
      // registration never refuses a lapsed/ended membership -- only a
      // training hold blocks -- but a coach/admin acting here should still
      // see it, so it rides along on the success message instead of being
      // silently dropped.
      // A full class waitlists rather than refusing (schedulerDb.ts), and the
      // route says which happened in `status`. Saying "submitted" to a family
      // who was waitlisted told them they had a seat.
      const message = payload.action === 'register_class' && result.status === 'waitlisted'
        ? 'The class is full, so this athlete was added to the waitlist.'
        : successMessage;
      if (payload.action === 'attendance_checkin') {
        const warned = checkInHoldWarningFrom(result.hold_warning);
        setCheckInHold(warned ? { athleteId: String(payload.athlete_id ?? ''), hold: warned } : null);
      }
      if (result.membership_flags && result.membership_flags.length > 0) {
        const summary = result.membership_flags
          .map((flag) => `${flag.program_name} (${flag.status})`)
          .join(', ');
        setActionMessage(
          `${message} Note: this athlete's membership is not active -- ${summary}. `
            + 'Registration was NOT blocked; please follow up with the family.',
        );
      } else {
        setActionMessage(message);
      }
      await loadSchedulerState();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setActionInFlight(false);
    }
  }

  const targetAthleteForAthleteRole = athleteId;
  const targetAthleteForOthers = selectedAthleteId;
  const shownCheckInHold = checkInHold
    && checkInHold.athleteId === (role === 'athlete' ? targetAthleteForAthleteRole : targetAthleteForOthers)
    ? checkInHold.hold
    : null;

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
          CoachRecognitionPad.tsx already does.

          The TYPE half of the same law now comes from the same attribute:
          design-system/foundation/ppbf-foundation.css floors every control
          inside this subtree at --t-md. Three review controls below carried
          `text-[length:var(--t-xs)]` -- 11.8px, on the surface Law 5 sets at
          19.1px. That utility is in `@layer utilities` and the floor is
          unlayered, so it stopped rendering the moment the floor landed; it is
          removed rather than left to tell a reader of this file a size the
          page does not use. The floor is the one place the figure is stated. */}
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

              The failure rung is --restricted, not --locked. --locked means
              MEDICALLY_NOT_ALLOWED, and a scheduler request that did not go
              through is not a medical restriction on a child -- dressing it
              in the medical channel is exactly the confusion that meaning
              exists to prevent. (Red itself is not reserved,
              OD-2026-09-29-001.) Success keeps the cleared rung. */}
          {errorMessage ? (
            <div className="rounded-[var(--r-md)] border-2 border-[color:var(--restricted)] bg-[rgba(192,90,30,0.10)] p-[var(--s4)]" role="alert">
              <span className="badge badge--restricted"><i>▲</i>Failed</span>
              <p className="t-body mt-[var(--s3)]">{errorMessage}</p>
              {errorDetail ? (
                <>
                  <p className="t-body mt-[var(--s3)]">Why: {errorDetail.explanation}</p>
                  <p className="t-body mt-[var(--s3)]">
                    To lift it: {errorDetail.liftCondition || 'not written down — ask whoever placed the hold.'}
                  </p>
                </>
              ) : null}
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
                {schedulerFailed ? (
                  <p className="t-muted mt-[var(--s3)]">The schedule could not be loaded just now.</p>
                ) : classes.length === 0 ? (
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
                            Seats: {item.registered_count ?? 0}/{item.capacity}
                            {item.coach_account_id ? ` | Coach: ${item.coach_account_id}` : ''}
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
                                showError('Select an athlete first before registering.');
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
                        showError('Select an athlete first.');
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
                    onChange={(e) => {
                      setSelectedClassId(e.target.value);
                      setCheckInHold(null);
                    }}
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
                        showError('Select an athlete first.');
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

                  {/* Beside the action it belongs to (OD-2026-10-06-024 ruling 1). */}
                  {shownCheckInHold && shownCheckInHold !== 'unreadable' ? (
                    <div className="rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] p-[var(--s4)]" role="status">
                      <p className="t-eyebrow">Active Training Hold</p>
                      <p className="t-body mt-[var(--s3)] font-semibold">
                        {HOLD_SCOPE_LABEL[shownCheckInHold.scope]} is currently paused for this athlete ({shownCheckInHold.reason_category}).
                        The check-in was NOT blocked.
                      </p>
                      <p className="t-body mt-[var(--s3)]">{shownCheckInHold.athlete_explanation}</p>
                      <p className="t-body mt-[var(--s3)]">
                        To lift it: {shownCheckInHold.lift_condition_text || 'not written down — ask whoever placed the hold.'}
                      </p>
                    </div>
                  ) : null}
                  {shownCheckInHold === 'unreadable' ? (
                    <div className="rounded-[var(--r-md)] border-2 border-[color:var(--restricted)] p-[var(--s4)]" role="status">
                      <p className="t-eyebrow">Training hold: could not be read</p>
                      <p className="t-body mt-[var(--s3)] font-semibold">
                        The check-in was saved, but whether this athlete is under a training hold is UNKNOWN. Do not read this as &quot;no hold&quot;.
                      </p>
                    </div>
                  ) : null}
                </article>

                <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
                  <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Parent Review and Records</h3>
                  <div className="mt-3 space-y-2 max-h-[340px] overflow-y-auto">
                    {schedulerFailed ? (
                      <p className="t-muted">Records could not be loaded just now.</p>
                    ) : registrations.length === 0 && attendance.length === 0 ? (
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
                            className="mt-1 min-h-[var(--tap)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-2 font-bold uppercase tracking-[0.08em] disabled:opacity-50"
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
                  {schedulerFailed ? (
                    <p className="t-muted">Coaching requests could not be loaded just now.</p>
                  ) : coachingRequests.length === 0 ? <p className="t-muted">No coaching requests yet.</p> : null}
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
                                  showError('Enter the coach account id to assign first.');
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
                              className="min-h-[var(--tap)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-2 font-bold uppercase tracking-[0.08em] disabled:opacity-50"
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
                              className="min-h-[var(--tap)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-2 font-bold uppercase tracking-[0.08em] disabled:opacity-50"
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
