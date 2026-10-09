import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  assertActiveCoachAccount,
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
  assertCoachAssignedToAthlete,
  athleteIdsForCoach,
} from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne } from '@/src/server/pilot/db';
import { formatGymStamp, formatGymTimeOfDay } from '@/src/lib/gymTime';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  bulkUpsertSchedulerAttendance,
  createSchedulerClass,
  createSchedulerCoachingRequest,
  getSchedulerClassById,
  getSchedulerCoachingRequestById,
  getSchedulerRegistrationById,
  listRegisteredAthleteIdsForClass,
  listSchedulerStore,
  markSchedulerRegistrationReviewed,
  registerForClassTransactionally,
  resolveSchedulerCoachingRequest,
  upsertSchedulerAttendance,
} from '@/src/server/pilot/schedulerDb';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => ({
  // The class-register rule (OD-2026-10-07-008 question card 1 item 4) runs
  // REAL here: the register tests below pin it, and the PR's mutation proof
  // loosens it in access.ts and watches those tests fail. Its one database
  // read, the walk-in live-row check, goes through the mocked ./db queryOne.
  actorRunsClass: jest.requireActual('@/src/server/pilot/access').actorRunsClass,
  assertActorCanMarkClassAthlete: jest.requireActual('@/src/server/pilot/access').assertActorCanMarkClassAthlete,
  assertActiveCoachAccount: jest.fn(),
  assertActorCanAccessAthlete: jest.fn(),
  // The athlete arm's live-row check. Resolves (a live athlete) unless a
  // test says otherwise; the deleted-athlete refusal is pinned against a
  // real database in athleteSelfDeletionMark.pg.test.ts.
  assertAthleteBelongsToOrganization: jest.fn(),
  assertCoachAssignedToAthlete: jest.fn(),
  athleteIdsForCoach: jest.fn(),
  isOrganizationAdminRole: jest.fn((role: string) => role === 'organization_admin' || role === 'admin'),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

// The parent branch of GET resolves its children through this. Left real, it
// runs against the mocked ./db and answers nothing, which is indistinguishable
// from "this guardian has no children" -- a filter test that passes because
// the fixture is empty proves nothing.
jest.mock('@/src/server/pilot/guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
}));

jest.mock('@/src/server/pilot/schedulerDb', () => ({
  createSchedulerClass: jest.fn(),
  createSchedulerCoachingRequest: jest.fn(),
  registerForClassTransactionally: jest.fn(),
  getSchedulerClassById: jest.fn(),
  getSchedulerRegistrationById: jest.fn(),
  markSchedulerRegistrationReviewed: jest.fn(),
  getSchedulerCoachingRequestById: jest.fn(),
  resolveSchedulerCoachingRequest: jest.fn(),
  setSchedulerClassCover: jest.fn(),
  upsertSchedulerAttendance: jest.fn(),
  bulkUpsertSchedulerAttendance: jest.fn(),
  listRegisteredAthleteIdsForClass: jest.fn(),
  listSchedulerStore: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  sanitizedSqlState: jest.fn(),
}));

jest.mock('@/src/server/pilot/safetyGateMatrix', () => ({
  recordSafetyGateEvaluation: jest.fn().mockResolvedValue({ evaluation_id: 'eval-1' }),
  getSafetyGateDefinition: jest.fn().mockResolvedValue({ gate_id: 'gate-1', gate_key: 'training_hold', active_flag: true }),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockRegister = registerForClassTransactionally as jest.Mock;
const mockAssertCanAct = assertActorCanAccessAthlete as jest.Mock;
const mockGetClass = getSchedulerClassById as jest.Mock;
const mockUpsertAttendance = upsertSchedulerAttendance as jest.Mock;
const mockBulkUpsertAttendance = bulkUpsertSchedulerAttendance as jest.Mock;
const mockListRegistered = listRegisteredAthleteIdsForClass as jest.Mock;

const classRecord = {
  class_id: 'class-1',
  title: 'Fundamentals',
  start_at: 'now',
  end_at: 'later',
  location: 'Main Floor',
  capacity: 20,
  scheduled_by_account_id: 'acct-coach-1',
  coach_account_id: 'acct-coach-1',
  status: 'open' as const,
  created_at: 'now',
  updated_at: 'now',
};

beforeEach(() => {
  mockAssertCanAct.mockResolvedValue(undefined);
  mockGetClass.mockResolvedValue(classRecord);
  mockUpsertAttendance.mockResolvedValue(undefined);
  mockBulkUpsertAttendance.mockResolvedValue(undefined);
  mockListRegistered.mockResolvedValue(['ATH-1', 'ATH-2', 'ATH-OUTSIDE']);
});

afterEach(() => {
  jest.clearAllMocks();
});

function athletePrincipal(): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  };
}

function principal(role: string, overrides: Record<string, unknown> = {}): PilotPrincipal {
  return {
    accountId: 'acct-caller',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  } as PilotPrincipal;
}

function registerRequest() {
  return new NextRequest('http://localhost/api/pilot/scheduler', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'register_class', class_id: 'class-1' }),
  });
}

function jsonRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/scheduler', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pilot/scheduler register_class', () => {
  // Registering twice is a normal thing for a family to do; it has to read as
  // a conflict the UI can explain, never as a masked server error.
  test('409 with a readable reason when the athlete is already registered', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockRegister.mockResolvedValueOnce({ outcome: 'already_registered' });

    const res = await POST(registerRequest());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Athlete already registered for this class' });
  });

  test('200 on a first registration', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockRegister.mockResolvedValueOnce({ outcome: 'registered', membershipFlags: [] });

    const res = await POST(registerRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: 'registered', membership_flags: [] });
  });

  // Non-blocking membership flag (capability-network audit finding): a
  // lapsed/ended membership never refuses the registration -- the response
  // still comes back 200/registered -- but the coach/admin who registered
  // this athlete needs to see it, so it rides along in the response body.
  test('200 on registration still carries membership_flags when the athlete has a lapsed/ended membership', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockRegister.mockResolvedValueOnce({
      outcome: 'registered',
      membershipFlags: [{ membership_id: 'mem-1', program_name: 'Youth Boxing', status: 'lapsed' }],
    });

    const res = await POST(registerRequest());
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      status: 'registered',
      membership_flags: [{ membership_id: 'mem-1', program_name: 'Youth Boxing', status: 'lapsed' }],
    });
  });

  // #82 STOP: the hold refusal carries the hold's own words -- the
  // explanation written for the athlete and the lift condition -- and the
  // blocked attempt is recorded as a gate evaluation so "how often is this
  // child trying to come back" stays answerable.
  test('403 with the athlete explanation when an all-training hold blocks the registration', async () => {
    const { recordSafetyGateEvaluation } = jest.requireMock('@/src/server/pilot/safetyGateMatrix') as {
      recordSafetyGateEvaluation: jest.Mock;
    };
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockRegister.mockResolvedValueOnce({
      outcome: 'training_hold',
      holdId: 'hold-1',
      athleteExplanation: 'We are giving your head time to heal.',
      liftConditionText: 'A doctor says you are ready.',
    });

    const res = await POST(registerRequest());
    const payload = await res.json();

    expect(res.status).toBe(403);
    expect(payload.athlete_explanation).toBe('We are giving your head time to heal.');
    expect(payload.lift_condition).toBe('A doctor says you are ready.');
    expect(recordSafetyGateEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({ gateKey: 'training_hold', outcome: 'blocked', metadata: { hold_id: 'hold-1' } }),
    );
  });

  // The gate-matrix migration is a separate operator dispatch from the
  // training-holds migration -- an org can have holds placeable before it
  // has the 'training_hold' gate row. The refusal (and the explanation
  // written FOR the athlete) must never depend on the evaluations table
  // accepting the write: without this, the FK violation on a missing gate
  // row would mask the intended 403 as a 500 that eats the explanation.
  test('the 403 still returns, with the explanation, when the gate row does not exist yet', async () => {
    const { getSafetyGateDefinition, recordSafetyGateEvaluation } = jest.requireMock(
      '@/src/server/pilot/safetyGateMatrix',
    ) as { getSafetyGateDefinition: jest.Mock; recordSafetyGateEvaluation: jest.Mock };
    getSafetyGateDefinition.mockResolvedValueOnce(null);
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockRegister.mockResolvedValueOnce({
      outcome: 'training_hold',
      holdId: 'hold-1',
      athleteExplanation: 'We are giving your head time to heal.',
      liftConditionText: 'A doctor says you are ready.',
    });

    const res = await POST(registerRequest());
    const payload = await res.json();

    expect(res.status).toBe(403);
    expect(payload.athlete_explanation).toBe('We are giving your head time to heal.');
    expect(recordSafetyGateEvaluation).not.toHaveBeenCalled();
  });

  // A fully pre-migration deploy may lack pilot.safety_gates entirely, not
  // just the training_hold row -- the lookup itself throws 42P01, and that
  // must degrade the same way as a missing row: still a 403, never a 500.
  test('the 403 still returns when the whole safety_gates table is missing', async () => {
    const { getSafetyGateDefinition, recordSafetyGateEvaluation } = jest.requireMock(
      '@/src/server/pilot/safetyGateMatrix',
    ) as { getSafetyGateDefinition: jest.Mock; recordSafetyGateEvaluation: jest.Mock };
    getSafetyGateDefinition.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.safety_gates" does not exist'), { code: '42P01' }),
    );
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockRegister.mockResolvedValueOnce({
      outcome: 'training_hold',
      holdId: 'hold-1',
      athleteExplanation: 'We are giving your head time to heal.',
      liftConditionText: 'A doctor says you are ready.',
    });

    const res = await POST(registerRequest());

    expect(res.status).toBe(403);
    expect(recordSafetyGateEvaluation).not.toHaveBeenCalled();
  });
});

