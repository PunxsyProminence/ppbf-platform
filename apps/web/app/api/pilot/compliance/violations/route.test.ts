import { NextRequest } from 'next/server';

import { GET, POST } from './route';
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
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function getRequest(query_?: string) {
  return new NextRequest(`http://localhost/api/pilot/compliance/violations${query_ ? `?${query_}` : ''}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/compliance/violations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/pilot/compliance/violations', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  test('403 for a role that cannot view violations', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'volunteer' }));
    const res = await GET(getRequest());
    expect(res.status).toBe(403);
  });

  test('403 when coach filters by an unassigned athlete (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await GET(getRequest('athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('unfiltered coach request is scoped to assigned athletes only', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('coach_id ='),
      expect.arrayContaining(['acct-1']),
    );
  });

  test('unfiltered organization_admin request is org-wide, not coach-scoped', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(expect.not.stringContaining('coach_id ='), expect.anything());
  });

  describe('limit validation', () => {
    test.each(['0', '-1', 'NaN', '3.5', 'abc', '999999999999999999999'])(
      '400 for an invalid limit=%s',
      async (rawLimit) => {
        mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
        const res = await GET(getRequest(`limit=${rawLimit}`));
        expect(res.status).toBe(400);
      },
    );

    test('excessive limit is clamped to the safe maximum, not rejected', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
      mockQuery.mockResolvedValueOnce([]);
      const res = await GET(getRequest('limit=100000'));
      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([100]));
    });

    test('missing limit falls back to the default', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
      mockQuery.mockResolvedValueOnce([]);
      const res = await GET(getRequest());
      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([50]));
    });
  });
});

describe('POST /api/pilot/compliance/violations', () => {
  test('400 when required fields are missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const res = await POST(postRequest({ rule_id: 'r1' }));
    expect(res.status).toBe(400);
  });

  test('403 when coach logs a violation against an unassigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(postRequest({ rule_id: 'r1', athlete_id: 'ath-other' }));
    expect(res.status).toBe(403);
  });

  test('201 when coach logs a violation against an assigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce({ rule_id: 'r1' }); // getComplianceRuleById
    mockQuery.mockResolvedValueOnce([{ violation_id: 'v1' }]);
    const res = await POST(postRequest({ rule_id: 'r1', athlete_id: 'ath-1' }));
    expect(res.status).toBe(201);
  });

  test('403 when organization_admin logs a violation against an athlete from another organization (cross-organization write)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(postRequest({ rule_id: 'r1', athlete_id: 'ath-other-org' }));
    expect(res.status).toBe(403);
  });

  test('cross-organization rule_id returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete succeeds
      .mockResolvedValueOnce(null); // rule not found in this org
    const res = await POST(postRequest({ rule_id: 'r-other-org', athlete_id: 'ath-1' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('cross-organization video_session_id returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce({ rule_id: 'r1' }) // getComplianceRuleById
      .mockResolvedValueOnce(null); // video session not found in this org
    const res = await POST(
      postRequest({ rule_id: 'r1', athlete_id: 'ath-1', video_session_id: 'vid-other-org' }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('video_session_id attributed to a different athlete returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce({ rule_id: 'r1' }) // getComplianceRuleById
      .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-2' });
    const res = await POST(
      postRequest({ rule_id: 'r1', athlete_id: 'ath-1', video_session_id: 'vid-1' }),
    );
    expect(res.status).toBe(404);
  });

  test('201 when video_session_id is attributed to the same athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ rule_id: 'r1' })
      .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ violation_id: 'v1' }]);
    const res = await POST(
      postRequest({ rule_id: 'r1', athlete_id: 'ath-1', video_session_id: 'vid-1' }),
    );
    expect(res.status).toBe(201);
  });
});
