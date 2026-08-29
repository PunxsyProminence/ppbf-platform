import { NextRequest } from 'next/server';

import { DELETE, GET, POST } from './route';
import { accessibleAthleteIds } from '@/src/server/pilot/access';
import { getDevelopmentBlock } from '@/src/server/pilot/athleteDevelopmentBlocks';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  athleteIdsLinkedToRun,
  linkSessionToBlock,
  listBlocksForRun,
  listSelectableRuns,
  listSessionsForBlock,
  unlinkSessionFromBlock,
} from '@/src/server/pilot/sessionBlockLinks';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
 * The coach API joining delivered sessions to athlete development blocks.
 *
 * THE TWO DIRECTIONS ARE DIFFERENT QUESTIONS and this file exists mostly to
 * hold that apart:
 *
 *   block -> sessions   the caller named a record about one minor, so the
 *                       athlete-access contract decides it;
 *   session -> blocks   the caller named a GYM-LEVEL record that carries no
 *                       athlete id, so an unfiltered answer would report
 *                       which children in that class have development plans.
 *
 * The relationship rules themselves (coach of record UNION active coverage,
 * organization boundary, soft-deleted athletes) are proven against real
 * Postgres in athleteIdsForCoach.pg.test.ts and coachCoverage.pg.test.ts, and
 * the SQL filter in sessionBlockLinks.pg.test.ts. Nothing here re-asserts them
 * with mocks. What is asserted here is that no path reaches a block without
 * the gate, and that the filtered direction actually filters.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, accessibleAthleteIds: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteDevelopmentBlocks', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteDevelopmentBlocks');
  return { ...actual, getDevelopmentBlock: jest.fn() };
});

jest.mock('@/src/server/pilot/sessionBlockLinks', () => ({
  linkSessionToBlock: jest.fn(),
  unlinkSessionFromBlock: jest.fn(),
  listSessionsForBlock: jest.fn(async () => []),
  listBlocksForRun: jest.fn(async () => []),
  listSelectableRuns: jest.fn(async () => []),
  athleteIdsLinkedToRun: jest.fn(async () => []),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccessibleIds = accessibleAthleteIds as jest.Mock;
const mockGetBlock = getDevelopmentBlock as jest.Mock;
const mockLink = linkSessionToBlock as jest.Mock;
const mockUnlink = unlinkSessionFromBlock as jest.Mock;
const mockSessionsForBlock = listSessionsForBlock as jest.Mock;
const mockBlocksForRun = listBlocksForRun as jest.Mock;
const mockSelectableRuns = listSelectableRuns as jest.Mock;
const mockLinkedAthleteIds = athleteIdsLinkedToRun as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

beforeEach(() => {
  mockAccessibleIds.mockResolvedValue(new Set<string>());
  mockSessionsForBlock.mockResolvedValue([]);
  mockBlocksForRun.mockResolvedValue([]);
  mockSelectableRuns.mockResolvedValue([]);
  mockLinkedAthleteIds.mockResolvedValue([]);
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-coach-a',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function block(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    block_id: 'blk-1',
    athlete_id: 'ath-1',
    title: 'Late summer block',
    training_emphasis: 'Round-three work rate.',
    starts_on: '2026-08-01',
    ends_on: '2026-09-30',
    status: 'active',
    created_by_account_id: 'acct-coach-a',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function getRequest(qs: string) {
  return new NextRequest(`http://localhost/api/pilot/coach/session-block-links${qs}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/session-block-links', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function deleteRequest(qs: string) {
  return new NextRequest(`http://localhost/api/pilot/coach/session-block-links${qs}`, {
    method: 'DELETE',
  });
}

describe('block -> sessions: gated on the athlete the STORED block names', () => {
  /* #762 moved the athlete gate INSIDE getDevelopmentBlock: it scopes by the
     actor's organization and returns null unless canActorReachAthlete clears
     the athlete the stored block names. So what this route must be shown to do
     is hand the module the ACTOR -- not an organization id, and not an athlete
     id from the request -- and treat null as the whole answer. */
  test('the module is handed the caller\'s own actor, unmodified', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block({ athlete_id: 'ath-stored' }));

    const response = await GET(getRequest('?block_id=blk-1&athlete_id=ath-i-can-reach'));

    expect(response.status).toBe(200);
    /* THE SAME OBJECT, not merely one that looks similar. An earlier version
       of this asserted objectContaining({ accountId, organizationId }), and a
       mutation that widened the actor's ROLE on the way in -- the one
       escalation this hand-off invites -- sailed straight through it. The
       module decides access from the whole actor, so the whole actor is what
       has to arrive. */
    expect(mockGetBlock).toHaveBeenCalledWith(actor, 'blk-1');
    // And no athlete id from the request reaches anything.
    expect(mockSessionsForBlock).toHaveBeenCalledWith('org-1', 'blk-1');
  });

  test('a block this caller may not reach is a 404 and reads nothing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    // What the module returns for BOTH "no such block" and "not your athlete".
    mockGetBlock.mockResolvedValue(null);

    const response = await GET(getRequest('?block_id=blk-1'));

    /* 404, not 403, and that is the improvement rather than a weakening: a
       403 would tell the caller the block exists and is somebody else's,
       which is the enumeration a hidden not-found refuses. */
    expect(response.status).toBe(404);
    expect(mockSessionsForBlock).not.toHaveBeenCalled();
  });

  test('a block in another organization is the same 404, indistinguishably', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(null);

    const response = await GET(getRequest('?block_id=blk-elsewhere'));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'Block not found.' });
    expect(mockSessionsForBlock).not.toHaveBeenCalled();
  });

  test('the organization is the session, never a value the caller sent', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block());

    await GET(getRequest('?block_id=blk-1&organization_id=org-2'));

    // org-1 travels inside the principal; org-2 from the query string reaches
    // nothing.
    expect(mockGetBlock).toHaveBeenCalledWith(actor, 'blk-1');
    expect(mockSessionsForBlock).toHaveBeenCalledWith('org-1', 'blk-1');
  });
});

