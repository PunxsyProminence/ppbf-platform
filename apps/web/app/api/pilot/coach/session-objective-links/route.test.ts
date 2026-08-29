import { NextRequest } from 'next/server';

import { DELETE, GET, POST } from './route';
import { getDevelopmentBlock } from '@/src/server/pilot/athleteDevelopmentBlocks';
import { listObjectivesForBlock } from '@/src/server/pilot/athleteDevelopmentBlockObjectives';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  linkSessionToObjective,
  listObjectiveLinksForBlock,
  listObjectivesForSessionBlock,
  unlinkSessionFromObjective,
} from '@/src/server/pilot/sessionObjectiveLinks';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
 * The coach API joining delivered sessions to Full Spectrum objectives.
 *
 * ONE GATE, ON THE BLOCK, ON EVERY PATH. An objective lives inside exactly one
 * block and a block is a record about one minor, so "may this caller see this
 * objective" is the same question as "may this caller open its block".
 * getDevelopmentBlock answers it for the actor and returns null for both "no
 * such block" and "not your athlete". What this file asserts is that no path
 * -- read, write or delete -- gets past it, and that the actor arrives
 * unmodified.
 *
 * The relationship rules themselves are proven against real Postgres in
 * athleteIdsForCoach.pg.test.ts and the invariant in
 * sessionObjectiveLinks.pg.test.ts. Nothing here re-asserts them with mocks.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteDevelopmentBlocks', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteDevelopmentBlocks');
  return { ...actual, getDevelopmentBlock: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteDevelopmentBlockObjectives', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteDevelopmentBlockObjectives');
  return { ...actual, listObjectivesForBlock: jest.fn(async () => []) };
});

