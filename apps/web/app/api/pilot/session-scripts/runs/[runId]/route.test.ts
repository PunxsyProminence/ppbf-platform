import { NextRequest } from 'next/server';

import { PATCH } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  SessionScriptRunError,
  finishSessionScriptRun,
  moveSessionScriptRunCursor,
  pauseSessionScriptRun,
  resumeSessionScriptRun,
} from '@/src/server/pilot/sessionScriptRuns';

// requireRole and jsonError stay real; gating and error mapping are the point of this suite.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/sessionScriptRuns', () => ({
  ...jest.requireActual('@/src/server/pilot/sessionScriptRuns'),
  finishSessionScriptRun: jest.fn(),
  moveSessionScriptRunCursor: jest.fn(),
  pauseSessionScriptRun: jest.fn(),
  resumeSessionScriptRun: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAdvance = jest.mocked(moveSessionScriptRunCursor);
const mockPause = jest.mocked(pauseSessionScriptRun);
const mockResume = jest.mocked(resumeSessionScriptRun);
const mockFinish = jest.mocked(finishSessionScriptRun);

const RUN_ID = 'ssrun_1';

const liveRun = {
  organization_id: 'org-1',
  run_id: RUN_ID,
  script_id: 'scr-1',
  script_version: 1,
  activity_id: null,
  delivered_by_account_id: 'acct-coach',
  delivered_on: '2026-08-09',
  athletes_present: 9,
  blocks_completed: null,
  reset_protocol_used: false,
  deviation_note: '',
  what_worked: '',
  what_did_not: '',
  created_at: '2026-08-09T16:00:00.000Z',
  run_state: 'in_progress' as const,
  started_at: '2026-08-09T16:00:00.000Z',
  ended_at: null,
  current_block_id: 'blk-2',
  paused_at: null,
  paused_seconds: 0,
  elapsed_seconds: 300,
  is_paused: false,
};

function asCoach(role = 'coach') {
  mockPrincipal.mockResolvedValue({
    accountId: 'acct-coach',
    organizationId: 'org-1',
    role,
  } as Awaited<ReturnType<typeof requirePrincipal>>);
}

