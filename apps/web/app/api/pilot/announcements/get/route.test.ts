import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { listAnnouncements, listAuthoredAnnouncementIds, listLiveAnnouncements } from '@/src/server/pilot/announcements';
import { listSeatsForAccount } from '@/src/server/pilot/boardSeats';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/announcements', () => ({
  listAnnouncements: jest.fn(),
  listLiveAnnouncements: jest.fn(),
  listAuthoredAnnouncementIds: jest.fn().mockResolvedValue([]),
  isAnnouncementPlacement: jest.requireActual('@/src/server/pilot/announcements').isAnnouncementPlacement,
  isAnnouncementKind: jest.requireActual('@/src/server/pilot/announcements').isAnnouncementKind,
  // The real projection, not a stub: these tests exist to prove what it
  // actually strips. A mocked one would assert nothing.
  projectAnnouncementForBoard: jest.requireActual('@/src/server/pilot/announcements').projectAnnouncementForBoard,
}));

jest.mock('@/src/server/pilot/boardSeats', () => ({
  listSeatsForAccount: jest.fn().mockResolvedValue([]),
}));

const mockListAuthored = listAuthoredAnnouncementIds as jest.Mock;
const mockListSeats = listSeatsForAccount as jest.Mock;
const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockListAnnouncements = listAnnouncements as jest.MockedFunction<typeof listAnnouncements>;
const mockListLiveAnnouncements = listLiveAnnouncements as jest.MockedFunction<typeof listLiveAnnouncements>;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token-1',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function request(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/pilot/announcements/get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pilot/announcements/get', () => {
  test('rejects an unauthenticated caller without reading any announcements', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const res = await POST(request({ organization_id: 'org-2', limit: 5 }));

    expect(res.status).toBe(401);
    expect(mockListLiveAnnouncements).not.toHaveBeenCalled();
    expect(mockListAnnouncements).not.toHaveBeenCalled();
  });

  test('ignores a caller-supplied organization_id and scopes to the principal organization', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(
      principal({ accountId: 'athlete-1', role: 'athlete', athleteId: 'ath-1', authProvider: 'ppbf_local' }),
    );
    mockListLiveAnnouncements.mockResolvedValueOnce([]);

    const res = await POST(request({ organization_id: 'org-2', limit: 5 }));

    expect(res.status).toBe(200);
    expect(mockListLiveAnnouncements).toHaveBeenCalledWith('org-1', {
      placement: 'gym_notices',
      kind: 'notice',
      limit: 5,
    });
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      organization_id: 'org-1',
    });
  });

  test('reads the requested placement and kind', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockListLiveAnnouncements.mockResolvedValueOnce([]);

    const res = await POST(request({ placement: 'coach_workspace', kind: 'motivation', limit: 3 }));

    expect(res.status).toBe(200);
    expect(mockListLiveAnnouncements).toHaveBeenCalledWith('org-1', {
      placement: 'coach_workspace',
      kind: 'motivation',
      limit: 3,
    });
  });

  test('refuses a placement or kind outside the stored vocabulary', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ placement: 'billboard' }));

    expect(res.status).toBe(400);
    expect(mockListLiveAnnouncements).not.toHaveBeenCalled();
  });

  // The default read is the only one a member gets, and it must never carry an
  // item that is retired, expired, or not yet in its window.
  test('an athlete cannot open the authoring view that returns unpublished items', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(
      principal({ accountId: 'athlete-1', role: 'athlete', athleteId: 'ath-1', authProvider: 'ppbf_local' }),
    );

    const res = await POST(request({ view: 'authoring' }));

    expect(res.status).toBe(403);
    expect(mockListAnnouncements).not.toHaveBeenCalled();
  });

  test('a coach opening the authoring view gets the unfiltered organization list', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockListAnnouncements.mockResolvedValueOnce([]);

    const res = await POST(request({ view: 'authoring' }));

    expect(res.status).toBe(200);
    expect(mockListAnnouncements).toHaveBeenCalledWith('org-1', 25);
    expect(mockListLiveAnnouncements).not.toHaveBeenCalled();
  });
});

/**
 * The board boundary, asserted on the API RESPONSE rather than on the DOM.
 *
 * No test anywhere put a board principal in front of this endpoint and looked
 * at the keys. The only board assertion that existed was a DOM one --
 * boardSeatEvidence.test.tsx checks the rendered page does not show the text --
 * and its own fixtures feed `message` and `author_name` into the mocked fetch,
 * so the authors knew the API returned them. The redaction was a TypeScript
 * interface, erased at compile time; the payload crossed the wire regardless,
 * and /notices rendered both fields to the same role in a visible ledger.
 *
 * These assert on Object.keys of the response, so they fail if any future
 * change puts the fields back by any route.
 */
