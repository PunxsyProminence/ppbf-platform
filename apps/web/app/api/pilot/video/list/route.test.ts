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
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'ready'"), ['org-1', 'ath-1', 50]);
  });

  test('athlete without a linked athlete profile sees no videos', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: null }));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(mockQuery).not.toHaveBeenCalled();
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
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'ready'"), ['org-1', 'ath-1', 50]);
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

  test('coach without athlete_id sees their assigned athletes AND unassigned video', async () => {
    // The old name for this test said "scoped to assigned athletes only",
    // which the query has never done -- it also returns athlete_id is null.
    // A test name is where the next reader forms their belief about scope, so
    // it now says what the SQL actually does. The breadth is intended and
    // owner-confirmed (2026-08-08); see the route's own comment for why.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(request());
    expect(res.status).toBe(200);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toEqual(expect.stringContaining('coach_id = $2'));
    expect(sql).toEqual(expect.stringContaining('athlete_id is null'));
    expect(params).toEqual(['org-1', 'acct-1', 50]);
  });

  test('the coach listing deliberately does NOT pin status, unlike athlete and parent', async () => {
    // Pinning status = 'ready' here would hide a coach's own quarantined
    // upload from them -- it would simply never appear, with no explanation.
    // If someone ever "fixes" this branch to match the other two, this fails
    // and points them at the decision instead of letting it pass review.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQuery.mockResolvedValueOnce([]);
    await GET(request());

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toEqual(expect.stringContaining("status = 'ready'"));
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
