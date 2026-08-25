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

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/publications/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(query_?: string) {
  return new NextRequest(`http://localhost/api/pilot/publications/create${query_ ? `?${query_}` : ''}`);
}

// Math.min(parseInt(...) || 50, 100) never rejected a negative limit --
// `-5 || 50` stays -5 since a negative number is truthy, and Math.min only
// clamps the UPPER bound -- so it reached Postgres and crashed with an
// unhandled "LIMIT must not be negative", masked as a generic 500.
describe('GET /api/pilot/publications/create (list)', () => {
  test('a negative limit is rejected with 400, never reaches the database', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));

    const res = await GET(getRequest('limit=-5'));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a valid limit still lists publications', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    // FIXTURE REPAIR, not a weakened assertion: a coach's list is now scoped
    // to the athletes they can currently reach, so the route makes ONE
    // reachability round trip (athleteIdsForCoach) before the publications
    // read. The first queued result answers that lookup; the second is the
    // publications read this test has always been about, and the assertion on
    // it below is unchanged.
    mockQuery
      .mockResolvedValueOnce([{ athlete_id: 'ath-1' }])
      .mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    const res = await GET(getRequest('limit=10'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ publication_id: 'pub-1' }] });
  });
});

// ---------------------------------------------------------------------------
// THE DEFECT THIS BLOCK PINS
//
// GET called getOrganizationPublications(principal.organizationId, ...), whose
// SQL is `where organization_id = $1` and nothing else, for EVERY allowed role
// -- coaches included. Its sibling GET /api/pilot/video/list scopes the SAME
// footage for a coach in SQL to
//
//   athlete_id in (select athlete_id from pilot.athletes where coach_id = $2)
//
// so a coach deliberately refused a minor's video row could still read that
// video's publication: publication_id, video_session_id, athlete_id, title,
// description, and -- the part that matters most for a child -- status and
// compliance_check_status, i.e. where that footage stands in the consent and
// compliance workflow. Disclosure rather than takeover (submit and publish
// both gate on submitted_by_account_id or org admin), but what is disclosed is
// a minor's footage and its consent state.
//
// The fix scopes a coach's read to the athletes they can reach AT THIS MOMENT
// -- athleteIdsForCoach: coach of record, plus coverage grants that have
// started and have not expired -- as a predicate on the read itself, rather
// than by filtering rows the database has already handed over.
//
// Org admins are deliberately NOT scoped: for that role
// assertActorCanAccessAthlete IS assertAthleteBelongsToOrganization, so the
// organization filter already is the per-athlete gate, and the admin
// compliance console depends on that reach (owner decision, 2026-08-14).
// ---------------------------------------------------------------------------

const OWN_PUBLICATION = {
  publication_id: 'pub-mine',
  video_session_id: 'vid-mine',
  athlete_id: 'ath-mine',
  submitted_by_account_id: 'acct-1',
  title: 'Jab mechanics',
  status: 'draft',
  compliance_check_status: 'pending',
};

// A child on another coach's roster. Everything on this row is what the attack
// reads: the id of their footage, and the fact that its compliance check has
// passed.
const VICTIM_PUBLICATION = {
  publication_id: 'pub-victim',
  video_session_id: 'vid-victim',
  athlete_id: 'ath-victim',
  submitted_by_account_id: 'acct-other-coach',
  title: 'Sparring - rib guard',
  status: 'approved',
  compliance_check_status: 'passed',
};

const ALL_PUBLICATIONS = [OWN_PUBLICATION, VICTIM_PUBLICATION];