// The athlete arm's live-row check, pinned here so the PR suite (which does not
// run the real-database suite) fails if it is removed. What the check reads is
// pinned against real rows in athleteSelfDeletionMark.pg.test.ts.
describe('the athlete arm requires the live athlete row', () => {
  const mockLiveRow = assertAthleteBelongsToOrganization as jest.Mock;

  test('an athlete acting on their own record is checked against their own gym', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockRegister.mockResolvedValueOnce({ outcome: 'registered', membershipFlags: [] });

    const res = await POST(registerRequest());

    expect(res.status).toBe(200);
    expect(mockLiveRow).toHaveBeenCalledWith('org-1', 'ath-1');
  });

  test('a deleted athlete (no live row) is refused with 403 and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockLiveRow.mockRejectedValueOnce(new Error('Forbidden: athlete does not belong to organization'));

    const res = await POST(registerRequest());

    expect(res.status).toBe(403);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});

describe('the admin arm requires the live athlete row', () => {
  const mockLiveRow = assertAthleteBelongsToOrganization as jest.Mock;
  // A queued rejection the route never consumes must not leak into the next
  // describe; clearAllMocks leaves queued one-time values in place.
  afterEach(() => mockLiveRow.mockReset());
  const adminRegister = () => jsonRequest({ action: 'register_class', class_id: 'class-1', athlete_id: 'ath-9' });

  test.each(['organization_admin', 'admin'])('%s acting on an athlete is checked against their own gym', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role, { accountId: 'acct-admin-1' }));
    mockRegister.mockResolvedValueOnce({ outcome: 'registered', membershipFlags: [] });

    const res = await POST(adminRegister());

    expect(res.status).toBe(200);
    expect(mockLiveRow).toHaveBeenCalledWith('org-1', 'ath-9');
  });

  test('a deleted athlete (no live row) cannot be registered by an admin: 403, nothing written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'acct-admin-1' }));
    mockLiveRow.mockRejectedValueOnce(new Error('Forbidden: athlete does not belong to organization'));

    const res = await POST(adminRegister());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: athlete does not belong to organization' });
    expect(mockRegister).not.toHaveBeenCalled();
  });
});

describe('attendance_checkin method attribution', () => {
  // A parent checking in their own linked child was previously recorded as
  // method: 'coach_override' -- the else branch that resolveAttendanceMethod
  // replaces -- misattributing who actually made the call.
  // checked_in_by_role was always correct; only method lied.
  test('a parent checking in their own child is recorded as method "parent", not coach_override', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent', { accountId: 'acct-parent-1' }));

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'present' }),
    );

    expect(response.status).toBe(200);
    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record.method).toBe('parent');
    expect(record.checked_in_by_role).toBe('parent');
  });

  test('a coach override is still recorded as coach_override', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));

    await POST(jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'absent' }));

    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record.method).toBe('coach_override');
  });

  test('an admin override is still recorded as admin_override', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'acct-admin-1' }));

    await POST(jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'excused' }));

    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record.method).toBe('admin_override');
  });

  test('an athlete self-checking-in is still recorded as self', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete', { athleteId: 'ATH-1' }));

    await POST(jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', status: 'present' }));

    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record.method).toBe('self');
  });
});

// OD-2026-10-06-024 ruling 1, "Warn only, both places": an active training hold
// never stops a check-in. The coach or admin marking the athlete is told in the
// answer; an athlete's own or a parent's check-in gets nothing new. The hold
// reader here is the real one, over the faked database.
describe('attendance check-in warns on an active training hold and does not block', () => {
  const mockQueryOne = queryOne as jest.Mock;
  const mockQuery = query as jest.Mock;
  afterEach(() => {
    mockQueryOne.mockReset();
    mockQuery.mockReset();
  });

  const HOLD_ROW = {
    hold_id: 'hold-1',
    athlete_id: 'ATH-1',
    scope: 'all_training',
    reason_category: 'administrative',
    reason_text: 'STAFF-ONLY DETAIL: PAYMENT DISPUTE',
    athlete_explanation: 'Training is paused while we sort out paperwork.',
    lift_condition_text: 'Bring the signed waiver.',
    placed_by_account_id: 'acct-coach-1',
    placed_by_role: 'coach',
    placed_at: '2026-10-01 10:00:00+00',
    expires_at: null,
    status: 'active',
  };
  const checkIn = (athleteId = 'ATH-1') =>
    jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: athleteId, status: 'present' });

  test.each(['coach', 'organization_admin', 'admin'])(
    '%s: the mark is stored (200) and the answer carries the hold facts',
    async (role) => {
      // A coach writes attendance only into a class they own (acct-coach-1 owns class-1).
      mockRequirePrincipal.mockResolvedValueOnce(principal(role, { accountId: role === 'coach' ? 'acct-coach-1' : 'acct-caller' }));
      mockQueryOne.mockResolvedValueOnce(HOLD_ROW);

      const response = await POST(checkIn());

      expect(response.status).toBe(200);
      expect(mockUpsertAttendance).toHaveBeenCalledTimes(1);
      const body = await response.json();
      expect(body).toMatchObject({ ok: true, class_id: 'class-1', athlete_id: 'ATH-1' });
      expect(body.hold_warning).toEqual({
        hold_id: 'hold-1',
        scope: 'all_training',
        reason_category: 'administrative',
        athlete_explanation: 'Training is paused while we sort out paperwork.',
        lift_condition_text: 'Bring the signed waiver.',
        expires_at: null,
      });
      expect(JSON.stringify(body)).not.toContain('PAYMENT DISPUTE');
    },
  );

  test('no hold: the answer is exactly what it was before, with no hold_warning key', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockQueryOne.mockResolvedValueOnce(null);

    const response = await POST(checkIn());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, class_id: 'class-1', athlete_id: 'ATH-1', method: 'coach_override' });
  });

  test('a failed hold read never fails the check-in; it is "unreadable", not "no hold"', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockQueryOne.mockRejectedValueOnce(new Error('connection reset'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await POST(checkIn());

    expect(response.status).toBe(200);
    expect(mockUpsertAttendance).toHaveBeenCalledTimes(1);
    expect((await response.json()).hold_warning).toBe('unreadable');
    errors.mockRestore();
  });

  test('an athlete checking themself in, and a parent checking in their child, get nothing new', async () => {
    // The hold is there and would be returned if the reader ran -- so what is
    // asserted is that it never reads for these roles, not that it found none.
    mockQueryOne.mockResolvedValue(HOLD_ROW);

    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete', { athleteId: 'ATH-1' }));
    const own = await POST(jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', status: 'present' }));

    mockRequirePrincipal.mockResolvedValueOnce(principal('parent', { accountId: 'acct-parent-1' }));
    const parent = await POST(checkIn());

    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ ok: true, class_id: 'class-1', athlete_id: 'ATH-1', method: 'self' });
    expect(parent.status).toBe(200);
    expect(await parent.json()).toEqual({ ok: true, class_id: 'class-1', athlete_id: 'ATH-1', method: 'parent' });
    expect(mockUpsertAttendance).toHaveBeenCalledTimes(2);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('bulk: a coach marking a roster is told which athletes are held; every mark is still stored', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockQuery
      .mockResolvedValueOnce([]) // sweepExpiredHolds
      .mockResolvedValueOnce([HOLD_ROW, { ...HOLD_ROW, hold_id: 'hold-9', athlete_id: 'ATH-NOT-IN-BATCH' }]);

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-2', status: 'present' },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(mockBulkUpsertAttendance.mock.calls[0][1]).toHaveLength(2);
    const body = await response.json();
    expect(body.marked_count).toBe(2);
    // Only the held athlete who was in the batch, and no staff-only text.
    expect(body.hold_warnings).toEqual([
      {
        athlete_id: 'ATH-1',
        hold_id: 'hold-1',
        scope: 'all_training',
        reason_category: 'administrative',
        athlete_explanation: 'Training is paused while we sort out paperwork.',
        lift_condition_text: 'Bring the signed waiver.',
        expires_at: null,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('PAYMENT DISPUTE');
  });

  test('bulk: nobody held means no hold key; a failed list says so rather than saying "none"', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const clean = await POST(
      jsonRequest({ action: 'bulk_attendance_checkin', class_id: 'class-1', entries: [{ athlete_id: 'ATH-1', status: 'present' }] }),
    );
    expect(await clean.json()).toEqual({ ok: true, class_id: 'class-1', marked_count: 1, athlete_ids: ['ATH-1'] });

    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await POST(
      jsonRequest({ action: 'bulk_attendance_checkin', class_id: 'class-1', entries: [{ athlete_id: 'ATH-1', status: 'present' }] }),
    );
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ marked_count: 1, hold_warnings_unreadable: true });
    errors.mockRestore();
  });
});