jest.mock('@/src/server/pilot/sessionObjectiveLinks', () => ({
  linkSessionToObjective: jest.fn(),
  unlinkSessionFromObjective: jest.fn(),
  listObjectivesForSessionBlock: jest.fn(async () => []),
  listObjectiveLinksForBlock: jest.fn(async () => []),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetBlock = getDevelopmentBlock as jest.Mock;
const mockBlockObjectives = listObjectivesForBlock as jest.Mock;
const mockLink = linkSessionToObjective as jest.Mock;
const mockUnlink = unlinkSessionFromObjective as jest.Mock;
const mockForSession = listObjectivesForSessionBlock as jest.Mock;
const mockLinksForBlock = listObjectiveLinksForBlock as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

beforeEach(() => {
  mockBlockObjectives.mockResolvedValue([]);
  mockForSession.mockResolvedValue([]);
  mockLinksForBlock.mockResolvedValue([]);
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
    block_id: 'blk-a',
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

function objective(overrides: Record<string, unknown> = {}) {
  return {
    objective_id: 'obj-a',
    block_id: 'blk-a',
    domain: 'technical',
    objective: 'Stop drifting to the ropes.',
    status: 'active',
    created_by_account_id: 'acct-coach-a',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function getRequest(qs: string) {
  return new NextRequest(`http://localhost/api/pilot/coach/session-objective-links${qs}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/session-objective-links', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function deleteRequest(qs: string) {
  return new NextRequest(`http://localhost/api/pilot/coach/session-objective-links${qs}`, {
    method: 'DELETE',
  });
}

describe('the block gate is on every path, and gets the actor untouched', () => {
  test('the block-wide read clears the block first, with the caller\'s own actor', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block());

    const response = await GET(getRequest('?block_id=blk-a'));

    expect(response.status).toBe(200);
    /* THE SAME OBJECT, not one that merely looks similar. The module decides
       access from the whole actor, so a route that rebuilt or widened it on
       the way in -- the one escalation this hand-off invites -- must fail
       here. objectContaining would let a changed role through. */
    expect(mockGetBlock).toHaveBeenCalledWith(actor, 'blk-a');
  });

  test.each([
    ['block-wide read', () => GET(getRequest('?block_id=blk-a'))],
    ['session read', () => GET(getRequest('?block_id=blk-a&run_id=run-1'))],
    ['link', () => POST(postRequest({ run_id: 'run-1', objective_id: 'obj-a', block_id: 'blk-a' }))],
    ['unlink', () => DELETE(deleteRequest('?run_id=run-1&objective_id=obj-a&block_id=blk-a'))],
  ])('a block this caller may not open stops the %s at 404', async (_name, call) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    // What the module returns for BOTH "no such block" and "not your athlete".
    mockGetBlock.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(404);
    // Nothing past the gate ran.
    expect(mockForSession).not.toHaveBeenCalled();
    expect(mockLinksForBlock).not.toHaveBeenCalled();
    expect(mockBlockObjectives).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  test('a GET with no block_id is refused rather than answered broadly', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await GET(getRequest('?run_id=run-1'));

    /* The run alone would be a run-wide answer, and a group session serves
       several children's blocks -- so it would hand back objectives belonging
       to children this caller has not been cleared for. */
    expect(response.status).toBe(400);
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(mockForSession).not.toHaveBeenCalled();
  });

  test('the organization is the session, never a value the caller sent', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block());

    await GET(getRequest('?block_id=blk-a&run_id=run-1&organization_id=org-2'));

    expect(mockGetBlock).toHaveBeenCalledWith(actor, 'blk-a');
    expect(mockForSession).toHaveBeenCalledWith('org-1', 'run-1', 'blk-a');
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])(
    'a %s is refused on every method',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      for (const response of [
        await GET(getRequest('?block_id=blk-a')),
        await GET(getRequest('?block_id=blk-a&run_id=run-1')),
        await POST(postRequest({ run_id: 'run-1', objective_id: 'obj-a', block_id: 'blk-a' })),
        await DELETE(deleteRequest('?run_id=run-1&objective_id=obj-a&block_id=blk-a')),
      ]) {
        expect(response.status).toBe(403);
      }
      expect(mockGetBlock).not.toHaveBeenCalled();
      expect(mockLink).not.toHaveBeenCalled();
      expect(mockUnlink).not.toHaveBeenCalled();
    },
  );
});

describe('reading', () => {
  test('the block-wide read returns the objectives and the links, unstitched', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockBlockObjectives.mockResolvedValue([objective(), objective({ objective_id: 'obj-b', domain: 'mental' })]);
    mockLinksForBlock.mockResolvedValue([
      { run_id: 'run-1', ...objective(), linked_by_account_id: 'acct-coach-a', linked_at: 'now' },
    ]);

    const payload = await (await GET(getRequest('?block_id=blk-a'))).json();

    /* Both lists, separately. An objective with no links must stay visibly an
       objective with no recorded links -- if the route stitched them, an
       unlinked objective would be indistinguishable from one the join
       dropped. */
    expect(payload.objectives).toHaveLength(2);
    expect(payload.links).toHaveLength(1);
    expect(mockBlockObjectives).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-coach-a' }),
      'blk-a',
    );
  });

  test('the session read is scoped to the block, not to the whole run', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());

    await GET(getRequest('?block_id=blk-a&run_id=run-1'));

    // All three arguments. A read that dropped the block id would answer
    // run-wide and cross into another child's plan.
    expect(mockForSession).toHaveBeenCalledWith('org-1', 'run-1', 'blk-a');
    expect(mockLinksForBlock).not.toHaveBeenCalled();
  });

  test('no response carries a count, coverage or per-domain tally', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockBlockObjectives.mockResolvedValue([
      objective({ objective_id: 'obj-a', domain: 'technical' }),
      objective({ objective_id: 'obj-b', domain: 'nutrition_body_composition' }),
    ]);
    mockLinksForBlock.mockResolvedValue([
      { run_id: 'run-1', ...objective(), linked_by_account_id: 'acct-coach-a', linked_at: 'now' },
      { run_id: 'run-2', ...objective(), linked_by_account_id: 'acct-coach-a', linked_at: 'now' },
    ]);

    const body = await (await GET(getRequest('?block_id=blk-a'))).text();

    /* Objectives carry a domain, so a tally here is one GROUP BY from a
       per-domain coverage chart about a child's training -- and 'nutrition'
       showing zero would read as a gap when it only means nobody recorded a
       link. */
    for (const forbidden of [
      'session_count', 'sessions_delivered', 'coverage', 'adherence', 'compliance',
      'percent', 'progress', 'on_track', 'score', 'weight', 'contribution', 'tally',
    ]) {
      expect(body).not.toContain(forbidden);
    }
    // Guards the guard: both objectives and both links really came back.
    expect(body).toContain('obj-b');
    expect(body).toContain('run-2');
  });
});

