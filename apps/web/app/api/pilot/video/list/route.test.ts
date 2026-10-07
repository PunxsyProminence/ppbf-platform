import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';
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

// The tagged-clip predicate (videoClipTags.ts). Doubled with a sentinel so
// these tests can see WHERE it lands; the embedded-pg suite proves the real
// predicate, and that it is empty before the migration is applied.
const UNTAGGED_SENTINEL = 'and /*UNTAGGED_ONLY*/ true';
jest.mock('@/src/server/pilot/videoClipTags', () => ({
  untaggedVideoSql: jest.fn(async () => 'and /*UNTAGGED_ONLY*/ true'),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function request(url = 'http://localhost/api/pilot/video/list') {
  return new NextRequest(url);
}

describe('GET /api/pilot/video/list', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  test('403 for volunteer', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'volunteer' }));
    const res = await GET(request());
    expect(res.status).toBe(403);
  });

  test('403 for staff', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'staff' }));
    const res = await GET(request());
    expect(res.status).toBe(403);
  });

  test('athlete sees only their own videos', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // live athlete row
    mockQuery.mockResolvedValueOnce([{ video_session_id: 'v1', athlete_id: 'ath-1' }]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'ready'"), ['org-1', 'ath-1', 50]);
  });

  test("a deleted athlete's surviving session is refused before any video is read", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce(null); // no live row: deleted_at is set
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: athlete does not belong to organization' });
    expect(queryOne.mock.calls[0][1]).toEqual(['ath-1', 'org-1']);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('athlete without a linked athlete profile sees no videos', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: null }));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('400 when parent omits athlete_id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const res = await GET(request());
    expect(res.status).toBe(400);
  });

  test('parent linked to athlete succeeds', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ video_session_id: 'v1', athlete_id: 'ath-1' }]);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-1'));
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'ready'"), ['org-1', 'ath-1', 50]);
  });

  test('403 when parent is not linked to the athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce(null);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('coach with athlete_id for an assigned athlete succeeds', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ video_session_id: 'v1', athlete_id: 'ath-1' }]);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-1'));
    expect(res.status).toBe(200);
  });

  test('403 when coach requests an unassigned athlete (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce(null);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('coach without athlete_id sees their assigned athletes AND unassigned video', async () => {
    // The old name for this test said "scoped to assigned athletes only",
    // which the query has never done -- it also returns athlete_id is null.
    // A test name is where the next reader forms their belief about scope, so
    // it now says what the SQL actually does. The breadth is intended and
    // owner-confirmed (2026-08-08); see the route's own comment for why.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(request());
    expect(res.status).toBe(200);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toEqual(expect.stringContaining('coach_id = $2'));
    expect(sql).toEqual(expect.stringContaining('athlete_id is null'));
    expect(params).toEqual(['org-1', 'acct-1', 50]);
  });

  test('the coach listing deliberately does NOT pin status, unlike athlete and parent', async () => {
    // Pinning status = 'ready' here would hide a coach's own quarantined
    // upload from them -- it would simply never appear, with no explanation.
    // If someone ever "fixes" this branch to match the other two, this fails
    // and points them at the decision instead of letting it pass review.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQuery.mockResolvedValueOnce([]);
    await GET(request());

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toEqual(expect.stringContaining("status = 'ready'"));
  });

  /*
   * TEACH SHADOW FOOTAGE IS NOT FILM STUDY FOOTAGE, AND THIS IS THE READ SIDE
   * OF THAT.
   *
   * Teach Shadow capture stores an athlete_id -- it must, because the
   * guardian-consent sweep only runs for a video that names one -- so without
   * this filter a teaching example recorded on the gym floor appears in that
   * athlete's film library as though a coach had filmed it for review. The
   * recorders being separate does not separate anything if the reads mix.
   *
   * The organization-admin branch is asserted NOT to filter, in the same
   * breath, because that one feeds safeguarding review and a review that
   * cannot see every file in the organization has a blind spot somebody chose.
   */
  test.each([
    ['athlete', () => principal({ role: 'athlete', athleteId: 'ath-1' }), 'http://localhost/api/pilot/video/list'],
    ['parent', () => principal({ role: 'parent' }), 'http://localhost/api/pilot/video/list?athlete_id=ath-1'],
    ['coach asking about one athlete', () => principal({ role: 'coach' }), 'http://localhost/api/pilot/video/list?athlete_id=ath-1'],
    ['coach listing everything they may see', () => principal({ role: 'coach' }), 'http://localhost/api/pilot/video/list'],
  ])('a %s reading Film Study never sees Teach Shadow footage', async (_label, who, url) => {
    mockRequirePrincipal.mockResolvedValueOnce(who());
    // The parent and named-athlete branches pass through
    // assertActorCanAccessAthlete first, which reads the link with queryOne.
    // Answering it keeps these tests about the listing rather than about the
    // access check, which has its own tests above.
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValue({ athlete_id: 'ath-1', coach_id: 'acct-1' });
    mockQuery.mockResolvedValue([]);

    const res = await GET(request(url));

    expect(res.status).toBe(200);
    const listing = mockQuery.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('from pilot.video_sessions'));
    expect(listing).toContain('capture_take_id is null');
  });

  test('an admin opening Film Study gets the Film Study view, not everything', async () => {
    /*
     * THE DEFECT THIS REPLACED. The filter used to be decided by ROLE, so an
     * organization admin was handed every video -- but an admin is allowed on
     * /coach/video-analysis, which is Film Study and reads this same route.
     * The one person who can see everything therefore saw teaching footage in
     * the film library, which is exactly the blur the separation exists to
     * remove. Film Study is now the default for every role.
     */
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([]);

    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(String(mockQuery.mock.calls[0]![0])).toContain('capture_take_id is null');
  });

  test('safeguarding review asks for every file, and gets it', async () => {
    // /admin/video-review is the one surface that sends scope=all. A review
    // that could not see every file in the organization would have a blind
    // spot somebody chose.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([]);

    const res = await GET(request('http://localhost/api/pilot/video/list?scope=all'));

    expect(res.status).toBe(200);
    expect(String(mockQuery.mock.calls[0]![0])).not.toContain('capture_take_id is null');
  });

  test('a coach cannot ask for every file by naming the scope', async () => {
    // The parameter only ever narrows for everyone else; widening is not a
    // thing a client may request.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));

    const res = await GET(request('http://localhost/api/pilot/video/list?scope=all'));

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('an unrecognised scope is refused rather than quietly ignored', async () => {
    // Silently falling back would mean a surface that misspelled its intent
    // got a different list than it asked for and never found out.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));

    const res = await GET(request('http://localhost/api/pilot/video/list?scope=everything'));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('organization_admin gets org-wide access', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([{ video_session_id: 'v1' }, { video_session_id: 'v2' }]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
  });

  describe('limit validation', () => {
    test.each(['0', '-1', 'NaN', '3.5', 'abc', '999999999999999999999'])(
      '400 for an invalid limit=%s',
      async (rawLimit) => {
        mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
        const res = await GET(request(`http://localhost/api/pilot/video/list?limit=${rawLimit}`));
        expect(res.status).toBe(400);
      },
    );

    test('excessive limit is clamped to the safe maximum, not rejected', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
      mockQuery.mockResolvedValueOnce([]);
      const res = await GET(request('http://localhost/api/pilot/video/list?limit=100000'));
      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([100]));
    });
  });
});

