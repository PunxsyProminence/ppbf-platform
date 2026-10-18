import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { createFamilyGoal, listFamilyGoalsForGuardian, updateFamilyGoal } from '@/src/server/pilot/familyGoals';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// Who reads and changes which goal (the guardian link, another guardian's
// goal, a staff goal, 18+, another gym) is proved on Postgres in
// familyGoalsGuardian.pg.test.ts. Here: the role, that the gym and the writer
// come from the session, and the action vocabulary. (#1593, PH-06)
jest.mock('@/src/server/pilot/familyGoals', () => ({
  listFamilyGoalsForGuardian: jest.fn(),
  createFamilyGoal: jest.fn(),
  updateFamilyGoal: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listFamilyGoalsForGuardian);
const mockCreate = jest.mocked(createFamilyGoal);
const mockUpdate = jest.mocked(updateFamilyGoal);

function principal(role = 'parent') {
  return { accountId: 'parent-1', role, organizationId: 'org-1', athleteId: null, sessionToken: 'token', authProvider: 'microsoft' } as never;
}

function request(method: string, body?: unknown, query = '') {
  return new NextRequest(`http://localhost/api/pilot/parent/family-goals${query}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
}

const GOAL = { goal_id: 'g1', title: 'Gym twice a week', support_action: 'Drive Tuesdays.', target_date: null, state: 'active' as const, completed_at: null, set_by: 'You', mine: true };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('/api/pilot/parent/family-goals (#1593, PH-06)', () => {
  test('GET reads one child for this guardian, with the gym and account from the session', async () => {
    mockPrincipal.mockResolvedValue(principal());
    mockList.mockResolvedValue([GOAL]);

    const response = await GET(request('GET', undefined, '?athlete_id=ath-1&organization_id=org-other'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [GOAL] });
    expect(mockList).toHaveBeenCalledWith('org-1', 'parent-1', 'ath-1');
  });

  test('GET with no child is a 400 and reads nothing', async () => {
    mockPrincipal.mockResolvedValue(principal());
    const response = await GET(request('GET'));
    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('POST adds a goal as this guardian, ignoring any writer or gym in the body', async () => {
    mockPrincipal.mockResolvedValue(principal());
    mockCreate.mockResolvedValue(GOAL);

    const response = await POST(request('POST', {
      athlete_id: 'ath-1', title: 'Gym twice a week', support_action: 'Drive Tuesdays.', target_date: '2026-11-30',
      account_id: 'someone-else', organization_id: 'org-other', created_by_role: 'coach',
    }));

    expect(response.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith({
      organizationId: 'org-1', accountId: 'parent-1', athleteId: 'ath-1', title: 'Gym twice a week', supportAction: 'Drive Tuesdays.', targetDate: '2026-11-30',
    });
  });

  test.each([
    [{ goal_id: 'g1', action: 'done' }, { kind: 'done', done: true }],
    [{ goal_id: 'g1', action: 'undo' }, { kind: 'done', done: false }],
    [{ goal_id: 'g1', action: 'retire' }, { kind: 'retire' }],
    [{ goal_id: 'g1', action: 'edit', title: 'T', support_action: 'S', target_date: null }, { kind: 'edit', title: 'T', supportAction: 'S', targetDate: null }],
  ])('PATCH %j changes the goal as this guardian', async (body, change) => {
    mockPrincipal.mockResolvedValue(principal());
    mockUpdate.mockResolvedValue(GOAL);

    const response = await PATCH(request('PATCH', body));

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({ organizationId: 'org-1', accountId: 'parent-1', goalId: 'g1', change });
  });

  test('PATCH with an unknown action, such as delete, is a 400 and changes nothing', async () => {
    mockPrincipal.mockResolvedValue(principal());
    const response = await PATCH(request('PATCH', { goal_id: 'g1', action: 'delete' }));
    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'coach', 'organization_admin', 'admin', 'board', 'platform_owner'])('%s is refused on every method', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));

    const responses = [
      await GET(request('GET', undefined, '?athlete_id=ath-1')),
      await POST(request('POST', { athlete_id: 'ath-1', title: 'T', support_action: 'S' })),
      await PATCH(request('PATCH', { goal_id: 'g1', action: 'done' })),
    ];

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
