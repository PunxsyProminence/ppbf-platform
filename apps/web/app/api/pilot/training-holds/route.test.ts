import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  assertAthleteBelongsToOrganization,
  assertCoachAssignedToAthlete,
} from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getActiveTrainingHold,
  getTrainingHoldById,
  liftTrainingHold,
  listTrainingHolds,
  placeTrainingHold,
} from '@/src/server/pilot/trainingHolds';

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertAthleteBelongsToOrganization: jest.fn(),
  assertCoachAssignedToAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/trainingHolds', () => ({
  ...jest.requireActual('@/src/server/pilot/trainingHolds'),
  getActiveTrainingHold: jest.fn(),
  getTrainingHoldById: jest.fn(),
  liftTrainingHold: jest.fn(),
  listTrainingHolds: jest.fn(),
  placeTrainingHold: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCoachAssigned = assertCoachAssignedToAthlete as jest.Mock;
const mockBelongs = assertAthleteBelongsToOrganization as jest.Mock;
const mockGuardianIds = guardianAthleteIds as jest.Mock;
const mockGetActive = getActiveTrainingHold as jest.Mock;
const mockGetById = getTrainingHoldById as jest.Mock;
const mockLift = liftTrainingHold as jest.Mock;
const mockList = listTrainingHolds as jest.Mock;
const mockPlace = placeTrainingHold as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const FULL_HOLD = {
  hold_id: 'hold-1',
  athlete_id: 'ATH-1',
  scope: 'all_training',
  reason_category: 'medical',
  reason_text: 'Concussion protocol pending clearance.',
  athlete_explanation: 'We are giving your head time to heal.',
  lift_condition_text: 'A doctor says you are ready.',
  placed_by_account_id: 'acct-coach-1',
  placed_by_role: 'coach',
  placed_at: '2026-08-06T12:00:00Z',
  expires_at: null,
  lifted_by_account_id: null,
  lifted_at: null,
  lift_note: '',
  status: 'active',
  created_at: '2026-08-06T12:00:00Z',
  updated_at: '2026-08-06T12:00:00Z',
};

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-caller',
    role,
    organizationId: 'org-a',
    athleteId: null,
    ...overrides,
  };
}

function getRequest(params = ''): NextRequest {
  return new NextRequest(`https://ppbf.example/api/pilot/training-holds${params}`);
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/training-holds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/training-holds', () => {
  test('an athlete gets only the athlete-safe projection of their own hold', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete', { athleteId: 'ATH-1' }));
    mockGetActive.mockResolvedValueOnce(FULL_HOLD);

    const response = await GET(getRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.hold).toEqual({
      scope: 'all_training',
      athlete_explanation: 'We are giving your head time to heal.',
      lift_condition_text: 'A doctor says you are ready.',
      placed_at: '2026-08-06T12:00:00Z',
      expires_at: null,
    });
    // The staff-facing fields never reach the athlete.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Concussion');
    expect(serialized).not.toContain('reason_category');
    expect(serialized).not.toContain('placed_by_account_id');
  });

  test('an athlete with no hold gets null, and an athlete account without an athlete row too', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete', { athleteId: 'ATH-1' }));
    mockGetActive.mockResolvedValueOnce(null);
    await expect((await GET(getRequest())).json()).resolves.toEqual({ ok: true, hold: null });

    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete', { athleteId: null }));
    await expect((await GET(getRequest())).json()).resolves.toEqual({ ok: true, hold: null });
    expect(mockGetActive).toHaveBeenCalledTimes(1);
  });

  test('a parent reads their linked child through the guardian gate, same projection', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockGuardianIds.mockResolvedValueOnce(['ATH-1', 'ATH-2']);
    mockGetActive.mockResolvedValueOnce(FULL_HOLD);

    const response = await GET(getRequest('?athlete_id=ATH-1'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockGuardianIds).toHaveBeenCalledWith('org-a', 'acct-caller');
    expect(JSON.stringify(payload)).not.toContain('Concussion');
  });

  test('a parent not linked to the athlete is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockGuardianIds.mockResolvedValueOnce(['ATH-OTHER']);

    const response = await GET(getRequest('?athlete_id=ATH-1'));

    expect(response.status).toBe(403);
    expect(mockGetActive).not.toHaveBeenCalled();
  });

  test('a coach must name an athlete and pass the assignment gate', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    const missingAthlete = await GET(getRequest());
    expect(missingAthlete.status).toBe(400);

    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockCoachAssigned.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));
    const notAssigned = await GET(getRequest('?athlete_id=ATH-OTHER'));
    expect(notAssigned.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an admin lists org-wide with full rows', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([FULL_HOLD]);

    const response = await GET(getRequest('?status=active'));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-a', { athleteId: undefined, status: 'active' });
  });

  test('board and platform_owner get nothing here -- a hold names one child', async () => {
    for (const role of ['board', 'platform_owner', 'volunteer', 'staff']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(getRequest());
      expect(response.status).toBe(403);
    }
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an invalid status filter is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    const response = await GET(getRequest('?status=nonsense'));
    expect(response.status).toBe(400);
  });
});

