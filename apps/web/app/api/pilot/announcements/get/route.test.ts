import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { listAnnouncements, listLiveAnnouncements } from '@/src/server/pilot/announcements';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/announcements', () => ({
  listAnnouncements: jest.fn(),
  listLiveAnnouncements: jest.fn(),
  isAnnouncementPlacement: jest.requireActual('@/src/server/pilot/announcements').isAnnouncementPlacement,
  isAnnouncementKind: jest.requireActual('@/src/server/pilot/announcements').isAnnouncementKind,
  // The real projection, not a stub: these tests exist to prove what it
  // actually strips. A mocked one would assert nothing.
  projectAnnouncementForBoard: jest.requireActual('@/src/server/pilot/announcements').projectAnnouncementForBoard,
}));

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

  test('the live view strips them too, and it has no role check at all', async () => {
    // This path calls requirePrincipal and nothing else, so every authenticated
    // principal reaches it. Projecting only the authoring view would leave the
    // same fields reachable through the weaker gate.
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
