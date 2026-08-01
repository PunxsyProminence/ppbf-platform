import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  // The assignment insert and the gap's status change have to commit together,
  // so both statements run on a transaction client rather than the module's
  // query(). The fake hands the callback a client whose query() is the same
  // spy, keeping the call assertions meaningful.
  withTransaction: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;

beforeEach(() => {
  // A transaction client returns the pg Result shape ({ rows }), unlike the
  // module's query() which returns the rows array directly.
  mockWithTransaction.mockImplementation(
    (work: (client: { query: jest.Mock }) => Promise<unknown>) => work({
      query: jest.fn(async (...args: unknown[]) => ({ rows: (await mockQuery(...args)) ?? [] })) as jest.Mock,
    }),
  );
});

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

  test('linked parent can read assignments for their athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // guardian link found
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(200);
  });

  test('unlinked parent is denied', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce(null); // no guardian link
    const res = await GET(getRequest('athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/pilot/progression/assignments', () => {
  test('parent cannot create an assignment (writes remain denied)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    const res = await POST(
      postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', drill_name: 'd', drill_description: 'x' }),
    );
    expect(res.status).toBe(403);
  });

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
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce({ gap_id: 'gap-1', athlete_id: 'ath-1' }); // getProgressionGapById
    mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-1' }]).mockResolvedValueOnce([]);
    const res = await POST(
      postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', drill_name: 'd', drill_description: 'x' }),
    );
    expect(res.status).toBe(201);
  });

  test('cross-organization gap_id returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce(null); // gap not found in this organization
    const res = await POST(
      postRequest({ athlete_id: 'ath-1', gap_id: 'gap-other-org', drill_name: 'd', drill_description: 'x' }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  // A coach picks a drill from the gym library instead of typing one out. The
  // drill's own wording is what gets recorded when the coach typed nothing.
  test('201 when a coach assigns a drill from the library by drill_id alone', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce({ gap_id: 'gap-1', athlete_id: 'ath-1' }) // getProgressionGapById
      .mockResolvedValueOnce({
        organization_id: 'org-1',
        drill_id: 'drill-jab',
        name: 'Straight Jab Retraction Snap',
        focus: 'Quick fist return to protect the chin.',
        difficulty: 'advanced',
        active: true,
      }); // getDrill
    mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-1' }]).mockResolvedValueOnce([]);

    const res = await POST(postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', drill_id: 'drill-jab' }));

    expect(res.status).toBe(201);
    const [, insertParams] = mockQuery.mock.calls[0];
    expect(insertParams[5]).toBe('Straight Jab Retraction Snap');
    expect(insertParams[6]).toBe('Quick fist return to protect the chin.');
    expect(insertParams[7]).toBe('advanced');
    expect(insertParams[12]).toBe('drill-jab');
  });

  // What the coach typed is the record of what was actually assigned that day,
  // so it is stored as typed even when the assignment also carries an anchor.
  test('keeps the wording a coach typed over the drill it anchors to', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ gap_id: 'gap-1', athlete_id: 'ath-1' })
      .mockResolvedValueOnce({
        organization_id: 'org-1',
        drill_id: 'drill-jab',
        name: 'Straight Jab Retraction Snap',
        focus: 'Quick fist return to protect the chin.',
        difficulty: 'intermediate',
        active: true,
      });
    mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-1' }]).mockResolvedValueOnce([]);

    const res = await POST(postRequest({
      athlete_id: 'ath-1',
      gap_id: 'gap-1',
      drill_id: 'drill-jab',
      drill_name: 'Jab retraction (Tuesday floor)',
      drill_description: 'Three rounds, focus on the elbow',
    }));

    expect(res.status).toBe(201);
    const [, insertParams] = mockQuery.mock.calls[0];
    expect(insertParams[5]).toBe('Jab retraction (Tuesday floor)');
    expect(insertParams[6]).toBe('Three rounds, focus on the elbow');
    expect(insertParams[12]).toBe('drill-jab');
  });

  // The path every assignment written before drills had identity takes.
  test('a typed assignment still works and carries no anchor', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ gap_id: 'gap-1', athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-1' }]).mockResolvedValueOnce([]);

    const res = await POST(
      postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', drill_name: 'd', drill_description: 'x' }),
    );

    expect(res.status).toBe(201);
    const [, insertParams] = mockQuery.mock.calls[0];
    expect(insertParams[12]).toBeNull();
    // No drill was named, so none was looked up.
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
  });

  test('an assignment naming neither a drill nor a drill_name is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));

    const res = await POST(postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', drill_name: 'd' }));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a drill_id from another organization returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ gap_id: 'gap-1', athlete_id: 'ath-1' })
      .mockResolvedValueOnce(null); // no such drill in this organization

    const res = await POST(postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', drill_id: 'drill-other-org' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // Retiring is how a gym stops teaching a drill; a new assignment must not
  // quietly revive it.
  test('a retired drill cannot be newly assigned', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ gap_id: 'gap-1', athlete_id: 'ath-1' })
      .mockResolvedValueOnce({
        organization_id: 'org-1',
        drill_id: 'drill-retired',
        name: 'Retired Drill',
        focus: 'No longer taught.',
        difficulty: 'intermediate',
        active: false,
      });

    const res = await POST(postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', drill_id: 'drill-retired' }));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a difficulty outside the shared vocabulary is refused before the write', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));

    const res = await POST(postRequest({
      athlete_id: 'ath-1',
      gap_id: 'gap-1',
      drill_name: 'd',
      drill_description: 'x',
      drill_difficulty: 'expert',
    }));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('gap belonging to another athlete returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete for ath-1
      .mockResolvedValueOnce({ gap_id: 'gap-1', athlete_id: 'ath-2' }); // gap belongs to a different athlete
    const res = await POST(
      postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', drill_name: 'd', drill_description: 'x' }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});