describe('session -> blocks: filtered, because a session names no athlete', () => {
  test('only athletes the caller may reach are passed to the row read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    // Three children's blocks hang off this class.
    mockLinkedAthleteIds.mockResolvedValue(['ath-1', 'ath-2', 'ath-3']);
    // The caller is coach of record for one of them.
    mockAccessibleIds.mockResolvedValue(new Set(['ath-2']));

    const response = await GET(getRequest('?run_id=run-1'));

    expect(response.status).toBe(200);
    expect(mockAccessibleIds).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-coach-a' }),
      ['ath-1', 'ath-2', 'ath-3'],
    );
    // The permitted subset, and only it. This is the assertion that stops a
    // gym-level record reporting which children have development plans.
    expect(mockBlocksForRun).toHaveBeenCalledWith('org-1', 'run-1', ['ath-2']);
  });

  test('a caller who reaches nobody in that class gets an empty list, not a roster', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockLinkedAthleteIds.mockResolvedValue(['ath-1', 'ath-2']);
    mockAccessibleIds.mockResolvedValue(new Set());

    const response = await GET(getRequest('?run_id=run-1'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockBlocksForRun).toHaveBeenCalledWith('org-1', 'run-1', []);
    expect(payload.blocks).toEqual([]);
  });

  test('the filter is never skipped, even when the run has no links at all', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockLinkedAthleteIds.mockResolvedValue([]);

    await GET(getRequest('?run_id=run-empty'));

    // Still through the contract. A branch that short-circuited "no
    // candidates" past accessibleAthleteIds would be one path where the gate
    // does not run, and the next change would widen it.
    expect(mockAccessibleIds).toHaveBeenCalledWith(expect.anything(), []);
    expect(mockBlocksForRun).toHaveBeenCalledWith('org-1', 'run-empty', []);
  });
});

describe('the picker', () => {
  test('lists settled runs for the session\'s organization, with no athlete read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockSelectableRuns.mockResolvedValue([
      { run_id: 'run-1', script_id: 'scr-1', script_name: 'Tuesday Technical', delivered_on: '2026-08-10', run_state: 'completed' },
    ]);

    const response = await GET(getRequest('?runs=options&organization_id=org-2'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockSelectableRuns).toHaveBeenCalledWith('org-1');
    expect(payload.runs).toHaveLength(1);
    // A delivered session carries no athlete id, so this branch asks no
    // athlete question -- and asserting that keeps it from quietly growing
    // one later.
    expect(mockAccessibleIds).not.toHaveBeenCalled();
    expect(mockGetBlock).not.toHaveBeenCalled();
  });

  test('a GET naming nothing at all is refused rather than answered broadly', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await GET(getRequest(''));

    expect(response.status).toBe(400);
    expect(mockSessionsForBlock).not.toHaveBeenCalled();
    expect(mockBlocksForRun).not.toHaveBeenCalled();
    expect(mockSelectableRuns).not.toHaveBeenCalled();
  });
});

