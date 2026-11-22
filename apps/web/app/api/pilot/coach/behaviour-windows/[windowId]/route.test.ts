import { NextRequest } from 'next/server';

import { GET, PATCH } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  behaviourWindowOf,
  changeLastWindowTap,
  closeBehaviourWindow,
  currentWindowChance,
  listMyWindowTaps,
  recordWindowTap,
} from '@/src/server/pilot/behaviourSampleWindows';
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
  return {
    ...actual,
    behaviourWindowOf: jest.fn(),
    changeLastWindowTap: jest.fn(),
    closeBehaviourWindow: jest.fn(),
    currentWindowChance: jest.fn(),
    listMyWindowTaps: jest.fn(),
    recordWindowTap: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockWindow = behaviourWindowOf as jest.Mock;
const mockChange = changeLastWindowTap as jest.Mock;
const mockClose = closeBehaviourWindow as jest.Mock;
const mockCurrent = currentWindowChance as jest.Mock;
const mockMine = listMyWindowTaps as jest.Mock;
const mockTap = recordWindowTap as jest.Mock;
const ACTIONS = [mockChange, mockClose, mockCurrent, mockMine, mockTap];

const WINDOW_ROW = { window_id: 'win-1', athlete_id: 'ath-1', chances: 10, closed_at: null };

beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
  mockWindow.mockResolvedValue(WINDOW_ROW);
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

const URL_BASE = 'http://localhost/api/pilot/coach/behaviour-windows/win-1';
const context = { params: Promise.resolve({ windowId: 'win-1' }) };
const get = (query = '') => GET(new NextRequest(`${URL_BASE}${query}`), context);
const patch = (body: unknown) => PATCH(
  new NextRequest(URL_BASE, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  context,
);

test('athletes, parents, the board, the platform owner and other roles cannot read or work a window (staff only)', async () => {
  for (const role of ['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
    expect((await get()).status).toBe(403);
    expect((await patch({ action: 'close' })).status).toBe(403);
  }
  expect(mockWindow).not.toHaveBeenCalled();
  for (const action of ACTIONS) expect(action).not.toHaveBeenCalled();
});

test('a window of another gym, or of an athlete the caller may not reach, answers as one that does not exist', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockWindow.mockRejectedValueOnce(new ValidationError('That window is not in this gym.'));
  expect((await get()).status).toBe(404);
  mockAccess.mockRejectedValue(new Error('Forbidden'));
  expect((await get()).status).toBe(404);
  for (const body of [
    { action: 'tap', chance: 1, polarity: 'occurrence' },
    { action: 'change_last', polarity: 'counterexample' },
    { action: 'close' },
  ]) {
    expect((await patch(body)).status).toBe(404);
  }
  expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'ath-1');
  for (const action of ACTIONS) expect(action).not.toHaveBeenCalled();
});

test('a failure to read the window is an error, not a quiet 404', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockWindow.mockRejectedValue(new Error('connection refused'));
  expect((await get()).status).toBe(500);
});

test('a coach reads the window, the chance the count stands at, and their own taps only (Q2 A)', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-5' }));
  mockCurrent.mockResolvedValue(4);
  mockMine.mockResolvedValue([{ chance: 2, polarity: 'occurrence' }]);
  // An account named in the query string is ignored: the reader is the session's.
  const response = await get('?observerAccountId=acct-other&readerAccountId=acct-other');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true, window: WINDOW_ROW, currentChance: 4, myTaps: [{ chance: 2, polarity: 'occurrence' }],
  });
  expect(mockWindow).toHaveBeenCalledWith('org-1', 'win-1');
  expect(mockCurrent).toHaveBeenCalledWith({ organizationId: 'org-1', windowId: 'win-1', readerAccountId: 'acct-5' });
  expect(mockMine).toHaveBeenCalledWith({ organizationId: 'org-1', windowId: 'win-1', observerAccountId: 'acct-5' });
});

test('a tap, a change of the last tap and a close are made as the caller, in the caller\'s role, whatever the body says', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-5', role: 'admin' }));
  const smuggled = { observerAccountId: 'acct-other', authorRole: 'coach', organizationId: 'org-other', closedByAccountId: 'acct-other' };
  mockTap.mockResolvedValue({ chance: 3, polarity: 'occurrence' });
  const tapped = await patch({ action: 'tap', chance: 3, polarity: 'occurrence', ...smuggled });
  expect(tapped.status).toBe(200);
  expect(await tapped.json()).toEqual({ ok: true, tap: { chance: 3, polarity: 'occurrence' } });
  expect(mockTap).toHaveBeenCalledWith({
    organizationId: 'org-1', windowId: 'win-1', chance: 3, polarity: 'occurrence', observerAccountId: 'acct-5', authorRole: 'admin',
  });

  mockChange.mockResolvedValue({ chance: 3, polarity: 'counterexample' });
  const changed = await patch({ action: 'change_last', polarity: 'counterexample', ...smuggled });
  expect(await changed.json()).toEqual({ ok: true, tap: { chance: 3, polarity: 'counterexample' } });
  expect(mockChange).toHaveBeenCalledWith({
    organizationId: 'org-1', windowId: 'win-1', polarity: 'counterexample', observerAccountId: 'acct-5', authorRole: 'admin',
  });

  mockClose.mockResolvedValue({ ...WINDOW_ROW, closed_at: '2026-11-22T20:00:00Z' });
  const closed = await patch({ action: 'close', ...smuggled });
  expect(await closed.json()).toEqual({ ok: true, window: { ...WINDOW_ROW, closed_at: '2026-11-22T20:00:00Z' } });
  expect(mockClose).toHaveBeenCalledWith({ organizationId: 'org-1', windowId: 'win-1', closedByAccountId: 'acct-5' });
});

test('an unknown action, a chance that is not a whole number, or a missing polarity is refused before anything runs', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  for (const body of [
    { action: 'reopen' },
    {},
    { action: 'tap', chance: '3', polarity: 'occurrence' },
    { action: 'tap', chance: 2.5, polarity: 'occurrence' },
    { action: 'tap', chance: 3 },
    { action: 'change_last' },
    null,
    [],
  ]) {
    expect((await patch(body)).status).toBe(400);
  }
  expect(mockWindow).not.toHaveBeenCalled();
  for (const action of ACTIONS) expect(action).not.toHaveBeenCalled();
});

test('the server\'s reason reaches the coach as a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockTap.mockRejectedValue(new ValidationError('That window is closed.'));
  const response = await patch({ action: 'tap', chance: 1, polarity: 'occurrence' });
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).toContain('That window is closed.');
});
