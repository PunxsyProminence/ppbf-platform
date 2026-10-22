import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  listPresentAthletes,
  setRunAthletePresent,
  staffPermittedAthletes,
} from '@/src/server/pilot/sessionRunAthletes';
import type { PilotRole } from '@/src/server/pilot/contracts';

// Who is in a session (audit finding F-067). The rules themselves -- the
// delivering coach, while live; staff here who reach the athlete; a read that
// names only permitted athletes -- are proven against real rows in
// sessionRunAthletes.pg.test.ts. With the module mocked, this file asserts what
// only the route decides: which roles are refused before the module runs, that
// the identity and the organization are the session's, that the permitted
// athlete ids come from the server and never from the request, how the body is
// parsed, and how the module's refusals are answered.
//
// requireRole and jsonError are NOT mocked: the gate and the error mapping are
// what this suite proves.

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/sessionRunAthletes', () => ({
  listPresentAthletes: jest.fn(),
  setRunAthletePresent: jest.fn(),
  staffPermittedAthletes: jest.fn(),
}));
jest.mock('@/src/server/pilot/trainingHolds', () => ({
  readStaffHoldWarning: jest.fn(),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockList = listPresentAthletes as jest.Mock;
const mockSet = setRunAthletePresent as jest.Mock;
const mockPermitted = staffPermittedAthletes as jest.Mock;
const mockHold = jest.requireMock('@/src/server/pilot/trainingHolds').readStaffHoldWarning as jest.Mock;
const ADA = { athlete_id: 'ath-1', full_name: 'Ada Reyes' };
const BEN = { athlete_id: 'ath-2', full_name: 'Ben Ortiz' };

const { ForbiddenError } = jest.requireActual('@/src/server/pilot/errors');
const { SessionScriptRunError } = jest.requireActual('@/src/server/pilot/sessionScriptRuns');

// Every PilotRole, as a record so a role added to the union fails to compile
// here until someone says whether it may see or record who was in a session.
const STAFF: Record<PilotRole, boolean> = {
  coach: true,
  organization_admin: true,
  admin: true,
  platform_owner: false,
  athlete: false,
  parent: false,
  board: false,
  volunteer: false,
  staff: false,
};
const ROLES = Object.keys(STAFF) as PilotRole[];

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-coach',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'secret-token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

const context = (runId = 'ssrun_1') => ({ params: Promise.resolve({ runId }) });
const URL_FOR = 'http://localhost/api/pilot/session-scripts/runs/ssrun_1/athletes';

function get(url = URL_FOR, runId = 'ssrun_1') {
  return GET(new NextRequest(url), context(runId));
}
function post(body: unknown, runId = 'ssrun_1') {
  return POST(
    new NextRequest(URL_FOR, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    context(runId),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue(principal());
  mockPermitted.mockResolvedValue([ADA, BEN]);
  mockList.mockResolvedValue([]);
  mockSet.mockResolvedValue({ outcome: 'marked' });
});

describe('who may see or record who was in a session', () => {
  it.each(ROLES)('%s: GET and POST are admitted only for a coach or an organization admin', async (role) => {
    mockPrincipal.mockResolvedValue(principal({ role }));

    const read = await get();
    const written = await post({ athlete_id: 'ath-1', present: true });

    if (STAFF[role]) {
      expect(read.status).toBe(200);
      expect(written.status).toBe(200);
    } else {
      expect(read.status).toBe(403);
      expect(written.status).toBe(403);
      // A refusal that has already read who was there is not a refusal.
      expect(mockPermitted).not.toHaveBeenCalled();
      expect(mockList).not.toHaveBeenCalled();
      expect(mockSet).not.toHaveBeenCalled();
    }
  });

  it('refuses before the body is read, so a malformed request gets the same answer', async () => {
    mockPrincipal.mockResolvedValue(principal({ role: 'parent' }));

    expect((await post('not json')).status).toBe(403);
    expect((await post({ athlete_id: 'ath-1', present: true, organization_id: 'org-9' })).status).toBe(403);
  });

  it('no session is a 401 on both verbs, and the module does not run', async () => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));

    expect((await get()).status).toBe(401);
    expect((await post({ athlete_id: 'ath-1', present: true })).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('the run id in the path', () => {
  it('a blank one, or one carrying a NUL byte, is a 400 on both verbs and reaches no read or write', async () => {
    for (const runId of ['   ', 'ssrun\u0000_1']) {
      const read = await get(URL_FOR, runId);
      expect(read.status).toBe(400);
      await expect(read.json()).resolves.toEqual({ error: 'RUN_ID_INVALID' });
      expect((await post({ athlete_id: 'ath-1', present: true }, runId)).status).toBe(400);
    }
    expect(mockPermitted).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it("names the present athletes of the session's own gym, filtered to ids the SERVER computed, and is not cached", async () => {
    const admin = principal({ role: 'organization_admin', accountId: 'acct-admin', organizationId: 'org-9' });
    mockPrincipal.mockResolvedValue(admin);
    mockPermitted.mockResolvedValue([{ ...ADA, dob: '2012-01-01', emergency_contact: 'secret' }]);
    mockList.mockResolvedValue([
      { run_id: 'ssrun_1', athlete_id: 'ath-1', full_name: 'Ada Reyes', marked_at: '2026-10-13T22:05:00.000Z' },
    ]);

    // Athlete ids and an organization in the query are not read.
    const response = await get(`${URL_FOR}?athlete_id=ath-77&organization_id=org-1&permitted=ath-77`);

    expect(mockPermitted).toHaveBeenCalledWith(admin);
    expect(mockList).toHaveBeenCalledWith('org-9', ['ssrun_1'], ['ath-1']);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    // The picker is the same server-computed set, id and name only: nothing else from the row passes.
    await expect(response.json()).resolves.toEqual({
      present: [{ athlete_id: 'ath-1', full_name: 'Ada Reyes', marked_at: '2026-10-13T22:05:00.000Z' }],
      gym: [ADA],
    });
  });

  it('a run with nobody marked, or a run id that is not this gym\'s, answers an empty list, not an error', async () => {
    const response = await get(URL_FOR, 'ssrun_other_gym');

    expect(mockList).toHaveBeenCalledWith('org-1', ['ssrun_other_gym'], ['ath-1', 'ath-2']);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ present: [], gym: [ADA, BEN] });
  });
});

describe('POST', () => {
  it("marks for the session's actor in the session's gym, on the run in the path, and never an actor named in the body", async () => {
    const response = await post({ athlete_id: '  ath-1  ', present: true });

    expect(mockSet).toHaveBeenCalledWith({
      actor: { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null },
      runId: 'ssrun_1',
      athleteId: 'ath-1',
      present: true,
    });
    // The session token is not handed down.
    expect(JSON.stringify(mockSet.mock.calls[0][0])).not.toContain('secret-token');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'marked', athlete_id: 'ath-1', present: true });
  });

  // D4 (OD-2026-10-21-002): on a session tied to a class, what the tap did to the register.
  it('answers what a tied tap did to the register, with the hold warning only when it wrote a mark', async () => {
    const HOLD = { hold_id: 'hold-1', scope: 'contact', reason_category: 'medical', athlete_explanation: '', lift_condition_text: '', expires_at: null };
    mockHold.mockResolvedValue(HOLD);
    for (const register of [{ effect: 'created' }, { effect: 'flipped', previous_status: 'absent' }]) {
      mockSet.mockResolvedValueOnce({ outcome: 'marked', register });
      const response = await post({ athlete_id: 'ath-1', present: true });
      await expect(response.json()).resolves.toEqual({ outcome: 'marked', athlete_id: 'ath-1', present: true, register, hold_warning: HOLD });
    }
    expect(mockHold).toHaveBeenCalledWith('coach', 'org-1', 'ath-1');
    mockHold.mockClear();
    for (const register of [{ effect: 'already_present' }, { effect: 'skipped', reason: 'class_cancelled' }]) {
      mockSet.mockResolvedValueOnce({ outcome: 'marked', register });
      const response = await post({ athlete_id: 'ath-1', present: true });
      await expect(response.json()).resolves.toEqual({ outcome: 'marked', athlete_id: 'ath-1', present: true, register });
    }
    for (const register of [{ effect: 'removed' }, { effect: 'kept' }, { effect: 'unchanged' }]) {
      mockSet.mockResolvedValueOnce({ outcome: 'unmarked', register });
      const response = await post({ athlete_id: 'ath-1', present: false });
      await expect(response.json()).resolves.toEqual({ outcome: 'unmarked', athlete_id: 'ath-1', present: false, register });
    }
    expect(mockHold).not.toHaveBeenCalled();
  });

  it('takes a mark back with present: false', async () => {
    mockSet.mockResolvedValue({ outcome: 'unmarked' });

    const response = await post({ athlete_id: 'ath-1', present: false });

    expect(mockSet.mock.calls[0][0].present).toBe(false);
    await expect(response.json()).resolves.toEqual({ outcome: 'unmarked', athlete_id: 'ath-1', present: false });
  });

  it('accepts no organization, account, role or run from the body', async () => {
    for (const extra of ['organization_id', 'marked_by_account_id', 'marked_by_role', 'run_id', 'removed_at']) {
      const response = await post({ athlete_id: 'ath-1', present: true, [extra]: 'x' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: `UNEXPECTED_FIELD:${extra}` });
    }
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('400s a body that names no athlete, or does not say present or not', async () => {
    const bad = [
      'not json',
      [],
      {},
      { present: true },
      { athlete_id: '  ', present: true },
      { athlete_id: 7, present: true },
      { athlete_id: 'ath\u0000-1', present: true },
      { athlete_id: 'ath-1' },
      { athlete_id: 'ath-1', present: 'yes' },
      { athlete_id: 'ath-1', present: null },
    ];
    for (const body of bad) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("answers the module's refusals with their own status: not this coach's run 404, not live 409, not permitted 403", async () => {
    mockSet.mockRejectedValueOnce(new SessionScriptRunError('SESSION_RUN_NOT_FOUND', 404));
    const missing = await post({ athlete_id: 'ath-1', present: true });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: 'SESSION_RUN_NOT_FOUND' });

    mockSet.mockRejectedValueOnce(new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409));
    const settled = await post({ athlete_id: 'ath-1', present: true });
    expect(settled.status).toBe(409);
    await expect(settled.json()).resolves.toEqual({ error: 'SESSION_RUN_NOT_LIVE' });

    mockSet.mockRejectedValueOnce(new ForbiddenError('This account may not record this athlete as present.', 'SESSION_RUN_ATHLETE_NOT_PERMITTED'));
    const refused = await post({ athlete_id: 'ath-elsewhere', present: true });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' });
  });
});
