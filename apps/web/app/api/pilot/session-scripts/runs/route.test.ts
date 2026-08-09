import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  SessionScriptRunError,
  getLiveRunForCoach,
  startSessionScriptRun,
} from '@/src/server/pilot/sessionScriptRuns';

// requireRole and jsonError are deliberately NOT mocked -- role gating and error mapping are two of
// the three things this suite exists to prove, and mocking them would leave both unexercised.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/sessionScriptRuns', () => ({
  ...jest.requireActual('@/src/server/pilot/sessionScriptRuns'),
  getLiveRunForCoach: jest.fn(),
  startSessionScriptRun: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockGetLive = jest.mocked(getLiveRunForCoach);
const mockStart = jest.mocked(startSessionScriptRun);

const liveRun = {
  organization_id: 'org-1',
  run_id: 'ssrun_1',
  script_id: 'scr-1',
  script_version: 2,
  activity_id: null,
  delivered_by_account_id: 'acct-coach',
  delivered_on: '2026-08-09',
  athletes_present: 11,
  blocks_completed: null,
  reset_protocol_used: false,
  deviation_note: '',
  what_worked: '',
  what_did_not: '',
  created_at: '2026-08-09T16:00:00.000Z',
  run_state: 'in_progress' as const,
  started_at: '2026-08-09T16:00:00.000Z',
  ended_at: null,
  current_block_id: 'blk-1',
  paused_at: null,
  paused_seconds: 0,
  elapsed_seconds: 600,
  is_paused: false,
};

function asCoach(role = 'coach') {
  mockPrincipal.mockResolvedValue({
    accountId: 'acct-coach',
    organizationId: 'org-1',
    role,
  } as Awaited<ReturnType<typeof requirePrincipal>>);
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/pilot/session-scripts/runs', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function get() {
  return new NextRequest('http://localhost/api/pilot/session-scripts/runs');
}

beforeEach(() => {
  jest.clearAllMocks();
  asCoach();
});

describe('GET runs — resume', () => {
  // "You have nothing running" is a successful answer to "do I have a session in progress", not a
  // missing resource. A 404 here would make the floor UI treat the normal case as an error.
  it('answers 200 with run:null when the coach has no live session', async () => {
    mockGetLive.mockResolvedValue(null);
    const response = await GET(get());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: null });
  });

  it('returns the live run including the server-computed clock', async () => {
    mockGetLive.mockResolvedValue(liveRun);
    const response = await GET(get());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.run.run_id).toBe('ssrun_1');
    expect(body.run.elapsed_seconds).toBe(600);
    expect(body.run.is_paused).toBe(false);
  });

  it('scopes the lookup to the calling coach and organization, not to anything in the request', async () => {
    mockGetLive.mockResolvedValue(null);
    await GET(get());
    expect(mockGetLive).toHaveBeenCalledWith('org-1', 'acct-coach');
  });

  // A run records who was on the floor, so browsing the plan and delivering it are different
  // permissions even though they read the same script.
  it.each(['athlete', 'parent', 'board', 'volunteer'])('refuses role %s', async (role) => {
    asCoach(role);
    mockGetLive.mockResolvedValue(liveRun);
    const response = await GET(get());
    expect(response.status).toBe(403);
    expect(mockGetLive).not.toHaveBeenCalled();
  });

  it.each(['coach', 'admin', 'organization_admin', 'platform_owner'])(
    'allows role %s',
    async (role) => {
      asCoach(role);
      mockGetLive.mockResolvedValue(null);
      expect((await GET(get())).status).toBe(200);
    },
  );
});

