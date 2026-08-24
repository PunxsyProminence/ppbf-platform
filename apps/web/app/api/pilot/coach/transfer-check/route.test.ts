import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getTransferReadout } from '@/src/server/pilot/falseProgress';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/falseProgress', () => {
  const actual = jest.requireActual('@/src/server/pilot/falseProgress');
  return { ...actual, getTransferReadout: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockReadout = getTransferReadout as jest.Mock;

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

const getRequest = (query = 'athlete_id=ath-1') =>
  new NextRequest(`http://localhost/api/pilot/coach/transfer-check?${query}`);

test('athletes and parents have no path to transfer flags about athletes', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockReadout).not.toHaveBeenCalled();
});

test('the readout is org-scoped from the principal and requires an athlete', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  // A coach who DOES hold access for ath-1. Before the per-athlete gate
  // existed this line was absent and the 200 below meant only "the caller is
  // a coach" -- which is exactly the hole: it passed for any athlete_id in
  // the organization, assigned to this coach or not.
  mockAccess.mockResolvedValue(undefined);

  expect((await GET(getRequest(''))).status).toBe(400);

  mockReadout.mockResolvedValue([{ metric_kind: 'reps', state: 'not_transferring' }]);
  const response = await GET(getRequest());
  expect(response.status).toBe(200);
  expect(mockReadout).toHaveBeenCalledWith('org-1', 'ath-1');
});

test('a coach with no relationship to the athlete is refused before the readout runs', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  // The message assertCoachAssignedToAthlete actually throws -- neither
  // coach_id of record nor an active coverage grant.
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  const response = await GET(getRequest());

  expect(response.status).toBe(403);
  expect(mockReadout).not.toHaveBeenCalled();
});

test('the athlete-access check runs before the readout, not after it', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  await GET(getRequest('athlete_id=ath-9'));

  expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1' }), 'ath-9');
  expect(mockReadout).not.toHaveBeenCalled();
});