/*
 * Tagged sparring and bout clips are STAFF ONLY (owner, 2026-10-03). A clip
 * uploaded under one athlete still carries that athlete_id, so without this
 * filter its title would show up in that athlete's and their parents' list.
 */
describe('GET /api/pilot/video/list tagged clips', () => {
  test('the athlete list leaves tagged clips out', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // live athlete row
    mockQuery.mockResolvedValueOnce([]);
    await GET(request());
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining(UNTAGGED_SENTINEL), ['org-1', 'ath-1', 50]);
  });

  test('the parent list leaves tagged clips out', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([]);
    await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-1'));
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining(UNTAGGED_SENTINEL), ['org-1', 'ath-1', 50]);
  });

  test('staff lists are not filtered: coaches review tagged clips', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([]);
    await GET(request());
    expect(mockQuery.mock.calls[0][0]).not.toContain(UNTAGGED_SENTINEL);
  });
});

/*
 * WHAT A FAMILY RECEIVES FROM THE LIST (videoFamilyView.ts, OD-2026-10-06-025).
 * Metadata only: the coach's notes travel with the single-video read after
 * the playback consent check, and the coach's account id never travels to a
 * family at all. Staff still get the storage row.
 */
describe('GET /api/pilot/video/list family projection', () => {
  const storedRow = {
    video_session_id: 'v1',
    title: 'Sparring round 3',
    notes: 'Guard dropped in round 2.',
    file_name: 'r3.mp4',
    file_size_bytes: 100,
    mime_type: 'video/mp4',
    status: 'ready',
    scan_state: 'clean',
    athlete_id: 'ath-1',
    uploaded_by_account_id: 'coach-acct-1',
    created_at: '2026-01-01T00:00:00.000Z',
  };

  test('the athlete list carries no notes and no coach account id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([storedRow]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Sparring round 3');
    expect(body.items[0]).not.toHaveProperty('notes');
    expect(body.items[0]).not.toHaveProperty('uploaded_by_account_id');
    expect(JSON.stringify(body)).not.toContain('coach-acct-1');
    expect(JSON.stringify(body)).not.toContain('Guard dropped');
  });

  test("the parent list of their child's film carries no notes and no coach account id", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([storedRow]);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).not.toHaveProperty('notes');
    expect(body.items[0]).not.toHaveProperty('uploaded_by_account_id');
    expect(JSON.stringify(body)).not.toContain('coach-acct-1');
  });

  test('a coach still receives the storage row, notes and uploader included', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    queryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([storedRow]);
    const res = await GET(request('http://localhost/api/pilot/video/list?athlete_id=ath-1'));
    const body = await res.json();
    expect(body.items[0].notes).toBe('Guard dropped in round 2.');
    expect(body.items[0].uploaded_by_account_id).toBe('coach-acct-1');
  });
});
