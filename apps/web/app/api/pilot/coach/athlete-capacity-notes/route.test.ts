import { NextRequest } from 'next/server';

import { DELETE, GET, POST } from './route';
import {
  addCapacityNote,
  listCapacityNotes,
  withdrawCapacityNote,
} from '@/src/server/pilot/athleteCapacityNotes';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The route over athleteCapacityNotes.ts. Who may reach which athlete is
 * proven against real rows in athleteCapacityNotes.pg.test.ts; with the module
 * mocked, this file asserts what only the route decides: which roles are
 * refused before the module runs, that the identity handed down is the
 * SESSION's and never anything in the body, how the body and query are
 * parsed, that each row answers `own` and the author's NAME -- and that the
 * author's account id never leaves the server.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteCapacityNotes', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteCapacityNotes');
  return {
    ...actual,
    addCapacityNote: jest.fn(),
    listCapacityNotes: jest.fn(),
    withdrawCapacityNote: jest.fn(),
  };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockList = listCapacityNotes as jest.Mock;
const mockAdd = addCapacityNote as jest.Mock;
const mockWithdraw = withdrawCapacityNote as jest.Mock;

const COACH = {
  accountId: 'acct-coach',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'secret-token',
  authProvider: 'microsoft',
};
const ACTOR = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };

const MINE = {
  note_id: 'note-1',
  athlete_id: 'ath-1',
  note: 'Held pace through all six rounds',
  author_account_id: 'acct-coach',
  author_role: 'coach',
  author_name: 'Coach Jason',
  created_at: '2026-10-08T12:00:00.000Z',
};
const THEIRS = {
  ...MINE,
  note_id: 'note-2',
  note: 'Gassed after round three',
  author_account_id: 'acct-admin',
  author_role: 'organization_admin',
  author_name: 'Coach Gym Admin',
};

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/pilot/coach/athlete-capacity-notes${query}`));
}

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/pilot/coach/athlete-capacity-notes', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function del(query: string) {
  return DELETE(new NextRequest(`http://localhost/api/pilot/coach/athlete-capacity-notes${query}`, { method: 'DELETE' }));
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('roles that can never hold a note are refused before the module runs', () => {
  it.each(['athlete', 'parent', 'volunteer', 'staff', 'platform_owner', 'board'])('%s', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    expect((await get('?athlete_id=ath-1')).status).toBe(403);
    expect((await post({ athlete_id: 'ath-1', note: 'x' })).status).toBe(403);
    expect((await del('?athlete_id=ath-1&note_id=note-1')).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('needs an athlete_id', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    expect((await get('')).status).toBe(400);
    expect((await get('?athlete_id=%20')).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('hands the module the session identity without the token, marks own notes, names authors, and keeps account ids out', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockList.mockResolvedValue([THEIRS, MINE]);
    const response = await get('?athlete_id=ath-1');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockList).toHaveBeenCalledWith(ACTOR, 'ath-1');
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.note_max).toBe(2000);
    expect(body.notes).toEqual([
      {
        note_id: 'note-2',
        athlete_id: 'ath-1',
        note: 'Gassed after round three',
        author_name: 'Coach Gym Admin',
        author_role: 'organization_admin',
        created_at: MINE.created_at,
        own: false,
      },
      {
        note_id: 'note-1',
        athlete_id: 'ath-1',
        note: 'Held pace through all six rounds',
        author_name: 'Coach Jason',
        author_role: 'coach',
        created_at: MINE.created_at,
        own: true,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('acct-');
  });

  it('passes the module\'s refusal through as a 403', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    const { ForbiddenError } = jest.requireActual('@/src/server/pilot/errors');
    mockList.mockRejectedValue(new ForbiddenError('no', 'CAPACITY_NOTE_NOT_PERMITTED'));
    expect((await get('?athlete_id=ath-1')).status).toBe(403);
  });
});

describe('POST', () => {
  it('writes for the session\'s actor, never one named in the body, and answers the row with own: true', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockAdd.mockResolvedValue(MINE);
    const response = await post({
      athlete_id: ' ath-1 ',
      note: 'Held pace through all six rounds',
      actor: { accountId: 'someone-else', role: 'organization_admin' },
      author_account_id: 'someone-else',
    });
    expect(response.status).toBe(200);
    expect(mockAdd).toHaveBeenCalledWith({ actor: ACTOR, athleteId: 'ath-1', note: 'Held pace through all six rounds' });
    const body = await response.json();
    expect(body.note).toEqual({
      note_id: 'note-1',
      athlete_id: 'ath-1',
      note: 'Held pace through all six rounds',
      author_name: 'Coach Jason',
      author_role: 'coach',
      created_at: MINE.created_at,
      own: true,
    });
    expect(JSON.stringify(body)).not.toContain('acct-');
  });

  it.each([
    ['no athlete', { athlete_id: '' }],
    ['a note that is not text', { note: 7 }],
    ['a body that omits the note', { note: undefined }],
  ])('refuses %s with a 400 and writes nothing', async (_label, patch) => {
    mockPrincipal.mockResolvedValue(COACH);
    // JSON drops `undefined`, which is how a case omits a key.
    expect((await post({ athlete_id: 'ath-1', note: 'x', ...patch })).status).toBe(400);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('passes the module\'s own shape refusal through as a 400', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    const { ValidationError } = jest.requireActual('@/src/server/pilot/errors');
    mockAdd.mockRejectedValue(new ValidationError('The note is empty.', 'CAPACITY_NOTE_INVALID'));
    expect((await post({ athlete_id: 'ath-1', note: '   ' })).status).toBe(400);
  });

  it.each([['a number', '5'], ['a string', '"x"'], ['a list', '[1, 2]'], ['not JSON', '{nope']])(
    'a body that is %s is a 400, not a server error',
    async (_label, body) => {
      mockPrincipal.mockResolvedValue(COACH);
      expect((await post(body)).status).toBe(400);
      expect(mockAdd).not.toHaveBeenCalled();
    },
  );
});

describe('DELETE', () => {
  it('withdraws for the session\'s actor by athlete and note id', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockWithdraw.mockResolvedValue(undefined);
    const response = await del('?athlete_id=ath-1&note_id=note-1');
    expect(response.status).toBe(200);
    expect(mockWithdraw).toHaveBeenCalledWith({ actor: ACTOR, athleteId: 'ath-1', noteId: 'note-1' });
    expect(await response.json()).toEqual({ ok: true, note_id: 'note-1' });
  });

  it.each([['no athlete', '?note_id=note-1'], ['no note', '?athlete_id=ath-1'], ['a blank note id', '?athlete_id=ath-1&note_id=%20']])(
    'refuses %s with a 400 and withdraws nothing',
    async (_label, query) => {
      mockPrincipal.mockResolvedValue(COACH);
      expect((await del(query)).status).toBe(400);
      expect(mockWithdraw).not.toHaveBeenCalled();
    },
  );

  it('passes the module\'s refusals through: 403 for somebody else\'s note, 404 for a withdrawn one', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    const { ForbiddenError, NotFoundError } = jest.requireActual('@/src/server/pilot/errors');
    mockWithdraw.mockRejectedValueOnce(new ForbiddenError('no', 'CAPACITY_NOTE_NOT_AUTHOR'));
    expect((await del('?athlete_id=ath-1&note_id=note-2')).status).toBe(403);
    mockWithdraw.mockRejectedValueOnce(new NotFoundError('gone', 'CAPACITY_NOTE_NOT_FOUND'));
    expect((await del('?athlete_id=ath-1&note_id=note-9')).status).toBe(404);
  });
});
