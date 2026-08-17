import { NextRequest } from 'next/server';

import { GET } from './route';
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

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function listRequest(query_?: string) {
  return new NextRequest(`http://localhost/api/pilot/goals/list${query_ ? `?${query_}` : ''}`);
}

// getGoalsByAthlete used to run an unbounded SELECT * -- see
// entities.ts#getGoalsByAthlete. Now carries a default cap since this route
// is the function's only caller and nothing else depends on completeness.
describe('GET /api/pilot/goals/list', () => {
  test('400 when athlete_id is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const res = await GET(listRequest());
    expect(res.status).toBe(400);
  });

  test('a coach of record gets goals, bounded to the default page size', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([]);

    const res = await GET(listRequest('athlete_id=ath-1'));

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', 'ath-1', 200, 0]);
  });

  test('an explicit limit is clamped to the max', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([]);

    const res = await GET(listRequest('athlete_id=ath-1&limit=999999'));

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', 'ath-1', 500, 0]);
  });

  test('an invalid limit is rejected with 400 before any goals read', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const res = await GET(listRequest('athlete_id=ath-1&limit=-1'));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