describe('POST runs — start', () => {
  it('starts a run and answers 201', async () => {
    mockStart.mockResolvedValue(liveRun);
    const response = await POST(post({ script_id: 'scr-1', athletes_present: 11 }));
    expect(response.status).toBe(201);
    expect(mockStart).toHaveBeenCalledWith('org-1', 'acct-coach', {
      scriptId: 'scr-1',
      activityId: null,
      athletesPresent: 11,
      deliveredOn: undefined,
    });
  });

  it('requires script_id', async () => {
    const response = await POST(post({ athletes_present: 3 }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'script_id' });
    expect(mockStart).not.toHaveBeenCalled();
  });

  // The whole point of the narrow body: these are the server's to set. Accepting either is how a
  // coach's clock becomes whatever their device believed, so they must be refused BY NAME rather
  // than quietly ignored -- a silently dropped field looks like it worked.
  it.each(['run_state', 'started_at', 'ended_at', 'paused_seconds', 'elapsed_seconds'])(
    'refuses %s rather than ignoring it',
    async (field) => {
      const response = await POST(post({ script_id: 'scr-1', [field]: 'anything' }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: `UNEXPECTED_FIELD:${field}` });
      expect(mockStart).not.toHaveBeenCalled();
    },
  );

  it('names every unexpected field, sorted, when more than one is sent', async () => {
    const response = await POST(post({ script_id: 'scr-1', zeta: 1, alpha: 2 }));
    await expect(response.json()).resolves.toEqual({ error: 'UNEXPECTED_FIELD:alpha,zeta' });
  });

  it.each([
    ['a negative count', -1],
    ['a fractional count', 2.5],
    ['a string count', '11'],
  ])('rejects athletes_present given %s', async (_label, value) => {
    const response = await POST(post({ script_id: 'scr-1', athletes_present: value }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'athletes_present' });
  });

  // Zero present is a real observation, not a missing one, and must not be coerced away.
  it('accepts zero athletes present', async () => {
    mockStart.mockResolvedValue(liveRun);
    await POST(post({ script_id: 'scr-1', athletes_present: 0 }));
    expect(mockStart).toHaveBeenCalledWith(
      'org-1',
      'acct-coach',
      expect.objectContaining({ athletesPresent: 0 }),
    );
  });

  it('passes null athletes_present through as unknown rather than as zero', async () => {
    mockStart.mockResolvedValue(liveRun);
    await POST(post({ script_id: 'scr-1', athletes_present: null }));
    expect(mockStart).toHaveBeenCalledWith(
      'org-1',
      'acct-coach',
      expect.objectContaining({ athletesPresent: null }),
    );
  });

  // delivered_on is which night this was, not when the session started. A timestamp here would
  // invite it to be confused with the start time the server owns.
  it.each(['2026-8-9', '09-08-2026', '2026-08-09T16:00:00Z', 'today'])(
    'rejects delivered_on %s',
    async (value) => {
      const response = await POST(post({ script_id: 'scr-1', delivered_on: value }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'delivered_on' });
    },
  );

  it('accepts a plain calendar date for delivered_on', async () => {
    mockStart.mockResolvedValue(liveRun);
    await POST(post({ script_id: 'scr-1', delivered_on: '2026-08-09' }));
    expect(mockStart).toHaveBeenCalledWith(
      'org-1',
      'acct-coach',
      expect.objectContaining({ deliveredOn: '2026-08-09' }),
    );
  });

  it('rejects a non-object body', async () => {
    const response = await POST(post(['script_id']));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_BODY' });
  });

  it('rejects a malformed JSON body without throwing', async () => {
    const request = new NextRequest('http://localhost/api/pilot/session-scripts/runs', {
      method: 'POST',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_BODY' });
  });

  // The module's own error codes must reach the client with their own status, so the UI can tell
  // "you already have one, go resume it" from "this plan has no blocks".
  it.each([
    ['SESSION_RUN_ALREADY_LIVE', 409],
    ['SESSION_SCRIPT_HAS_NO_BLOCKS', 422],
    ['SESSION_SCRIPT_NOT_FOUND', 404],
  ])('maps %s to %i', async (code, status) => {
    mockStart.mockRejectedValue(new SessionScriptRunError(code, status));
    const response = await POST(post({ script_id: 'scr-1' }));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code });
  });

  it('does not leak an unexpected server error as a run-state code', async () => {
    mockStart.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const response = await POST(post({ script_id: 'scr-1' }));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('connection terminated');
  });

  it.each(['athlete', 'parent'])('refuses role %s before touching the module', async (role) => {
    asCoach(role);
    const response = await POST(post({ script_id: 'scr-1' }));
    expect(response.status).toBe(403);
    expect(mockStart).not.toHaveBeenCalled();
  });
});
