import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  confirmPathwayCheckpoint,
  getAthletePathway,
  grantMinorAllowance,
  pathwayAccessibleAthleteIds,
  placeAthleteOnStage,
  withdrawMinorAllowance,
  withdrawPathwayCheckpoint,
} from '@/src/server/pilot/adultPathway';
import { ConflictError, ForbiddenError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The route over adultPathway.ts. Who may reach which athlete, and who may be
 * placed, are proven against real rows in adultPathway.pg.test.ts; with the
 * module mocked, this file asserts what only the route decides: which roles
 * are refused before the module runs, that the identity handed down is the
 * SESSION's and never anything in the body, how each action is parsed, and
 * that people come back as names, not account ids.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/achievements', () => ({
  getCoachDisplayName: jest.fn(async (_org: string, accountId: string) => `Coach ${accountId}`),
}));

jest.mock('@/src/server/pilot/adultPathway', () => {
  const actual = jest.requireActual('@/src/server/pilot/adultPathway');
  return {
    ...actual,
    getAthletePathway: jest.fn(),
    pathwayAccessibleAthleteIds: jest.fn(),
    placeAthleteOnStage: jest.fn(async () => ({ placement_id: 'pl-1' })),
    confirmPathwayCheckpoint: jest.fn(async () => ({ confirmation_id: 'c-1' })),
    withdrawPathwayCheckpoint: jest.fn(async () => undefined),
    grantMinorAllowance: jest.fn(async () => ({ allowance_id: 'al-1' })),
    withdrawMinorAllowance: jest.fn(async () => ({ allowance: {}, endedPlacementId: 'pl-1' })),
  };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockGet = getAthletePathway as jest.Mock;
const mockAccessible = pathwayAccessibleAthleteIds as jest.Mock;
const mockPlace = placeAthleteOnStage as jest.Mock;

const COACH = {
  accountId: 'acct-coach',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'secret-token',
  authProvider: 'microsoft',
};
const SESSION_ACTOR = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/pilot/coach/adult-pathway${query}`));
}

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/pilot/coach/adult-pathway', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  mockPrincipal.mockResolvedValue(COACH);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('who reaches the module', () => {
  it.each(['athlete', 'parent', 'volunteer', 'board', 'platform_owner'])('refuses a %s before the module runs', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    expect((await get('?athlete_id=ath-1')).status).toBe(403);
    expect((await post({ action: 'place', athlete_id: 'ath-1', stage_key: 'foundation' })).status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPlace).not.toHaveBeenCalled();
  });

  it.each(['coach', 'organization_admin', 'admin'])('lets a %s through to the module', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    expect((await post({ action: 'place', athlete_id: 'ath-1', stage_key: 'foundation' })).status).toBe(200);
  });

  it("hands down the session's identity, never one in the body", async () => {
    await post({
      action: 'place', athlete_id: 'ath-1', stage_key: 'foundation',
      actor: { accountId: 'acct-forged', role: 'organization_admin' }, organization_id: 'org-other',
    });
    expect(mockPlace).toHaveBeenCalledWith(
      { actor: SESSION_ACTOR, athleteId: 'ath-1', stageKey: 'foundation', note: '' },
    );
  });

  it("passes the module's refusals through with their status", async () => {
    mockPlace.mockRejectedValueOnce(new ConflictError('under 18', 'PATHWAY_ALLOWANCE_REQUIRED'));
    expect((await post({ action: 'place', athlete_id: 'ath-1', stage_key: 'foundation' })).status).toBe(409);
    mockGet.mockRejectedValueOnce(new ForbiddenError('no', 'PATHWAY_NOT_PERMITTED'));
    expect((await get('?athlete_id=ath-1')).status).toBe(403);
  });
});

describe('parsing', () => {
  it('needs an athlete id and a known action', async () => {
    expect((await get('')).status).toBe(400);
    expect((await post({ action: 'promote', athlete_id: 'ath-1' })).status).toBe(400);
    expect((await post({ athlete_id: 'ath-1', stage_key: 'foundation' })).status).toBe(400);
    expect((await post({ action: 'place', stage_key: 'foundation' })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
  });

  it('refuses a missing or blank allowance reason before the module runs', async () => {
    expect((await post({ action: 'grant_allowance', athlete_id: 'ath-1' })).status).toBe(400);
    expect((await post({ action: 'grant_allowance', athlete_id: 'ath-1', reason: '  ' })).status).toBe(400);
    expect(grantMinorAllowance).not.toHaveBeenCalled();
  });

  it('routes each action to its module function', async () => {
    await post({ action: 'confirm', athlete_id: 'ath-1', stage_key: 'foundation', goal_key: 'footwork' });
    expect(confirmPathwayCheckpoint).toHaveBeenCalledWith(
      { actor: SESSION_ACTOR, athleteId: 'ath-1', stageKey: 'foundation', goalKey: 'footwork' },
    );
    await post({ action: 'withdraw_checkpoint', athlete_id: 'ath-1', goal_key: 'footwork' });
    expect(withdrawPathwayCheckpoint).toHaveBeenCalledWith({ actor: SESSION_ACTOR, athleteId: 'ath-1', goalKey: 'footwork' });
    await post({ action: 'grant_allowance', athlete_id: 'ath-1', reason: 'Adult open class.' });
    expect(grantMinorAllowance).toHaveBeenCalledWith({ actor: SESSION_ACTOR, athleteId: 'ath-1', reason: 'Adult open class.' });
    const res = await post({ action: 'withdraw_allowance', athlete_id: 'ath-1' });
    expect(withdrawMinorAllowance).toHaveBeenCalledWith({ actor: SESSION_ACTOR, athleteId: 'ath-1' });
    expect(await res.json()).toEqual({ ok: true, ended_placement_id: 'pl-1' });
  });

  it('caps and checks the roster list', async () => {
    mockAccessible.mockResolvedValue(new Set(['ath-1']));
    const ok = await post({ action: 'accessible_athletes', athlete_ids: ['ath-1', 'ath-2'] });
    expect(await ok.json()).toEqual({ ok: true, athlete_ids: ['ath-1'] });
    expect((await post({ action: 'accessible_athletes', athlete_ids: [1] })).status).toBe(400);
    expect((await post({ action: 'accessible_athletes', athlete_ids: Array(1001).fill('a') })).status).toBe(400);
  });
});

describe('the read', () => {
  it('names people instead of returning account ids alone', async () => {
    mockGet.mockResolvedValue({
      eligibility: { eligible: false, basis: 'minor' },
      allowance: null,
      current: { placement_id: 'pl-1', stage_key: 'foundation', set_by_account_id: 'acct-a', ended_by_account_id: null },
      history: [{ placement_id: 'pl-1', stage_key: 'foundation', set_by_account_id: 'acct-a', ended_by_account_id: null }],
      checkpoints: [{ goal_key: 'footwork', confirmed_by_account_id: 'acct-b' }],
    });
    const res = await get('?athlete_id=ath-1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.eligibility).toEqual({ eligible: false, basis: 'minor' });
    expect(body.current).toMatchObject({ set_by_name: 'Coach acct-a', ended_by_name: null });
    expect(body.checkpoints[0]).toMatchObject({ confirmed_by_name: 'Coach acct-b' });
    expect(mockGet).toHaveBeenCalledWith(SESSION_ACTOR, 'ath-1');
  });
});
