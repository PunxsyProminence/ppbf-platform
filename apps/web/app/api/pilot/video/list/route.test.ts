import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';
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

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function request(url = 'http://localhost/api/pilot/video/list') {
  return new NextRequest(url);
}

describe('GET /api/pilot/video/list', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  test('403 for volunteer', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'volunteer' }));
    const res = await GET(request());
    expect(res.status).toBe(403);
  });

  test('403 for staff', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'staff' }));
    const res = await GET(request());
    expect(res.status).toBe(403);
  });

  test('athlete sees only their own videos', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQuery.mockResolvedValueOnce([{ video_session_id: 'v1', athlete_id: 'ath-1' }]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('account_id = $2'), ['org-1', 'acct-1', 50]);
  });

  test('400 when parent omits athlete_id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const res = await GET(request());
    expect(res.status).toBe(400);
  });

  test('parent linked to athlete succeeds', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ video_session_id: 'v1', athlete_id: 'ath-1' }]);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-1'));
    expect(res.status).toBe(200);
  });

  test('403 when parent is not linked to the athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce(null);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('coach with athlete_id for an assigned athlete succeeds', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ video_session_id: 'v1', athlete_id: 'ath-1' }]);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-1'));
    expect(res.status).toBe(200);
  });

  test('403 when coach requests an unassigned athlete (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce(null);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('coach without athlete_id is scoped to assigned athletes only', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('coach_id = $2'), ['org-1', 'acct-1', 50]);
  });

  test('organization_admin gets org-wide access', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([{ video_session_id: 'v1' }, { video_session_id: 'v2' }]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
  });

  describe('limit validation', () => {
    test.each(['0', '-1', 'NaN', '3.5', 'abc', '999999999999999999999'])(
      '400 for an invalid limit=%s',
      async (rawLimit) => {
        mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
        const res = await GET(request(`http://localhost/api/pilot/video/list?limit=${rawLimit}`));
        expect(res.status).toBe(400);
      },
    );

    test('excessive limit is clamped to the safe maximum, not rejected', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
      mockQuery.mockResolvedValueOnce([]);
      const res = await GET(request('http://localhost/api/pilot/video/list?limit=100000'));
      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([100]));
    });
  });
});
