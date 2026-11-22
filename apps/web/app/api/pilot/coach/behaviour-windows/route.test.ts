import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { listOpenBehaviourWindows, openBehaviourWindow } from '@/src/server/pilot/behaviourSampleWindows';
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

jest.mock('@/src/server/pilot/behaviourSampleWindows', () => {
  const actual = jest.requireActual('@/src/server/pilot/behaviourSampleWindows');
  return { ...actual, listOpenBehaviourWindows: jest.fn(), openBehaviourWindow: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockList = listOpenBehaviourWindows as jest.Mock;
const mockOpen = openBehaviourWindow as jest.Mock;

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

const URL_BASE = 'http://localhost/api/pilot/coach/behaviour-windows';
const getRequest = (query = '?sessionRunId=run-1') => new NextRequest(`${URL_BASE}${query}`);
const postRequest = (body: unknown) =>
  new NextRequest(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const WINDOW = {
  athleteId: 'ath-1',
  behaviourKey: 'k_one',
  sessionRunId: 'run-1',
  drillId: 'drill-1',
  taskConstraint: 'controlled',
};

test('athletes, parents, the board, the platform owner and other roles cannot open or list windows (staff only)', async () => {
  for (const role of ['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
    expect((await GET(getRequest())).status).toBe(403);
    expect((await POST(postRequest(WINDOW))).status).toBe(403);
  }
  expect(mockList).not.toHaveBeenCalled();
  expect(mockOpen).not.toHaveBeenCalled();
});

test('a window is opened as the caller, in the caller\'s role and gym, whatever the body says', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-7', role: 'organization_admin' }));
  mockOpen.mockResolvedValue({ window_id: 'win-1' });
  const response = await POST(postRequest({
    ...WINDOW, chances: 5, organizationId: 'org-other', openedByAccountId: 'acct-other', openedByRole: 'admin',
  }));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ ok: true, window: { window_id: 'win-1' } });
  expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', accountId: 'acct-7' }), 'ath-1');
  expect(mockOpen).toHaveBeenCalledWith({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    behaviourKey: 'k_one',
    runId: 'run-1',
    context: { drillId: 'drill-1' },
    taskConstraint: 'controlled',
    chances: 5,
    openedByAccountId: 'acct-7',
    openedByRole: 'organization_admin',
  });
});

test('an athlete the caller may not reach answers as one that does not exist', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(new Error('Forbidden'));
  expect((await POST(postRequest(WINDOW))).status).toBe(404);
  expect(mockOpen).not.toHaveBeenCalled();
});

test('a body without a run, with no drill context or two, without a name or athlete, or with chances not a number is refused before anything runs', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  for (const body of [
    { ...WINDOW, sessionRunId: undefined, sessionDate: '2026-11-22' },
    { ...WINDOW, drillId: undefined },
    { ...WINDOW, blockId: 'block-1' },
    { ...WINDOW, behaviourKey: '' },
    { ...WINDOW, athleteId: undefined },
    { ...WINDOW, chances: 'ten' },
    null,
    [],
    7,
  ]) {
    expect((await POST(postRequest(body))).status).toBe(400);
  }
  expect(mockAccess).not.toHaveBeenCalled();
  expect(mockOpen).not.toHaveBeenCalled();
});

test('the server\'s reason reaches the coach as a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockOpen.mockRejectedValue(new ValidationError('That athlete is not marked present in that session run.'));
  const response = await POST(postRequest(WINDOW));
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).toContain('not marked present');
});

test('the open windows of a run are listed for the caller, leaving out any whose athlete the caller may not reach', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-4' }));
  mockList.mockResolvedValue([
    { window_id: 'win-1', athlete_id: 'ath-1' },
    { window_id: 'win-2', athlete_id: 'ath-hidden' },
  ]);
  mockAccess.mockImplementation(async (_actor: unknown, athleteId: string) => {
    if (athleteId === 'ath-hidden') throw new Error('Forbidden');
  });
  const response = await GET(getRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, windows: [{ window_id: 'win-1', athlete_id: 'ath-1' }] });
  expect(mockList).toHaveBeenCalledWith({ organizationId: 'org-1', runId: 'run-1', readerAccountId: 'acct-4' });
  expect((await GET(getRequest(''))).status).toBe(400);
});
