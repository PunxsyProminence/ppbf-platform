import { NextRequest } from 'next/server';

import { POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ConflictError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import { readStaffHoldWarning } from '@/src/server/pilot/trainingHolds';
import { issueWorkoutTemplate } from '@/src/server/pilot/workoutTemplates';

// The route's contract: who may issue, to whom, and what each outcome of the
// writer becomes on the wire. The writer is faked -- its decisions are proven
// in workoutTemplateIssue.test.ts and its transaction against real PostgreSQL
// in workoutTemplateIssue.pg.test.ts. requireRole is the real one, so the
// role cases prove the gate that ships.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/workoutTemplates', () => ({
  issueWorkoutTemplate: jest.fn(),
}));

jest.mock('@/src/server/pilot/trainingHolds', () => ({
  readStaffHoldWarning: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockReach = assertActorCanAccessAthlete as jest.Mock;
const mockIssue = issueWorkoutTemplate as jest.Mock;
const mockHold = readStaffHoldWarning as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/pilot/workout-templates/issue', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const BODY = { template_id: 'wtp_1', athlete_id: 'athlete-1' };

const ISSUED = {
  outcome: 'issued',
  issue_id: '0b0e3f0c-6a53-4d0e-9d0b-3a8f5a1c2d4e',
  template: { template_id: 'wtp_1', name: 'Technical Tuesday', version: 2 },
  steps: [
    { step: 1, item_id: 'wti_1', assignment: { assignment_id: 'assignment_1', drill_id: 'op-1', gap_id: null } },
    { step: 2, item_id: 'wti_2', assignment: { assignment_id: 'assignment_2', drill_id: 'op-2', gap_id: null } },
  ],
  adopted: [{ drill_id: 'op-2', reference_drill_id: 'ref-2', name: 'Slip Rope Shuffle' }],
};

const REFUSED = {
  outcome: 'refused',
  message: 'Nothing was issued. Not floor-tested by a coach of this gym yet: Slip Rope Shuffle.',
  drills: [{
    steps: [2],
    drill_id: 'ref-2',
    name: 'Slip Rope Shuffle',
    untested_draft: true,
    reason: 'It is a draft that requires floor validation, and no coach of this gym has marked it floor-tested.',
  }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockReach.mockResolvedValue(undefined);
  mockIssue.mockResolvedValue(ISSUED);
  mockHold.mockResolvedValue(null);
});

describe('who may issue a template', () => {
  test.each(['coach', 'organization_admin', 'admin'] as const)('%s is admitted', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));

    const res = await POST(post(BODY));

    expect(res.status).toBe(201);
    expect(mockIssue).toHaveBeenCalledTimes(1);
  });

  test.each(['athlete', 'parent', 'platform_owner', 'board', 'volunteer', 'staff'] as const)(
    '%s is refused before anything is read or written',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      const res = await POST(post(BODY));

      expect(res.status).toBe(403);
      expect(mockReach).not.toHaveBeenCalled();
      expect(mockIssue).not.toHaveBeenCalled();
      expect(mockHold).not.toHaveBeenCalled();
    },
  );

  test('the role gate answers before the body is looked at', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete' }));

    // A malformed body from a role that may not issue is still a 403, not a 400.
    const res = await POST(post('{not json'));

    expect(res.status).toBe(403);
  });
});

describe('the request', () => {
  test.each([
    ['no template_id', { athlete_id: 'athlete-1' }],
    ['a blank template_id', { template_id: '  ', athlete_id: 'athlete-1' }],
    ['a numeric template_id', { template_id: 7, athlete_id: 'athlete-1' }],
    ['no athlete_id', { template_id: 'wtp_1' }],
    ['a malformed body', '{not json'],
    ['a JSON null body', 'null'],
    ['a JSON string body', '"wtp_1"'],
  ] as Array<[string, unknown]>)('%s is a 400 and nothing is written', async (_label, body) => {
    const res = await POST(post(body));

    expect(res.status).toBe(400);
    expect(mockReach).not.toHaveBeenCalled();
    expect(mockIssue).not.toHaveBeenCalled();
  });

  test('the organization is the session gym, never the body', async () => {
    await POST(post({ ...BODY, organization_id: 'org-other' }));

    expect(mockIssue).toHaveBeenCalledWith({
      organizationId: 'org-1',
      templateId: 'wtp_1',
      athleteId: 'athlete-1',
      actorAccountId: 'coach-1',
      actorRole: 'coach',
      requestKey: null,
    });
  });
});

