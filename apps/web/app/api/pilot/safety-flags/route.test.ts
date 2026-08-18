import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { accessibleAthleteIds, assertCoachAssignedToAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getSafetyFlagById,
  listOpenSafetyFlags,
  raiseSafetyFlag,
  resolveSafetyFlag,
} from '@/src/server/pilot/safetyFlags';

/*
  Route-level assertions for the safety-flag queue: the athlete-scope gate,
  and the validation status codes.

  ATHLETE SCOPE (2026-08-18 safety audit, CRITICAL). Role membership was the
  only check on this route, so any coach could read the whole gym's open queue
  -- flag codes include medical_clearance_missing and concussion_rest_period,
  each naming one child -- raise a flag against any child, and bypass an open
  flag on a child they have no standing on. These tests pin all three shut,
  and pin that organization_admin/admin are NOT narrowed by the fix.

  VALIDATION STATUS CODES. The four tests at the bottom predate the scope work
  and exist because the service-layer tests could not have caught the defect
  they cover. safetyFlags.pg.test.ts asserted `.rejects.toThrow('CODE')` -- a
  substring match BELOW jsonError, which passes no matter what status the
  message would eventually map to. Every one of those validations was in fact
  returning 500 "Internal server error" to the caller, with the reason
  discarded, and the suite stayed green.

  raiseSafetyFlag is mocked, but its default implementation IS the real one
  (see beforeEach), so the validation tests still exercise the whole chain --
  route -> service -> typed error -> jsonError -> NextResponse -- with no
  database: its subject-required check fires before any query. Only the tests
  that need a successful write override it. Mocking the service outright would
  have tested the mock.
*/

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  accessibleAthleteIds: jest.fn(),
  assertCoachAssignedToAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/safetyFlags', () => ({
  ...jest.requireActual('@/src/server/pilot/safetyFlags'),
  getSafetyFlagById: jest.fn(),
  listOpenSafetyFlags: jest.fn(),
  raiseSafetyFlag: jest.fn(),
  resolveSafetyFlag: jest.fn(),
}));

const actualSafetyFlags = jest.requireActual('@/src/server/pilot/safetyFlags');

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockCoachAssigned = assertCoachAssignedToAthlete as jest.Mock;
const mockAccessibleAthleteIds = accessibleAthleteIds as jest.Mock;
const mockGetFlagById = getSafetyFlagById as jest.Mock;
const mockListOpenFlags = listOpenSafetyFlags as jest.Mock;
const mockRaise = raiseSafetyFlag as jest.Mock;
const mockResolve = resolveSafetyFlag as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

function principal(role = 'coach', overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'coach-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
    mustChangePin: false,
    ...overrides,
  };
}

function flagRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    flag_id: 'flag-1',
    athlete_id: 'ATH-MINE',
    person_account_id: null,
    flag_class: 'external_rule',
    flag_code: 'concussion_rest_period',
    severity: 'blocking_display',
    triggered_by: 'human_entry',
    trigger_detail: 'Head contact in sparring on the 14th.',
    evidence_basis: 'Coach observation.',
    confidence_note: '',
    source_activity_id: null,
    source_reference: null,
    status: 'open',
    resolution: null,
    resolved_by_account_id: null,
    resolved_by_role: null,
    resolved_at: null,
    coach_note: null,
    created_at: '2026-08-18T12:00:00Z',
    updated_at: '2026-08-18T12:00:00Z',
    ...overrides,
  };
}

