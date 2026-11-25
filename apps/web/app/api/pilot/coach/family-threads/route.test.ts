import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { ForbiddenError, NotFoundError, ValidationError } from '@/src/server/pilot/errors';
import { listFamilyThreadsForStaff, replyInFamilyThread } from '@/src/server/pilot/familyThreads';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// requireRole stays real; the athlete gate is faked at its contract. The gym-, athlete- and
// reader-scoped SQL, the reply's audit row and the store's own gate on the thread's athlete are
// proved on Postgres in familyThreadsStaff.pg.test.ts. Here: the role gate, the athlete gate on
// GET, the body, and that the route hands down the session's identity. (W4 item 4, PM-1c)
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/familyThreads', () => ({
  listFamilyThreadsForStaff: jest.fn(),
  replyInFamilyThread: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAccess = jest.mocked(assertActorCanAccessAthlete);
const mockList = jest.mocked(listFamilyThreadsForStaff);
const mockReply = jest.mocked(replyInFamilyThread);

const THREAD = '11111111-1111-4111-8111-111111111111';
const CREATED = { thread_id: THREAD, post_id: '22222222-2222-4222-8222-222222222222', created_at: '2026-11-25T03:00:00.000Z' };

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

function get(query = '?athlete_id=ath-1') {
  return GET(new NextRequest(`http://localhost/api/pilot/coach/family-threads${query}`));
}

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/coach/family-threads', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue(undefined);
});

describe('GET /api/pilot/coach/family-threads (W4 item 4)', () => {
  test.each(['coach', 'organization_admin', 'admin'])('%s reads the threads on an athlete they reach, as themselves', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockList.mockResolvedValue([]);
    const response = await get('?athlete_id=%20ath-1%20&account_id=someone-else');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [] });
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'staff-1', organizationId: 'org-1', role }), 'ath-1');
    expect(mockList).toHaveBeenCalledWith({ organizationId: 'org-1', accountId: 'staff-1', role }, 'ath-1');
  });

  test('an athlete the caller cannot reach is refused before anything is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAccess.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));
    expect((await get()).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test.each(['parent', 'athlete', 'board', 'platform_owner'])('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    expect((await get()).status).toBe(403);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  test.each([
    ['no athlete id', ''],
    ['a blank athlete id', '?athlete_id=%20'],
    ['an over-long athlete id', `?athlete_id=${'a'.repeat(301)}`],
    ['an athlete id with a NUL character', '?athlete_id=ATH%00X'],
  ])('%s is 400 and reads nothing', async (_label, query) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    expect((await get(query)).status).toBe(400);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/coach/family-threads (W4 item 4)', () => {
  test.each(['coach', 'organization_admin', 'admin'])('%s answers under a thread as themselves', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockReply.mockResolvedValue(CREATED);
    const response = await post({ thread_id: ` ${THREAD} `, text: 'Yes, see you Saturday.', account_id: 'someone-else', role: 'admin' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, item: CREATED });
    expect(mockReply).toHaveBeenCalledWith(
      { organizationId: 'org-1', accountId: 'staff-1', role },
      { threadId: THREAD, text: 'Yes, see you Saturday.' },
    );
  });

  test.each([
    ['no thread id', { text: 'Hi' }],
    ['a blank thread id', { thread_id: '  ', text: 'Hi' }],
    ['a non-string thread id', { thread_id: 7, text: 'Hi' }],
    ['no body', 'not json'],
  ])('%s is 400 and writes nothing', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    expect((await post(body)).status).toBe(400);
    expect(mockReply).not.toHaveBeenCalled();
  });

  test.each([
    ['a thread out of reach', new NotFoundError('Not found: that message is not in your gym.'), 404],
    ['no active seat', new ForbiddenError('Forbidden: no active staff seat in this gym.'), 403],
    ['words missing', new ValidationError('Write a message before sending.'), 400],
  ])('%s keeps the store status', async (_label, error, status) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockReply.mockRejectedValue(error);
    expect((await post({ thread_id: THREAD, text: 'x' })).status).toBe(status);
  });

  test.each(['parent', 'athlete', 'board', 'platform_owner'])('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    expect((await post({ thread_id: THREAD, text: 'Hi' })).status).toBe(403);
    expect(mockReply).not.toHaveBeenCalled();
  });
});
