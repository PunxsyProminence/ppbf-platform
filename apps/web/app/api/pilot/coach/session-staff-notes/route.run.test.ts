import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createRunStaffNote,
  createSessionStaffNote,
  listRunStaffNotes,
  listSessionStaffNotes,
} from '@/src/server/pilot/sessionStaffNotes';
import type { PilotRole } from '@/src/server/pilot/contracts';

// A staff note on an athlete in a session RUN (audit finding F-067), through
// the same route as a note on the athlete's own session. route.test.ts covers
// the session branch and the verbs that work by note id; this file covers what
// the run branch adds: that a request names a session OR a run, which module
// function each reaches, that the same roles are refused, and that the module's
// "not marked present" refusal is passed through. The rule itself is proven on
// real rows in sessionRunAthletes.pg.test.ts.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/sessionStaffNotes', () => {
  const actual = jest.requireActual('@/src/server/pilot/sessionStaffNotes');
  return {
    ...actual,
    createRunStaffNote: jest.fn(),
    createSessionStaffNote: jest.fn(),
    listRunStaffNotes: jest.fn(),
    listSessionStaffNotes: jest.fn(),
  };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockListRun = listRunStaffNotes as jest.Mock;
const mockListSession = listSessionStaffNotes as jest.Mock;
const mockCreateRun = createRunStaffNote as jest.Mock;
const mockCreateSession = createSessionStaffNote as jest.Mock;

const { ConflictError } = jest.requireActual('@/src/server/pilot/errors');

const COACH = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null, sessionToken: 'secret-token', authProvider: 'microsoft' };
const ACTOR = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };
const BASE = 'http://localhost/api/pilot/coach/session-staff-notes';

const get = (query: string) => GET(new NextRequest(`${BASE}?${query}`));
const post = (body: unknown) => POST(new NextRequest(BASE, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue(COACH);
  mockListRun.mockResolvedValue([]);
  mockListSession.mockResolvedValue([]);
  mockCreateRun.mockResolvedValue({ note_id: '4f9d2c1e-6b3a-4e8f-9c2d-1a2b3c4d5e6f' });
  mockCreateSession.mockResolvedValue({ note_id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' });
});

describe('a note on a run', () => {
  it('GET with run_id lists through the run read, for the session actor, and shows run_id on each row with no account id', async () => {
    mockListRun.mockResolvedValue([
      {
        note_id: '4f9d2c1e-6b3a-4e8f-9c2d-1a2b3c4d5e6f', session_id: null, run_id: 'ssrun_1', athlete_id: 'ath-1',
        author_role: 'coach', note: 'Hands dropped in round two.', created_at: 'c', updated_at: 'u',
        author_name: 'Coach Dee', written_by_me: true,
      },
    ]);

    const response = await get('run_id=ssrun_1&athlete_id=ath-1');

    expect(mockListRun).toHaveBeenCalledWith(ACTOR, 'ssrun_1', 'ath-1');
    expect(mockListSession).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notes).toEqual([
      {
        note_id: '4f9d2c1e-6b3a-4e8f-9c2d-1a2b3c4d5e6f', session_id: null, run_id: 'ssrun_1', athlete_id: 'ath-1',
        note: 'Hands dropped in round two.', author_name: 'Coach Dee', author_role: 'coach', created_at: 'c', updated_at: 'u', own: true,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('acct-coach');
  });

  it('POST with run_id writes through the run writer, for the session actor, never one named in the body', async () => {
    const response = await post({ run_id: ' ssrun_1 ', athlete_id: 'ath-1', note: 'Good feet.', author_account_id: 'acct-someone-else', organization_id: 'org-9' });

    expect(mockCreateRun).toHaveBeenCalledWith({ actor: ACTOR, runId: 'ssrun_1', athleteId: 'ath-1', note: 'Good feet.' });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, note_id: '4f9d2c1e-6b3a-4e8f-9c2d-1a2b3c4d5e6f' });
  });

  it('a session note still goes the session way', async () => {
    await get('session_id=sess-1&athlete_id=ath-1');
    await post({ session_id: 'sess-1', athlete_id: 'ath-1', note: 'As before.' });

    expect(mockListSession).toHaveBeenCalledWith(ACTOR, 'sess-1', 'ath-1');
    expect(mockCreateSession).toHaveBeenCalledWith({ actor: ACTOR, sessionId: 'sess-1', athleteId: 'ath-1', note: 'As before.' });
    expect(mockListRun).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('a request naming both a session and a run, or neither, is refused and reaches no writer or reader', async () => {
    expect((await get('session_id=sess-1&run_id=ssrun_1&athlete_id=ath-1')).status).toBe(400);
    expect((await get('athlete_id=ath-1')).status).toBe(400);
    expect((await post({ session_id: 'sess-1', run_id: 'ssrun_1', athlete_id: 'ath-1', note: 'x' })).status).toBe(400);
    expect((await post({ athlete_id: 'ath-1', note: 'x' })).status).toBe(400);
    expect((await post({ run_id: '   ', athlete_id: 'ath-1', note: 'x' })).status).toBe(400);
    // Something that is not text still names it: a number beside a real id is "both", and alone is refused.
    expect((await post({ session_id: 5, run_id: 'ssrun_1', athlete_id: 'ath-1', note: 'x' })).status).toBe(400);
    expect((await post({ session_id: 'sess-1', run_id: ['ssrun_1'], athlete_id: 'ath-1', note: 'x' })).status).toBe(400);
    expect((await post({ run_id: 7, athlete_id: 'ath-1', note: 'x' })).status).toBe(400);
    for (const mock of [mockListRun, mockListSession, mockCreateRun, mockCreateSession]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it.each(['athlete', 'parent', 'platform_owner', 'board', 'volunteer', 'staff'] as PilotRole[])(
    '%s is refused on the run branch before the module runs',
    async (role) => {
      mockPrincipal.mockResolvedValue({ ...COACH, role });

      expect((await get('run_id=ssrun_1&athlete_id=ath-1')).status).toBe(403);
      expect((await post({ run_id: 'ssrun_1', athlete_id: 'ath-1', note: 'x' })).status).toBe(403);
      expect(mockListRun).not.toHaveBeenCalled();
      expect(mockCreateRun).not.toHaveBeenCalled();
    },
  );

  it("passes through the module's refusal for an athlete not marked present in that run", async () => {
    mockCreateRun.mockRejectedValue(new ConflictError(
      'This athlete is not marked present in this session, so a note cannot be added for them here.',
      'SESSION_STAFF_NOTE_ATHLETE_NOT_PRESENT',
    ));

    const response = await post({ run_id: 'ssrun_1', athlete_id: 'ath-2', note: 'x' });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_STAFF_NOTE_ATHLETE_NOT_PRESENT' });
  });
});