describe('bulk_attendance_checkin', () => {
  test('a coach marks a whole roster in one call', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-2', status: 'absent', note: 'called in sick' },
        ],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, marked_count: 2 });
    expect(mockBulkUpsertAttendance).toHaveBeenCalledTimes(1);
    const [, records] = mockBulkUpsertAttendance.mock.calls[0];
    expect(records).toHaveLength(2);
    expect(records.map((r: { method: string }) => r.method)).toEqual(['coach_override', 'coach_override']);
    // Reach comes from the class register, not from per-athlete assignment
    // (OD-2026-10-07-008 question card 1 item 4).
    expect(mockAssertCanAct).not.toHaveBeenCalled();
  });

  test('athlete and parent roles are refused -- bulk marking is a coach/admin action', async () => {
    for (const role of ['athlete', 'parent']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role, { athleteId: 'ATH-1' }));
      const response = await POST(
        jsonRequest({ action: 'bulk_attendance_checkin', class_id: 'class-1', entries: [{ athlete_id: 'ATH-1', status: 'present' }] }),
      );
      expect(response.status).toBe(403);
    }
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });

  test('a duplicate athlete_id in the batch is refused rather than silently overwritten', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-1', status: 'absent' },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });

  test('an empty entries array is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));

    const response = await POST(jsonRequest({ action: 'bulk_attendance_checkin', class_id: 'class-1', entries: [] }));

    expect(response.status).toBe(400);
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });

  test('one athlete who is neither registered nor a live athlete of the gym fails the whole batch before any write', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    // The walk-in live-row read (assertAthleteBelongsToOrganization) finds
    // nobody: a stranger's id, or a deleted athlete's.
    (queryOne as jest.Mock).mockResolvedValueOnce(null);

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-STRANGER', status: 'present' },
        ],
      }),
    );

    expect(response.status).toBe(403);
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });
});

describe('coach class-ownership on attendance writes', () => {
  // Without this, a coach could overwrite another coach's attendance
  // attestations in a class they cannot even read (the summary route 403s
  // them) -- write access without read access, on a safeguarding record.
  test('a coach who does not own the class cannot bulk-mark it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [{ athlete_id: 'ATH-1', status: 'absent' }],
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('only the coach, cover or scheduler of this class'),
    });
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });

  test('a coach who does not own the class cannot single-mark it either', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'absent' }),
    );

    expect(response.status).toBe(403);
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
  });

  test('a covering coach owns the class for attendance purposes', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-covering' }));
    mockGetClass.mockResolvedValueOnce({ ...classRecord, covering_coach_account_id: 'acct-covering' });

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [{ athlete_id: 'ATH-1', status: 'present' }],
      }),
    );

    expect(response.status).toBe(200);
  });

  test('admin is not subject to class ownership', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'acct-admin-1' }));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [{ athlete_id: 'ATH-1', status: 'present' }],
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe('attendance requires registration', () => {
  // An unregistered mark counts in the org summary but appears on no class
  // roster -- a number no drill-down can explain -- and it is what let an
  // athlete self-mark 'present' in every class in the gym.
  // Since OD-2026-10-07-008 (question card 1 item 4) a coach running the
  // class may mark an unregistered athlete of the gym PRESENT as a walk-in;
  // absent and excused stay registered-only -- nobody is absent from a class
  // they were never on. The walk-in cases are pinned in the class-register
  // describe below.
  test('single check-in marking an unregistered athlete absent is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-2']);
    // A live athlete of the gym -- so the refusal below is the status rule, not the live-row check.
    (queryOne as jest.Mock).mockResolvedValueOnce({ athlete_id: 'ATH-1' });

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'absent' }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('not registered for this class; a walk-in can only be marked present'),
    });
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
  });

  test("a parent's mark on an unregistered child is still refused outright", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent', { accountId: 'acct-parent-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-2']);

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'present' }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('not registered') });
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
  });

  test('an athlete cannot self-check-in to a class they are not registered for', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete', { athleteId: 'ATH-1' }));
    mockListRegistered.mockResolvedValueOnce([]);

    const response = await POST(jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', status: 'present' }));

    expect(response.status).toBe(400);
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
  });

  test('a bulk batch marking one unregistered athlete absent fails whole before any write', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-1']);
    (queryOne as jest.Mock).mockResolvedValueOnce({ athlete_id: 'ATH-2' });

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-2', status: 'absent' },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });
});

/* THE CLASS REGISTER: WHOLE CLASS PLUS WALK-INS (OD-2026-10-07-008, question
   card 1 item 4). The coach who teaches, scheduled, or is covering a class
   marks every athlete registered to it, assigned to them or not, and may mark
   an unregistered athlete of the gym present as a walk-in. A coach who does
   not run the class gets nothing from it. Everything outside the register
   stays assigned-coach only (OD-2026-10-05-024 item 2).

   assertActorCanAccessAthlete is mocked and watched: the register path must
   never consult it, or the rule has quietly fallen back to assignment. The
   walk-in live-row read is the mocked queryOne. */
