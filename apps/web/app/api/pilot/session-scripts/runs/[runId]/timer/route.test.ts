import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  adjustRoundTimer,
  configureRoundTimer,
  moveRoundTimer,
  readOwnRoundTimer,
  readRoundTimerRevision,
  type RoundTimerView,
} from '@/src/server/pilot/roundTimers';
import { SessionScriptRunError } from '@/src/server/pilot/sessionScriptRuns';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/roundTimers', () => ({
  ...jest.requireActual('@/src/server/pilot/roundTimers'),
  configureRoundTimer: jest.fn(),
  moveRoundTimer: jest.fn(),
  readOwnRoundTimer: jest.fn(),
  adjustRoundTimer: jest.fn(),
  readRoundTimerRevision: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockConfigure = jest.mocked(configureRoundTimer);
const mockMove = jest.mocked(moveRoundTimer);
const mockRead = jest.mocked(readOwnRoundTimer);
const mockAdjust = jest.mocked(adjustRoundTimer);
const mockRevision = jest.mocked(readRoundTimerRevision);

const TIMER: RoundTimerView = {
  state: 'ready',
  phase: 'ready',
  round: 0,
  rounds_total: 3,
  round_seconds: 180,
  rest_seconds: 60,
  seconds_left: 0,
  is_paused: false,
};

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: 'acct-coach',
    organizationId: 'org-1',
    role,
  } as Awaited<ReturnType<typeof requirePrincipal>>);
}

function post(body: unknown, runId = 'ssrun_1') {
  return POST(
    new NextRequest(`http://localhost/api/pilot/session-scripts/runs/${runId}/timer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );
}

function get(runId = 'ssrun_1') {
  return GET(new NextRequest(`http://localhost/api/pilot/session-scripts/runs/${runId}/timer`), {
    params: Promise.resolve({ runId }),
  });
}

const CONFIGURE = { action: 'configure', round_seconds: 180, rest_seconds: 60, rounds_total: 3 };

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigure.mockResolvedValue(TIMER);
  mockMove.mockResolvedValue({ ...TIMER, state: 'running', phase: 'work', round: 1, seconds_left: 180 });
  mockRead.mockResolvedValue(TIMER);
  // No revision unless a test gives one: the answers below then read exactly as before.
  mockRevision.mockResolvedValue(null);
});

describe('GET: the coach screens read the shared timer', () => {
  it.each(['coach', 'organization_admin', 'admin'])('%s reads it, uncached, from the session gym and account', async (role) => {
    as(role);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ timer: TIMER });
    expect(mockRead).toHaveBeenCalledWith('org-1', 'acct-coach', 'ssrun_1');
  });

  it('a run with no timer reads null', async () => {
    as('coach');
    mockRead.mockResolvedValue(null);
    expect(await (await get()).json()).toEqual({ timer: null });
  });

  it.each(['athlete', 'parent', 'platform_owner', 'volunteer'])('%s is refused', async (role) => {
    as(role);
    expect((await get()).status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('POST: configure, start, pause, resume, end', () => {
  it('configure passes the three numbers and nothing else', async () => {
    as('coach');
    const response = await post(CONFIGURE);
    expect(response.status).toBe(200);
    expect(mockConfigure).toHaveBeenCalledWith('org-1', 'acct-coach', 'ssrun_1', {
      roundSeconds: 180,
      restSeconds: 60,
      roundsTotal: 3,
    });
    expect(await response.json()).toEqual({ timer: TIMER });
  });

  it.each(['start', 'pause', 'resume', 'end'])('%s is one named move', async (action) => {
    as('coach');
    const response = await post({ action });
    expect(response.status).toBe(200);
    expect(mockMove).toHaveBeenCalledWith('org-1', 'acct-coach', 'ssrun_1', action);
    expect(mockConfigure).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...CONFIGURE, round_seconds: 0 }, 'round_seconds'],
    [{ ...CONFIGURE, round_seconds: 3601 }, 'round_seconds'],
    [{ ...CONFIGURE, round_seconds: 90.5 }, 'round_seconds'],
    [{ ...CONFIGURE, round_seconds: '180' }, 'round_seconds'],
    [{ ...CONFIGURE, rest_seconds: -1 }, 'rest_seconds'],
    [{ ...CONFIGURE, rest_seconds: 3601 }, 'rest_seconds'],
    [{ ...CONFIGURE, rounds_total: 0 }, 'rounds_total'],
    [{ ...CONFIGURE, rounds_total: 101 }, 'rounds_total'],
    [{ action: 'configure' }, 'round_seconds'],
  ])('configure refuses %j with 400 %s before any write', async (body, code) => {
    as('coach');
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: code });
    expect(mockConfigure).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: 'start', started_at: '2026-10-12T18:00:00Z' }, 'UNEXPECTED_FIELD:started_at'],
    [{ action: 'pause', seconds_left: 10 }, 'UNEXPECTED_FIELD:seconds_left'],
    [{ ...CONFIGURE, state: 'running' }, 'UNEXPECTED_FIELD:state'],
    [{ action: 'restart' }, 'action:expected one of configure|start|pause|resume|end|add_30|repeat'],
    [{}, 'action:expected one of configure|start|pause|resume|end|add_30|repeat'],
  ])('refuses a client-sent time, state or unknown action: %j', async (body, code) => {
    as('coach');
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: code });
    expect(mockMove).not.toHaveBeenCalled();
    expect(mockConfigure).not.toHaveBeenCalled();
  });

  it('a body that is not an object is a 400', async () => {
    as('coach');
    expect((await post('[1]')).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
  });

  it.each(['athlete', 'parent', 'platform_owner', 'volunteer'])('%s is refused', async (role) => {
    as(role);
    expect((await post({ action: 'start' })).status).toBe(403);
    expect(mockMove).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'SESSION_RUN_NOT_FOUND'],
    [409, 'SESSION_RUN_NOT_LIVE'],
    [409, 'ROUND_TIMER_RUNNING'],
    [409, 'ROUND_TIMER_NOT_SET'],
    [409, 'ROUND_TIMER_PAUSED'],
  ])("the module's %s %s reaches the caller", async (status, code) => {
    as('coach');
    mockMove.mockRejectedValue(new SessionScriptRunError(code, status));
    const response = await post({ action: 'start' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });
});

