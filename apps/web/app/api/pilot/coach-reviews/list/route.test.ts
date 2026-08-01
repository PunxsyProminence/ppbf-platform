import { NextRequest } from 'next/server';

import { GET } from './route';
import { getCoachReviewsBySession, getSessionById } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getSessionById: jest.fn(),
  getCoachReviewsBySession: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetSessionById = getSessionById as jest.Mock;
const mockGetCoachReviews = getCoachReviewsBySession as jest.Mock;

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

function getRequest(sessionId: string) {
  return new NextRequest(`http://localhost/api/pilot/coach-reviews/list?session_id=${sessionId}`);
}

describe('GET /api/pilot/coach-reviews/list', () => {
  // A session id that does not resolve inside the caller's organization is a
  // not-found, and must be indistinguishable from one owned by another gym --
  // not a masked server error.
  test('404 for a session that does not exist in this organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetSessionById.mockResolvedValueOnce(null);

    const res = await GET(getRequest('sess-other-org'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockGetCoachReviews).not.toHaveBeenCalled();
  });

  test('200 for a session the athlete owns', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetSessionById.mockResolvedValueOnce({ session_id: 'sess-1', athlete_id: 'ath-1' });
    mockGetCoachReviews.mockResolvedValueOnce([]);

    const res = await GET(getRequest('sess-1'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });
});
