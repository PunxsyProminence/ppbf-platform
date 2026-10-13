import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { createFamilyMessageReply, listOwnReplies } from '@/src/server/pilot/familyMessageReplies';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { requirePrincipal } from '@/src/server/pilot/http';
import { NotFoundError, ValidationError } from '@/src/server/pilot/errors';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
}));

// The ownership, gym and link rules live in familyMessageReplies.ts and are
// proved on Postgres in familyMessageReplyReads.pg.test.ts. Here: roles, the
// body, and that the route hands the caller's own identity down. (#1542, FC-03)
jest.mock('@/src/server/pilot/familyMessageReplies', () => ({
  createFamilyMessageReply: jest.fn(),
  listOwnReplies: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGuardianAthleteIds = jest.mocked(guardianAthleteIds);
const mockCreate = jest.mocked(createFamilyMessageReply);
const mockListOwn = jest.mocked(listOwnReplies);

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
  return POST(new NextRequest('http://localhost/api/pilot/parent/message-replies', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
}

const REPLY = {
  reply_id: 'reply-1',
  note_id: '11111111-1111-4111-8111-111111111111',
  reply_text: 'See you Thursday.',
  created_at: '2026-10-13T23:30:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGuardianAthleteIds.mockResolvedValue(['ath-1']);
});

describe('GET /api/pilot/parent/message-replies (#1542, FC-03)', () => {
  test("a guardian reads their own replies, for the children linked to them now", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockListOwn.mockResolvedValue([REPLY]);

    const response = await GET(new NextRequest('http://localhost/api/pilot/parent/message-replies'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [REPLY] });
    expect(mockGuardianAthleteIds).toHaveBeenCalledWith('org-1', 'parent-1');
    expect(mockListOwn).toHaveBeenCalledWith('org-1', 'parent-1', ['ath-1']);
  });

  test.each(['coach', 'organization_admin', 'admin', 'athlete', 'platform_owner'])('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await GET(new NextRequest('http://localhost/api/pilot/parent/message-replies'));

    expect(response.status).toBe(403);
    expect(mockListOwn).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/parent/message-replies (#1542, FC-03)', () => {
  test('a reply is recorded as this guardian, in this gym, on that note', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockCreate.mockResolvedValue(REPLY);

    const response = await post({ note_id: ` ${REPLY.note_id} `, reply_text: 'See you Thursday.' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, item: REPLY });
    expect(mockCreate).toHaveBeenCalledWith({
      organizationId: 'org-1',
      accountId: 'parent-1',
      noteId: REPLY.note_id,
      replyText: 'See you Thursday.',
    });
  });

  test.each(['coach', 'organization_admin', 'admin', 'athlete', 'platform_owner'])('%s cannot reply', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await post({ note_id: REPLY.note_id, reply_text: 'x' });

    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each([
    ['no note id', { reply_text: 'Hello' }],
    ['a blank note id', { note_id: '  ', reply_text: 'Hello' }],
    ['no reply text', { note_id: REPLY.note_id }],
    ['reply text that is not text', { note_id: REPLY.note_id, reply_text: 42 }],
    ['a body that is not JSON', 'not json'],
  ])('%s is refused with a 400, and nothing is written', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await post(body);

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("a note that is not this guardian's is a 404 with the module's sentence", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockCreate.mockRejectedValue(new NotFoundError('Not found: that message is not on your page.'));

    const response = await post({ note_id: REPLY.note_id, reply_text: 'Hello' });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Not found: that message is not on your page.');
  });

  test("an empty or too-long reply is refused with the module's sentence", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockCreate.mockRejectedValue(new ValidationError('A reply is at most 2000 characters.'));

    const response = await post({ note_id: REPLY.note_id, reply_text: 'x'.repeat(2001) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('A reply is at most 2000 characters.');
  });
});
