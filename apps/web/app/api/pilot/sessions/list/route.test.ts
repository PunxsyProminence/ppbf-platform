import { NextRequest } from 'next/server';

import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The db layer is the mock boundary, NOT the access module: these tests run
// the real requireRole and assertActorCanAccessAthlete, so what they pin is
// the route's actual authorization, not a stub of it. queryOne answers the
// coach-of-record / coverage / org-membership lookups; query answers the
// sessions read.
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

function listRequest(athleteId?: string) {
  const search = athleteId === undefined ? '' : `?athlete_id=${encodeURIComponent(athleteId)}`;
  return new NextRequest(`http://localhost/api/pilot/sessions/list${search}`);
}

describe('GET /api/pilot/sessions/list', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(listRequest('ath-1'));
    expect(res.status).toBe(401);
  });

  test('400 when athlete_id is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const res = await GET(listRequest());
    expect(res.status).toBe(400);
  });

  test.each(['parent', 'board', 'staff', 'volunteer', 'platform_owner'] as const)(
    'role %s cannot list training sessions',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));
      const res = await GET(listRequest('ath-1'));
      expect(res.status).toBe(403);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  test('a coach of record gets the sessions, scoped to their own organization in SQL', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    // Coach-of-record lookup matches.
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    const rows = [
      { session_id: 's-2', athlete_id: 'ath-1', date: '2026-08-12', rpe: 7, notes: 'n', completed_flag: true },
      { session_id: 's-1', athlete_id: 'ath-1', date: '2026-08-10', rpe: 5, notes: 'n', completed_flag: true },
    ];
    mockQuery.mockResolvedValueOnce(rows);

    const res = await GET(listRequest('ath-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: rows });

    // The coach-of-record check itself carries the coach AND the organization.
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('coach_id = $2'),
      ['ath-1', 'acct-coach-1', 'org-1'],
    );
    // The sessions read is pinned to the principal's organization -- a
    // session from another organization cannot match this predicate, so
    // foreign-org sessions can never appear in the response.
    const [sessionsSql, sessionsParams] = mockQuery.mock.calls[0];
    expect(String(sessionsSql)).toContain('organization_id = $1');
    expect(sessionsParams).toEqual(['org-1', 'ath-1']);
  });

  test('a coach who is not assigned (no record, no live coverage) is refused before any sessions read', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    // Neither the coach-of-record lookup nor the coverage lookup matches.
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const res = await GET(listRequest('ath-not-mine'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: coach not assigned to athlete' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a coach holding a live coverage grant gets the sessions', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    // Not coach of record, but the coverage lookup matches.
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ athlete_id: 'ath-covered' });
    mockQuery.mockResolvedValueOnce([]);

    const res = await GET(listRequest('ath-covered'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  test('an organization admin is refused a cross-organization athlete_id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin', accountId: 'acct-admin-1' }));
    // The org-membership lookup finds no such athlete in this organization.
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await GET(listRequest('ath-other-org'));
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('an athlete cannot read another athlete\'s sessions', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-self' }));
    const res = await GET(listRequest('ath-someone-else'));
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