describe('the class register: whole class plus walk-ins', () => {
  const mockQueryOne = queryOne as jest.Mock;
  const mockQuery = query as jest.Mock;
  const mockAudit = writePilotAuditEvent as jest.Mock;
  afterEach(() => {
    mockQueryOne.mockReset();
    mockQuery.mockReset();
  });

  // class-1: coach_account_id and scheduled_by_account_id are acct-coach-1.
  const runs = {
    teaches: { accountId: 'acct-coach-1', cls: classRecord },
    scheduled: { accountId: 'acct-scheduler', cls: { ...classRecord, coach_account_id: 'acct-other', scheduled_by_account_id: 'acct-scheduler' } },
    covers: { accountId: 'acct-cover', cls: { ...classRecord, covering_coach_account_id: 'acct-cover' } },
  };

  test.each(Object.entries(runs))(
    'a coach who %s the class marks a registered athlete they are not assigned to',
    async (_label, who) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: who.accountId }));
      mockGetClass.mockResolvedValueOnce(who.cls);
      mockListRegistered.mockResolvedValueOnce(['ATH-NOT-MINE']);
      // The hold read after the mark: no hold.
      mockQueryOne.mockResolvedValueOnce(null);

      const response = await POST(
        jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-NOT-MINE', status: 'absent' }),
      );

      expect(response.status).toBe(200);
      expect(mockAssertCanAct).not.toHaveBeenCalled();
      const [, record] = mockUpsertAttendance.mock.calls[0];
      expect(record).toMatchObject({ athlete_id: 'ATH-NOT-MINE', status: 'absent', method: 'coach_override' });
      // A registered athlete needs no live-row read: the roster already excludes deleted athletes.
      expect(mockQueryOne.mock.calls.some(([sql]) => String(sql).includes('pilot.athletes'))).toBe(false);
    },
  );

  test('a coach who does not run the class is refused for a registered athlete, even one assigned to them', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-1']);

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'present' }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Forbidden: only the coach, cover or scheduler of this class can mark its register',
    });
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
    // The class decides; assignment is not consulted either way.
    expect(mockAssertCanAct).not.toHaveBeenCalled();
  });

  test('a walk-in: the coach running the class marks an unregistered athlete of the gym present, stored as walk_in', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-1']);
    // The live-row read finds the athlete in this gym; the hold read after
    // the mark finds no hold.
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ATH-WALKIN' }).mockResolvedValueOnce(null);

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-WALKIN', status: 'present' }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, class_id: 'class-1', athlete_id: 'ATH-WALKIN', method: 'walk_in' });
    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record).toMatchObject({ athlete_id: 'ATH-WALKIN', status: 'present', method: 'walk_in', checked_in_by_role: 'coach' });
    // The live-row read is scoped to this gym and to live athletes.
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('deleted_at is null');
    expect(params).toEqual(['ATH-WALKIN', 'org-1']);
    expect(mockAssertCanAct).not.toHaveBeenCalled();
  });

  test('a walk-in who is not a live athlete of this gym is refused, and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-1']);
    mockQueryOne.mockResolvedValueOnce(null);

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-ELSEWHERE', status: 'present' }),
    );

    expect(response.status).toBe(403);
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
  });

  test('a coach who does not run the class cannot mark a walk-in on it either', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));
    mockListRegistered.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ATH-WALKIN' });

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-WALKIN', status: 'present' }),
    );

    expect(response.status).toBe(403);
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('an admin marks a walk-in too, stored as walk_in, not admin_override', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'acct-admin-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-1']);
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ATH-WALKIN' }).mockResolvedValueOnce(null);

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-WALKIN', status: 'present' }),
    );

    expect(response.status).toBe(200);
    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record.method).toBe('walk_in');
  });

  test('bulk: a registered athlete and a walk-in in one batch keep their own methods', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-1']);
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ATH-WALKIN' });
    // readStaffHoldWarnings' list read: nobody held.
    mockQuery.mockResolvedValueOnce([]);

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'excused' },
          { athlete_id: 'ATH-WALKIN', status: 'present' },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const [, records] = mockBulkUpsertAttendance.mock.calls[0];
    expect(records.map((r: { athlete_id: string; method: string }) => [r.athlete_id, r.method])).toEqual([
      ['ATH-1', 'coach_override'],
      ['ATH-WALKIN', 'walk_in'],
    ]);
    expect(mockAssertCanAct).not.toHaveBeenCalled();
  });

  test('cover_class writes an audit row naming the class, the previous cover and the new one (route-survey B6)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));
    mockGetClass.mockResolvedValueOnce({ ...classRecord, covering_coach_account_id: 'acct-before' });

    const response = await POST(jsonRequest({ action: 'cover_class', class_id: 'class-1' }));

    expect(response.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      event_type: 'update',
      actor_account_id: 'acct-coach-2',
      actor_role: 'coach',
      organization_id: 'org-1',
      entity_type: 'scheduler_class',
      entity_id: 'class-1',
      details: {
        action: 'cover_class',
        class_id: 'class-1',
        previous_covering_coach_account_id: 'acct-before',
        covering_coach_account_id: 'acct-coach-2',
      },
    });
  });

  test('cover_class on a class nobody covered records the previous cover as null', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));

    await POST(jsonRequest({ action: 'cover_class', class_id: 'class-1' }));

    expect(mockAudit.mock.calls[0][0].details).toMatchObject({ previous_covering_coach_account_id: null });
  });
});

// Audit s3: a mistyped date on the schedule screen answered 500 with the
// field name replaced by "Internal server error". Caller-fixable input is a
// 400 that names the field.
describe('POST /api/pilot/scheduler answers bad input with 400 and the field name', () => {
  const mockCreateClass = createSchedulerClass as jest.Mock;

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['an unparseable start_at', { start_at: 'next tuesday' }, 'start_at must be a valid date string'],
    ['a missing end_at', { end_at: undefined }, 'end_at must be a non-empty string'],
    ['a blank title', { title: '   ' }, 'title must be a non-empty string'],
    ['a fractional capacity', { capacity: 12.5 }, 'capacity must be an integer'],
    ['a capacity over 200', { capacity: 500 }, 'capacity must be between 1 and 200'],
  ];

  test.each(cases)('%s', async (_label, patch, message) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    const response = await POST(jsonRequest({
      action: 'create_class',
      title: 'Evening boxing',
      start_at: '2026-07-15T18:00',
      end_at: '2026-07-15T19:30',
      location: 'Main Floor',
      capacity: 20,
      ...patch,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  test('a bad attendance status names the field', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'here' }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'status must be present, absent, or excused' });
  });
});

