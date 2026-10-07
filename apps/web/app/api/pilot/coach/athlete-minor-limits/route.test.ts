import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  minorLimitAccessibleAthleteIds,
  readAthleteMinorLimits,
  setMinorLimit,
} from '@/src/server/pilot/athleteMinorLimits';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The route over athleteMinorLimits.ts. Who may reach which athlete is proven
 * against real rows in athleteMinorLimits.pg.test.ts; with the module mocked,
 * this file asserts what only the route decides: which roles are refused
 * before the module runs, that the identity handed down is the SESSION's and
 * never anything in the body, how the body is parsed (one type per write, the
 * value key required, text for supervision and a number otherwise), and that
 * a cleared limit answers `limit: null` -- the same "no limit set" an athlete
 * with no row gets.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/achievements', () => ({
  getCoachDisplayName: jest.fn(async (_org: string, accountId: string) => `Coach ${accountId}`),
}));

jest.mock('@/src/server/pilot/athleteMinorLimits', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteMinorLimits');
  return {
    ...actual,
    minorLimitAccessibleAthleteIds: jest.fn(),
    readAthleteMinorLimits: jest.fn(),
    setMinorLimit: jest.fn(),
  };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readAthleteMinorLimits as jest.Mock;
const mockSet = setMinorLimit as jest.Mock;
const mockAccessible = minorLimitAccessibleAthleteIds as jest.Mock;

const COACH = {
  accountId: 'acct-coach',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'secret-token',
  authProvider: 'microsoft',
};
const ACTOR = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };

const HEAT = {
  limit_id: 'lim-1',
  athlete_id: 'ath-1',
  limit_type: 'heat_exposure_minutes_per_session',
  value_number: 20,
  value_text: null,
  unit: 'minutes',
  note: 'Summer only',
  set_by_account_id: 'acct-coach',
  set_by_role: 'coach',
  set_at: '2026-10-07T12:00:00.000Z',
};
const SUPERVISION = {
  ...HEAT,
  limit_id: 'lim-2',
  limit_type: 'supervision',
  value_number: null,
  value_text: 'Coach within arm\'s reach for all pad work',
  unit: 'text',
};
const CLEARED_HEAT = { ...HEAT, limit_id: 'lim-3', value_number: null };

