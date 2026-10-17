// The staff family-goals route (PH-06b): who may call it, the athlete gate,
// and that the gym and the writer come from the session, never the body.
import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createStaffFamilyGoal,
  listFamilyGoalsForStaff,
  updateStaffFamilyGoal,
} from '@/src/server/pilot/familyGoals';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// requireRole stays real; the athlete gate is faked at its contract and the
// gym-scoped reads and writes are proved on Postgres (familyGoalsStaff.pg.test.ts).
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/familyGoals', () => ({
  listFamilyGoalsForStaff: jest.fn(),
  createStaffFamilyGoal: jest.fn(),
  updateStaffFamilyGoal: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockList = listFamilyGoalsForStaff as jest.Mock;
const mockCreate = createStaffFamilyGoal as jest.Mock;
const mockUpdate = updateStaffFamilyGoal as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(role: string): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

const URL_BASE = 'http://localhost/api/pilot/coach/family-goals';

function getRequest(query = '?athlete_id=ath-1') {
  return new NextRequest(`${URL_BASE}${query}`);
}

function bodyRequest(method: 'POST' | 'PATCH', body: unknown) {
  return new NextRequest(URL_BASE, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

const GOAL = {
  goal_id: '11111111-1111-4111-8111-111111111111',
  title: 'Shadowbox at home',
  support_action: 'Clear space in the garage.',
  target_date: null,
  state: 'active',
  completed_at: null,
  set_by: 'Coach Pat',
  mine_to_change: true,
};

const STAFF = ['coach', 'organization_admin', 'admin'];
const NOT_STAFF = ['athlete', 'parent', 'platform_owner', 'board'];

describe('GET /api/pilot/coach/family-goals', () => {
  test.each(STAFF)('%s reads the goals for an athlete of their own gym', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockAccess.mockResolvedValue(undefined);
    mockList.mockResolvedValue([GOAL]);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [GOAL] });
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', role }), 'ath-1');
    expect(mockList).toHaveBeenCalledWith('org-1', 'ath-1');
  });

  test.each(NOT_STAFF)('%s is refused and nothing is read', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('when the athlete gate refuses (another gym), nothing is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAccess.mockRejectedValue(new Error('Forbidden: athlete not in organization'));
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('a missing athlete_id is a 400', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    const response = await GET(getRequest(''));
    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/coach/family-goals', () => {
  test.each(STAFF)('%s adds a goal, written as the session, for a gated athlete', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockAccess.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue(GOAL);

    const response = await POST(bodyRequest('POST', {
      athlete_id: 'ath-1', title: 'Shadowbox at home', support_action: 'Clear space in the garage.', target_date: '2026-11-30',
      // A body cannot choose the gym or the writer.
      organization_id: 'org-other', created_by_account_id: 'acct-other', created_by_role: 'parent',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, item: GOAL });
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'ath-1');
    expect(mockCreate).toHaveBeenCalledWith({
      actor: expect.objectContaining({ accountId: 'acct-1', organizationId: 'org-1', role }),
      athleteId: 'ath-1',
      title: 'Shadowbox at home',
      supportAction: 'Clear space in the garage.',
      targetDate: '2026-11-30',
    });
  });

  test.each(NOT_STAFF)('%s is refused and nothing is written', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    const response = await POST(bodyRequest('POST', { athlete_id: 'ath-1', title: 'x', support_action: 'y' }));
    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('when the athlete gate refuses, nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAccess.mockRejectedValue(new Error('Forbidden: athlete not in organization'));
    const response = await POST(bodyRequest('POST', { athlete_id: 'ath-9', title: 'x', support_action: 'y' }));
    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a missing athlete_id is a 400', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    const response = await POST(bodyRequest('POST', { title: 'x', support_action: 'y' }));
    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/pilot/coach/family-goals', () => {
  test.each([
    [{ action: 'done' }, { kind: 'done', done: true }],
    [{ action: 'undo' }, { kind: 'done', done: false }],
    [{ action: 'retire' }, { kind: 'retire' }],
    [{ action: 'edit', title: 'T', support_action: 'S', target_date: null }, { kind: 'edit', title: 'T', supportAction: 'S', targetDate: null }],
  ])('%o reaches the staff change as the session', async (sent, change) => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockUpdate.mockResolvedValue(GOAL);

    const response = await PATCH(bodyRequest('PATCH', { goal_id: GOAL.goal_id, ...sent }));

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      actor: expect.objectContaining({ accountId: 'acct-1', organizationId: 'org-1', role: 'coach' }),
      goalId: GOAL.goal_id,
      change,
    });
  });

  test.each(NOT_STAFF)('%s is refused and nothing is changed', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    const response = await PATCH(bodyRequest('PATCH', { goal_id: GOAL.goal_id, action: 'done' }));
    expect(response.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('an unknown action and a missing goal_id are 400s', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    expect((await PATCH(bodyRequest('PATCH', { goal_id: GOAL.goal_id, action: 'delete' }))).status).toBe(400);
    expect((await PATCH(bodyRequest('PATCH', { action: 'done' }))).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