const ATHLETE_SCOPE_PREDICATE = /athlete_id = any\(\$(\d+)/;

// Stands in for Postgres on pilot.video_publications, honouring exactly the
// one predicate this defect is about: when the statement carries
// `athlete_id = any($n)` only the bound ids come back; when it does not, the
// whole organization comes back -- which is precisely what the unfixed route
// received. A "fix" that filtered in the route instead of in SQL, or that
// dropped the predicate for an empty scope, fails here rather than passing.
function publicationRowsFor(sql: string, params: unknown[]) {
  const match = sql.match(ATHLETE_SCOPE_PREDICATE);
  if (!match) {
    return ALL_PUBLICATIONS;
  }
  const scoped = params[Number(match[1]) - 1] as string[];
  return ALL_PUBLICATIONS.filter((row) => scoped.includes(row.athlete_id));
}

// access.ts is NOT mocked here, so the reachability lookup runs for real
// against this same fake database -- including its live `starts_at <= now()`
// / `expires_at > now()` predicates, which is how a lapsed or revoked coverage
// grant stops working with no cleanup job.
function databaseWithReachableAthletes(reachable: string[]) {
  return (sql: string, params: unknown[] = []) => {
    if (sql.includes('pilot.coach_coverage')) {
      return Promise.resolve(reachable.map((athlete_id) => ({ athlete_id })));
    }
    if (sql.includes('pilot.video_publications')) {
      return Promise.resolve(publicationRowsFor(sql, params));
    }
    throw new Error(`unexpected statement in this test: ${sql}`);
  };
}

function publicationsCall() {
  const call = mockQuery.mock.calls.find(([text]) => String(text).includes('pilot.video_publications'));
  if (!call) {
    throw new Error('the route never read pilot.video_publications');
  }
  return { sql: String(call[0]), params: call[1] as unknown[] };
}

function idsFrom(payload: unknown) {
  return (payload as { items: Array<{ publication_id: string }> }).items.map((item) => item.publication_id);
}

describe('GET /api/pilot/publications/create -- a coach reads only their own athletes', () => {
  // mockImplementation and any un-consumed mockResolvedValueOnce survive
  // jest.clearAllMocks(), which clears call records only. Reset on both sides
  // so each test here starts from a database that answers exactly what it was
  // given, and so no fake database leaks into the POST suite below.
  beforeEach(() => {
    mockQuery.mockReset();
  });

  afterEach(() => {
    mockQuery.mockReset();
  });

  // THE ATTACK: coach acct-1, holding nothing but a coach session in org-1 and
  // no relationship of any kind to ath-victim, calls
  // GET /api/pilot/publications/create with no parameters and reads
  // ath-victim's publication row -- the same child whose video row
  // GET /api/pilot/video/list withholds from them.
  test('a coach cannot read the publication of a child they cannot reach', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', accountId: 'acct-1' }));
    mockQuery.mockImplementation(databaseWithReachableAthletes(['ath-mine']));

    const res = await GET(getRequest());
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(idsFrom(payload)).toEqual(['pub-mine']);
    // Nothing of the other child's record survives anywhere in the response:
    // not the athlete id, not the id of their footage, not its consent state.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('ath-victim');
    expect(serialized).not.toContain('vid-victim');
    expect(serialized).not.toContain('pub-victim');

    // And it was refused IN SQL: the read itself carried the athlete
    // predicate, bound to exactly the reachable set.
    const { sql, params } = publicationsCall();
    expect(sql).toMatch(ATHLETE_SCOPE_PREDICATE);
    expect(params).toContainEqual(['ath-mine']);
  });

  // The legitimate path, and the reason reachability is re-read per request: a
  // covering coach must see what they are entitled to for exactly as long as
  // the grant is live.
  test('an active coverage grant reaches that athlete, and the grant is re-read live on every request', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', accountId: 'acct-1' }));
    mockQuery.mockImplementation(databaseWithReachableAthletes(['ath-mine', 'ath-victim']));

    const res = await GET(getRequest());

    expect(res.status).toBe(200);
    expect(idsFrom(await res.json())).toEqual(['pub-mine', 'pub-victim']);

    const reachabilitySql = String(mockQuery.mock.calls[0][0]);
    expect(reachabilitySql).toContain('pilot.coach_coverage');
    expect(reachabilitySql).toContain('starts_at <= now()');
    expect(reachabilitySql).toContain('expires_at > now()');
  });

  // The fail-closed half of the same rule: when every grant has lapsed or been
  // revoked the reachable set is empty, and an empty scope must still BE a
  // scope. An implementation that treated `[]` as "no filter" would hand back
  // the whole organization at the exact moment access ended.
  test('a coach with no reachable athletes reads nothing, and the empty scope still reaches the SQL', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', accountId: 'acct-1' }));
    mockQuery.mockImplementation(databaseWithReachableAthletes([]));

    const res = await GET(getRequest());

    expect(res.status).toBe(200);
    expect(idsFrom(await res.json())).toEqual([]);

    const { sql, params } = publicationsCall();
    expect(sql).toMatch(ATHLETE_SCOPE_PREDICATE);
    expect(params).toContainEqual([]);
  });

  // Org-scoping IS the gate for this role, so the reach is unchanged and no
  // relationship table is consulted. Both spellings of the role, since legacy
  // 'admin' rows are still migrating.
  test.each(['organization_admin', 'admin'] as const)(
    'an %s still reads the whole organization and consults no relationship table',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));
      mockQuery.mockImplementation(databaseWithReachableAthletes([]));

      const res = await GET(getRequest());

      expect(res.status).toBe(200);
      expect(idsFrom(await res.json())).toEqual(['pub-mine', 'pub-victim']);
      expect(publicationsCall().sql).not.toMatch(ATHLETE_SCOPE_PREDICATE);
      expect(mockQuery.mock.calls.some(([text]) => String(text).includes('pilot.coach_coverage'))).toBe(false);
    },
  );

  // The scope is appended to a statement that builds its own placeholders, so
  // this pins that every $n still resolves to the parameter the caller meant:
  // a shifted binding would silently filter on the wrong value rather than
  // fail loudly.
  test('the athlete scope composes with the status and type filters without shifting a bound parameter', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', accountId: 'acct-1' }));
    mockQuery.mockImplementation(databaseWithReachableAthletes(['ath-mine']));

    await GET(getRequest('status=draft&publication_type=research_library&limit=10'));

    const { sql, params } = publicationsCall();
    expect(params).toEqual(['org-1', 'draft', 'research_library', ['ath-mine'], 10]);
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    expect(Math.max(...placeholders)).toBe(params.length);
  });
});