describe('the board aggregate-only boundary, on the wire', () => {
  const FULL_ROW = {
    announcement_id: 'ann-1',
    organization_id: 'org-1',
    message: 'Congratulations to Maya R. on her first bout.',
    author_name: 'Coach Jason',
    author_role: 'coach',
    created_at: '2026-08-01T00:00:00Z',
    placement: 'gym_notices',
    kind: 'notice',
    active: true,
    starts_at: null,
    ends_at: null,
  };

  test('the authoring view strips message and author_name for a board principal', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'board', accountId: 'board-1' }));
    mockListAnnouncements.mockResolvedValueOnce([FULL_ROW] as never);

    const body = await (await POST(request({ view: 'authoring' }))).json();

    expect(Object.keys(body.announcements[0])).not.toContain('message');
    expect(Object.keys(body.announcements[0])).not.toContain('author_name');
    // The whole serialized payload, not just the keys: a nested copy would
    // still be a disclosure.
    expect(JSON.stringify(body)).not.toContain('Maya R.');
    expect(JSON.stringify(body)).not.toContain('Coach Jason');
  });

  test('the live view strips them too', async () => {
    // Every authenticated principal reaches this path, each for its own
    // placements. Projecting only the authoring view would leave the same
    // fields reachable through the weaker gate.
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'board', accountId: 'board-1' }));
    mockListLiveAnnouncements.mockResolvedValueOnce([FULL_ROW] as never);

    const body = await (await POST(request({}))).json();

    expect(JSON.stringify(body)).not.toContain('Maya R.');
    expect(JSON.stringify(body)).not.toContain('Coach Jason');
  });

  test('board still receives the governance fields it is entitled to', async () => {
    // Guards against "fixing" this by returning nothing. Board oversight needs
    // to know a notice exists, when, where, and from which ROLE.
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'board', accountId: 'board-1' }));
    mockListAnnouncements.mockResolvedValueOnce([FULL_ROW] as never);

    const body = await (await POST(request({ view: 'authoring' }))).json();

    expect(body.announcements[0]).toMatchObject({
      announcement_id: 'ann-1',
      author_role: 'coach',
      placement: 'gym_notices',
      active: true,
    });
  });

  test('a coach is unaffected and still reads the full row', async () => {
    // The projection is keyed on the board role. Narrowing every reader would
    // break the authoring surfaces this endpoint exists to serve.
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockListAnnouncements.mockResolvedValueOnce([FULL_ROW] as never);

    const body = await (await POST(request({ view: 'authoring' }))).json();

    expect(body.announcements[0].message).toBe('Congratulations to Maya R. on her first bout.');
    expect(body.announcements[0].author_name).toBe('Coach Jason');
  });
});

/*
 * CL-A8: the authoring view tells the page what this caller may DO, so it
 * does not offer a seat the post route will refuse or a Retire the update
 * route will refuse. Both are top-level arrays, not row fields, so the board
 * projection's allow-list above is untouched.
 */
describe('what the authoring view says this caller may do', () => {
  const ROW = (id: string) => ({
    announcement_id: id,
    organization_id: 'org-1',
    message: 'm',
    author_name: 'n',
    author_role: 'coach',
    created_at: '2026-08-01T00:00:00Z',
    placement: 'gym_notices',
    kind: 'notice',
    active: true,
    starts_at: null,
    ends_at: null,
  });

  test('a coach may edit only the notices they posted, and signs as no seat', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockListAnnouncements.mockResolvedValueOnce([ROW('ann-1'), ROW('ann-2')] as never);
    mockListAuthored.mockResolvedValueOnce(['ann-2']);

    const body = await (await POST(request({ view: 'authoring' }))).json();

    expect(mockListAuthored).toHaveBeenCalledWith('org-1', 'coach-1', ['ann-1', 'ann-2']);
    expect(body.editable_announcement_ids).toEqual(['ann-2']);
    expect(body.author_seats).toEqual([]);
    expect(mockListSeats).not.toHaveBeenCalled();
  });

  test.each(['organization_admin', 'admin'] as const)('an %s may edit every notice listed', async (role) => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role, accountId: 'admin-1' }));
    mockListAnnouncements.mockResolvedValueOnce([ROW('ann-1'), ROW('ann-2')] as never);

    const body = await (await POST(request({ view: 'authoring' }))).json();

    expect(body.editable_announcement_ids).toEqual(['ann-1', 'ann-2']);
    expect(mockListAuthored).not.toHaveBeenCalled();
  });

  test('a board member is offered only the seats they hold, held-outright first', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'board', accountId: 'board-1' }));
    mockListAnnouncements.mockResolvedValueOnce([ROW('ann-1')] as never);
    mockListAuthored.mockResolvedValueOnce([]);
    mockListSeats.mockResolvedValueOnce([
      { seat: 'treasurer', is_primary: true },
      { seat: 'secretary', is_primary: false },
    ]);

    const body = await (await POST(request({ view: 'authoring' }))).json();

    expect(mockListSeats).toHaveBeenCalledWith('org-1', 'board-1');
    expect(body.author_seats).toEqual(['board-treasurer', 'board-secretary']);
    expect(body.editable_announcement_ids).toEqual([]);
  });

  test('the live view carries neither', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockListLiveAnnouncements.mockResolvedValueOnce([ROW('ann-1')] as never);

    const body = await (await POST(request({}))).json();

    expect(body).not.toHaveProperty('editable_announcement_ids');
    expect(body).not.toHaveProperty('author_seats');
  });
});

