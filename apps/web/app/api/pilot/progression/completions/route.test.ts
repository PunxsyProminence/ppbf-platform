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

const assignmentRow = (overrides: Record<string, unknown> = {}) => ({
  assignment_id: 'asg-1',
  gap_id: 'gap-1',
  athlete_id: 'ath-1',
  drill_name: 'drill',
  drill_description: 'desc',
  drill_difficulty: 'intermediate',
  rep_count: null,
  duration_minutes: null,
  frequency_per_week: null,
  due_date: null,
  status: 'assigned',
  completion_percentage: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function getRequest(query_?: string) {
  return new NextRequest(`http://localhost/api/pilot/progression/completions${query_ ? `?${query_}` : ''}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/progression/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/pilot/progression/completions', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(401);
  });

  test('403 for a role that cannot view completions', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(403);
  });

  test('400 when assignment_id is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const res = await GET(getRequest());
    expect(res.status).toBe(400);
  });

  test('nonexistent assignment returns hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await GET(getRequest('assignment_id=does-not-exist'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('cross-athlete access (unassigned coach) returns the same hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow({ athlete_id: 'ath-other' }))
      .mockResolvedValueOnce(null);
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('athlete can view completions for their own assignment', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(assignmentRow());
    mockQuery.mockResolvedValueOnce([{ completion_id: 'c1' }]);
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(200);
  });

  test('assigned coach can view completions', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/pilot/progression/completions', () => {
  test('403 when athlete records a completion for another athlete (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-other' }));
    expect(res.status).toBe(403);
  });

  test('rejects when the assignment does not belong to the specified athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(assignmentRow({ athlete_id: 'ath-other' }));
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1' }));
    expect(res.status).toBe(400);
  });

  test('athlete can record their own completion', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(assignmentRow());
    mockQuery.mockResolvedValueOnce([{ completion_id: 'c1', assignment_id: 'asg-1' }]);
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1' }));
    expect(res.status).toBe(201);
  });

  test('403 when an unassigned coach tries to verify a completion', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-other', verify: true, verified: true }));
    expect(res.status).toBe(403);
  });

  test('assigned coach can record and verify a completion', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce(assignmentRow()); // getDrillAssignmentById
    mockQuery
      .mockResolvedValueOnce([{ completion_id: 'c1', assignment_id: 'asg-1' }]) // recordCompletion insert
      .mockResolvedValueOnce([]); // verifyCompletion update
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1', verify: true, verified: true }));
    expect(res.status).toBe(201);
  });
});
