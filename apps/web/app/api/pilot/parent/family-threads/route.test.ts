import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { listOwnFamilyThreads, startFamilyThread, writeAgainInFamilyThread } from '@/src/server/pilot/familyThreads';
import { requirePrincipal } from '@/src/server/pilot/http';
import { ForbiddenError, NotFoundError, ValidationError } from '@/src/server/pilot/errors';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The link, gym, ownership and 18 rules live in familyThreads.ts and guardianAccess.ts and are
// proved on Postgres in familyThreadsGuardian.pg.test.ts. Here: the role gate, the body, and that
// the route hands down the caller's own identity, never one from the body. (W4 item 4, PM-1b)
jest.mock('@/src/server/pilot/familyThreads', () => ({
  listOwnFamilyThreads: jest.fn(),
  startFamilyThread: jest.fn(),
  writeAgainInFamilyThread: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listOwnFamilyThreads);
const mockStart = jest.mocked(startFamilyThread);
const mockAgain = jest.mocked(writeAgainInFamilyThread);

const THREAD = '11111111-1111-4111-8111-111111111111';
const CREATED = { thread_id: THREAD, post_id: THREAD, created_at: '2026-11-25T03:00:00.000Z' };

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

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/parent/family-threads', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/parent/family-threads (W4 item 4)', () => {
  test("a guardian reads their own threads, for this session's account and gym", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockList.mockResolvedValue([]);
    const response = await GET(new NextRequest('http://localhost/api/pilot/parent/family-threads?account_id=someone-else'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [] });
    expect(mockList).toHaveBeenCalledWith('org-1', 'parent-1');
  });

  test.each(['coach', 'organization_admin', 'admin', 'athlete', 'board', 'platform_owner'])('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest('http://localhost/api/pilot/parent/family-threads'));
    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/parent/family-threads (W4 item 4)', () => {
  test('athlete_id opens a thread as the session account', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockStart.mockResolvedValue(CREATED);
    const response = await post({ athlete_id: ' ath-1 ', text: 'Is practice on Saturday?', account_id: 'someone-else' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, item: CREATED });
    expect(mockStart).toHaveBeenCalledWith({
      organizationId: 'org-1', accountId: 'parent-1', athleteId: 'ath-1', text: 'Is practice on Saturday?',
    });
    expect(mockAgain).not.toHaveBeenCalled();
  });

  test('thread_id writes again in that thread as the session account (Q2 A)', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAgain.mockResolvedValue(CREATED);
    const response = await post({ thread_id: THREAD, text: 'Thank you!' });
    expect(response.status).toBe(201);
    expect(mockAgain).toHaveBeenCalledWith({ organizationId: 'org-1', accountId: 'parent-1', threadId: THREAD, text: 'Thank you!' });
    expect(mockStart).not.toHaveBeenCalled();
  });

  test.each([
    ['neither', { text: 'Hi' }],
    ['both', { athlete_id: 'ath-1', thread_id: THREAD, text: 'Hi' }],
    ['blank ids', { athlete_id: '  ', thread_id: '', text: 'Hi' }],
    ['a non-string id', { athlete_id: 7, text: 'Hi' }],
    ['an over-long athlete id', { athlete_id: 'a'.repeat(301), text: 'Hi' }],
    ['no body', 'not json'],
  ])('%s is 400 and writes nothing', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockAgain).not.toHaveBeenCalled();
  });

  test.each([
    ['a child not linked now', new ForbiddenError('Forbidden: parent not linked to athlete'), 403],
    ['words missing', new ValidationError('Write a message before sending.'), 400],
  ])('%s keeps the store status', async (_label, error, status) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockStart.mockRejectedValue(error);
    expect((await post({ athlete_id: 'ath-1', text: 'x' })).status).toBe(status);
  });

  test("another guardian's thread is 404", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAgain.mockRejectedValue(new NotFoundError('Not found: that message is not on your page.'));
    expect((await post({ thread_id: THREAD, text: 'x' })).status).toBe(404);
  });

  test.each(['coach', 'organization_admin', 'admin', 'athlete'])('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    const response = await post({ athlete_id: 'ath-1', text: 'Hi' });
    expect(response.status).toBe(403);
    expect(mockStart).not.toHaveBeenCalled();
  });
});
