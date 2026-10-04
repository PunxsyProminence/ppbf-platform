import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  contactCapAccessibleAthleteIds,
  listContactCapHistory,
  setContactCap,
} from '@/src/server/pilot/athleteContactCaps';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The route over athleteContactCaps.ts. Who may reach which athlete is proven
 * against real rows in athleteContactCaps.pg.test.ts; with the module mocked,
 * this file asserts what only the route decides: which roles are refused
 * before the module runs, that the identity handed down is the SESSION's and
 * never anything in the body, how the body is parsed, and that a cleared cap
 * answers `cap: null` -- the same "no cap set" an athlete with no row gets.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/achievements', () => ({
  getCoachDisplayName: jest.fn(async (_org: string, accountId: string) => `Coach ${accountId}`),
}));

jest.mock('@/src/server/pilot/athleteContactCaps', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteContactCaps');
  return {
    ...actual,
    contactCapAccessibleAthleteIds: jest.fn(),
    listContactCapHistory: jest.fn(),
    setContactCap: jest.fn(),
  };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockHistory = listContactCapHistory as jest.Mock;
const mockSet = setContactCap as jest.Mock;
const mockAccessible = contactCapAccessibleAthleteIds as jest.Mock;

const COACH = {
  accountId: 'acct-coach',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'secret-token',
  authProvider: 'microsoft',
};

const ROW = {
  cap_id: 'cap-1',
  athlete_id: 'ath-1',
  highest_allowed_stage: 'controlled_sparring',
  max_hard_open_sessions_per_7_days: 1,
  note: 'Only with Coach present',
  set_by_account_id: 'acct-coach',
  set_by_role: 'coach',
  set_at: '2026-10-04T12:00:00.000Z',
};
const CLEARED = { ...ROW, cap_id: 'cap-2', highest_allowed_stage: null, max_hard_open_sessions_per_7_days: null };

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/pilot/coach/athlete-contact-caps${query}`));
}

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/pilot/coach/athlete-contact-caps', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('roles that can never hold a cap are refused before the module runs', () => {
  it.each(['athlete', 'parent', 'volunteer', 'staff', 'platform_owner', 'board'])('%s', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    expect((await get('?athlete_id=ath-1')).status).toBe(403);
    expect((await post({ athlete_id: 'ath-1', highest_allowed_stage: 'none' })).status).toBe(403);
    expect(mockHistory).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('needs an athlete_id', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    expect((await get('')).status).toBe(400);
  });

  it('hands the module the session identity, without the session token, and names the setter', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockHistory.mockResolvedValue([ROW]);
    const response = await get('?athlete_id=ath-1');
    expect(response.status).toBe(200);
    const actor = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };
    expect(mockHistory).toHaveBeenCalledTimes(1);
    expect(mockHistory).toHaveBeenCalledWith(actor, 'ath-1');
    const body = await response.json();
    expect(body.cap).toEqual({ ...ROW, set_by_name: 'Coach acct-coach' });
    expect(body.history).toHaveLength(1);
  });

  it('the cap in force is the newest history row, from the same read', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    const newer = { ...ROW, cap_id: 'cap-3', highest_allowed_stage: 'none' };
    mockHistory.mockResolvedValue([newer, ROW]);
    expect((await (await get('?athlete_id=ath-1')).json()).cap.cap_id).toBe('cap-3');
  });

  it('a cleared cap, like no row at all, answers cap: null', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockHistory.mockResolvedValue([CLEARED, ROW]);
    expect((await (await get('?athlete_id=ath-1')).json()).cap).toBeNull();

    mockHistory.mockResolvedValue([]);
    expect((await (await get('?athlete_id=ath-1')).json()).cap).toBeNull();
  });

  it('passes the module\'s refusal through as a 403', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    const { ForbiddenError } = jest.requireActual('@/src/server/pilot/errors');
    mockHistory.mockRejectedValue(new ForbiddenError('no', 'CONTACT_CAP_NOT_PERMITTED'));
    expect((await get('?athlete_id=ath-1')).status).toBe(403);
  });
});

describe('POST', () => {
  it('writes for the session\'s actor, never one named in the body', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockSet.mockResolvedValue(ROW);
    const response = await post({
      athlete_id: ' ath-1 ',
      highest_allowed_stage: 'controlled_sparring',
      max_hard_open_sessions_per_7_days: 1,
      note: 'Only with Coach present',
      actor: { accountId: 'someone-else', role: 'organization_admin' },
      set_by_account_id: 'someone-else',
    });
    expect(response.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({
      actor: { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null },
      athleteId: 'ath-1',
      highestAllowedStage: 'controlled_sparring',
      maxHardOpenSessionsPer7Days: 1,
      note: 'Only with Coach present',
    });
    expect((await response.json()).cap.set_by_name).toBe('Coach acct-coach');
  });

  it('empty values clear a limit, and both empty answers cap: null', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockSet.mockResolvedValue(CLEARED);
    const response = await post({ athlete_id: 'ath-1', highest_allowed_stage: '', max_hard_open_sessions_per_7_days: null });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ highestAllowedStage: null, maxHardOpenSessionsPer7Days: null, note: '' }),
    );
    const body = await response.json();
    expect(body.cap).toBeNull();
    expect(body.written.cap_id).toBe('cap-2');
  });

  it.each([
    ['an invented stage', { highest_allowed_stage: 'hard_sparring' }],
    ['a count sent as text', { max_hard_open_sessions_per_7_days: '2' }],
    ['a fractional count', { max_hard_open_sessions_per_7_days: 1.5 }],
    ['a note that is not text', { note: 7 }],
    ['no athlete', { athlete_id: '' }],
    ['a body that omits both limits', { highest_allowed_stage: undefined, max_hard_open_sessions_per_7_days: undefined, note: 'x' }],
    ['a body that omits the session limit', { highest_allowed_stage: 'none', max_hard_open_sessions_per_7_days: undefined }],
    ['a body that omits the stage', { highest_allowed_stage: undefined, max_hard_open_sessions_per_7_days: 2 }],
  ])('refuses %s with a 400 and writes nothing', async (_label, patch) => {
    mockPrincipal.mockResolvedValue(COACH);
    // A complete, valid body, so each case is refused for its own reason.
    // JSON drops `undefined`, which is how a case omits a key.
    const response = await post({
      athlete_id: 'ath-1',
      highest_allowed_stage: null,
      max_hard_open_sessions_per_7_days: null,
      ...patch,
    });
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('POST action accessible_athletes (the cap page roster)', () => {
  it('returns the ids the module admits, for the session actor, and writes nothing', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockAccessible.mockResolvedValue(new Set(['ath-1']));
    const response = await post({ action: 'accessible_athletes', athlete_ids: ['ath-1', 'ath-2'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, athlete_ids: ['ath-1'] });
    expect(mockAccessible).toHaveBeenCalledWith(
      { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null },
      ['ath-1', 'ath-2'],
    );
    expect(mockSet).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown action', { action: 'delete' }],
    ['ids that are not a list', { action: 'accessible_athletes', athlete_ids: 'ath-1' }],
    ['ids that are not text', { action: 'accessible_athletes', athlete_ids: [1] }],
    ['more than 1000 ids', { action: 'accessible_athletes', athlete_ids: Array.from({ length: 1001 }, (_, i) => `a${i}`) }],
  ])('refuses %s with a 400', async (_label, body) => {
    mockPrincipal.mockResolvedValue(COACH);
    expect((await post(body)).status).toBe(400);
    expect(mockAccessible).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('roles that can never hold a cap are refused before the module runs', async () => {
    mockPrincipal.mockResolvedValue({ ...COACH, role: 'parent' });
    expect((await post({ action: 'accessible_athletes', athlete_ids: ['ath-1'] })).status).toBe(403);
    expect(mockAccessible).not.toHaveBeenCalled();
  });
});
