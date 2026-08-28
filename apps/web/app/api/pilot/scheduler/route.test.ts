import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  assertActiveCoachAccount,
  assertActorCanAccessAthlete,
  assertCoachAssignedToAthlete,
  athleteIdsForCoach,
} from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  bulkUpsertSchedulerAttendance,
  getSchedulerClassById,
  getSchedulerCoachingRequestById,
  listRegisteredAthleteIdsForClass,
  listSchedulerStore,
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
  assertActiveCoachAccount: jest.fn(),
  assertActorCanAccessAthlete: jest.fn(),
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
  registerForClassTransactionally: jest.fn(),
  getSchedulerClassById: jest.fn(),
  getSchedulerCoachingRequestById: jest.fn(),
  resolveSchedulerCoachingRequest: jest.fn(),
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
    expect(mockAssertCanAct).toHaveBeenCalledTimes(2);
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

  test("one athlete outside the coach's reach fails the whole batch before any write", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockAssertCanAct
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-OUTSIDE', status: 'present' },
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
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('does not own this class') });
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
  test('single check-in for an unregistered athlete is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
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

  test('a bulk batch containing one unregistered athlete fails whole before any write', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-1']);

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

    expect(response.status).toBe(400);
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
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

  test('covering a class does not disclose registrations for unreachable athletes', async () => {
    mockRequirePrincipal.mockResolvedValue(coachPrincipal());
    mockAthleteIdsForCoach.mockResolvedValue(['ath-mine']);
    mockListStore.mockResolvedValue(storeWithCoveredClass());

    const body = await (await GET(new NextRequest('http://localhost/api/pilot/scheduler'))).json();

    const athleteIds = body.registrations.map((row: { athlete_id: string }) => row.athlete_id);
    expect(athleteIds).toEqual(['ath-mine']);
    expect(athleteIds).not.toContain('ath-other');
  });

  test('covering a class does not disclose attendance notes for unreachable athletes', async () => {
    mockRequirePrincipal.mockResolvedValue(coachPrincipal());
    mockAthleteIdsForCoach.mockResolvedValue(['ath-mine']);
    mockListStore.mockResolvedValue(storeWithCoveredClass());

    const body = await (await GET(new NextRequest('http://localhost/api/pilot/scheduler'))).json();

    const athleteIds = body.attendance.map((row: { athlete_id: string }) => row.athlete_id);
    expect(athleteIds).toEqual(['ath-mine']);
    // The note is the part that matters: free text a coach wrote about a child.
    expect(JSON.stringify(body.attendance)).not.toContain('private other');
  });

  test('a reachable athlete on an owned class is still returned', async () => {
    // Guards against "fixing" this by filtering everything out.
    mockRequirePrincipal.mockResolvedValue(coachPrincipal());
    mockAthleteIdsForCoach.mockResolvedValue(['ath-mine']);
    mockListStore.mockResolvedValue(storeWithCoveredClass());

    const body = await (await GET(new NextRequest('http://localhost/api/pilot/scheduler'))).json();

    expect(body.registrations).toHaveLength(1);
    expect(body.attendance).toHaveLength(1);
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
      }, {
        // Another family's child in the same class. The row itself must never
        // reach this reader -- and the SEAT IT OCCUPIES must, or the count
        // beside the capacity is a lie. Both are asserted below.
        registration_id: 'reg-2',
        class_id: 'class-1',
        athlete_id: 'ath-someone-else',
        requested_by_role: 'parent',
        requested_by_account_id: 'other-parent@example.com',
        parent_reviewed: true,
        parent_reviewed_at: 'now',
        parent_reviewer_account_id: 'other-parent@example.com',
        status: 'registered',
        created_at: 'now',
        updated_at: 'now',
      }, {
        // Cancelled, so it holds no seat. Guards the status filter in
        // classRegistrationCount surviving the change of argument.
        registration_id: 'reg-3',
        class_id: 'class-1',
        athlete_id: 'ath-cancelled',
        requested_by_role: 'parent',
        requested_by_account_id: 'third-parent@example.com',
        parent_reviewed: false,
        status: 'cancelled',
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

  /*
   * app/schedule/page.tsx renders `Seats: {registered_count}/{capacity}` and a
   * family reads it to decide whether there is room. decorateClasses used to
   * count the FILTERED registrations, so that number was the seats taken by
   * the reader's own household -- 0 or 1 for nearly every family, on a class
   * that might be full. A wrong number, not a narrower one, and it sends a
   * parent into a registration the server then refuses.
   */
  test.each(FAMILY)('%s sees the seats taken in the CLASS, not the seats taken by their own child', async (_label, actor) => {
    arrangeStore();
    mockRequirePrincipal.mockResolvedValue(actor);

    const body = await (await schedulerGet()).json();

    // Two registered rows in this class, one of them another family's; the
    // third is cancelled and holds no seat.
    expect(body.classes[0].registered_count).toBe(2);
  });

  test.each(FAMILY)('%s still receives only their own registration row', async (_label, actor) => {
    // The control that keeps the fix above from being a disclosure: the SEAT
    // is counted, the ROW is not returned, and the other family's athlete id
    // and their parent's email appear nowhere in the body.
    arrangeStore();
    mockRequirePrincipal.mockResolvedValue(actor);

    const body = await (await schedulerGet()).json();

    expect(body.registrations).toHaveLength(1);
    expect(body.registrations[0].registration_id).toBe('reg-1');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('ath-someone-else');
    expect(serialized).not.toContain('other-parent@example.com');
    expect(serialized).not.toContain('reg-2');
  });

  test('a coach sees the same seat count, not the seats in their own scope', async () => {
    // The coach branch filters registrations too (owned class AND reachable
    // athlete), so it had the same wrong number. One count, one meaning.
    arrangeStore();
    mockRequirePrincipal.mockResolvedValue(principal('coach', { accountId: STAFF_EMAIL }));

    const body = await (await schedulerGet()).json();

    expect(body.classes[0].registered_count).toBe(2);
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