describe('review_coaching_request', () => {
  const mockGetCoachingRequest = getSchedulerCoachingRequestById as jest.Mock;
  const mockResolveRequest = resolveSchedulerCoachingRequest as jest.Mock;
  const mockAssertActiveCoach = assertActiveCoachAccount as jest.Mock;
  const mockAssertCoachAssigned = assertCoachAssignedToAthlete as jest.Mock;
  const mockAuditEvent = writePilotAuditEvent as jest.Mock;

  const pendingRequest = {
    request_id: 'req-1',
    athlete_id: 'ath-1',
    requested_by_role: 'parent',
    requested_by_account_id: 'acct-parent',
    preferred_at: '2026-08-20T17:00:00.000Z',
    goals: 'Southpaw defense',
    status: 'pending',
    assigned_coach_account_id: null,
    created_at: 'now',
    updated_at: 'now',
  };

  function reviewRequest(extra: Record<string, unknown> = {}) {
    return jsonRequest({
      action: 'review_coaching_request',
      request_id: 'req-1',
      decision: 'approve',
      assigned_coach_account_id: 'acct-coach-9',
      ...extra,
    });
  }

  beforeEach(() => {
    mockGetCoachingRequest.mockResolvedValue(pendingRequest);
    mockResolveRequest.mockResolvedValue(true);
    mockAssertActiveCoach.mockResolvedValue(undefined);
    mockAssertCoachAssigned.mockResolvedValue(undefined);
  });

  // Owner policy 2026-08-14: org-admin-only. A coach must never approve,
  // decline, self-assign, or claim a request for 1:1 time with a minor.
  test.each(['coach', 'parent', 'athlete'])('%s cannot resolve a coaching request', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role, role === 'athlete' ? { athleteId: 'ath-1' } : {}));

    const response = await POST(reviewRequest());

    expect(response.status).toBe(403);
    expect(mockResolveRequest).not.toHaveBeenCalled();
  });

  test('a coach cannot self-assign by approving with their own account id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(reviewRequest({ assigned_coach_account_id: 'acct-caller' }));

    expect(response.status).toBe(403);
    expect(mockResolveRequest).not.toHaveBeenCalled();
  });

  test('an approval records the assigned coach and audits the resolution', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(reviewRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      request_id: 'req-1',
      status: 'approved',
      assigned_coach_account_id: 'acct-coach-9',
    });
    expect(mockAssertActiveCoach).toHaveBeenCalledWith('org-1', 'acct-coach-9', 'assigned_coach_account_id');
    expect(mockAssertCoachAssigned).toHaveBeenCalledWith('acct-coach-9', 'ath-1', 'org-1');
    expect(mockResolveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        requestId: 'req-1',
        status: 'approved',
        assignedCoachAccountId: 'acct-coach-9',
      }),
    );
    const [event] = mockAuditEvent.mock.calls[0];
    expect(event).toMatchObject({
      entity_type: 'scheduler_coaching_request',
      entity_id: 'req-1',
      organization_id: 'org-1',
    });
    expect(event.details).toMatchObject({
      action: 'coaching_request_approved',
      athlete_id: 'ath-1',
      assigned_coach_account_id: 'acct-coach-9',
    });
  });

  test('a decline needs no coach checks', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));

    const response = await POST(jsonRequest({ action: 'review_coaching_request', request_id: 'req-1', decision: 'decline' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: 'declined' });
    expect(mockAssertActiveCoach).not.toHaveBeenCalled();
    expect(mockAssertCoachAssigned).not.toHaveBeenCalled();
    expect(mockResolveRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'declined', assignedCoachAccountId: null }),
    );
  });

  test('approving without naming a coach is refused before any check runs', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ action: 'review_coaching_request', request_id: 'req-1', decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockResolveRequest).not.toHaveBeenCalled();
  });

  test('an account that is not an active coach in this organization cannot be assigned', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockAssertActiveCoach.mockRejectedValueOnce(
      new Error('Missing assigned_coach_account_id: must be an active coach account in this organization'),
    );

    const response = await POST(reviewRequest({ assigned_coach_account_id: 'acct-parent' }));

    expect(response.status).toBe(400);
    expect(mockResolveRequest).not.toHaveBeenCalled();
  });

  test('a coach with no relationship to the athlete is refused, and the refusal names the coverage console', async () => {
    // The assignment rides the existing coach<->athlete access model:
    // coach-of-record or active coverage. This workflow validates, it never
    // grants -- temporary access goes through the coverage console.
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockAssertCoachAssigned.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

    const response = await POST(reviewRequest());

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/coach coverage console/);
    expect(mockResolveRequest).not.toHaveBeenCalled();
  });

  test('an already-resolved request is refused without a second write', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetCoachingRequest.mockResolvedValueOnce({ ...pendingRequest, status: 'approved' });

    const response = await POST(reviewRequest());

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/already resolved/);
    expect(mockResolveRequest).not.toHaveBeenCalled();
  });

  test('losing the CAS race reports already-resolved rather than overwriting', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockResolveRequest.mockResolvedValueOnce(false);

    const response = await POST(reviewRequest());

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/already resolved/);
  });

  test('a request outside the acting organization reads as missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetCoachingRequest.mockResolvedValueOnce(null);

    const response = await POST(reviewRequest());

    expect(response.status).toBe(400);
    expect(mockResolveRequest).not.toHaveBeenCalled();
  });
});


describe('GET /api/pilot/scheduler scopes coaching requests to a coach’s reachable athletes', () => {
  const mockAthleteIdsForCoach = athleteIdsForCoach as jest.Mock;
  const mockListStore = listSchedulerStore as jest.Mock;

  // The bug: the coach branch of filterStateForActor returned
  // store.coaching_requests unfiltered, while the parent and athlete branches
  // scope by athlete-reachability. A coaching request is athlete-linked and
  // carries free-text goals, so this disclosed every athlete's 1:1 coaching
  // request org-wide to any coach.
  test('a coach receives coaching requests only for athletes they can reach, not the whole org', async () => {
    mockRequirePrincipal.mockResolvedValue({
      accountId: 'acct-coach',
      role: 'coach',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });
    mockAthleteIdsForCoach.mockResolvedValue(['ath-mine']);
    mockListStore.mockResolvedValue({
      classes: [],
      registrations: [],
      attendance: [],
      coaching_requests: [
        { coaching_request_id: 'cr-mine', athlete_id: 'ath-mine', goals: 'private mine', preferred_at: null, status: 'open', requested_by_account_id: 'p-1' },
        { coaching_request_id: 'cr-other', athlete_id: 'ath-other', goals: 'private other', preferred_at: null, status: 'open', requested_by_account_id: 'p-2' },
      ],
    });

    const response = await GET(new NextRequest('http://localhost/api/pilot/scheduler'));

    expect(response.status).toBe(200);
    const body = await response.json();
    const athleteIds = body.coaching_requests.map((row: { athlete_id: string }) => row.athlete_id);
    expect(athleteIds).toEqual(['ath-mine']);
    expect(athleteIds).not.toContain('ath-other');
    expect(mockAthleteIdsForCoach).toHaveBeenCalledWith('org-1', 'acct-coach');
  });
});

/**
 * The same leak the block above closed for coaching_requests, on the two
 * properties that were missed.
 *
 * registrations and attendance were scoped by CLASS OWNERSHIP alone. That is
 * self-granting: cover_class checks only that the caller is a coach and then
 * writes their own accountId as covering_coach_account_id, with no approval,
 * no check that the class's own coach is unavailable, no time bound and no
 * audit row -- and covering_coach_account_id is one of the three things the
 * ownership set counts. One POST therefore bought any coach every
 * registration and attendance row, including free-text notes, for any class
 * in the organization.
 *
 * The write side was never open: assertCanActOnAthlete still gates per-athlete
 * writes. This is a read scope.
 */
describe('GET /api/pilot/scheduler scopes athlete-linked rows, not just classes', () => {
  const mockAthleteIdsForCoach = athleteIdsForCoach as jest.Mock;
  const mockListStore = listSchedulerStore as jest.Mock;

  function coachPrincipal() {
    return {
      accountId: 'acct-coach',
      role: 'coach' as const,
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft' as const,
    };
  }

  /** A class the coach owns ONLY by having covered it themselves. */
  function storeWithCoveredClass() {
    return {
      classes: [
        {
          class_id: 'cls-not-mine',
          coach_account_id: 'acct-other-coach',
          scheduled_by_account_id: 'acct-other-coach',
          covering_coach_account_id: 'acct-coach',
          start_at: '2026-09-01T10:00:00Z',
          end_at: '2026-09-01T11:00:00Z',
          status: 'scheduled',
        },
      ],
      registrations: [
        { registration_id: 'reg-mine', class_id: 'cls-not-mine', athlete_id: 'ath-mine', status: 'registered' },
        { registration_id: 'reg-other', class_id: 'cls-not-mine', athlete_id: 'ath-other', status: 'registered' },
      ],
      attendance: [
        { attendance_id: 'att-mine', class_id: 'cls-not-mine', athlete_id: 'ath-mine', status: 'present', note: 'mine' },
        { attendance_id: 'att-other', class_id: 'cls-not-mine', athlete_id: 'ath-other', status: 'present', note: 'private other' },
      ],
      coaching_requests: [],
    };
  }

  /* OD-2026-10-07-008 ruling 4 + Overwatch option B (2026-10-09): the coach
     running a class takes its whole register, so they SEE every registration
     and every attendance STATUS on it. Attendance note text -- free text a
     coach wrote about a child -- stays with athletes they reach, so a
     self-granted cover still reads no other coach's notes (CL-A2, #1266). */
  test('the coach running a class sees every registration on it', async () => {
    mockRequirePrincipal.mockResolvedValue(coachPrincipal());
    mockAthleteIdsForCoach.mockResolvedValue(['ath-mine']);
    mockListStore.mockResolvedValue(storeWithCoveredClass());

    const body = await (await GET(new NextRequest('http://localhost/api/pilot/scheduler'))).json();

    const athleteIds = body.registrations.map((row: { athlete_id: string }) => row.athlete_id).sort();
    expect(athleteIds).toEqual(['ath-mine', 'ath-other']);
  });

  test('the coach running a class sees every attendance status, but notes only for athletes they reach', async () => {
    mockRequirePrincipal.mockResolvedValue(coachPrincipal());
    mockAthleteIdsForCoach.mockResolvedValue(['ath-mine']);
    mockListStore.mockResolvedValue(storeWithCoveredClass());

    const body = await (await GET(new NextRequest('http://localhost/api/pilot/scheduler'))).json();

    const byAthlete = Object.fromEntries(
      body.attendance.map((row: { athlete_id: string; status: string; note: string }) => [row.athlete_id, row]),
    );
    expect(byAthlete['ath-other'].status).toBe('present');
    expect(byAthlete['ath-mine'].note).toBe('mine');
    // The note is the part that matters: free text a coach wrote about a child.
    expect(JSON.stringify(body.attendance)).not.toContain('private other');
  });

  test('a class the coach does not run discloses no registration or attendance', async () => {
    mockRequirePrincipal.mockResolvedValue(coachPrincipal());
    mockAthleteIdsForCoach.mockResolvedValue(['ath-mine']);
    const store = storeWithCoveredClass();
    store.classes[0].covering_coach_account_id = 'acct-someone-else';
    mockListStore.mockResolvedValue(store);

    const body = await (await GET(new NextRequest('http://localhost/api/pilot/scheduler'))).json();

    expect(body.registrations).toEqual([]);
    expect(body.attendance).toEqual([]);
  });

  test('a reachable athlete on an owned class is still returned', async () => {
    // Guards against "fixing" this by filtering everything out.
    mockRequirePrincipal.mockResolvedValue(coachPrincipal());
    mockAthleteIdsForCoach.mockResolvedValue(['ath-mine']);
    mockListStore.mockResolvedValue(storeWithCoveredClass());

    const body = await (await GET(new NextRequest('http://localhost/api/pilot/scheduler'))).json();

    expect(body.registrations.some((row: { athlete_id: string }) => row.athlete_id === 'ath-mine')).toBe(true);
    expect(body.attendance.some((row: { athlete_id: string }) => row.athlete_id === 'ath-mine')).toBe(true);
  });
});