// +30 SEC and REPEAT (OD-2026-10-17-010): named actions that carry the revision the screen read.
describe('POST add_30 / repeat', () => {
  const RUNNING: RoundTimerView = { ...TIMER, state: 'running', phase: 'work', round: 2, seconds_left: 110 };

  it.each(['add_30', 'repeat'] as const)('%s passes the action and the revision through, and answers with the next revision', async (action) => {
    as('coach');
    mockAdjust.mockResolvedValue({ timer: RUNNING, revision: '1760724000000002' });
    const response = await post({ action, revision: '1760724000000001' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ timer: RUNNING, revision: '1760724000000002' });
    expect(mockAdjust).toHaveBeenCalledWith('org-1', 'acct-coach', 'ssrun_1', action, '1760724000000001');
    expect(mockMove).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: 'add_30' }],
    [{ action: 'add_30', revision: 1760724000000001 }],
    [{ action: 'repeat', revision: 'abc' }],
    [{ action: 'repeat', revision: '' }],
  ])('refuses %j without a revision it can compare', async (body) => {
    as('coach');
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'revision' });
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it('refuses any other field, as every action here does', async () => {
    as('coach');
    const response = await post({ action: 'add_30', revision: '1', seconds: 30 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'UNEXPECTED_FIELD:seconds' });
  });

  it('a revision on start, pause, resume or end is still an unexpected field', async () => {
    as('coach');
    const response = await post({ action: 'pause', revision: '1' });
    expect(await response.json()).toEqual({ error: 'UNEXPECTED_FIELD:revision' });
  });

  it.each([
    ['ROUND_TIMER_STALE', 409],
    ['ROUND_TIMER_TOO_EARLY', 409],
    ['SESSION_RUN_NOT_FOUND', 404],
  ])('a refusal from the module answers %s with %d', async (code, status) => {
    as('coach');
    mockAdjust.mockRejectedValue(new SessionScriptRunError(code, status));
    const response = await post({ action: 'add_30', revision: '1' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  it('every answer with a timer carries its revision, so the screen can send it back', async () => {
    as('coach');
    mockRevision.mockResolvedValue('1760724000000009');
    expect(await (await get()).json()).toEqual({ timer: TIMER, revision: '1760724000000009' });
    expect(await (await post({ action: 'start' })).json()).toMatchObject({ revision: '1760724000000009' });
    expect(await (await post(CONFIGURE)).json()).toMatchObject({ revision: '1760724000000009' });
  });

  it('no timer, no revision', async () => {
    as('coach');
    mockRead.mockResolvedValue(null);
    expect(await (await get()).json()).toEqual({ timer: null });
    expect(mockRevision).not.toHaveBeenCalled();
  });
});