describe('linking', () => {
  test('the block is cleared first, and block_id is NOT passed to the write', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block());
    mockLink.mockResolvedValue({
      link: {
        organization_id: 'org-1', run_id: 'run-1', objective_id: 'obj-a',
        block_id: 'blk-a', linked_by_account_id: 'acct-coach-a', created_at: 'now',
      },
      created: true,
    });

    const response = await POST(postRequest({
      run_id: 'run-1',
      objective_id: 'obj-a',
      block_id: 'blk-a',
      organization_id: 'org-2',
      linked_by_account_id: 'acct-someone-else',
    }));

    expect(response.status).toBe(201);
    expect(mockGetBlock).toHaveBeenCalledWith(actor, 'blk-a');
    /* block_id clears the caller and goes no further: the module establishes
       the objective's REAL parent itself. So a body naming a block the caller
       can open plus an objective belonging to one they cannot gets nothing. */
    expect(mockLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      runId: 'run-1',
      objectiveId: 'obj-a',
      linkedByAccountId: 'acct-coach-a',
    });
    expect(mockLink.mock.calls[0][0]).not.toHaveProperty('blockId');
  });

  test('an objective not on a block this session supports is a 404', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    // The module's null: wrong organization, wrong block, or no block link.
    mockLink.mockResolvedValue(null);

    const response = await POST(postRequest({
      run_id: 'run-1', objective_id: 'obj-elsewhere', block_id: 'blk-a',
    }));

    expect(response.status).toBe(404);
    expect((await response.json()).error)
      .toBe('That objective is not on a block this session supports.');
  });

  test('linking twice answers 200 and says it was not created', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockLink.mockResolvedValue({
      link: {
        organization_id: 'org-1', run_id: 'run-1', objective_id: 'obj-a',
        block_id: 'blk-a', linked_by_account_id: 'acct-first', created_at: 'then',
      },
      created: false,
    });

    const response = await POST(postRequest({
      run_id: 'run-1', objective_id: 'obj-a', block_id: 'blk-a',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.created).toBe(false);
    // And it still names whoever said it first.
    expect(payload.link.linked_by_account_id).toBe('acct-first');
  });

  test.each([
    {},
    { run_id: 'run-1' },
    { objective_id: 'obj-a' },
    { run_id: 'run-1', objective_id: 'obj-a' },
    { run_id: 'run-1', objective_id: 'obj-a', block_id: '  ' },
  ])('an incomplete body is refused: %p', async (body) => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest(body as Record<string, unknown>));

    expect(response.status).toBe(400);
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });
});

describe('unlinking', () => {
  test('it is gated exactly as linking is, and removes only the statement', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block());
    mockUnlink.mockResolvedValue(true);

    const response = await DELETE(
      deleteRequest('?run_id=run-1&objective_id=obj-a&block_id=blk-a'),
    );

    expect(response.status).toBe(200);
    expect(mockGetBlock).toHaveBeenCalledWith(actor, 'blk-a');
    /* THE CLEARED BLOCK REACHES THE WRITE, and this assertion is the one that
       used to pin the bug: it asserted three arguments, so a delete scoped to
       (organization, run, objective) alone read as correct. Authorization was
       proved about blk-a and then spent on whatever block obj-a belonged to.

       Unlike the link path above -- where block_id is deliberately NOT passed
       because linkSessionToObjective re-derives the block in SQL and would
       reject a mismatch -- the delete has no such derivation, so the block it
       was cleared for has to be carried into the statement. */
    expect(mockUnlink).toHaveBeenCalledWith('org-1', 'run-1', 'obj-a', 'blk-a', actor.accountId);
  });

  /* The delete path names the block; the link path deliberately does not.
     Held together so the asymmetry reads as a decision rather than as one of
     them having been forgotten -- which is how it got here. */
  test('the block reaching the write is the block the gate cleared, not the one asked for', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block());
    mockUnlink.mockResolvedValue(true);

    await DELETE(deleteRequest('?run_id=run-1&objective_id=obj-a&block_id=blk-a'));

    const [, , , blockArg] = mockUnlink.mock.calls[0];
    expect(blockArg).toBe('blk-a');
    // Not the run and not the objective: a delete scoped by either of those
    // instead would be the same hole wearing a different argument.
    expect(blockArg).not.toBe('run-1');
    expect(blockArg).not.toBe('obj-a');
  });

  test('removing a link that is not there is not an error', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockUnlink.mockResolvedValue(false);

    const response = await DELETE(
      deleteRequest('?run_id=run-1&objective_id=obj-a&block_id=blk-a'),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).removed).toBe(false);
  });

  test('an incomplete query string is refused before the gate', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    for (const qs of [
      '?run_id=run-1',
      '?objective_id=obj-a',
      '?run_id=run-1&objective_id=obj-a',
      '?run_id=run-1&objective_id=obj-a&block_id=',
    ]) {
      const response = await DELETE(deleteRequest(qs));
      expect(response.status).toBe(400);
    }
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});