// A publication carries a named youth athlete's video into a research or
// public surface, so it must clear the same gates the violations route
// applies: the actor's access to the athlete, and the video session belonging
// to this organization and to that same athlete.
describe('POST /api/pilot/publications/create', () => {
  test('403 when a coach publishes an athlete they are not assigned to', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await POST(
      postRequest({ video_session_id: 'vid-1', athlete_id: 'ath-other', publication_type: 'research_library' }),
    );

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('403 when an organization_admin publishes an athlete from another organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await POST(
      postRequest({ video_session_id: 'vid-1', athlete_id: 'ath-other-org', publication_type: 'research_library' }),
    );

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('cross-organization video_session_id returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce(null); // video session not found in this org

    const res = await POST(
      postRequest({ video_session_id: 'vid-other-org', athlete_id: 'ath-1', publication_type: 'research_library' }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('video_session_id attributed to a different athlete returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-2' });

    const res = await POST(
      postRequest({ video_session_id: 'vid-1', athlete_id: 'ath-1', publication_type: 'research_library' }),
    );

    expect(res.status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('201 when the athlete is accessible and the video session matches', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-1', status: 'ready' });
    mockQuery.mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    const res = await POST(
      postRequest({
        video_session_id: 'vid-1',
        athlete_id: 'ath-1',
        publication_type: 'research_library',
        title: 'Jab mechanics',
      }),
    );

    expect(res.status).toBe(201);
  });

  // A publication drafted from unreleased footage would carry a quarantined --
  // or infected -- file all the way to a passing compliance check, because
  // every later step reads the publication row rather than the video.
  test('a video that has not been released cannot be drafted into a publication', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-1', status: 'quarantined' });

    const res = await POST(
      postRequest({
        video_session_id: 'vid-1',
        athlete_id: 'ath-1',
        publication_type: 'research_library',
        title: 'Jab mechanics',
      }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).video_status).toBe('quarantined');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
