import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { listBehaviourObservations, recordBehaviourObservation } from '@/src/server/pilot/behaviourObservations';
import { ValidationError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/behaviourObservations', () => {
  const actual = jest.requireActual('@/src/server/pilot/behaviourObservations');
  return {
    ...actual,
    listBehaviourObservations: jest.fn().mockResolvedValue([]),
    recordBehaviourObservation: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockList = listBehaviourObservations as jest.Mock;
const mockRecord = recordBehaviourObservation as jest.Mock;

beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
  mockList.mockResolvedValue([]);
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const URL_BASE = 'http://localhost/api/pilot/coach/behaviour-observations';
const getRequest = (query = '?athleteId=ath-1') => new NextRequest(`${URL_BASE}${query}`);
const postRequest = (body: Record<string, unknown>) =>
  new NextRequest(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const REPORT = {
  athleteId: 'ath-1',
  behaviourKey: 'drops_lead_hand_after_jab',
  sessionRunId: 'run-1',
  drillId: 'drill-1',
  taskConstraint: 'controlled',
  polarity: 'occurrence',
  attributionTarget: 'athlete',
  attributionCertainty: 'probable',
};

test('athletes, parents, the board and the platform owner cannot read or file reports (Q2: staff only)', async () => {
  for (const role of ['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
    expect((await GET(getRequest())).status).toBe(403);
    expect((await POST(postRequest(REPORT))).status).toBe(403);
  }
  expect(mockList).not.toHaveBeenCalled();
  expect(mockRecord).not.toHaveBeenCalled();
});

test('an athlete the caller may not reach answers as one that does not exist', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(new Error('Forbidden'));
  expect((await GET(getRequest())).status).toBe(404);
  expect((await POST(postRequest(REPORT))).status).toBe(404);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockRecord).not.toHaveBeenCalled();
});

test("staff list one athlete's reports in their own gym", async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  mockList.mockResolvedValue([{ observation_id: 'obs-1' }]);
  const response = await GET(getRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, observations: [{ observation_id: 'obs-1' }] });
  expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'ath-1');
  expect(mockList).toHaveBeenCalledWith('org-1', 'ath-1');
  expect((await GET(getRequest(''))).status).toBe(400);
});

test('a report is filed as the caller, in the caller\'s role and gym', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-7', role: 'coach' }));
  mockRecord.mockResolvedValue({ observation_id: 'obs-9' });
  const response = await POST(postRequest({ ...REPORT, note: 'dropped it twice', viewQuality: 'clear', sameMomentAs: 'obs-2' }));
  expect(response.status).toBe(201);
  expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    observerAccountId: 'acct-7',
    authorRole: 'coach',
    session: { runId: 'run-1' },
    context: { drillId: 'drill-1' },
    sameMomentAs: 'obs-2',
    viewQuality: 'clear',
    note: 'dropped it twice',
  }));
});

test('a body with no session, two sessions, no drill context or two of them is refused before anything runs', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  const noSession = { ...REPORT, sessionRunId: undefined };
  for (const body of [
    noSession,
    { ...REPORT, sessionDate: '2026-10-18' },
    { ...REPORT, drillId: undefined },
    { ...REPORT, blockId: 'block-1' },
    { ...REPORT, athleteId: '' },
  ]) {
    expect((await POST(postRequest(body))).status).toBe(400);
  }
  expect(mockAccess).not.toHaveBeenCalled();
  expect(mockRecord).not.toHaveBeenCalled();
});

test('a body that is not an object is refused as a 400, not a 500', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  for (const raw of ['null', '7', '[]']) {
    const response = await POST(new NextRequest(URL_BASE, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
    }));
    expect(response.status).toBe(400);
  }
  expect(mockRecord).not.toHaveBeenCalled();
});

test("the writer's reason reaches the coach as a 400", async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockRecord.mockRejectedValue(new ValidationError('That behaviour name is not on the active list.'));
  const response = await POST(postRequest(REPORT));
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).toContain('not on the active list');
});
