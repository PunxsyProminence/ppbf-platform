import { NextRequest } from 'next/server';

import { POST } from './route';
import { recordFamilyMessageRead } from '@/src/server/pilot/familyMessageReads';
import { requirePrincipal } from '@/src/server/pilot/http';
import { NotFoundError } from '@/src/server/pilot/errors';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The note, gym and guardian-link rules live in familyMessageReads.ts and are
// proved on Postgres in familyMessageReadState.pg.test.ts. Here: roles, the
// body, and that the route hands the caller's own identity down. (#1542, FC-05)
jest.mock('@/src/server/pilot/familyMessageReads', () => ({
  recordFamilyMessageRead: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockRecord = jest.mocked(recordFamilyMessageRead);

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
  return POST(new NextRequest('http://localhost/api/pilot/parent/message-reads', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
}

const NOTE_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/parent/message-reads (#1542, FC-05)', () => {
  test('the read is recorded as this guardian, in this gym, on that note', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockRecord.mockResolvedValue({ note_id: NOTE_ID, first_read_at: '2026-10-13T23:30:00.000Z' });

    const response = await post({ note_id: ` ${NOTE_ID} ` });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, read: { note_id: NOTE_ID, first_read_at: '2026-10-13T23:30:00.000Z' } });
    expect(mockRecord).toHaveBeenCalledWith({ organizationId: 'org-1', accountId: 'parent-1', noteId: NOTE_ID });
  });

  test.each(['coach', 'organization_admin', 'admin', 'athlete', 'platform_owner'])('%s cannot record a family read', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await post({ note_id: NOTE_ID });

    expect(response.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each([
    ['no note id', {}],
    ['a blank note id', { note_id: '  ' }],
    ['a note id that is not text', { note_id: 42 }],
    ['a body that is not JSON', 'not json'],
  ])('%s is refused with a 400, and nothing is written', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await post(body);

    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test("a note that is not this guardian's is a 404 with the module's sentence", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockRecord.mockRejectedValue(new NotFoundError('Not found: that message is not on your page.'));

    const response = await post({ note_id: NOTE_ID });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Not found: that message is not on your page.');
  });
});