describe('POST: recording that a session supported a block', () => {
  test('the gate runs before the write, on the caller\'s own actor', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block({ athlete_id: 'ath-stored' }));
    mockLink.mockResolvedValue({
      link: { organization_id: 'org-1', run_id: 'run-1', block_id: 'blk-1', linked_by_account_id: 'acct-coach-a', created_at: 'now' },
      created: true,
    });

    const response = await POST(postRequest({
      run_id: 'run-1',
      block_id: 'blk-1',
      // Ignored. A body that could file this under another gym or another
      // person's name is the failure this asserts.
      organization_id: 'org-2',
      linked_by_account_id: 'acct-someone-else',
      athlete_id: 'ath-i-can-reach',
    }));

    expect(response.status).toBe(201);
    // The caller's own actor, unmodified; nothing from the body reaches it.
    expect(mockGetBlock).toHaveBeenCalledWith(actor, 'blk-1');
    expect(mockLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      runId: 'run-1',
      blockId: 'blk-1',
      linkedByAccountId: 'acct-coach-a',
    });
  });

  test('a block this caller may not reach writes nothing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(null);

    const response = await POST(postRequest({ run_id: 'run-1', block_id: 'blk-1' }));

    expect(response.status).toBe(404);
    expect(mockLink).not.toHaveBeenCalled();
  });

  test('linking twice answers 200 and says it was not created', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockLink.mockResolvedValue({
      link: { organization_id: 'org-1', run_id: 'run-1', block_id: 'blk-1', linked_by_account_id: 'acct-first', created_at: 'then' },
      created: false,
    });

    const response = await POST(postRequest({ run_id: 'run-1', block_id: 'blk-1' }));
    const payload = await response.json();

    // Not a 409. The second click asked for a state that is already true, and
    // reporting "created" twice would be a small lie about what happened.
    expect(response.status).toBe(200);
    expect(payload.created).toBe(false);
    // And the link still names whoever said it FIRST.
    expect(payload.link.linked_by_account_id).toBe('acct-first');
  });

  test('a run that is not in this organization is a 404', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockLink.mockResolvedValue(null);

    const response = await POST(postRequest({ run_id: 'run-elsewhere', block_id: 'blk-1' }));
    expect(response.status).toBe(404);
  });

  test('a missing run_id or block_id is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    for (const body of [{}, { run_id: 'run-1' }, { block_id: 'blk-1' }, { run_id: '  ', block_id: 'blk-1' }]) {
      const response = await POST(postRequest(body));
      expect(response.status).toBe(400);
    }
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });
});

describe('DELETE: removing the statement', () => {
  test('unlinking is gated exactly as linking is', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block({ athlete_id: 'ath-stored' }));
    mockUnlink.mockResolvedValue(true);

    const response = await DELETE(deleteRequest('?run_id=run-1&block_id=blk-1'));

    expect(response.status).toBe(200);
    // Unlinking is a write about this block, so it goes through the same
    // module gate the read and the link do.
    expect(mockGetBlock).toHaveBeenCalledWith(actor, 'blk-1');
    /* The account goes through too, and it is not decoration. requireRole
       above compares the account's HOME role (pilot.accounts.role); the role
       that governs a write is the one on the membership row for THIS
       organization, and only the module can ask for it. */
    expect(mockUnlink).toHaveBeenCalledWith('org-1', 'run-1', 'blk-1', actor.accountId);
  });

  test('a block this caller may not reach removes nothing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(null);

    const response = await DELETE(deleteRequest('?run_id=run-1&block_id=blk-1'));

    expect(response.status).toBe(404);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  test('removing a link that is not there is not an error', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockUnlink.mockResolvedValue(false);

    const response = await DELETE(deleteRequest('?run_id=run-1&block_id=blk-1'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.removed).toBe(false);
  });
});

describe('who may call this at all', () => {
  test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])(
    'a %s is refused on every method',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      for (const response of [
        await GET(getRequest('?runs=options')),
        await GET(getRequest('?block_id=blk-1')),
        await GET(getRequest('?run_id=run-1')),
        await POST(postRequest({ run_id: 'run-1', block_id: 'blk-1' })),
        await DELETE(deleteRequest('?run_id=run-1&block_id=blk-1')),
      ]) {
        expect(response.status).toBe(403);
      }
      expect(mockLink).not.toHaveBeenCalled();
      expect(mockUnlink).not.toHaveBeenCalled();
      expect(mockSelectableRuns).not.toHaveBeenCalled();
      expect(mockBlocksForRun).not.toHaveBeenCalled();
    },
  );
});

describe('what this route refuses to be', () => {
  test('no response carries a count, coverage or adherence figure', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockSessionsForBlock.mockResolvedValue([
      { run_id: 'run-1', script_id: 'scr-1', script_name: 'Tuesday Technical', delivered_on: '2026-08-10', delivered_by_account_id: 'acct-coach-a', run_state: 'completed', athletes_present: 9, blocks_completed: 4, deviation_note: '', what_worked: 'Held up.', what_did_not: '', linked_by_account_id: 'acct-coach-a', linked_at: 'now' },
      { run_id: 'run-2', script_id: 'scr-1', script_name: 'Tuesday Technical', delivered_on: '2026-08-17', delivered_by_account_id: 'acct-coach-a', run_state: 'completed', athletes_present: 11, blocks_completed: 5, deviation_note: '', what_worked: '', what_did_not: '', linked_by_account_id: 'acct-coach-a', linked_at: 'now' },
    ]);

    const body = await (await GET(getRequest('?block_id=blk-1'))).text();

    /* Plan-versus-actual is the build order's NEXT slice. The moment sessions
       are countable against a plan, "72% of planned sessions delivered" is one
       aggregate away -- a compliance figure about a coach's work with a child,
       assembled from links nobody validated. */
    for (const forbidden of [
      'session_count', 'sessions_delivered', 'coverage', 'adherence', 'compliance',
      'percent', 'progress', 'on_track', 'score',
    ]) {
      expect(body).not.toContain(forbidden);
    }
    // Guards the guard: both sessions really did come back, with the run's own
    // words carried through verbatim.
    expect(body).toContain('run-2');
    expect(body).toContain('Held up.');
  });
});
