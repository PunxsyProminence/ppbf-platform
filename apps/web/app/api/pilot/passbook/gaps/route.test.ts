import { NextRequest } from 'next/server';

import { GET } from './route';
import { getCoachPassbookGapQueue } from '@/src/server/pilot/passbook';
import { athleteIdsForCoach } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/passbook', () => ({
  getCoachPassbookGapQueue: jest.fn(),
}));

// The reach list is faked at the access contract, not the db: the route's
// job is to hand athleteIdsForCoach's answer (coach of record UNION active
// coverage) to the queue, and to hand null for an organization admin.
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, athleteIdsForCoach: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetGapQueue = getCoachPassbookGapQueue as jest.Mock;
const mockAthleteIdsForCoach = athleteIdsForCoach as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

const request = new NextRequest('http://localhost/api/pilot/passbook/gaps');

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/passbook/gaps', () => {
  test('scopes a coach to the athletes they reach: coach of record and covered', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAthleteIdsForCoach.mockResolvedValueOnce(['ath-own', 'ath-covered']);
    mockGetGapQueue.mockResolvedValueOnce([{ gap_id: 'gap-1' }]);

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockAthleteIdsForCoach).toHaveBeenCalledWith('org-1', 'coach-1');
    expect(mockGetGapQueue).toHaveBeenCalledWith('org-1', ['ath-own', 'ath-covered']);
    await expect(response.json()).resolves.toEqual({ items: [{ gap_id: 'gap-1' }] });
  });

  test.each(['organization_admin', 'admin'] as const)('%s can read the organization queue', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role, accountId: `${role}-1` }));
    mockGetGapQueue.mockResolvedValueOnce([]);

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockAthleteIdsForCoach).not.toHaveBeenCalled();
    expect(mockGetGapQueue).toHaveBeenCalledWith('org-1', null);
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner'] as const)('rejects %s', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mockGetGapQueue).not.toHaveBeenCalled();
  });
});
