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
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
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
});
