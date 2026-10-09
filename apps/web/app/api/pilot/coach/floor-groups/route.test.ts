import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { addGroup, createPlan, getPlan, placeAthlete, removeAthlete } from '@/src/server/pilot/floorGroups';
import { getSchedulerClassById, listRegisteredAthleteIdsForClass } from '@/src/server/pilot/schedulerDb';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/floorGroups', () => ({
  createPlan: jest.fn(),
  getPlan: jest.fn(),
  addGroup: jest.fn(),
  placeAthlete: jest.fn(),
  removeAthlete: jest.fn().mockResolvedValue([]),
  listPlans: jest.fn().mockResolvedValue([]),
  listGroups: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/src/server/pilot/schedulerDb', () => ({
  getSchedulerClassById: jest.fn(),
  listRegisteredAthleteIdsForClass: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockCreatePlan = createPlan as jest.Mock;
const mockGetPlan = getPlan as jest.Mock;
const mockAddGroup = addGroup as jest.Mock;
const mockPlace = placeAthlete as jest.Mock;
const mockRemove = removeAthlete as jest.Mock;
const mockGetClass = getSchedulerClassById as jest.Mock;
const mockRegistered = listRegisteredAthleteIdsForClass as jest.Mock;

// The athlete gate is permissive by default so each test states its own
// access decision rather than inheriting the previous test's --
// clearAllMocks clears calls, not implementations. The default plan is tied
// to no class, so the pre-ruling tests below keep their assigned-only shape.
beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
  mockGetPlan.mockResolvedValue({ plan_id: 'p-1', plan_on: '2026-08-16', class_id: null });
  mockGetClass.mockResolvedValue(null);
  mockRegistered.mockResolvedValue([]);
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/coach/floor-groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('athletes and parents cannot see or make the floor', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(new NextRequest('http://localhost/api/pilot/coach/floor-groups'))).status).toBeGreaterThanOrEqual(400);
    expect((await POST(postRequest({ action: 'create_plan', plan_on: '2026-08-16' }))).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockCreatePlan).not.toHaveBeenCalled();
});

test('a plan needs a real date; rotation minutes must be a sane whole number when given', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(postRequest({ action: 'create_plan', plan_on: 'today' }))).status).toBe(400);
  expect((await POST(postRequest({ action: 'create_plan', plan_on: '2026-08-16', rotation_minutes: 0 }))).status).toBe(400);
  expect((await POST(postRequest({ action: 'create_plan', plan_on: '2026-08-16', rotation_minutes: 3.5 }))).status).toBe(400);
  expect(mockCreatePlan).not.toHaveBeenCalled();

  mockCreatePlan.mockResolvedValue({ plan_id: 'p-1', plan_on: '2026-08-16' });
  expect((await POST(postRequest({ action: 'create_plan', plan_on: '2026-08-16' }))).status).toBe(200);
});

test('a group without a station is legal -- a small-group day is not a broken circuit', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAddGroup.mockResolvedValue({ group_id: 'g-1', station_name: null, members: [] });

  const response = await POST(postRequest({ action: 'add_group', plan_id: 'p-1', group_name: 'Small group A' }));
  expect(response.status).toBe(200);
  expect(mockAddGroup).toHaveBeenCalledWith(expect.objectContaining({
    groupName: 'Small group A', stationName: undefined,
  }));
});

test('placing needs all three ids and hides unknown targets; an unknown action is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(postRequest({ action: 'place', plan_id: 'p-1', group_id: 'g-1' }))).status).toBe(400);
  expect(mockPlace).not.toHaveBeenCalled();

  // The gate is granted here, so this 404 is the MODULE's hidden not-found
  // (mockPlace resolves null), not an access decision. The gate's own refusal
  // is the next test.
  mockPlace.mockResolvedValue(null);
  expect((await POST(postRequest({
    action: 'place', plan_id: 'p-1', group_id: 'g-1', athlete_id: 'ath-other-org',
  }))).status).toBe(404);

  expect((await POST(postRequest({ action: 'shuffle', plan_id: 'p-1' }))).status).toBe(400);
});

test('a coach cannot place or remove an athlete who is not theirs', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  expect((await POST(postRequest({
    action: 'place', plan_id: 'p-1', group_id: 'g-1', athlete_id: 'ath-not-mine',
  }))).status).toBe(403);
  expect((await POST(postRequest({
    action: 'remove', plan_id: 'p-1', athlete_id: 'ath-not-mine',
  }))).status).toBe(403);

  expect(mockPlace).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled();
});

