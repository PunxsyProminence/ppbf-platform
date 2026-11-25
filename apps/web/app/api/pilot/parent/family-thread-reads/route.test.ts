import { NextRequest } from 'next/server';

import { POST } from './route';
import { recordFamilyThreadReadByGuardian } from '@/src/server/pilot/familyThreads';
import { requirePrincipal } from '@/src/server/pilot/http';
import { NotFoundError } from '@/src/server/pilot/errors';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// Whose post may be recorded as seen is familyThreads.ts's rule, proved on Postgres in
// familyThreadsGuardian.pg.test.ts. Here: the role gate, the body and the caller's identity.
jest.mock('@/src/server/pilot/familyThreads', () => ({
  recordFamilyThreadReadByGuardian: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockRecord = jest.mocked(recordFamilyThreadReadByGuardian);
const POST_ID = '22222222-2222-4222-8222-222222222222';

function principal(role = 'parent') {
  return {
    accountId: 'parent-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as never;
}

function send(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/parent/family-thread-reads', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/parent/family-thread-reads (W4 item 4)', () => {
  test("records the read as the session's own account", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockRecord.mockResolvedValue({ post_id: POST_ID });
    const response = await send({ post_id: POST_ID, account_id: 'someone-else' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, item: { post_id: POST_ID } });
    expect(mockRecord).toHaveBeenCalledWith({ organizationId: 'org-1', accountId: 'parent-1', postId: POST_ID });
  });

  test.each([{}, { post_id: '' }, { post_id: 5 }, 'not json'])('a missing post_id is 400 (%p)', async (body) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    expect((await send(body)).status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a post that is not theirs to read is 404', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockRecord.mockRejectedValue(new NotFoundError('Not found: that message is not on your page.'));
    expect((await send({ post_id: POST_ID })).status).toBe(404);
  });

  test.each(['coach', 'organization_admin', 'admin', 'athlete', 'board'])('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    expect((await send({ post_id: POST_ID })).status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