describe('reach: a coach who cannot reach the athlete is refused', () => {
  test('the athlete gate is asked with the session principal and the named athlete', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);

    await POST(post(BODY));

    expect(mockReach).toHaveBeenCalledWith(actor, 'athlete-1');
    // Reach is decided before the writer runs.
    expect(mockReach.mock.invocationCallOrder[0]).toBeLessThan(mockIssue.mock.invocationCallOrder[0]);
  });

  test('an athlete the coach cannot reach answers the hidden 404, and nothing is read or written', async () => {
    mockReach.mockRejectedValue(new Error('Forbidden: coach is not assigned to athlete'));

    const res = await POST(post(BODY));

    expect(res.status).toBe(404);
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockHold).not.toHaveBeenCalled();
  });

  test('an athlete that does not exist reads exactly the same', async () => {
    mockReach.mockRejectedValue(new Error('Athlete not found'));
    const missing = await POST(post(BODY));
    mockReach.mockRejectedValue(new Error('Forbidden: coach is not assigned to athlete'));
    const unreachable = await POST(post(BODY));

    expect(missing.status).toBe(unreachable.status);
    expect(await missing.json()).toEqual(await unreachable.json());
  });
});

describe('the outcomes', () => {
  test("a template id that names nothing in this gym is the hidden 404", async () => {
    mockIssue.mockResolvedValue({ outcome: 'not_found' });

    const res = await POST(post(BODY));

    expect(res.status).toBe(404);
    expect(mockHold).not.toHaveBeenCalled();
  });

  test('a refusal is a 409 that names every drill, and no hold is read for a write that did not happen', async () => {
    mockIssue.mockResolvedValue(REFUSED);

    const res = await POST(post(BODY));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: REFUSED.message,
      code: 'WORKOUT_TEMPLATE_ISSUE_REFUSED',
      drills: REFUSED.drills,
    });
    expect(mockHold).not.toHaveBeenCalled();
  });

  test('a conflict the writer throws keeps its status and code', async () => {
    mockIssue.mockRejectedValue(
      new ConflictError('This workout template has no steps to issue.', 'WORKOUT_TEMPLATE_EMPTY'),
    );

    const res = await POST(post(BODY));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'WORKOUT_TEMPLATE_EMPTY' });
  });

  test('an issue is a 201 that names the issued workout and says what was created', async () => {
    const res = await POST(post(BODY));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      organization_id: 'org-1',
      athlete_id: 'athlete-1',
      issue_id: ISSUED.issue_id,
      template: ISSUED.template,
      created: { assignments: 2, adopted_drills: 1 },
      steps: ISSUED.steps,
      adopted_drills: ISSUED.adopted,
    });
  });
});

describe('an athlete with an active training hold (OD-2026-10-06-024 ruling 1: warn only)', () => {
  const WARNING = {
    hold_id: 'hold-1',
    scope: 'all_training',
    reason_category: 'medical',
    athlete_explanation: 'Resting this week.',
    lift_condition_text: 'Cleared by the coach.',
    expires_at: null,
  };

  test('the issue still happens, and the answer carries the same hold_warning the assignments route gives', async () => {
    mockHold.mockResolvedValue(WARNING);

    const res = await POST(post(BODY));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.hold_warning).toEqual(WARNING);
    expect(body.created).toEqual({ assignments: 2, adopted_drills: 1 });
    expect(mockIssue).toHaveBeenCalledTimes(1);
  });

  test('the hold is read for the caller role, this gym and this athlete, after the write', async () => {
    mockHold.mockResolvedValue(WARNING);

    await POST(post(BODY));

    expect(mockHold).toHaveBeenCalledWith('coach', 'org-1', 'athlete-1');
    expect(mockIssue.mock.invocationCallOrder[0]).toBeLessThan(mockHold.mock.invocationCallOrder[0]);
  });

  test('no hold: the answer has no hold_warning key at all', async () => {
    const res = await POST(post(BODY));

    expect(await res.json()).not.toHaveProperty('hold_warning');
  });

  test('a hold that could not be read says so rather than reading as no hold', async () => {
    mockHold.mockResolvedValue('unreadable');

    const res = await POST(post(BODY));

    expect(res.status).toBe(201);
    expect((await res.json()).hold_warning).toBe('unreadable');
  });
});