/* THE CLASS REGISTER ON THE FLOOR (OD-2026-10-07-008, question card 1 item
   4). A plan tied to a class the coach runs (teach / scheduled / cover) lets
   them place and remove every athlete registered to that class, assigned to
   them or not. A plan tied to no class, a class the coach does not run, or an
   athlete not registered to it, all fall back to the assignment gate exactly
   as before. The gate mock is watched both ways: the register path must not
   consult it, and the fallback must. */
describe('a plan tied to a class the coach runs', () => {
  const classPlan = { plan_id: 'p-cls', plan_on: '2026-08-16', class_id: 'cls-1' };
  const myClass = { class_id: 'cls-1', coach_account_id: 'acct-1', scheduled_by_account_id: 'acct-1', covering_coach_account_id: null };
  const theirClass = { class_id: 'cls-1', coach_account_id: 'acct-9', scheduled_by_account_id: 'acct-9', covering_coach_account_id: null };

  test('a registered athlete is placed and removed without the assignment gate', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetPlan.mockResolvedValue(classPlan);
    mockGetClass.mockResolvedValue(myClass);
    mockRegistered.mockResolvedValue(['ath-registered']);
    mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));
    mockPlace.mockResolvedValue([]);

    expect((await POST(postRequest({
      action: 'place', plan_id: 'p-cls', group_id: 'g-1', athlete_id: 'ath-registered',
    }))).status).toBe(200);
    expect((await POST(postRequest({ action: 'remove', plan_id: 'p-cls', athlete_id: 'ath-registered' }))).status).toBe(200);

    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockPlace).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRegistered).toHaveBeenCalledWith('org-1', 'cls-1');
  });

  test('a covering coach runs the class too', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-cover' }));
    mockGetPlan.mockResolvedValue(classPlan);
    mockGetClass.mockResolvedValue({ ...theirClass, covering_coach_account_id: 'acct-cover' });
    mockRegistered.mockResolvedValue(['ath-registered']);
    mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));
    mockPlace.mockResolvedValue([]);

    expect((await POST(postRequest({
      action: 'place', plan_id: 'p-cls', group_id: 'g-1', athlete_id: 'ath-registered',
    }))).status).toBe(200);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  test('an athlete NOT registered to the class goes through the assignment gate, and a walk-in holds no registration', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetPlan.mockResolvedValue(classPlan);
    mockGetClass.mockResolvedValue(myClass);
    mockRegistered.mockResolvedValue(['ath-registered']);
    mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    expect((await POST(postRequest({
      action: 'place', plan_id: 'p-cls', group_id: 'g-1', athlete_id: 'ath-walk-in',
    }))).status).toBe(403);
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1' }), 'ath-walk-in');
    expect(mockPlace).not.toHaveBeenCalled();
  });

  test('a class the coach does not run widens nothing, whoever is registered', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetPlan.mockResolvedValue(classPlan);
    mockGetClass.mockResolvedValue(theirClass);
    mockRegistered.mockResolvedValue(['ath-registered']);
    mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    expect((await POST(postRequest({
      action: 'place', plan_id: 'p-cls', group_id: 'g-1', athlete_id: 'ath-registered',
    }))).status).toBe(403);
    expect(mockAccess).toHaveBeenCalledTimes(1);
    // The roster of a class the coach does not run is never even read.
    expect(mockRegistered).not.toHaveBeenCalled();
    expect(mockPlace).not.toHaveBeenCalled();
  });

  test('a plan with no class stays assigned-only: the class rule has nothing to widen by', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    expect((await POST(postRequest({
      action: 'place', plan_id: 'p-1', group_id: 'g-1', athlete_id: 'ath-not-mine',
    }))).status).toBe(403);
    expect(mockGetClass).not.toHaveBeenCalled();
  });

  test('an admin is not widened by the class rule and not narrowed by it: the gate decides', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockGetPlan.mockResolvedValue(classPlan);
    mockGetClass.mockResolvedValue(theirClass);
    mockRegistered.mockResolvedValue(['ath-registered']);
    mockPlace.mockResolvedValue([]);

    expect((await POST(postRequest({
      action: 'place', plan_id: 'p-cls', group_id: 'g-1', athlete_id: 'ath-registered',
    }))).status).toBe(200);
    expect(mockAccess).toHaveBeenCalledTimes(1);
    expect(mockGetClass).not.toHaveBeenCalled();
  });

  test('an unknown plan answers the hidden 404 before any athlete check, on place and on remove', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetPlan.mockResolvedValue(null);

    expect((await POST(postRequest({
      action: 'place', plan_id: 'p-none', group_id: 'g-1', athlete_id: 'ath-1',
    }))).status).toBe(404);
    expect((await POST(postRequest({ action: 'remove', plan_id: 'p-none', athlete_id: 'ath-1' }))).status).toBe(404);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockPlace).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