/**
 * WHICH PLACEMENTS EACH ROLE MAY ASK THE LIVE READ FOR (issue #1475 Part B).
 *
 * The placement comes from the request body. Checked on the live app as the
 * test athlete: asking for 'coach_workspace' or 'parent_hub' answered 200. A
 * notice body can name an athlete, and the Customize screen tells the admin
 * that the coaches' board reaches coaches only and the parents' board reaches
 * guardians only.
 *
 * The table is written out here in full rather than imported from the route,
 * so a row changed there fails here. A refused pair must answer exactly as a
 * word that is no placement at all, and must not read anything.
 */
describe('which placements each role may ask the live read for', () => {
  const PLACEMENTS = ['gym_notices', 'athlete_workspace', 'coach_workspace', 'parent_hub', 'everywhere'];

  const ALLOWED: Record<string, string[]> = {
    coach: PLACEMENTS,
    organization_admin: PLACEMENTS,
    // The legacy row name for organization_admin.
    admin: PLACEMENTS,
    platform_owner: PLACEMENTS,
    board: PLACEMENTS,
    athlete: ['athlete_workspace', 'gym_notices', 'everywhere'],
    parent: ['parent_hub', 'gym_notices', 'everywhere'],
    staff: ['gym_notices', 'everywhere'],
    volunteer: ['gym_notices', 'everywhere'],
  };

  const PAIRS = Object.entries(ALLOWED).flatMap(([role, allowed]) =>
    PLACEMENTS.map((placement) => [role, placement, allowed.some((item) => item === placement)] as const),
  );

  const asRole = (role: string) => principal({ role, accountId: `${role}-1` } as Partial<PilotPrincipal>);

  test('the table covers nine roles and all five placements, and refuses some pair', () => {
    expect(Object.keys(ALLOWED)).toHaveLength(9);
    expect(PAIRS).toHaveLength(45);
    expect(PAIRS.filter(([, , allowed]) => !allowed)).toHaveLength(10);
  });

  test.each(PAIRS.filter(([, , allowed]) => allowed))('%s may read %s', async (role, placement) => {
    mockResolvePrincipal.mockResolvedValueOnce(asRole(role));
    mockListLiveAnnouncements.mockResolvedValueOnce([]);

    const res = await POST(request({ placement }));

    expect(res.status).toBe(200);
    expect(mockListLiveAnnouncements).toHaveBeenCalledWith('org-1', { placement, kind: 'notice', limit: 8 });
  });

  test.each(PAIRS.filter(([, , allowed]) => !allowed))(
    '%s asking for %s is answered exactly as an unknown placement, and nothing is read',
    async (role, placement) => {
      mockResolvePrincipal.mockResolvedValueOnce(asRole(role));
      const unknown = await POST(request({ placement: 'billboard' }));

      mockResolvePrincipal.mockResolvedValueOnce(asRole(role));
      const refused = await POST(request({ placement }));

      expect(unknown.status).toBe(400);
      expect(refused.status).toBe(unknown.status);
      expect(await refused.text()).toBe(await unknown.text());
      expect(mockListLiveAnnouncements).not.toHaveBeenCalled();
    },
  );

  test('the motivation kind follows the same table', async () => {
    // The chalkboard reads kind 'motivation'; the table is about the placement.
    mockResolvePrincipal.mockResolvedValueOnce(asRole('athlete'));
    expect((await POST(request({ placement: 'coach_workspace', kind: 'motivation' }))).status).toBe(400);

    mockResolvePrincipal.mockResolvedValueOnce(asRole('athlete'));
    mockListLiveAnnouncements.mockResolvedValueOnce([]);
    expect((await POST(request({ placement: 'athlete_workspace', kind: 'motivation' }))).status).toBe(200);
    expect(mockListLiveAnnouncements).toHaveBeenCalledTimes(1);
  });

  test('a request that names no placement reads gym_notices, which every role may', async () => {
    for (const role of Object.keys(ALLOWED)) {
      mockResolvePrincipal.mockResolvedValueOnce(asRole(role));
      mockListLiveAnnouncements.mockResolvedValueOnce([]);

      expect((await POST(request({}))).status).toBe(200);
    }
    expect(mockListLiveAnnouncements).toHaveBeenCalledTimes(9);
  });
});