// ONE PRESS, ONE ISSUE (lane P7c, PR F). The coach's screen sends a request key
// with a press of Issue and the same key again when that press got no answer.
// The writer decides what a key means (proven against real PostgreSQL in
// workoutIssues.pg.test.ts); this is what the route accepts and what each
// outcome becomes on the wire.
describe('a request key', () => {
  const ALREADY = {
    outcome: 'already_issued',
    issue_id: ISSUED.issue_id,
    template: ISSUED.template,
    step_count: 2,
  };

  test('the key is handed to the writer exactly as sent; a request with none hands it null', async () => {
    await POST(post({ ...BODY, request_key: 'a1b2c3d4-0000-4000-8000-000000000001' }));
    await POST(post(BODY));
    await POST(post({ ...BODY, request_key: null }));

    expect(mockIssue.mock.calls.map(([params]) => params.requestKey)).toEqual([
      'a1b2c3d4-0000-4000-8000-000000000001',
      null,
      null,
    ]);
  });

  test('a key of exactly 200 characters is accepted', async () => {
    const res = await POST(post({ ...BODY, request_key: 'k'.repeat(200) }));

    expect(res.status).toBe(201);
    expect(mockIssue.mock.calls[0][0].requestKey).toBe('k'.repeat(200));
  });

  test.each([
    ['an empty key', ''],
    ['a blank key', '   '],
    ['a key of 201 characters', 'k'.repeat(201)],
    ['a numeric key', 7],
    ['a key that is an object', { key: 'x' }],
    ['a key that is true', true],
  ] as Array<[string, unknown]>)('%s is a 400 that says so, and nothing is read or written', async (_label, requestKey) => {
    const res = await POST(post({ ...BODY, request_key: requestKey }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('request_key must be text of 1 to 200 characters');
    expect(mockReach).not.toHaveBeenCalled();
    expect(mockIssue).not.toHaveBeenCalled();
  });

  test('a role that may not issue is refused before its key is looked at', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete' }));

    const res = await POST(post({ ...BODY, request_key: 7 }));

    expect(res.status).toBe(403);
  });

  test('the reach check still comes before the writer is asked about any key', async () => {
    mockReach.mockRejectedValue(new Error('forbidden'));

    const res = await POST(post({ ...BODY, request_key: 'key-1' }));

    expect(res.status).toBe(404);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  test('a repeat of an issued request is a 200 that names the first issue and reports nothing as created', async () => {
    mockIssue.mockResolvedValue(ALREADY);

    const res = await POST(post({ ...BODY, request_key: 'key-1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      already_issued: true,
      organization_id: 'org-1',
      athlete_id: 'athlete-1',
      issue_id: ISSUED.issue_id,
      template: ISSUED.template,
      step_count: 2,
    });
  });

  test('a repeat still says the training hold: the first answer may never have arrived', async () => {
    mockIssue.mockResolvedValue(ALREADY);
    mockHold.mockResolvedValue({ hold_id: 'hold-1', scope: 'all_training' });

    const res = await POST(post({ ...BODY, request_key: 'key-1' }));

    expect(res.status).toBe(200);
    expect((await res.json()).hold_warning).toEqual({ hold_id: 'hold-1', scope: 'all_training' });
    expect(mockHold).toHaveBeenCalledWith('coach', 'org-1', 'athlete-1');
  });

  test('a key already used for a different workout keeps the writer\'s 409 and code', async () => {
    mockIssue.mockRejectedValue(
      new ConflictError('This request was already used to issue a different workout.', 'WORKOUT_ISSUE_REQUEST_KEY_REUSED'),
    );

    const res = await POST(post({ ...BODY, request_key: 'key-1' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This request was already used to issue a different workout.',
      code: 'WORKOUT_ISSUE_REQUEST_KEY_REUSED',
    });
    expect(mockHold).not.toHaveBeenCalled();
  });
});
