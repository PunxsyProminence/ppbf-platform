import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { assertAthleteBelongsToOrganization } from '@/src/server/pilot/access';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

// The athlete arms' live-row read. assertActorCanAccessAthlete (POST) calls
// the real one inside access.ts, so the POST tests still answer it by queryOne.
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertAthleteBelongsToOrganization: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockLiveRow = assertAthleteBelongsToOrganization as jest.Mock;

beforeEach(() => {
  mockLiveRow.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  };
}

function postRequest(plan: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/floor-plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan }),
  });
}

const GENERATED_AT_PARAM = 3;

describe('POST /api/pilot/floor-plans', () => {
  test('an unparseable generatedAt falls back to now instead of reaching timestamptz', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // live athlete row (assertActorCanAccessAthlete)
    mockQuery.mockResolvedValueOnce([]);

    const res = await POST(postRequest({ generatedAt: 'whenever', tasks: [] }));

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(Number.isNaN(new Date(params[GENERATED_AT_PARAM] as string).getTime())).toBe(false);
  });

  test('a valid generatedAt is preserved', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // live athlete row (assertActorCanAccessAthlete)
    mockQuery.mockResolvedValueOnce([]);

    const res = await POST(postRequest({ generatedAt: '2026-07-30T12:00:00.000Z', tasks: [] }));

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[GENERATED_AT_PARAM]).toBe('2026-07-30T12:00:00.000Z');
  });

  test('400 for a plan larger than the stored-payload ceiling', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(postRequest({ generatedAt: '2026-07-30T12:00:00.000Z', notes: 'x'.repeat(200_000) }));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

function patchRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/floor-plans', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// PATCH marks one task on the athlete's newest plan done (or not). The athlete
// is the principal's -- the route reads no athlete identity from the request
// at all, so the self-scope tests here are about what the queries were issued
// with, which is the only place an identity appears.
describe('PATCH /api/pilot/floor-plans', () => {
  function planRow(tasks: Array<Record<string, unknown>>) {
    return {
      plan_id: 'plan-1',
      payload: {
        athleteName: 'Test Athlete',
        readiness: 'GREEN',
        generatedAt: '2026-08-20T17:00:00.000Z',
        tasks,
      },
    };
  }

  test('marks the named task done on the stored plan', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(planRow([
      { id: 't1', title: 'Warmup' },
      { id: 't2', title: 'Cooldown' },
    ]));
    mockQuery.mockResolvedValueOnce([]);

    const res = await PATCH(patchRequest({ task_id: 't1', completed: true }));

    expect(res.status).toBe(200);
    const [updateSql, updateParams] = mockQuery.mock.calls[0];
    expect(updateSql).toContain('update pilot.athlete_floor_plans');
    const written = JSON.parse(updateParams[0] as string) as {
      tasks: Array<{ id: string; completed?: boolean }>;
    };
    expect(written.tasks.find((task) => task.id === 't1')?.completed).toBe(true);
    // The other task is returned untouched, not defaulted.
    expect(written.tasks.find((task) => task.id === 't2')?.completed).toBeUndefined();
    expect(updateParams.slice(1)).toEqual(['org-1', 'plan-1', 'ath-1']);
  });

  test('unticking writes false rather than deleting the record of the day', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(planRow([{ id: 't1', title: 'Warmup', completed: true }]));
    mockQuery.mockResolvedValueOnce([]);

    const res = await PATCH(patchRequest({ task_id: 't1', completed: false }));

    expect(res.status).toBe(200);
    const written = JSON.parse(mockQuery.mock.calls[0][1][0] as string) as {
      tasks: Array<{ id: string; completed?: boolean }>;
    };
    expect(written.tasks[0].completed).toBe(false);
  });

  test('the athlete written for is the principal, and a body athlete_id changes nothing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(planRow([{ id: 't1', title: 'Warmup' }]));
    mockQuery.mockResolvedValueOnce([]);

    // A forged body naming another athlete. The route reads no athlete_id
    // from the request, so this must be inert: both the read and the write go
    // to the principal's own record.
    const res = await PATCH(patchRequest({ task_id: 't1', completed: true, athlete_id: 'ath-other' }));

    expect(res.status).toBe(200);
    const [, selectParams] = mockQueryOne.mock.calls[0];
    expect(selectParams).toEqual(['org-1', 'ath-1']);
    const [, updateParams] = mockQuery.mock.calls[0];
    expect(updateParams).toContain('ath-1');
    expect(updateParams).not.toContain('ath-other');
  });

  test('403 for any role but athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce({ ...principal(), role: 'coach', athleteId: undefined });

    const res = await PATCH(patchRequest({ task_id: 't1', completed: true }));

    expect(res.status).toBe(403);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('403 for an athlete session with no linked athlete record', async () => {
    mockRequirePrincipal.mockResolvedValueOnce({ ...principal(), athleteId: undefined });

    const res = await PATCH(patchRequest({ task_id: 't1', completed: true }));

    expect(res.status).toBe(403);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('400 without a task_id, before anything is read', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await PATCH(patchRequest({ completed: true }));

    expect(res.status).toBe(400);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('400 for a completed that is not a boolean', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await PATCH(patchRequest({ task_id: 't1', completed: 'yes' }));

    expect(res.status).toBe(400);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('404 when the athlete has no plan at all', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await PATCH(patchRequest({ task_id: 't1', completed: true }));

    expect(res.status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('404 for a task that is not on the current plan, with no write', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(planRow([{ id: 't1', title: 'Warmup' }]));

    const res = await PATCH(patchRequest({ task_id: 'someone-elses-task', completed: true }));

    expect(res.status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("a deleted athlete's surviving session", () => {
  test('GET: the live athlete reads their plans; the deleted one is refused before any plan is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1', payload: { tasks: [] } }]);
    const live = await GET(new NextRequest('http://localhost/api/pilot/floor-plans'));
    expect(live.status).toBe(200);
    expect(mockLiveRow).toHaveBeenCalledWith('org-1', 'ath-1');

    mockQuery.mockClear();
    mockLiveRow.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));
    const refused = await GET(new NextRequest('http://localhost/api/pilot/floor-plans'));
    expect(refused.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('PATCH: refused before the plan is read or written', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockLiveRow.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));
    const res = await PATCH(
      new NextRequest('http://localhost/api/pilot/floor-plans', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task_id: 't1', completed: true }),
      }),
    );
    expect(res.status).toBe(403);
    expect(mockLiveRow).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
