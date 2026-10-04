import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete, athleteIdsForCoach } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listTaggedClips } from '@/src/server/pilot/videoClipTags';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn(), athleteIdsForCoach: jest.fn() };
});
jest.mock('@/src/server/pilot/videoClipTags', () => ({ listTaggedClips: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockCoachScope = jest.mocked(athleteIdsForCoach);
const mockList = jest.mocked(listTaggedClips);

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

const get = (query = '') => GET(new NextRequest(`http://localhost/api/pilot/video/clips${query}`));

beforeEach(() => {
  jest.resetAllMocks();
  mockPrincipal.mockResolvedValue(principal());
  mockCoachScope.mockResolvedValue(['ath-1']);
  mockList.mockResolvedValue([]);
});

test.each(['athlete', 'parent', 'volunteer', 'board'] as const)('%s cannot list tagged clips (staff only)', async (role) => {
  mockPrincipal.mockResolvedValueOnce(principal({ role, athleteId: 'ath-1' }));
  const res = await get();
  expect(res.status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});

test('a coach lists within their own athletes only', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(mockList).toHaveBeenCalledWith({
    organizationId: 'org-1', athleteIds: ['ath-1'], athleteId: undefined, competitionId: undefined, limit: 50,
  });
});

test('a coach naming an athlete who is not theirs is refused before any read', async () => {
  mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));
  const res = await get('?athlete_id=ath-9');
  expect(res.status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});

test('a coach filters by competition, still inside their own scope', async () => {
  await get('?competition_id=comp-1');
  expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ athleteIds: ['ath-1'], competitionId: 'comp-1' }));
});

test('an organization admin lists the whole organization', async () => {
  mockPrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
  await get('?athlete_id=ath-2');
  expect(mockCoachScope).not.toHaveBeenCalled();
  expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ athleteIds: null, athleteId: 'ath-2' }));
});

test('an invalid limit is a 400', async () => {
  const res = await get('?limit=-1');
  expect(res.status).toBe(400);
});
