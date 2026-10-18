import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listOwnReplyReads, recordFamilyReplyRead } from '@/src/server/pilot/familyReplyReads';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// requireRole stays real; the athlete gate is faked at its contract. The
// gym- and reader-scoped SQL itself is proved on Postgres in
// familyReplyReadState.pg.test.ts. (#1542's track, FC-09b)
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/familyReplyReads', () => ({
  listOwnReplyReads: jest.fn(),
  recordFamilyReplyRead: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockList = listOwnReplyReads as jest.Mock;
const mockRecord = recordFamilyReplyRead as jest.Mock;

const REPLY = '44444444-4444-4444-8444-444444444444';

afterEach(() => {
  jest.clearAllMocks();
});

function principal(role: string): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

function getRequest(query = '?athlete_id=ath-1') {
  return new NextRequest(`http://localhost/api/pilot/coach/family-reply-reads${query}`);
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/pilot/coach/family-reply-reads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/pilot/coach/family-reply-reads (FC-09b)', () => {
  test.each(['coach', 'organization_admin', 'admin'])('%s reads their own seen replies, for an athlete of their own gym', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockAccess.mockResolvedValue(undefined);
    mockList.mockResolvedValue([{ reply_id: REPLY }]);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ reply_id: REPLY }] });
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'ath-1');
    // The gym and the reader are the session's, never the request's.
    expect(mockList).toHaveBeenCalledWith('org-1', 'acct-1', 'ath-1');
  });

  test('an account or gym named in the query is ignored', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAccess.mockResolvedValue(undefined);
    mockList.mockResolvedValue([]);

    await GET(getRequest('?athlete_id=ath-1&account_id=acct-other&organization_id=org-other'));

    expect(mockList).toHaveBeenCalledWith('org-1', 'acct-1', 'ath-1');
  });

  test.each(['athlete', 'parent', 'platform_owner'])('%s is refused and nothing is read', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('when the athlete gate refuses (another gym), nothing is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAccess.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));

    const response = await GET(getRequest('?athlete_id=ath-elsewhere'));

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an athlete id is required', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await GET(getRequest(''));

    expect(response.status).toBe(400);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  test('signed out is 401 and nothing is read', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/coach/family-reply-reads (FC-09b)', () => {
  test.each(['coach', 'organization_admin', 'admin'])('%s records a read as themselves, in their own gym', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockRecord.mockResolvedValue({ reply_id: REPLY });

    const response = await POST(postRequest({ reply_id: REPLY, account_id: 'acct-other', organization_id: 'org-other' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, read: { reply_id: REPLY } });
    expect(mockRecord).toHaveBeenCalledWith({ organizationId: 'org-1', accountId: 'acct-1', role }, REPLY);
  });

  test.each(['athlete', 'parent', 'platform_owner'])('%s is refused and nothing is written', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await POST(postRequest({ reply_id: REPLY }));

    expect(response.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each([[{}], [{ reply_id: '' }], [{ reply_id: 7 }]])('a missing reply id is 400 and nothing is written (%j)', async (body) => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await POST(postRequest(body));

    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test("a reply not in the caller's gym is the server's 404", async () => {
    const { NotFoundError } = jest.requireActual('@/src/server/pilot/errors');
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockRecord.mockRejectedValue(new NotFoundError('Not found: that reply is not in your gym.'));

    const response = await POST(postRequest({ reply_id: REPLY }));

    expect(response.status).toBe(404);
  });
});