const EMPTY_LIMITS = {
  heat_exposure_minutes_per_session: null,
  weight_cut_max_percent_body_weight: null,
  supervision: null,
};

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/pilot/coach/athlete-minor-limits${query}`));
}

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/pilot/coach/athlete-minor-limits', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('roles that can never hold a limit are refused before the module runs', () => {
  it.each(['athlete', 'parent', 'volunteer', 'staff', 'platform_owner', 'board'])('%s', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    expect((await get('?athlete_id=ath-1')).status).toBe(403);
    expect((await post({ athlete_id: 'ath-1', limit_type: 'supervision', value: 'x' })).status).toBe(403);
    expect((await post({ action: 'accessible_athletes', athlete_ids: ['ath-1'] })).status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockAccessible).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('needs an athlete_id', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    expect((await get('')).status).toBe(400);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('hands the module the session identity, without the session token, and names each setter', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockRead.mockResolvedValue({
      athlete_is_minor: true,
      limits: { ...EMPTY_LIMITS, heat_exposure_minutes_per_session: HEAT, supervision: SUPERVISION },
      history: [SUPERVISION, HEAT],
    });
    const response = await get('?athlete_id=ath-1');
    expect(response.status).toBe(200);
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockRead).toHaveBeenCalledWith(ACTOR, 'ath-1');
    const body = await response.json();
    expect(body.athlete_is_minor).toBe(true);
    expect(body.limit_types).toEqual([
      'heat_exposure_minutes_per_session',
      'weight_cut_max_percent_body_weight',
      'supervision',
    ]);
    expect(body.limits.heat_exposure_minutes_per_session).toEqual({ ...HEAT, set_by_name: 'Coach acct-coach' });
    expect(body.limits.supervision.value_text).toBe(SUPERVISION.value_text);
    // No limit set reads as null, never as a number the app chose.
    expect(body.limits.weight_cut_max_percent_body_weight).toBeNull();
    expect(body.history).toHaveLength(2);
    expect(body.history[0].set_by_name).toBe('Coach acct-coach');
  });

  it('an adult is reported as such, with every type unset answering null', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockRead.mockResolvedValue({ athlete_is_minor: false, limits: EMPTY_LIMITS, history: [] });
    const body = await (await get('?athlete_id=ath-1')).json();
    expect(body.athlete_is_minor).toBe(false);
    expect(body.limits).toEqual(EMPTY_LIMITS);
    expect(body.history).toEqual([]);
  });

  it('passes the module\'s refusal through as a 403', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    const { ForbiddenError } = jest.requireActual('@/src/server/pilot/errors');
    mockRead.mockRejectedValue(new ForbiddenError('no', 'MINOR_LIMIT_NOT_PERMITTED'));
    expect((await get('?athlete_id=ath-1')).status).toBe(403);
  });
});

describe('POST', () => {
  it('writes a number for the session\'s actor, never one named in the body', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockSet.mockResolvedValue(HEAT);
    const response = await post({
      athlete_id: ' ath-1 ',
      limit_type: 'heat_exposure_minutes_per_session',
      value: 20,
      note: 'Summer only',
      actor: { accountId: 'someone-else', role: 'organization_admin' },
      set_by_account_id: 'someone-else',
    });
    expect(response.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({
      actor: ACTOR,
      athleteId: 'ath-1',
      limitType: 'heat_exposure_minutes_per_session',
      valueNumber: 20,
      valueText: null,
      note: 'Summer only',
    });
    const body = await response.json();
    expect(body.limit.set_by_name).toBe('Coach acct-coach');
    expect(body.written.limit_id).toBe('lim-1');
  });

  it('writes text for supervision', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockSet.mockResolvedValue(SUPERVISION);
    const response = await post({ athlete_id: 'ath-1', limit_type: 'supervision', value: SUPERVISION.value_text });
    expect(response.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ limitType: 'supervision', valueNumber: null, valueText: SUPERVISION.value_text, note: '' }),
    );
  });

  it('null or "" clears a limit, and a cleared limit answers limit: null', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockSet.mockResolvedValue(CLEARED_HEAT);
    for (const value of [null, '']) {
      const response = await post({ athlete_id: 'ath-1', limit_type: 'heat_exposure_minutes_per_session', value });
      expect(response.status).toBe(200);
      expect(mockSet).toHaveBeenLastCalledWith(expect.objectContaining({ valueNumber: null, valueText: null }));
      const body = await response.json();
      expect(body.limit).toBeNull();
      expect(body.written.limit_id).toBe('lim-3');
    }
  });

  it.each([
    ['an invented type', { limit_type: 'contact_level', value: 1 }],
    ['a number sent as text', { limit_type: 'heat_exposure_minutes_per_session', value: '20' }],
    ['a percentage sent as text', { limit_type: 'weight_cut_max_percent_body_weight', value: '3' }],
    ['supervision sent as a number', { limit_type: 'supervision', value: 2 }],
    ['a note that is not text', { limit_type: 'supervision', value: 'x', note: 7 }],
    ['no athlete', { athlete_id: '' }],
    ['a body that omits the value', { limit_type: 'supervision', value: undefined, note: 'x' }],
    ['a body that omits the type', { limit_type: undefined, value: 1 }],
  ])('refuses %s with a 400 and writes nothing', async (_label, patch) => {
    mockPrincipal.mockResolvedValue(COACH);
    // A complete, valid body, so each case is refused for its own reason.
    // JSON drops `undefined`, which is how a case omits a key.
    const response = await post({
      athlete_id: 'ath-1',
      limit_type: 'heat_exposure_minutes_per_session',
      value: 15,
      ...patch,
    });
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('passes the module\'s own shape refusal through as a 400', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    const { ValidationError } = jest.requireActual('@/src/server/pilot/errors');
    mockSet.mockRejectedValue(new ValidationError('a percentage of body weight cannot be more than 100', 'MINOR_LIMIT_INVALID'));
    expect((await post({ athlete_id: 'ath-1', limit_type: 'weight_cut_max_percent_body_weight', value: 150 })).status).toBe(400);
  });

  it.each([['a number', 5], ['a string', 'x'], ['a list', [1, 2]], ['true', true]])(
    'a body that is %s is a 400, not a server error',
    async (_label, body) => {
      mockPrincipal.mockResolvedValue(COACH);
      expect((await post(body)).status).toBe(400);
      expect(mockSet).not.toHaveBeenCalled();
    },
  );
});

describe('POST action accessible_athletes (the roster filter)', () => {
  it('returns the ids the module admits, for the session actor, and writes nothing', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockAccessible.mockResolvedValue(new Set(['ath-1']));
    const response = await post({
      action: 'accessible_athletes',
      athlete_ids: ['ath-1', 'ath-2'],
      actor: { accountId: 'someone-else', role: 'organization_admin', organizationId: 'org-1' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, athlete_ids: ['ath-1'] });
    expect(mockAccessible).toHaveBeenCalledWith(ACTOR, ['ath-1', 'ath-2']);
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
});