function patch(body: unknown, runId = RUN_ID) {
  const request = new NextRequest(`http://localhost/api/pilot/session-scripts/runs/${runId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return PATCH(request, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  asCoach();
  mockAdvance.mockResolvedValue(liveRun);
  mockPause.mockResolvedValue(liveRun);
  mockResume.mockResolvedValue({ ...liveRun, is_paused: false });
  mockFinish.mockResolvedValue({ ...liveRun, run_state: 'completed', ended_at: 'x' } as never);
});

describe('action dispatch', () => {
  it('requires a known action and names the allowed set', async () => {
    const response = await patch({});
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('advance|pause|resume|finish');
  });

  it.each(['complete', 'start', 'delete', ''])('refuses unknown action %s', async (action) => {
    const response = await patch({ action });
    expect(response.status).toBe(400);
    expect(mockAdvance).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
  });

  // A PATCH that took column values could set run_state to completed while leaving ended_at unset.
  // Naming the action is what keeps that decision on the server.
  it('refuses a body that tries to set columns directly', async () => {
    const response = await patch({ action: 'pause', run_state: 'completed' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'UNEXPECTED_FIELD:run_state' });
    expect(mockPause).not.toHaveBeenCalled();
  });

  it.each(['athlete', 'parent', 'board'])('refuses role %s before touching the module', async (role) => {
    asCoach(role);
    const response = await patch({ action: 'pause' });
    expect(response.status).toBe(403);
    expect(mockPause).not.toHaveBeenCalled();
  });
});

describe('advance', () => {
  it('moves the cursor to the requested block', async () => {
    const response = await patch({ action: 'advance', to_block_id: 'blk-3' });
    expect(response.status).toBe(200);
    expect(mockAdvance).toHaveBeenCalledWith('org-1', 'acct-coach', RUN_ID, 'blk-3');
  });

  it('requires to_block_id, because the client does not own block order', async () => {
    const response = await patch({ action: 'advance' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'to_block_id' });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it.each([['an empty string', ''], ['whitespace', '   ']])(
    'rejects to_block_id given %s',
    async (_label, value) => {
      const response = await patch({ action: 'advance', to_block_id: value });
      expect(response.status).toBe(400);
      expect(mockAdvance).not.toHaveBeenCalled();
    },
  );

  it('trims the block id rather than passing padding through to SQL', async () => {
    await patch({ action: 'advance', to_block_id: '  blk-3  ' });
    expect(mockAdvance).toHaveBeenCalledWith('org-1', 'acct-coach', RUN_ID, 'blk-3');
  });

  it('refuses extra fields alongside advance', async () => {
    const response = await patch({ action: 'advance', to_block_id: 'blk-3', force: true });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'UNEXPECTED_FIELD:force' });
  });

  // The invariant the FK cannot hold: a block from another script exists, so only the module can
  // refuse it, and the refusal must reach the client with its own status.
  it('surfaces a cross-script cursor as 422 with its own code', async () => {
    mockAdvance.mockRejectedValue(
      new SessionScriptRunError('SESSION_RUN_BLOCK_NOT_IN_SCRIPT', 422),
    );
    const response = await patch({ action: 'advance', to_block_id: 'blk-other' });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'SESSION_RUN_BLOCK_NOT_IN_SCRIPT' });
  });
});

describe('pause and resume', () => {
  it('pauses', async () => {
    expect((await patch({ action: 'pause' })).status).toBe(200);
    expect(mockPause).toHaveBeenCalledWith('org-1', 'acct-coach', RUN_ID);
  });

  it('resumes', async () => {
    expect((await patch({ action: 'resume' })).status).toBe(200);
    expect(mockResume).toHaveBeenCalledWith('org-1', 'acct-coach', RUN_ID);
  });

  it.each(['pause', 'resume'])('refuses extra fields alongside %s', async (action) => {
    const response = await patch({ action, paused_seconds: 999 });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'UNEXPECTED_FIELD:paused_seconds' });
  });

  it('reports a pause on an already-finished run as 409, not as success', async () => {
    mockPause.mockRejectedValue(new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409));
    const response = await patch({ action: 'pause' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'SESSION_RUN_NOT_LIVE' });
  });
});

describe('finish', () => {
  it('defaults to completed when no outcome is given', async () => {
    expect((await patch({ action: 'finish' })).status).toBe(200);
    expect(mockFinish).toHaveBeenCalledWith(
      'org-1',
      'acct-coach',
      RUN_ID,
      expect.objectContaining({ runState: 'completed' }),
    );
  });

  // A session cut short by an injury or an empty room is not a completed delivery, and recording it
  // as one would enter it in history as if the plan had been taught.
  it('records abandoned as abandoned', async () => {
    await patch({ action: 'finish', run_state: 'abandoned', deviation_note: 'injury' });
    expect(mockFinish).toHaveBeenCalledWith(
      'org-1',
      'acct-coach',
      RUN_ID,
      expect.objectContaining({ runState: 'abandoned', deviationNote: 'injury' }),
    );
  });

  it.each(['in_progress', 'paused', 'done', ''])('rejects run_state %s', async (value) => {
    const response = await patch({ action: 'finish', run_state: value });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('completed|abandoned');
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it('carries the whole debrief through', async () => {
    await patch({
      action: 'finish',
      blocks_completed: 6,
      athletes_present: 12,
      reset_protocol_used: true,
      deviation_note: 'skipped conditioning',
      what_worked: 'slip drill',
      what_did_not: 'footwork ladder',
    });
    expect(mockFinish).toHaveBeenCalledWith('org-1', 'acct-coach', RUN_ID, {
      runState: 'completed',
      blocksCompleted: 6,
      athletesPresent: 12,
      resetProtocolUsed: true,
      deviationNote: 'skipped conditioning',
      whatWorked: 'slip drill',
      whatDidNot: 'footwork ladder',
    });
  });

  // Zero blocks completed is a real outcome -- a session that started and taught nothing -- and
  // must not be coerced into "unknown".
  it('accepts zero blocks completed', async () => {
    await patch({ action: 'finish', blocks_completed: 0 });
    expect(mockFinish).toHaveBeenCalledWith(
      'org-1',
      'acct-coach',
      RUN_ID,
      expect.objectContaining({ blocksCompleted: 0 }),
    );
  });

  it.each([
    ['blocks_completed', -1],
    ['blocks_completed', 1.5],
    ['athletes_present', -3],
    ['reset_protocol_used', 'yes'],
    ['deviation_note', 42],
    ['what_worked', {}],
  ])('rejects %s given an invalid value', async (field, value) => {
    const response = await patch({ action: 'finish', [field]: value });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: field });
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it('refuses fields that are not part of the debrief', async () => {
    const response = await patch({ action: 'finish', started_at: 'now' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'UNEXPECTED_FIELD:started_at' });
  });

  it('reports re-finishing a settled run as 409', async () => {
    mockFinish.mockRejectedValue(new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409));
    expect((await patch({ action: 'finish' })).status).toBe(409);
  });
});

describe("another coach's run", () => {
  // Same code and status as a run that does not exist, so the route cannot be used to discover
  // which run ids are real.
  it.each(['advance', 'pause', 'resume', 'finish'])(
    'is indistinguishable from a missing run on %s',
    async (action) => {
      const notFound = new SessionScriptRunError('SESSION_RUN_NOT_FOUND', 404);
      mockAdvance.mockRejectedValue(notFound);
      mockPause.mockRejectedValue(notFound);
      mockResume.mockRejectedValue(notFound);
      mockFinish.mockRejectedValue(notFound);

      const body =
        action === 'advance' ? { action, to_block_id: 'blk-3' } : { action };
      const response = await patch(body);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'SESSION_RUN_NOT_FOUND' });
    },
  );
});

describe('run id', () => {
  it('rejects a blank run id in the path', async () => {
    const response = await patch({ action: 'pause' }, '   ');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'run_id' });
    expect(mockPause).not.toHaveBeenCalled();
  });
});