describe('POST place', () => {
  const placeBody = {
    action: 'place',
    athlete_id: 'ATH-1',
    scope: 'all_training',
    reason_category: 'medical',
    reason_text: 'Concussion protocol.',
    athlete_explanation: 'We are giving your head time to heal.',
    lift_condition_text: 'A doctor says you are ready.',
  };

  test('a coach places through the assignment gate and the audit event is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockPlace.mockResolvedValueOnce(FULL_HOLD);

    const response = await POST(postRequest(placeBody));

    expect(response.status).toBe(200);
    expect(mockCoachAssigned).toHaveBeenCalledWith('acct-caller', 'ATH-1', 'org-a');
    expect(mockPlace).toHaveBeenCalledWith(
      expect.objectContaining({ placedByRole: 'coach', athleteId: 'ATH-1', scope: 'all_training' }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'safety_hold_placed', entity_type: 'training_hold', entity_id: 'hold-1' }),
    );
  });

  test('an admin places through the org-membership gate instead', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockPlace.mockResolvedValueOnce(FULL_HOLD);

    await POST(postRequest(placeBody));

    expect(mockBelongs).toHaveBeenCalledWith('org-a', 'ATH-1');
    expect(mockCoachAssigned).not.toHaveBeenCalled();
    expect(mockPlace).toHaveBeenCalledWith(expect.objectContaining({ placedByRole: 'organization_admin' }));
  });

  test('the athlete explanation is required -- a hold a child cannot read a reason for is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(postRequest({ ...placeBody, athlete_explanation: '   ' }));

    expect(response.status).toBe(400);
    expect(mockPlace).not.toHaveBeenCalled();
  });

  test('vocabulary is validated before any authority check touches the database', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    const badScope = await POST(postRequest({ ...placeBody, scope: 'weekends_only' }));
    expect(badScope.status).toBe(400);

    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    const badCategory = await POST(postRequest({ ...placeBody, reason_category: 'vibes' }));
    expect(badCategory.status).toBe(400);

    expect(mockCoachAssigned).not.toHaveBeenCalled();
    expect(mockPlace).not.toHaveBeenCalled();
  });

  test('a past expires_at is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    const response = await POST(postRequest({ ...placeBody, expires_at: '2020-01-01T00:00:00Z' }));
    expect(response.status).toBe(400);
  });

  // Not "any positive delta": the DB CHECK compares against placed_at,
  // stamped by the database's own now() at insert time. A value that
  // clears an app-clock check by a few milliseconds could still lose the
  // race to a slow insert and hit the CHECK as a raw 500 instead of a
  // clean 400 here.
  test('an expires_at only seconds in the future is refused, not just a strictly-past one', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    const response = await POST(
      postRequest({ ...placeBody, expires_at: new Date(Date.now() + 5_000).toISOString() }),
    );
    expect(response.status).toBe(400);
    expect(mockPlace).not.toHaveBeenCalled();
  });

  test('an expires_at safely past the buffer is accepted', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockPlace.mockResolvedValueOnce(FULL_HOLD);
    const response = await POST(
      postRequest({ ...placeBody, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    expect(response.status).toBe(200);
  });

  test('athletes and parents cannot place holds', async () => {
    for (const role of ['athlete', 'parent', 'board']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await POST(postRequest(placeBody));
      expect(response.status).toBe(403);
    }
    expect(mockPlace).not.toHaveBeenCalled();
  });

  test('a live-hold conflict surfaces as 409', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockPlace.mockRejectedValueOnce(new Error('Hold already exists: hold-live is active for this athlete -- lift it first'));

    const response = await POST(postRequest(placeBody));

    expect(response.status).toBe(409);
  });

  // THE deploy-window fix: the audit-vocabulary migration is already
  // applied in real environments and this PR widens it in place, so an
  // operator must re-dispatch it after deploy. If code lands first, the
  // audit write hits the OLD constraint -- but the hold has already
  // committed (placeTrainingHold resolved), so a 500 here would tell a
  // coach their safety action failed when the child is in fact held.
  test('a failing audit write does not fail the request -- the hold already committed', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockPlace.mockResolvedValueOnce(FULL_HOLD);
      mockAudit.mockRejectedValueOnce(
        Object.assign(new Error('new row for relation "audit_events" violates check constraint'), { code: '23514' }),
      );

      const response = await POST(postRequest(placeBody));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toEqual({ ok: true, hold: FULL_HOLD });
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'training-hold-audit-write-failed', code: '23514' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST lift', () => {
  test('an admin lifts any hold; the audit event is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    mockGetById.mockResolvedValueOnce(FULL_HOLD);
    mockLift.mockResolvedValueOnce({ ...FULL_HOLD, status: 'lifted' });

    const response = await POST(postRequest({ action: 'lift', hold_id: 'hold-1', lift_note: 'Cleared.' }));

    expect(response.status).toBe(200);
    expect(mockLift).toHaveBeenCalledWith('org-a', 'hold-1', 'acct-caller', 'Cleared.');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'safety_hold_lifted' }));
  });

  test('a coach lifts through the assignment gate (owner decision: coaches lift too)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockGetById.mockResolvedValueOnce(FULL_HOLD);
    mockLift.mockResolvedValueOnce({ ...FULL_HOLD, status: 'lifted' });

    const response = await POST(postRequest({ action: 'lift', hold_id: 'hold-1' }));

    expect(response.status).toBe(200);
    expect(mockCoachAssigned).toHaveBeenCalledWith('acct-caller', 'ATH-1', 'org-a');
  });

  test("a coach probing another roster's hold id gets the same Missing as a bogus id", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockGetById.mockResolvedValueOnce(FULL_HOLD);
    mockCoachAssigned.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));
    const notMine = await POST(postRequest({ action: 'lift', hold_id: 'hold-1' }));
    const notMinePayload = await notMine.json();

    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockGetById.mockResolvedValueOnce(null);
    const bogus = await POST(postRequest({ action: 'lift', hold_id: 'hold-ghost' }));
    const bogusPayload = await bogus.json();

    expect(notMine.status).toBe(bogus.status);
    expect(notMinePayload).toEqual(bogusPayload);
    expect(mockLift).not.toHaveBeenCalled();
  });

  test('lifting an already-lifted hold surfaces the Unsupported transition as 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    mockGetById.mockResolvedValueOnce({ ...FULL_HOLD, status: 'lifted' });
    mockLift.mockRejectedValueOnce(new Error("Unsupported transition: hold is 'lifted' and cannot be lifted"));

    const response = await POST(postRequest({ action: 'lift', hold_id: 'hold-1' }));

    expect(response.status).toBe(400);
  });

  test('a failing audit write does not fail the lift -- the hold is already lifted', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
      mockGetById.mockResolvedValueOnce(FULL_HOLD);
      mockLift.mockResolvedValueOnce({ ...FULL_HOLD, status: 'lifted' });
      mockAudit.mockRejectedValueOnce(
        Object.assign(new Error('new row for relation "audit_events" violates check constraint'), { code: '23514' }),
      );

      const response = await POST(postRequest({ action: 'lift', hold_id: 'hold-1' }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.hold).toMatchObject({ status: 'lifted' });
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'training-hold-audit-write-failed', code: '23514' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST envelope', () => {
  test('malformed JSON and unknown actions are 400s', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    const malformed = await POST(
      new NextRequest('https://ppbf.example/api/pilot/training-holds', { method: 'POST', body: '{nope' }),
    );
    expect(malformed.status).toBe(400);

    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    const unknown = await POST(postRequest({ action: 'pause' }));
    expect(unknown.status).toBe(400);
  });
});
