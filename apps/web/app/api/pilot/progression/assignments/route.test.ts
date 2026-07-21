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
  return new NextRequest(`http://localhost/api/pilot/progression/assignments?${query_}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/progression/assignments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/pilot/progression/assignments', () => {
  test('403 when athlete requests another athlete_id (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const res = await GET(getRequest('athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('athlete can read their own assignments', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/pilot/progression/assignments', () => {
  test('403 when coach assigns a drill to an unassigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(
      postRequest({ athlete_id: 'ath-other', gap_id: 'gap-1', drill_name: 'd', drill_description: 'x' }),
    );
    expect(res.status).toBe(403);
  });

  test('201 when coach assigns a drill to an assigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-1' }]).mockResolvedValueOnce([]);
    const res = await POST(
      postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', drill_name: 'd', drill_description: 'x' }),
    );
    expect(res.status).toBe(201);
  });
});