function get(params = '') {
  return GET(new NextRequest(`http://localhost/api/pilot/safety-flags${params}`));
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/safety-flags', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

function patch(body: Record<string, unknown>) {
  return PATCH(new NextRequest('http://localhost/api/pilot/safety-flags', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal() as never);
  // The real validation chain by default -- see the header note.
  mockRaise.mockImplementation(actualSafetyFlags.raiseSafetyFlag);
  mockListOpenFlags.mockResolvedValue([]);
  mockAccessibleAthleteIds.mockResolvedValue(new Set());
  mockAudit.mockResolvedValue(undefined);
});

describe('GET /api/pilot/safety-flags athlete scope', () => {
  test('a coach naming their own athlete passes the assignment gate and reads that queue', async () => {
    const mine = flagRow();
    mockListOpenFlags.mockResolvedValueOnce([mine]);
    mockAccessibleAthleteIds.mockResolvedValueOnce(new Set(['ATH-MINE']));

    const res = await get('?athlete_id=ATH-MINE');

    expect(res.status).toBe(200);
    expect(mockCoachAssigned).toHaveBeenCalledWith('coach-1', 'ATH-MINE', 'org-1');
    expect(mockListOpenFlags).toHaveBeenCalledWith('org-1', expect.objectContaining({ athleteId: 'ATH-MINE' }));
    expect((await res.json()).flags).toEqual([mine]);
  });

  test('a coach naming an athlete they do not stand on is refused, and the queue is never read', async () => {
    mockCoachAssigned.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

    const res = await get('?athlete_id=ATH-OTHER');

    expect(res.status).toBe(403);
    expect(mockListOpenFlags).not.toHaveBeenCalled();
  });

  test('the coach board is filtered per row: another coach\'s athletes never appear', async () => {
    // THE finding. This read previously returned every open flag in the gym.
    const mine = flagRow({ flag_id: 'flag-mine', athlete_id: 'ATH-MINE' });
    const covered = flagRow({ flag_id: 'flag-covered', athlete_id: 'ATH-COVERED' });
    const notMine = flagRow({
      flag_id: 'flag-not-mine',
      athlete_id: 'ATH-OTHER',
      flag_code: 'medical_clearance_missing',
    });
    const aboutMe = flagRow({
      flag_id: 'flag-about-me',
      athlete_id: null,
      person_account_id: 'coach-1',
      flag_class: 'system_guidance',
      flag_code: 'certification_lapsed',
    });
    const aboutAnotherAdult = flagRow({
      flag_id: 'flag-about-someone-else',
      athlete_id: null,
      person_account_id: 'coach-2',
      flag_class: 'system_guidance',
      flag_code: 'certification_lapsed',
    });
    mockListOpenFlags.mockResolvedValueOnce([mine, covered, notMine, aboutMe, aboutAnotherAdult]);
    // The coach of record for one, an active coverage grant on the other --
    // accessibleAthleteIds is the batched form of the same gate and admits both.
    mockAccessibleAthleteIds.mockResolvedValueOnce(new Set(['ATH-MINE', 'ATH-COVERED']));

    const res = await get();
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.flags.map((flag: { flag_id: string }) => flag.flag_id))
      .toEqual(['flag-mine', 'flag-covered', 'flag-about-me']);
    // Not just absent from the ids -- absent from the body. The flag code and
    // the athlete id are each a disclosure about a child on their own.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('ATH-OTHER');
    expect(serialized).not.toContain('medical_clearance_missing');
    expect(mockAccessibleAthleteIds).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'coach-1', role: 'coach', organizationId: 'org-1' }),
      ['ATH-MINE', 'ATH-COVERED', 'ATH-OTHER'],
    );
  });

  test('a coach whose athletes have no open flags gets an empty queue, not a refusal', async () => {
    mockListOpenFlags.mockResolvedValueOnce([flagRow({ athlete_id: 'ATH-OTHER' })]);
    mockAccessibleAthleteIds.mockResolvedValueOnce(new Set());

    const res = await get();

    expect(res.status).toBe(200);
    expect((await res.json()).flags).toEqual([]);
  });

  test('organization_admin and admin still read the whole organization, unfiltered', async () => {
    for (const role of ['organization_admin', 'admin']) {
      jest.clearAllMocks();
      const wholeGym = [
        flagRow({ flag_id: 'flag-a', athlete_id: 'ATH-MINE' }),
        flagRow({ flag_id: 'flag-b', athlete_id: 'ATH-OTHER' }),
        flagRow({ flag_id: 'flag-c', athlete_id: null, person_account_id: 'coach-2' }),
      ];
      mockRequirePrincipal.mockResolvedValueOnce(principal(role, { accountId: 'admin-1' }) as never);
      mockListOpenFlags.mockResolvedValueOnce(wholeGym);

      const res = await get('?severity=blocking_display');

      expect(res.status).toBe(200);
      expect((await res.json()).flags).toEqual(wholeGym);
      // No per-athlete narrowing for an admin, on either path.
      expect(mockAccessibleAthleteIds).not.toHaveBeenCalled();
      expect(mockCoachAssigned).not.toHaveBeenCalled();
    }
  });

  test('an admin may still name one athlete without an assignment gate', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'admin-1' }) as never);
    mockListOpenFlags.mockResolvedValueOnce([flagRow({ athlete_id: 'ATH-OTHER' })]);

    const res = await get('?athlete_id=ATH-OTHER');

    expect(res.status).toBe(200);
    expect(mockCoachAssigned).not.toHaveBeenCalled();
    expect(mockListOpenFlags).toHaveBeenCalledWith('org-1', expect.objectContaining({ athleteId: 'ATH-OTHER' }));
  });

  test('a role outside the queue is still refused before anything is read', async () => {
    for (const role of ['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role) as never);
      expect((await get()).status).toBe(403);
    }
    expect(mockListOpenFlags).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/safety-flags athlete scope', () => {
  const body = {
    athlete_id: 'ATH-MINE',
    flag_class: 'external_rule',
    flag_code: 'concussion_rest_period',
    severity: 'blocking_display',
    trigger_detail: 'Head contact in sparring.',
  };

  test('a coach raises against their own athlete through the assignment gate', async () => {
    mockRaise.mockResolvedValueOnce(flagRow());

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(mockCoachAssigned).toHaveBeenCalledWith('coach-1', 'ATH-MINE', 'org-1');
    expect(mockRaise).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      athleteId: 'ATH-MINE',
      triggeredBy: 'human_entry',
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'create',
      entity_type: 'safety_flag',
      entity_id: 'flag-1',
    }));
  });

  test('a coach cannot raise a flag against a child they do not stand on', async () => {
    // THE finding: a flag lands in a child's permanent safety record.
    mockCoachAssigned.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

    const res = await post({ ...body, athlete_id: 'ATH-OTHER' });

    expect(res.status).toBe(403);
    expect(mockRaise).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a coach cannot route around the gate through person_account_id', async () => {
    // An athlete has an account too, so a person-subject flag from a coach
    // would file against any child in the gym with the athlete gate never run.
    const res = await post({
      person_account_id: 'acct-some-child',
      flag_class: 'external_rule',
      flag_code: 'medical_clearance_missing',
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing athlete_id');
    expect(mockCoachAssigned).not.toHaveBeenCalled();
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a coach cannot smuggle a second, unscoped subject alongside their own athlete', async () => {
    const res = await post({ ...body, person_account_id: 'acct-someone-else' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Unsupported person_account_id');
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('vocabulary is still validated before the authority check', async () => {
    const res = await post({ athlete_id: 'ATH-MINE', flag_code: 'load_spike' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing flag_class');
    expect(mockCoachAssigned).not.toHaveBeenCalled();
  });

  test('an admin raises against any athlete in the organization, ungated', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'admin-1' }) as never);
    mockRaise.mockResolvedValueOnce(flagRow({ athlete_id: 'ATH-OTHER' }));

    const res = await post({ ...body, athlete_id: 'ATH-OTHER' });

    expect(res.status).toBe(201);
    expect(mockCoachAssigned).not.toHaveBeenCalled();
    expect(mockRaise).toHaveBeenCalledWith(expect.objectContaining({ athleteId: 'ATH-OTHER' }));
  });

  test('an admin may still raise a person-subject flag', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin', { accountId: 'admin-1' }) as never);
    mockRaise.mockResolvedValueOnce(flagRow({ athlete_id: null, person_account_id: 'coach-2' }));

    const res = await post({
      person_account_id: 'coach-2',
      flag_class: 'system_guidance',
      flag_code: 'certification_lapsed',
    });

    expect(res.status).toBe(201);
    expect(mockRaise).toHaveBeenCalledWith(expect.objectContaining({
      athleteId: undefined,
      personAccountId: 'coach-2',
    }));
  });
});

describe('PATCH /api/pilot/safety-flags athlete scope', () => {
  const body = {
    flag_id: 'flag-1',
    status: 'bypassed',
    resolution: 'false_positive',
    coach_note: 'Cleared by the physician this morning; rest period served.',
  };

  test('a coach resolves a flag on their own athlete', async () => {
    mockGetFlagById.mockResolvedValueOnce(flagRow());
    mockResolve.mockResolvedValueOnce(flagRow({ status: 'bypassed', resolution: 'false_positive' }));

    const res = await patch(body);

    expect(res.status).toBe(200);
    expect(mockGetFlagById).toHaveBeenCalledWith('org-1', 'flag-1');
    expect(mockCoachAssigned).toHaveBeenCalledWith('coach-1', 'ATH-MINE', 'org-1');
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({
      flagId: 'flag-1',
      status: 'bypassed',
      resolvedByAccountId: 'coach-1',
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'update' }));
  });

  test("a coach bypassing a flag on another coach's athlete is refused, indistinguishably from a bogus id", async () => {
    // THE finding at its worst: status='bypassed' stands a blocking flag down
    // and lets a child train through it.
    mockGetFlagById.mockResolvedValueOnce(flagRow({ athlete_id: 'ATH-OTHER' }));
    mockCoachAssigned.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));
    const notMine = await patch(body);
    const notMinePayload = await notMine.json();

    mockGetFlagById.mockResolvedValueOnce(null);
    const bogus = await patch({ ...body, flag_id: 'flag-ghost' });
    const bogusPayload = await bogus.json();

    expect(notMine.status).toBe(404);
    expect(notMine.status).toBe(bogus.status);
    expect(notMinePayload).toEqual(bogusPayload);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a coach cannot stand down a person-subject flag, including one about themselves', async () => {
    mockGetFlagById.mockResolvedValueOnce(flagRow({ athlete_id: null, person_account_id: 'coach-1' }));

    const res = await patch(body);

    expect(res.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('an admin resolves any flag in the organization, ungated', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'admin-1' }) as never);
    mockResolve.mockResolvedValueOnce(flagRow({ athlete_id: 'ATH-OTHER', status: 'upheld' }));

    const res = await patch({ ...body, status: 'upheld', resolution: 'acted_on' });

    expect(res.status).toBe(200);
    expect(mockGetFlagById).not.toHaveBeenCalled();
    expect(mockCoachAssigned).not.toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({
      status: 'upheld',
      resolvedByRole: 'organization_admin',
    }));
  });

  test('the mandatory note is still enforced before any authority check', async () => {
    const res = await patch({ ...body, coach_note: '   ' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing flag_id, status, resolution, or coach_note');
    expect(mockGetFlagById).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/safety-flags validation status codes', () => {
  test('a flag with neither subject returns 400 with the reason, not 500', async () => {
    // Raised as an admin: a coach no longer reaches this branch, because a
    // coach must name an athlete they are assigned to (see the scope tests
    // above). The regression this pins is jsonError's, not the role's.
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'admin-1' }) as never);

    const res = await post({ flag_class: 'system_guidance', flag_code: 'load_spike' });

    // The regression. This was 500 "Internal server error".
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('athlete_id or a person_account_id');
    expect(body.error).not.toBe('Internal server error');
    expect(body.code).toBe('SAFETY_FLAG_SUBJECT_REQUIRED');
  });

  test('a medical flag code raised by SHADOW is refused as 400, naming the code', async () => {
    // triggered_by is not client-supplied on this route -- it is forced to
    // 'human_entry' -- so this branch is unreachable through the API today.
    // Asserted anyway: the check exists to mirror a database constraint, and a
    // future route that does pass triggered_by must not discover that its
    // refusal reads as a server fault.
    await expect(
      actualSafetyFlags.raiseSafetyFlag({
        organizationId: 'org-1',
        athleteId: 'ATH-1',
        flagClass: 'external_rule',
        flagCode: 'concussion_rest_period',
        triggeredBy: 'shadow_inference',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'SAFETY_FLAG_MEDICAL_CODE_REQUIRES_HUMAN_ENTRY',
    });
  });

  test('a missing flag_class still returns 400 through the untouched prefix branch', async () => {
    // The string-prefix branches remain in jsonError for un-migrated throws.
    // This asserts the migration did not disturb them.
    const res = await post({ athlete_id: 'ATH-MINE', flag_code: 'load_spike' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing flag_class');
  });

  test('an unauthenticated caller is still refused before any validation', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));
    const res = await post({ flag_class: 'system_guidance', flag_code: 'load_spike' });
    expect(res.status).toBe(401);
  });
});