/**
 * WHAT A FAMILY ACTUALLY RECEIVES FROM GET, which nothing in this file asked
 * before.
 *
 * Every GET test above runs as a coach. The parent and athlete branches of
 * filterStateForActor -- the ones a guardian and a child actually go through
 * -- had no coverage at all, so nothing pinned which fields left the server
 * for them.
 *
 * Two things were leaving that should not:
 *
 *   *_account_id, on every collection. staffProvisioning.ts:316 resolves an
 *   account_id as `existing?.account_id || accountIdHint || loginEmail` and
 *   the admin invite route passes the hint only when an admin typed one, so
 *   an account_id IS a staff member's login email unless somebody chose
 *   otherwise. app/schedule/page.tsx printed one under "Coach:" on every row
 *   of the class list.
 *
 *   attendance.note, free text a coach typed about a child -- privacyTiers.ts
 *   registers it at tier `organization` in those words and names only the
 *   coach/admin-gated attendance-summary route as its enforcer. This route is
 *   a second reader that entry does not name.
 *
 * The classes collection is the sharpest case because it is deliberately NOT
 * row-filtered: a family browses the whole catalogue to register against it,
 * so every class in the organization arrived carrying three staff
 * identifiers.
 */
describe('GET /api/pilot/scheduler withholds staff fields from a family reader', () => {
  const mockListStore = listSchedulerStore as jest.Mock;
  const mockGuardianAthleteIds = guardianAthleteIds as jest.Mock;

  const STAFF_EMAIL = 'coach@example.com';
  const COVER_EMAIL = 'cover@example.com';
  const SCHEDULER_EMAIL = 'admin@example.com';
  const COACH_NOTE = 'Arrived upset; welfare lead spoke to them.';

  function arrangeStore(): void {
    mockGuardianAthleteIds.mockResolvedValue(['ath-mine']);
    (athleteIdsForCoach as jest.Mock).mockResolvedValue(['ath-mine']);
    mockListStore.mockResolvedValue({
      classes: [{
        class_id: 'class-1',
        title: 'Fundamentals',
        start_at: '2026-08-01T18:00:00.000Z',
        end_at: '2026-08-01T19:00:00.000Z',
        location: 'Main Floor',
        capacity: 20,
        scheduled_by_account_id: SCHEDULER_EMAIL,
        coach_account_id: STAFF_EMAIL,
        covering_coach_account_id: COVER_EMAIL,
        status: 'open',
        created_at: 'now',
        updated_at: 'now',
      }],
      registrations: [{
        registration_id: 'reg-1',
        class_id: 'class-1',
        athlete_id: 'ath-mine',
        requested_by_role: 'coach',
        requested_by_account_id: STAFF_EMAIL,
        parent_reviewed: true,
        parent_reviewed_at: 'now',
        parent_reviewer_account_id: 'parent@example.com',
        status: 'registered',
        created_at: 'now',
        updated_at: 'now',
      }],
      coaching_requests: [{
        request_id: 'cr-1',
        athlete_id: 'ath-mine',
        requested_by_role: 'parent',
        requested_by_account_id: 'parent@example.com',
        preferred_at: 'now',
        goals: 'wants to work the jab',
        status: 'approved',
        assigned_coach_account_id: STAFF_EMAIL,
        created_at: 'now',
        updated_at: 'now',
      }],
      attendance: [{
        attendance_id: 'att-1',
        class_id: 'class-1',
        athlete_id: 'ath-mine',
        status: 'present',
        method: 'coach_override',
        checked_in_by_role: 'coach',
        checked_in_by_account_id: STAFF_EMAIL,
        note: COACH_NOTE,
        checked_in_at: 'now',
        updated_at: 'now',
      }],
    });
  }

  function schedulerGet() {
    return GET(new NextRequest('http://localhost/api/pilot/scheduler'));
  }

  const FAMILY: Array<[string, PilotPrincipal]> = [
    ['a linked guardian', principal('parent', { accountId: 'parent@example.com' })],
    ['the athlete themself', principal('athlete', { accountId: 'athlete@example.com', athleteId: 'ath-mine' })],
  ];

  const STAFF: Array<[string, PilotPrincipal]> = [
    ['a coach', principal('coach', { accountId: STAFF_EMAIL })],
    ['an organization admin', principal('organization_admin')],
    ['the legacy admin role', principal('admin')],
  ];

  test('the reader tables are not empty', () => {
    expect(FAMILY.length).toBeGreaterThan(0);
    expect(STAFF.length).toBeGreaterThan(0);
  });

  test.each(FAMILY)('%s receives no account identifier anywhere in the response', async (_label, actor) => {
    arrangeStore();
    mockRequirePrincipal.mockResolvedValue(actor);

    const body = await (await schedulerGet()).json();

    // The whole body, not four separate key checks: an account_id is a login
    // email here, and one surviving path is the whole disclosure.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(STAFF_EMAIL);
    expect(serialized).not.toContain(COVER_EMAIL);
    expect(serialized).not.toContain(SCHEDULER_EMAIL);
  });

  test.each(FAMILY)('%s receives the class catalogue without the three staff ids on it', async (_label, actor) => {
    arrangeStore();
    mockRequirePrincipal.mockResolvedValue(actor);

    const body = await (await schedulerGet()).json();

    // Still a usable catalogue -- this is what a family registers against, so
    // the rows themselves must not disappear.
    expect(body.classes).toHaveLength(1);
    expect(body.classes[0]).toMatchObject({ class_id: 'class-1', title: 'Fundamentals', capacity: 20 });
    const keys = Object.keys(body.classes[0]);
    expect(keys).not.toContain('coach_account_id');
    expect(keys).not.toContain('covering_coach_account_id');
    expect(keys).not.toContain('scheduled_by_account_id');
  });

  test.each(FAMILY)("%s receives attendance without the coach's free-text note", async (_label, actor) => {
    arrangeStore();
    mockRequirePrincipal.mockResolvedValue(actor);

    const body = await (await schedulerGet()).json();

    expect(body.attendance).toHaveLength(1);
    expect(body.attendance[0]).toMatchObject({ status: 'present', method: 'coach_override' });
    expect(Object.keys(body.attendance[0])).not.toContain('note');
    expect(JSON.stringify(body.attendance)).not.toContain('welfare lead');
    // The role stays: it names no person, and a parent who checked their own
    // child in needs to see that a parent did it.
    expect(body.attendance[0].checked_in_by_role).toBe('coach');
  });

  test.each(FAMILY)('%s still receives their own registration and coaching request', async (_label, actor) => {
    // The control against over-narrowing. Only the identifiers and the staff
    // note move; the records themselves are the point of the screen.
    arrangeStore();
    mockRequirePrincipal.mockResolvedValue(actor);

    const body = await (await schedulerGet()).json();

    expect(body.registrations[0]).toMatchObject({
      registration_id: 'reg-1',
      status: 'registered',
      requested_by_role: 'coach',
      parent_reviewed: true,
    });
    expect(body.coaching_requests[0]).toMatchObject({
      request_id: 'cr-1',
      status: 'approved',
      requested_by_role: 'parent',
      // Free text, and deliberately kept: the REQUESTER writes it and a
      // parent can be the requester. Withholding a family's own words from
      // them would be inventing a rule rather than applying one.
      goals: 'wants to work the jab',
    });
  });

  test.each(STAFF)('%s keeps every field', async (_label, actor) => {
    arrangeStore();
    mockRequirePrincipal.mockResolvedValue(actor);

    const body = await (await schedulerGet()).json();

    expect(body.classes[0].coach_account_id).toBe(STAFF_EMAIL);
    expect(body.classes[0].covering_coach_account_id).toBe(COVER_EMAIL);
    expect(body.classes[0].scheduled_by_account_id).toBe(SCHEDULER_EMAIL);
    expect(body.attendance[0].note).toBe(COACH_NOTE);
    expect(body.attendance[0].checked_in_by_account_id).toBe(STAFF_EMAIL);
    expect(body.registrations[0].requested_by_account_id).toBe(STAFF_EMAIL);
    expect(body.coaching_requests[0].assigned_coach_account_id).toBe(STAFF_EMAIL);
  });

  test('the coach ownership test still sees the ids it needs', async () => {
    /* The projection runs AFTER filterStateForActor on purpose. The coach
       branch decides which classes it owns by comparing coach_account_id,
       scheduled_by_account_id and covering_coach_account_id against its own
       accountId, so narrowing earlier would have taken the coach's ownership
       test away from it and silently emptied its registrations and
       attendance. This is the test that fails if the projection is ever moved
       up into the filter. */
    arrangeStore();
    mockRequirePrincipal.mockResolvedValue(principal('coach', { accountId: STAFF_EMAIL }));

    const body = await (await schedulerGet()).json();

    expect(body.registrations).toHaveLength(1);
    expect(body.attendance).toHaveLength(1);
  });

  test('a parent whose guardian links resolve to nobody receives no athlete-linked row', async () => {
    // Guards the fixture itself: if guardianAthleteIds answered nothing in
    // the tests above, every filter assertion would pass vacuously.
    arrangeStore();
    mockGuardianAthleteIds.mockResolvedValue([]);
    mockRequirePrincipal.mockResolvedValue(principal('parent', { accountId: 'stranger@example.com' }));

    const body = await (await schedulerGet()).json();

    expect(body.registrations).toEqual([]);
    expect(body.attendance).toEqual([]);
    expect(body.coaching_requests).toEqual([]);
    // The catalogue is still there: it is not athlete-linked.
    expect(body.classes).toHaveLength(1);
  });
});

