import { NextRequest } from 'next/server';

import { DELETE, GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createSessionStaffNote,
  listSessionStaffNotes,
  removeOwnSessionStaffNote,
  updateOwnSessionStaffNote,
} from '@/src/server/pilot/sessionStaffNotes';

/*
 * The route over sessionStaffNotes.ts. Who reaches which athlete, and that
 * only the author changes or removes a note, are proven against real rows in
 * sessionStaffNotes.pg.test.ts; with the module mocked, this file asserts what
 * only the route decides: which roles are refused before the module runs
 * (athlete and parent among them -- OD-2026-10-10-003 ruling 3, staff only),
 * that the identity handed down is the SESSION's and never anything in the
 * request, how the body and query are parsed, that each listed row answers
 * `own` and the author's NAME, that the module's refusals pass through -- and
 * that an account id never leaves the server.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/sessionStaffNotes', () => {
  const actual = jest.requireActual('@/src/server/pilot/sessionStaffNotes');
  return {
    ...actual,
    createSessionStaffNote: jest.fn(),
    listSessionStaffNotes: jest.fn(),
    removeOwnSessionStaffNote: jest.fn(),
    updateOwnSessionStaffNote: jest.fn(),
  };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockList = listSessionStaffNotes as jest.Mock;
const mockCreate = createSessionStaffNote as jest.Mock;
const mockUpdate = updateOwnSessionStaffNote as jest.Mock;
const mockRemove = removeOwnSessionStaffNote as jest.Mock;
const moduleMocks = [mockList, mockCreate, mockUpdate, mockRemove];

const { ForbiddenError, NotFoundError, ValidationError } = jest.requireActual('@/src/server/pilot/errors');

const COACH = {
  accountId: 'acct-coach',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'secret-token',
  authProvider: 'microsoft',
};
const ACTOR = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };

const NOTE_ID = '4f9d2c1e-6b3a-4e8f-9c2d-1a2b3c4d5e6f';
const OTHER_NOTE_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

// As listSessionStaffNotes returns them: no account id, written_by_me instead.
const MINE = {
  note_id: NOTE_ID,
  session_id: 'sess-1',
  athlete_id: 'ath-1',
  author_role: 'coach',
  author_name: 'Coach Jason',
  note: 'Before: tight shoulders, keep it light.',
  created_at: '2026-10-08T12:00:00.000Z',
  updated_at: '2026-10-08T12:05:00.000Z',
  written_by_me: true,
};
const THEIRS = {
  ...MINE,
  note_id: OTHER_NOTE_ID,
  author_role: 'organization_admin',
  author_name: 'Coach Gym Admin',
  note: 'Parent asked about Saturday.',
  written_by_me: false,
};
// As the write functions return them: the stored row, account id included.
const STORED = {
  note_id: NOTE_ID,
  session_id: 'sess-1',
  athlete_id: 'ath-1',
  author_account_id: 'acct-coach',
  author_role: 'coach',
  note: MINE.note,
  created_at: MINE.created_at,
  updated_at: MINE.updated_at,
};

const URL = 'http://localhost/api/pilot/coach/session-staff-notes';

function get(query: string) {
  return GET(new NextRequest(`${URL}${query}`));
}

function send(handler: typeof POST, method: string, body: unknown) {
  return handler(
    new NextRequest(URL, {
      method,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

const post = (body: unknown) => send(POST, 'POST', body);
const patch = (body: unknown) => send(PATCH, 'PATCH', body);

function del(query: string) {
  return DELETE(new NextRequest(`${URL}${query}`, { method: 'DELETE' }));
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('staff only: every other role is refused on every verb before the module runs', () => {
  it.each(['athlete', 'parent', 'volunteer', 'staff', 'platform_owner', 'board'])('%s', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role, athleteId: role === 'athlete' ? 'ath-1' : null });
    expect((await get('?session_id=sess-1&athlete_id=ath-1')).status).toBe(403);
    expect((await post({ session_id: 'sess-1', athlete_id: 'ath-1', note: 'x' })).status).toBe(403);
    expect((await patch({ note_id: NOTE_ID, note: 'x' })).status).toBe(403);
    expect((await del(`?note_id=${NOTE_ID}`)).status).toBe(403);
    for (const mock of moduleMocks) expect(mock).not.toHaveBeenCalled();
  });

  it.each(['coach', 'organization_admin', 'admin'])('%s reaches the module on every verb', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    mockList.mockResolvedValue([]);
    mockCreate.mockResolvedValue(STORED);
    mockUpdate.mockResolvedValue(STORED);
    mockRemove.mockResolvedValue(undefined);
    expect((await get('?session_id=sess-1&athlete_id=ath-1')).status).toBe(200);
    expect((await post({ session_id: 'sess-1', athlete_id: 'ath-1', note: 'x' })).status).toBe(200);
    expect((await patch({ note_id: NOTE_ID, note: 'x' })).status).toBe(200);
    expect((await del(`?note_id=${NOTE_ID}`)).status).toBe(200);
    for (const mock of moduleMocks) expect(mock).toHaveBeenCalledTimes(1);
  });

  it('no session is a 401 on every verb, and the module does not run', async () => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
    expect((await get('?session_id=sess-1&athlete_id=ath-1')).status).toBe(401);
    expect((await post({ session_id: 'sess-1', athlete_id: 'ath-1', note: 'x' })).status).toBe(401);
    expect((await patch({ note_id: NOTE_ID, note: 'x' })).status).toBe(401);
    expect((await del(`?note_id=${NOTE_ID}`)).status).toBe(401);
    for (const mock of moduleMocks) expect(mock).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it.each([
    ['no session', '?athlete_id=ath-1'],
    ['a blank session', '?session_id=%20&athlete_id=ath-1'],
    ['no athlete', '?session_id=sess-1'],
    ['a NUL byte in the session id', '?session_id=sess%00&athlete_id=ath-1'],
    ['a NUL byte in the athlete id', '?session_id=sess-1&athlete_id=ath%00'],
  ])(
    'refuses %s with a 400 and reads nothing',
    async (_label, query) => {
      mockPrincipal.mockResolvedValue(COACH);
      expect((await get(query)).status).toBe(400);
      expect(mockList).not.toHaveBeenCalled();
    },
  );

  it('hands the module the session identity without the token, lists every note it returns, marks own, names authors, and keeps account ids out', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    // A field the module might grow later must not reach the response by default.
    mockList.mockResolvedValue([{ ...THEIRS, author_account_id: 'acct-admin' }, MINE]);
    const response = await get('?session_id=%20sess-1%20&athlete_id=ath-1&account_id=someone-else');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockList).toHaveBeenCalledWith(ACTOR, 'sess-1', 'ath-1');
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      note_max: 2000,
      notes: [
        {
          note_id: OTHER_NOTE_ID,
          session_id: 'sess-1',
          athlete_id: 'ath-1',
          note: 'Parent asked about Saturday.',
          author_name: 'Coach Gym Admin',
          author_role: 'organization_admin',
          created_at: MINE.created_at,
          updated_at: MINE.updated_at,
          own: false,
        },
        {
          note_id: NOTE_ID,
          session_id: 'sess-1',
          athlete_id: 'ath-1',
          note: 'Before: tight shoulders, keep it light.',
          author_name: 'Coach Jason',
          author_role: 'coach',
          created_at: MINE.created_at,
          updated_at: MINE.updated_at,
          own: true,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('acct-');
  });

  it('passes the module\'s refusals through: 403 for an athlete the coach cannot reach, 404 for a session that is not that athlete\'s', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockList.mockRejectedValueOnce(new ForbiddenError('no', 'SESSION_STAFF_NOTE_NOT_PERMITTED'));
    const refused = await get('?session_id=sess-1&athlete_id=ath-2');
    expect(refused.status).toBe(403);
    expect(await refused.json()).not.toHaveProperty('notes');
    mockList.mockRejectedValueOnce(new NotFoundError('none', 'SESSION_STAFF_NOTE_SESSION_NOT_FOUND'));
    expect((await get('?session_id=sess-9&athlete_id=ath-1')).status).toBe(404);
  });
});

describe('POST', () => {
  it('writes for the session\'s actor, never one named in the body, and answers the note id only', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockCreate.mockResolvedValue(STORED);
    const response = await post({
      session_id: ' sess-1 ',
      athlete_id: ' ath-1 ',
      note: '  Before: tight shoulders, keep it light.  ',
      actor: { accountId: 'someone-else', role: 'organization_admin' },
      author_account_id: 'someone-else',
      author_role: 'organization_admin',
    });
    expect(response.status).toBe(200);
    // The note goes down as typed; the module trims and measures it.
    expect(mockCreate).toHaveBeenCalledWith({
      actor: ACTOR,
      sessionId: 'sess-1',
      athleteId: 'ath-1',
      note: '  Before: tight shoulders, keep it light.  ',
    });
    const body = await response.json();
    expect(body).toEqual({ ok: true, note_id: NOTE_ID });
    expect(JSON.stringify(body)).not.toContain('acct-');
  });

  it.each([
    ['no session', { session_id: '' }],
    ['no athlete', { athlete_id: undefined }],
    ['a note that is not text', { note: 7 }],
    ['a body that omits the note', { note: undefined }],
    ['a note holding a NUL byte', { note: 'a\u0000b' }],
    ['a session id holding a NUL byte', { session_id: 'sess\u0000' }],
  ])('refuses %s with a 400 and writes nothing', async (_label, change) => {
    mockPrincipal.mockResolvedValue(COACH);
    // JSON drops `undefined`, which is how a case omits a key.
    expect((await post({ session_id: 'sess-1', athlete_id: 'ath-1', note: 'x', ...change })).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([['a number', '5'], ['a string', '"x"'], ['a list', '[1, 2]'], ['not JSON', '{nope']])(
    'a body that is %s is a 400, not a server error',
    async (_label, body) => {
      mockPrincipal.mockResolvedValue(COACH);
      expect((await post(body)).status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  it('passes the module\'s refusals through: 400 blank note, 403 unreachable athlete, 404 session not that athlete\'s', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    const body = { session_id: 'sess-1', athlete_id: 'ath-1', note: '   ' };
    mockCreate.mockRejectedValueOnce(new ValidationError('The note cannot be blank.', 'SESSION_STAFF_NOTE_INVALID'));
    expect((await post(body)).status).toBe(400);
    mockCreate.mockRejectedValueOnce(new ForbiddenError('no', 'SESSION_STAFF_NOTE_NOT_PERMITTED'));
    expect((await post(body)).status).toBe(403);
    mockCreate.mockRejectedValueOnce(new NotFoundError('none', 'SESSION_STAFF_NOTE_SESSION_NOT_FOUND'));
    expect((await post(body)).status).toBe(404);
  });
});

describe('PATCH', () => {
  it('changes the note for the session\'s actor by note id, and answers the note id only', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockUpdate.mockResolvedValue(STORED);
    const response = await patch({ note_id: NOTE_ID, note: 'After: moved well.', author_account_id: 'someone-else', athlete_id: 'ath-2' });
    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({ actor: ACTOR, noteId: NOTE_ID, note: 'After: moved well.' });
    const body = await response.json();
    expect(body).toEqual({ ok: true, note_id: NOTE_ID });
    expect(JSON.stringify(body)).not.toContain('acct-');
  });

  it.each([
    ['no note id', { note_id: undefined }],
    ['a hand-crafted note id', { note_id: 'abc' }],
    ['a note id that is not text', { note_id: 7 }],
    ['a note that is not text', { note: null }],
    ['a note holding a NUL byte', { note: 'a\u0000b' }],
  ])('refuses %s with a 400 and changes nothing', async (_label, change) => {
    mockPrincipal.mockResolvedValue(COACH);
    expect((await patch({ note_id: NOTE_ID, note: 'x', ...change })).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('passes the module\'s refusals through: 403 for somebody else\'s note, 404 for a removed one', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockUpdate.mockRejectedValueOnce(new ForbiddenError('Only the coach who wrote this note may change it.', 'SESSION_STAFF_NOTE_AUTHOR_ONLY'));
    const refused = await patch({ note_id: OTHER_NOTE_ID, note: 'x' });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('SESSION_STAFF_NOTE_AUTHOR_ONLY');
    mockUpdate.mockRejectedValueOnce(new NotFoundError('No such staff note.', 'SESSION_STAFF_NOTE_NOT_FOUND'));
    expect((await patch({ note_id: NOTE_ID, note: 'x' })).status).toBe(404);
  });
});

describe('DELETE', () => {
  it('removes for the session\'s actor by note id', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockRemove.mockResolvedValue(undefined);
    const response = await del(`?note_id=${NOTE_ID}&account_id=someone-else`);
    expect(response.status).toBe(200);
    expect(mockRemove).toHaveBeenCalledWith({ actor: ACTOR, noteId: NOTE_ID });
    expect(await response.json()).toEqual({ ok: true, note_id: NOTE_ID });
  });

  it.each([['no note', ''], ['a blank note id', '?note_id=%20'], ['a hand-crafted note id', '?note_id=abc']])(
    'refuses %s with a 400 and removes nothing',
    async (_label, query) => {
      mockPrincipal.mockResolvedValue(COACH);
      expect((await del(query)).status).toBe(400);
      expect(mockRemove).not.toHaveBeenCalled();
    },
  );

  it('passes the module\'s refusals through: 403 for somebody else\'s note, 404 for a removed one', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockRemove.mockRejectedValueOnce(new ForbiddenError('no', 'SESSION_STAFF_NOTE_AUTHOR_ONLY'));
    expect((await del(`?note_id=${OTHER_NOTE_ID}`)).status).toBe(403);
    mockRemove.mockRejectedValueOnce(new NotFoundError('gone', 'SESSION_STAFF_NOTE_NOT_FOUND'));
    expect((await del(`?note_id=${NOTE_ID}`)).status).toBe(404);
  });
});
