import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  assertActiveCoachAccount,
  assertActorCanAccessAthlete,
  assertCoachAssignedToAthlete,
  athleteIdsForCoach,
} from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
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
