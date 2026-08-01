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
