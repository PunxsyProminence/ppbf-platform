import { NextRequest } from 'next/server';

import { POST } from './route';
import { ForbiddenError, NotFoundError } from '@/src/server/pilot/errors';
import { recordFamilyThreadReadByStaff } from '@/src/server/pilot/familyThreads';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The post's athlete gate, "a guardian's post only" and the first time kept are proved on
// Postgres in familyThreadsStaff.pg.test.ts. Here: the role gate, the body, and that the route
// hands down the session's identity. (W4 item 4, PM-1c)
jest.mock('@/src/server/pilot/familyThreads', () => ({
  recordFamilyThreadReadByStaff: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockRecord = jest.mocked(recordFamilyThreadReadByStaff);

const POST_ID = '33333333-3333-4333-8333-333333333333';

function principal(role = 'coach') {
  return {
    accountId: 'staff-1',
    role,
    organizationId: 'org-1',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as never;
}

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/coach/family-thread-reads', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/coach/family-thread-reads (W4 item 4)', () => {
  test.each(['coach', 'organization_admin', 'admin'])('%s records their own read', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockRecord.mockResolvedValue({ post_id: POST_ID });
    const response = await post({ post_id: ` ${POST_ID} `, account_id: 'someone-else' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, read: { post_id: POST_ID } });
    expect(mockRecord).toHaveBeenCalledWith({ organizationId: 'org-1', accountId: 'staff-1', role }, POST_ID);
  });

  test.each([
    ['no post id', {}],
    ['a blank post id', { post_id: ' ' }],
    ['a non-string post id', { post_id: 7 }],
    ['no body', 'not json'],
  ])('%s is 400 and writes nothing', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    expect((await post(body)).status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each([
    ['a post out of reach', new NotFoundError('Not found: that message is not in your gym.'), 404],
    ['no active seat', new ForbiddenError('Forbidden: no active staff seat in this gym.'), 403],
  ])('%s keeps the store status', async (_label, error, status) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockRecord.mockRejectedValue(error);
    expect((await post({ post_id: POST_ID })).status).toBe(status);
  });

  test.each(['parent', 'athlete', 'board', 'platform_owner', 'volunteer', 'staff'])('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    expect((await post({ post_id: POST_ID })).status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