/**
 * THE SEAT COUNT IS ONE FACT ABOUT THE CLASS, not a count of the rows this
 * reader may see.
 *
 * decorateClasses used to count registrations on the actor-filtered store, so
 * a parent's "Seats: n/20" counted only their own children: a full class read
 * as 0/20, they registered, and were waitlisted. A coach covering a class saw
 * only their own roster's share of it. The count now comes from the whole
 * organization's store while the rows stay filtered -- and the count is a
 * bare integer, so it names nobody.
 */
describe('GET /api/pilot/scheduler reports the true seat count without widening the rows', () => {
  const mockListStore = listSchedulerStore as jest.Mock;
  const mockGuardianAthleteIds = guardianAthleteIds as jest.Mock;
  const mockAthleteIdsForCoach = athleteIdsForCoach as jest.Mock;

  function registration(id: string, athleteId: string, status: 'registered' | 'waitlisted' | 'cancelled') {
    return {
      registration_id: id,
      class_id: 'class-full',
      athlete_id: athleteId,
      requested_by_role: 'parent',
      requested_by_account_id: `${athleteId}-guardian@example.com`,
      parent_reviewed: true,
      parent_reviewed_at: 'now',
      parent_reviewer_account_id: `${athleteId}-guardian@example.com`,
      status,
      created_at: 'now',
      updated_at: 'now',
    };
  }

  /** Two seats, both taken -- one by this family's child, one by another family's. */
  function arrangeFullClass(): void {
    mockListStore.mockResolvedValue({
      classes: [{
        class_id: 'class-full',
        title: 'Evening Sparring Prep',
        start_at: '2026-09-01T22:00:00.000Z',
        end_at: '2026-09-01T23:00:00.000Z',
        location: 'Ring',
        capacity: 2,
        scheduled_by_account_id: 'acct-coach',
        coach_account_id: 'acct-coach',
        status: 'full',
        created_at: 'now',
        updated_at: 'now',
      }],
      registrations: [
        registration('reg-mine', 'ath-mine', 'registered'),
        registration('reg-other-family', 'ath-other-family', 'registered'),
        // Neither of these holds a seat, so neither may be counted.
        registration('reg-waiting', 'ath-waiting', 'waitlisted'),
        registration('reg-cancelled', 'ath-cancelled', 'cancelled'),
      ],
      coaching_requests: [],
      attendance: [],
    });
  }

  function schedulerGet() {
    return GET(new NextRequest('http://localhost/api/pilot/scheduler'));
  }

  test("a parent sees every taken seat, not just their own child's", async () => {
    arrangeFullClass();
    mockGuardianAthleteIds.mockResolvedValue(['ath-mine']);
    mockRequirePrincipal.mockResolvedValue(principal('parent', { accountId: 'mine-guardian@example.com' }));

    const body = await (await schedulerGet()).json();

    expect(body.classes[0].registered_count).toBe(2);
    expect(body.classes[0].capacity).toBe(2);
  });

  test('a parent with no child on the class still sees it as full', async () => {
    arrangeFullClass();
    mockGuardianAthleteIds.mockResolvedValue(['ath-somebody-else']);
    mockRequirePrincipal.mockResolvedValue(principal('parent', { accountId: 'new-guardian@example.com' }));

    const body = await (await schedulerGet()).json();

    // The exact case from the defect: this used to read 0/2.
    expect(body.classes[0].registered_count).toBe(2);
    expect(body.registrations).toEqual([]);
  });

  test('the count widens nothing else: a parent still receives only their own registration row', async () => {
    arrangeFullClass();
    mockGuardianAthleteIds.mockResolvedValue(['ath-mine']);
    mockRequirePrincipal.mockResolvedValue(principal('parent', { accountId: 'mine-guardian@example.com' }));

    const body = await (await schedulerGet()).json();

    expect(body.registrations.map((row: { registration_id: string }) => row.registration_id)).toEqual(['reg-mine']);
    // No trace of the other families anywhere in the body -- not their
    // athlete ids, not their registration ids, not their guardians.
    const serialized = JSON.stringify(body);
    for (const other of ['ath-other-family', 'reg-other-family', 'ath-waiting', 'ath-cancelled', 'other-family-guardian']) {
      expect(serialized).not.toContain(other);
    }
  });

  test('an athlete sees the true count too', async () => {
    arrangeFullClass();
    mockRequirePrincipal.mockResolvedValue(principal('athlete', { accountId: 'athlete@example.com', athleteId: 'ath-mine' }));

    const body = await (await schedulerGet()).json();

    expect(body.classes[0].registered_count).toBe(2);
    expect(body.registrations).toHaveLength(1);
  });

  test('the coach running the class sees the true count and its whole register, without family account ids', async () => {
    // OD-2026-10-07-008 ruling 4 + Overwatch option B: the register is the
    // class's, so every row on it comes back; the family's account id on an
    // athlete this coach does not otherwise reach does not.
    arrangeFullClass();
    mockAthleteIdsForCoach.mockResolvedValue(['ath-mine']);
    mockRequirePrincipal.mockResolvedValue(principal('coach', { accountId: 'acct-coach' }));

    const body = await (await schedulerGet()).json();

    expect(body.classes[0].registered_count).toBe(2);
    const rows = body.registrations as Array<{ athlete_id: string; requested_by_account_id: string }>;
    expect(rows.map((row) => row.athlete_id)).toContain('ath-other-family');
    const other = rows.find((row) => row.athlete_id === 'ath-other-family');
    expect(other?.requested_by_account_id).toBe('');
    expect(JSON.stringify(body.registrations)).not.toContain('ath-other-family-guardian');
  });
});

