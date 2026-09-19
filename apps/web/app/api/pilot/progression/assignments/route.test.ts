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
  // W-D3, OD-2026-09-18-001. Every new assignment is anchored to an ACTIVE
  // operational drill in the caller's gym, and its wording is snapshotted from
  // pilot.drills by assignDrill. These cases pin the ROUTE half of that; the
  // writer half is pinned in progression.test.ts, and what the SQL actually
  // refuses against a real database is pinned in coachCards.pg.test.ts and
  // drillsPersistence.pg.test.ts.
  //
  // queryOne order inside the route: assertActorCanAccessAthlete, then
  // getProgressionGapById, then getDrill. Every validation check runs before
  // the first of those, so a 400 case needs no queryOne at all.
  const ACTIVE_DRILL = {
    organization_id: 'org-1',
    drill_id: 'drill-jab',
    name: 'Straight Jab Retraction Snap',
    focus: 'Quick fist return to protect the chin.',
    difficulty: 'advanced',
    active: true,
  };

  function coach() {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
  }

  /** Access granted, gap found, and getDrill answering with `drill`. */
  function reachesTheDrill(drill: Record<string, unknown> | null) {
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertActorCanAccessAthlete
      .mockResolvedValueOnce({ gap_id: 'gap-1', athlete_id: 'ath-1' }) // getProgressionGapById
      .mockResolvedValueOnce(drill); // getDrill
  }

  const VALID = { athlete_id: 'ath-1', gap_id: 'gap-1', drill_id: 'drill-jab' };

  test('parent cannot create an assignment (writes remain denied)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    const res = await POST(postRequest(VALID));
    expect(res.status).toBe(403);
  });

  test('403 when coach assigns a drill to an unassigned athlete', async () => {
    coach();
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(postRequest({ ...VALID, athlete_id: 'ath-other' }));
    expect(res.status).toBe(403);
  });

  test("201 for an active operational drill in the caller's gym", async () => {
    coach();
    reachesTheDrill(ACTIVE_DRILL);
    mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-1' }]).mockResolvedValueOnce([]);

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(201);
    const [insertSql, insertParams] = mockQuery.mock.calls[0];
    expect(insertParams[1]).toBe('org-1');
    expect(insertParams[2]).toBe('drill-jab');
    expect(insertParams[3]).toBe('gap-1');
    expect(insertParams[4]).toBe('ath-1');
    // The wording is snapshotted from pilot.drills by the insert itself...
    expect(insertSql).toMatch(/from pilot\.drills d\s+where d\.organization_id = \$2 and d\.drill_id = \$3 and d\.active/);
    expect(insertSql).toContain('d.name, d.focus');
    // ...so there is no parameter carrying a name or a description.
    expect(insertParams).toHaveLength(11);
    expect(insertParams).not.toContain('Straight Jab Retraction Snap');
  });

  test("an explicit valid difficulty overrides the drill's; none lets the drill decide", async () => {
    coach();
    reachesTheDrill(ACTIVE_DRILL);
    mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-1' }]).mockResolvedValueOnce([]);
    await POST(postRequest({ ...VALID, drill_difficulty: 'beginner' }));
    expect(mockQuery.mock.calls[0][1][6]).toBe('beginner');

    mockQuery.mockClear();
    coach();
    reachesTheDrill(ACTIVE_DRILL);
    mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-2' }]).mockResolvedValueOnce([]);
    await POST(postRequest(VALID));
    expect(mockQuery.mock.calls[0][1][6]).toBeNull();
  });

  test('cross-organization gap_id returns a hidden not-found response', async () => {
    coach();
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertActorCanAccessAthlete
      .mockResolvedValueOnce(null); // gap not found in this organization
    const res = await POST(postRequest({ ...VALID, gap_id: 'gap-other-org' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('gap belonging to another athlete returns a hidden not-found response', async () => {
    coach();
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ gap_id: 'gap-1', athlete_id: 'ath-2' });
    const res = await POST(postRequest(VALID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  describe('drill_id is required, and must be a real string', () => {
    test.each([
      ['absent', {}],
      ['null', { drill_id: null }],
      ['an empty string', { drill_id: '' }],
      ['whitespace', { drill_id: '   ' }],
      // Used to reach `.trim()` on a number and 500 with a TypeError.
      ['a number', { drill_id: 42 }],
      ['an object', { drill_id: { id: 'drill-jab' } }],
    ])('%s -> 400 before any read or write', async (_label, drill) => {
      coach();
      const res = await POST(postRequest({ athlete_id: 'ath-1', gap_id: 'gap-1', ...drill }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'DRILL_ID_REQUIRED' });
      expect(mockQueryOne).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    // INVERTED. This case used to be 'a typed assignment still works and
    // carries no anchor' -- the very behaviour the owner ruling ends.
    test('the old free-text-only payload is refused, and nothing is written', async () => {
      coach();
      const res = await POST(postRequest({
        athlete_id: 'ath-1', gap_id: 'gap-1', drill_name: 'Jab discipline', drill_description: 'Three rounds',
      }));
      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('THE STALE-CLIENT RULE: typed drill wording is refused, not discarded', () => {
    test.each([
      ['drill_name', { drill_name: 'Jab retraction (Tuesday floor)' }],
      ['drill_description', { drill_description: 'Three rounds, focus on the elbow' }],
      ['both', { drill_name: 'Jab', drill_description: 'Three rounds' }],
      // A non-string is still an attempt to supply wording.
      ['a non-string drill_name', { drill_name: 7 }],
    ])('non-empty %s alongside a valid drill_id -> 400, nothing written', async (_label, text) => {
      coach();
      const res = await POST(postRequest({ ...VALID, ...text }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'DRILL_TEXT_NOT_ACCEPTED' });
      // Refused before the drill was even looked up -- silently accepting the
      // drill while dropping the coach's words is exactly what this prevents.
      expect(mockQueryOne).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('absent, null or empty legacy fields say nothing and are tolerated', async () => {
      coach();
      reachesTheDrill(ACTIVE_DRILL);
      mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-1' }]).mockResolvedValueOnce([]);
      const res = await POST(postRequest({ ...VALID, drill_name: '', drill_description: '   ' }));
      expect(res.status).toBe(201);

      coach();
      reachesTheDrill(ACTIVE_DRILL);
      mockQuery.mockResolvedValueOnce([{ assignment_id: 'asg-2' }]).mockResolvedValueOnce([]);
      const res2 = await POST(postRequest({ ...VALID, drill_name: null, drill_description: null }));
      expect(res2.status).toBe(201);
    });
  });

  describe('only an active operational drill in this gym can anchor', () => {
    test('a drill_id from another organization returns a hidden not-found response', async () => {
      coach();
      reachesTheDrill(null); // getDrill is org-scoped: another gym's drill is absent
      const res = await POST(postRequest({ ...VALID, drill_id: 'drill-other-org' }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('a reference-library id is not assignable, and reads exactly like an unknown id', async () => {
      // getDrill reads pilot.drills only, so a pilot.drill_library id finds
      // nothing -- the same hidden 404 as a drill that does not exist.
      coach();
      reachesTheDrill(null);
      const res = await POST(postRequest({ ...VALID, drill_id: 'drl_3c2aad1eb8baa9' }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('a retired drill cannot be newly assigned', async () => {
      coach();
      reachesTheDrill({ ...ACTIVE_DRILL, drill_id: 'drill-retired', active: false });
      const res = await POST(postRequest({ ...VALID, drill_id: 'drill-retired' }));
      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test("a drill retired between the route's check and the write is still refused", async () => {
      // The route saw an active drill; by the time the INSERT ... SELECT ran it
      // was retired, so the statement selected nothing. The writer refuses
      // rather than returning an empty assignment.
      coach();
      reachesTheDrill(ACTIVE_DRILL);
      mockQuery.mockResolvedValueOnce([]);
      const res = await POST(postRequest(VALID));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'DRILL_NOT_ASSIGNABLE' });
    });
  });

  test('a difficulty outside the shared vocabulary is refused before the write', async () => {
    coach();
    const res = await POST(postRequest({ ...VALID, drill_difficulty: 'expert' }));
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
