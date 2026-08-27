import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getAthleteIntelligence } from '@/src/server/pilot/athleteIntelligence';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteIntelligence', () => ({
  getAthleteIntelligence: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockRead = getAthleteIntelligence as jest.Mock;

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
  new NextRequest(`http://localhost/api/pilot/coach/athlete-intelligence?${query}`);

/* platform_owner and board are refused by name inside
 * assertActorCanAccessAthlete, and refused again here by the role list. Athlete
 * and parent are refused by the role list alone: whether a child or a guardian
 * should read SHADOW formula internals and vision-model observation text about
 * themselves is a policy question with an owner, and this route does not answer
 * it by leaving the list open. */
test('non-staff roles have no path to an athlete intelligence read', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner', 'board', 'staff', 'volunteer'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockRead).not.toHaveBeenCalled();
});

test('the read is org-scoped from the principal and requires an athlete', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);

  expect((await GET(getRequest(''))).status).toBe(400);
  expect(mockRead).not.toHaveBeenCalled();

  mockRead.mockResolvedValue({ organizationId: 'org-1', athleteId: 'ath-1' });
  const response = await GET(getRequest());

  expect(response.status).toBe(200);
  // The organization comes from the session, never from the query string --
  // there is no organization_id parameter on this route at all.
  expect(mockRead).toHaveBeenCalledWith({ organizationId: 'org-1', athleteId: 'ath-1' });
});

test('a coach with no relationship to the athlete is refused before any read runs', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  const response = await GET(getRequest());

  expect(response.status).toBe(403);
  expect(mockRead).not.toHaveBeenCalled();
});

/* The gate runs ONCE, on the caller-supplied athlete_id, before the read. A
 * check that ran after the read would have already assembled another child's
 * formula results, attempts and film in memory. */
test('the athlete-access check runs once, on the requested athlete, before the read', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);
  mockRead.mockResolvedValue({ organizationId: 'org-1', athleteId: 'ath-9' });

  await GET(getRequest('athlete_id=ath-9'));

  expect(mockAccess).toHaveBeenCalledTimes(1);
  expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1' }), 'ath-9');
  expect(mockAccess.mock.invocationCallOrder[0]).toBeLessThan(mockRead.mock.invocationCallOrder[0]);
});
