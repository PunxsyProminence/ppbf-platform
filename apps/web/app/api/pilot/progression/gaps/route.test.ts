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
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function getRequest(query_: string) {
  return new NextRequest(`http://localhost/api/pilot/progression/gaps?${query_}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/progression/gaps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/pilot/progression/gaps', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(401);
  });

  test('403 when athlete requests another athlete_id (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const res = await GET(getRequest('athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('athlete can read their own gaps', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(200);
  });

  test('403 when organization_admin requests an athlete from another organization (cross-organization)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await GET(getRequest('athlete_id=ath-other-org'));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/pilot/progression/gaps', () => {
  test('403 when coach creates a gap for an unassigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(
      postRequest({ athlete_id: 'ath-other', gap_type: 'technique', gap_description: 'x' }),
    );
    expect(res.status).toBe(403);
  });

  test('201 when coach creates a gap for an assigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ gap_id: 'gap-1' }]);
    const res = await POST(
      postRequest({ athlete_id: 'ath-1', gap_type: 'technique', gap_description: 'x' }),
    );
    expect(res.status).toBe(201);
  });
});
