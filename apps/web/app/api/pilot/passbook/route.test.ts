import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { query, queryOne } from '@/src/server/pilot/db';
import { getAthletePassbook } from '@/src/server/pilot/passbook';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

// getGuardianPassbook stays REAL, over a mocked database: the guardian case
// below is then a claim about what actually leaves this route for a parent,
// not about what a stub was told to return.
jest.mock('@/src/server/pilot/passbook', () => {
  const actual = jest.requireActual('@/src/server/pilot/passbook');
  return { ...actual, getAthletePassbook: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockGetPassbook = getAthletePassbook as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'athlete-account-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function request(query = 'athlete_id=ath-1'): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/passbook?${query}`);
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/passbook', () => {
  test('requires authentication', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mockGetPassbook).not.toHaveBeenCalled();
  });

  test('rejects board access to an individual athlete passbook', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'board', athleteId: null }));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockAssertAccess).not.toHaveBeenCalled();
    expect(mockGetPassbook).not.toHaveBeenCalled();
  });

  test('requires an athlete id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await GET(request(''));

    expect(response.status).toBe(400);
    expect(mockAssertAccess).not.toHaveBeenCalled();
  });

  test('checks per-athlete access before assembling the organization-scoped passbook', async () => {
    const actor = principal({ accountId: 'coach-1', role: 'coach', athleteId: null });
    mockRequirePrincipal.mockResolvedValueOnce(actor);
    mockAssertAccess.mockResolvedValueOnce(undefined);
    mockGetPassbook.mockResolvedValueOnce({ athlete: { athlete_id: 'ath-1' }, pages: {} });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockAssertAccess).toHaveBeenCalledWith(actor, 'ath-1');
    expect(mockGetPassbook).toHaveBeenCalledWith('org-1', 'ath-1', 'coach');
  });

  // pilot.coach_observations is shared with guardian-authored barrier reports
  // and staff conduct notes, and this route's gate admits the athlete
  // themselves as well as staff. The reader's role therefore has to reach
  // getAthletePassbook, which owns the per-audience note_type allow-list; a
  // route that dropped it would hand every reader the widest book the module
  // can build. A guardian is not in this list: it reads getGuardianPassbook
  // instead (the describe block at the end of this file). Every other
  // admitted reader gets the full book exactly as getAthletePassbook built it.
  test.each([
    ['athlete', { accountId: 'athlete-account-1', athleteId: 'ath-1' }],
    ['coach', { accountId: 'coach-1', athleteId: null }],
    ['organization_admin', { accountId: 'admin-1', athleteId: null }],
    ['admin', { accountId: 'admin-legacy-1', athleteId: null }],
  ] as const)('passes the %s reader role down and returns the full book unchanged', async (role, identity) => {
    const actor = principal({ role, ...identity });
    const book = {
      athlete: { athlete_id: 'ath-1' },
      pages: { sessions: [{ session_id: 'session-1', date: '2026-08-03', rpe: 6, completed_flag: true }] },
    };
    mockRequirePrincipal.mockResolvedValueOnce(actor);
    mockAssertAccess.mockResolvedValueOnce(undefined);
    mockGetPassbook.mockResolvedValueOnce(book);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockGetPassbook).toHaveBeenCalledWith('org-1', 'ath-1', role);
    await expect(response.json()).resolves.toEqual({ passbook: book });
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each([
    ['athlete', { accountId: 'athlete-account-1', athleteId: 'ath-1' }],
  // getAthletePassbook is mocked here, so this pins the route's pass-through:
  // an authorized athlete still receives the corner and the gaps.
  // WHICH coach_observations rows the corner may carry is decided one layer
  // down and is pinned in src/server/pilot/passbook.test.ts.
  ] as const)('allows an authorized %s to receive the scoped coach observations and progression gaps in the book', async (role, identity) => {
    const actor = principal({ role, ...identity });
    mockRequirePrincipal.mockResolvedValueOnce(actor);
    mockAssertAccess.mockResolvedValueOnce(undefined);
    mockGetPassbook.mockResolvedValueOnce({
      athlete: { athlete_id: 'ath-1' },
      pages: {
        corner: { observations: [{ note_id: 'note-1' }] },
        progression_gaps: [{ gap_id: 'gap-1' }],
      },
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAssertAccess).toHaveBeenCalledWith(actor, 'ath-1');
    expect(body.passbook.pages.corner.observations).toEqual([{ note_id: 'note-1' }]);
    expect(body.passbook.pages.progression_gaps).toEqual([{ gap_id: 'gap-1' }]);
  });

  test('does not disclose whether an authorized-scope lookup is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAssertAccess.mockResolvedValueOnce(undefined);
    mockGetPassbook.mockResolvedValueOnce(null);

    const response = await GET(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  });

  test('stops before reading when the shared athlete-access guard refuses', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: parent not linked to athlete'));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockGetPassbook).not.toHaveBeenCalled();
  });

  /* OD-2026-09-30-004 d3 (owner chose A): a linked guardian's book matches
     ParentDigest -- the child's name and the completed-session count, and no
     dated rows of any kind. getGuardianPassbook is the real module here, over
     a mocked database, so this is what a parent's request actually returns.
     On main this route handed a guardian getAthletePassbook's full book. */
  describe('a linked guardian receives the ParentDigest-shaped book only', () => {
    // Implementations queued here must not outlive the case that queued them:
    // on a route that never calls one of these, a leftover would leak forward.
    afterEach(() => {
      mockGetPassbook.mockReset();
      mockQuery.mockReset();
      mockQueryOne.mockReset();
    });

    function asGuardian() {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'parent-account-1', role: 'parent', athleteId: null }));
      mockAssertAccess.mockResolvedValueOnce(undefined);
    }

    test('returns name and completed-session count, never the full book', async () => {
      asGuardian();
      // What the full book would carry, so a route that still reached for it
      // would put dated rows in the body this test reads.
      mockGetPassbook.mockResolvedValueOnce({
        athlete: { athlete_id: 'ath-1', full_name: 'Avery Boxer', dob: '2012-05-01' },
        pages: { sessions: [{ session_id: 'session-1', date: '2026-08-03', rpe: 6, completed_flag: true }] },
      });
      mockQueryOne
        .mockResolvedValueOnce({ organization_id: 'org-1', athlete_id: 'ath-1', full_name: 'Avery Boxer' })
        .mockResolvedValueOnce({ completed: '12' });

      const response = await GET(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        passbook: { athlete: { athlete_id: 'ath-1', full_name: 'Avery Boxer' }, completed_sessions: 12 },
      });
      expect(mockAssertAccess).toHaveBeenCalledWith(expect.objectContaining({ role: 'parent' }), 'ath-1');
      expect(mockGetPassbook).not.toHaveBeenCalled();
      // No row-returning read ran at all; the only sessions SQL is the count.
      expect(mockQuery).not.toHaveBeenCalled();
      const sessionSql = mockQueryOne.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('pilot.sessions'));
      expect(sessionSql).toHaveLength(1);
      expect(sessionSql[0]).toMatch(/select count\(\*\)/);
    });

    test('keeps a missing athlete hidden', async () => {
      asGuardian();
      mockQueryOne.mockResolvedValueOnce(null);

      const response = await GET(request());

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Not found' });
      expect(mockGetPassbook).not.toHaveBeenCalled();
    });
  });
});
