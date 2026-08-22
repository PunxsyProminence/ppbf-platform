import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { addGroup, createPlan, placeAthlete, removeAthlete } from '@/src/server/pilot/floorGroups';
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
  addGroup: jest.fn(),
  placeAthlete: jest.fn(),
  removeAthlete: jest.fn().mockResolvedValue([]),
  listPlans: jest.fn().mockResolvedValue([]),
  listGroups: jest.fn().mockResolvedValue([]),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockCreatePlan = createPlan as jest.Mock;
const mockAddGroup = addGroup as jest.Mock;
const mockPlace = placeAthlete as jest.Mock;
const mockRemove = removeAthlete as jest.Mock;

// The athlete gate is permissive by default so each test states its own
// access decision rather than inheriting the previous test's --
// clearAllMocks clears calls, not implementations.
beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
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