/**
 * parent_review_registration MUST NOT BE AN ID ORACLE.
 *
 * It answered 400 "Missing registration record" for an id that does not exist
 * and 403 "Forbidden: parent not linked to athlete" for another family's --
 * so a guardian could tell a real registration id from a made-up one. Both now
 * answer the same 404.
 */
describe("POST parent_review_registration answers a missing id and another family's id the same way", () => {
  const mockGetRegistration = getSchedulerRegistrationById as jest.Mock;
  const mockMarkReviewed = markSchedulerRegistrationReviewed as jest.Mock;

  const otherFamilyRegistration = {
    registration_id: 'reg-other-family',
    class_id: 'class-1',
    athlete_id: 'ath-other-family',
    requested_by_role: 'athlete',
    requested_by_account_id: 'other@example.com',
    parent_reviewed: false,
    status: 'registered',
    created_at: 'now',
    updated_at: 'now',
  };

  function reviewRequest(registrationId: string) {
    return jsonRequest({ action: 'parent_review_registration', registration_id: registrationId });
  }

  beforeEach(() => {
    mockMarkReviewed.mockResolvedValue(undefined);
  });

  test('a missing id answers 404 Not found', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent'));
    mockGetRegistration.mockResolvedValue(null);

    const res = await POST(reviewRequest('reg-does-not-exist'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockMarkReviewed).not.toHaveBeenCalled();
  });

  test("another family's id answers the same 404, and nothing is written", async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent'));
    mockGetRegistration.mockResolvedValue(otherFamilyRegistration);
    mockAssertCanAct.mockRejectedValue(new Error('Forbidden: parent not linked to athlete'));

    const res = await POST(reviewRequest('reg-other-family'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockMarkReviewed).not.toHaveBeenCalled();
  });

  test('the two answers are byte-identical', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent'));

    mockGetRegistration.mockResolvedValueOnce(null);
    const missing = await POST(reviewRequest('reg-does-not-exist'));

    mockGetRegistration.mockResolvedValueOnce(otherFamilyRegistration);
    mockAssertCanAct.mockRejectedValueOnce(new Error('Forbidden: parent not linked to athlete'));
    const foreign = await POST(reviewRequest('reg-other-family'));

    expect(foreign.status).toBe(missing.status);
    expect(await foreign.text()).toBe(await missing.text());
  });

  test("a guardian reviewing their own child's registration still succeeds", async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent', { accountId: 'mine-guardian@example.com' }));
    mockGetRegistration.mockResolvedValue({ ...otherFamilyRegistration, registration_id: 'reg-mine', athlete_id: 'ath-mine' });

    const res = await POST(reviewRequest('reg-mine'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, registration_id: 'reg-mine' });
    expect(mockAssertCanAct).toHaveBeenCalledWith(expect.objectContaining({ role: 'parent' }), 'ath-mine');
    expect(mockMarkReviewed).toHaveBeenCalledWith('org-1', 'reg-mine', 'mine-guardian@example.com', expect.any(String));
  });

  test('a database fault in the access check stays a fault, not a "not found"', async () => {
    // Only the access REFUSAL is folded into the 404. Telling a guardian a
    // record does not exist because the database fell over would be false.
    mockRequirePrincipal.mockResolvedValue(principal('parent'));
    mockGetRegistration.mockResolvedValue(otherFamilyRegistration);
    mockAssertCanAct.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const res = await POST(reviewRequest('reg-other-family'));

    expect(res.status).toBe(500);
    expect(mockMarkReviewed).not.toHaveBeenCalled();
  });

  test('a coach is still refused before any lookup', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const res = await POST(reviewRequest('reg-other-family'));

    expect(res.status).toBe(403);
    expect(mockGetRegistration).not.toHaveBeenCalled();
    expect(mockMarkReviewed).not.toHaveBeenCalled();
  });
});

/**
 * TIME-01 (audit 2026-10-07). The schedule screen posts a datetime-local value
 * with no zone ('2026-07-15T18:00'). The route read it with `new Date(value)`,
 * which uses the SERVER's zone: on a UTC server 6:00 pm was stored as 18:00Z
 * and the gym then showed 2:00 pm. A zone-less time means the gym's clock.
 *
 * These expectations do not depend on the host zone, but the OLD code only
 * fails them when the host is not America/New_York (there it was accidentally
 * right, which is how the bug hid on a developer's machine). CI runs in UTC.
 * Jest gives a test its own copy of process.env, so a test cannot switch the
 * zone itself; to prove the fix on a New York machine run the file with
 * TZ=UTC and TZ=Asia/Tokyo set before jest starts.
 */
describe('POST /api/pilot/scheduler reads a zone-less time as the gym clock', () => {
  const mockCreateClass = createSchedulerClass as jest.Mock;
  const mockCreateCoaching = createSchedulerCoachingRequest as jest.Mock;

  function createClassRequest(startAt: string, endAt: string) {
    return jsonRequest({
      action: 'create_class',
      title: 'Evening boxing',
      start_at: startAt,
      end_at: endAt,
      location: 'Main Floor',
      capacity: 20,
    });
  }

  async function storedClass(startAt: string, endAt: string) {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    const res = await POST(createClassRequest(startAt, endAt));
    expect(res.status).toBe(200);
    return mockCreateClass.mock.calls[0][1] as { start_at: string; end_at: string };
  }

  test('6:00 pm typed in summer is stored as 6:00 pm gym time and reads back as 6:00 pm', async () => {
    const row = await storedClass('2026-07-15T18:00', '2026-07-15T19:30');
    expect(row.start_at).toBe('2026-07-15T22:00:00.000Z');
    expect(row.end_at).toBe('2026-07-15T23:30:00.000Z');
    expect(formatGymTimeOfDay(row.start_at)).toBe('6:00 PM');
    expect(formatGymStamp(row.start_at)).toBe('July 15, 2026 at 6:00 PM');
  });

  test('6:00 pm typed in winter is stored as 6:00 pm gym time and reads back as 6:00 pm', async () => {
    const row = await storedClass('2026-01-15T18:00', '2026-01-15T19:30');
    expect(row.start_at).toBe('2026-01-15T23:00:00.000Z');
    expect(formatGymTimeOfDay(row.start_at)).toBe('6:00 PM');
  });

  test('a value that carries an offset or Z is stored exactly as sent', async () => {
    const row = await storedClass('2026-07-15T18:00:00-04:00', '2026-07-15T23:30:00Z');
    expect(row.start_at).toBe('2026-07-15T22:00:00.000Z');
    expect(row.end_at).toBe('2026-07-15T23:30:00.000Z');
  });

  test('a preferred coaching time is read the same way', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    const res = await POST(jsonRequest({
      action: 'request_coaching',
      athlete_id: 'ath-1',
      preferred_at: '2026-07-15T18:00',
      goals: 'Work the jab',
    }));
    expect(res.status).toBe(200);
    expect(mockCreateCoaching.mock.calls[0][1]).toMatchObject({ preferred_at: '2026-07-15T22:00:00.000Z' });
  });

  test('an impossible date is refused rather than rolled into the next month', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    const res = await POST(createClassRequest('2026-02-30T18:00', '2026-02-28T19:00'));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockCreateClass).not.toHaveBeenCalled();
  });
});
