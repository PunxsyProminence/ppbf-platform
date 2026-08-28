import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { listObjectivesForBlock } from '@/src/server/pilot/athleteDevelopmentBlockObjectives';
import { listDevelopmentBlocksForAthlete } from '@/src/server/pilot/athleteDevelopmentBlocks';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
 * The family-facing read: an athlete's own development blocks, and a
 * guardian's view of their child's.
 *
 * Owner decision 2026-08-28: everything, verbatim, including the
 * nutrition_body_composition domain. So the assertions here are not about
 * what is hidden -- nothing is -- they are about the three ways a read-only
 * family surface can still be wrong:
 *
 *   1. an athlete reading a subject that is not themselves. The athlete arm
 *      takes the id from the SESSION and never from the query string, so this
 *      file proves the parameter is ignored rather than validated.
 *   2. a guardian reading a child they are not linked to. Delegated to
 *      assertActorCanAccessAthlete, and proven here to be called BEFORE any
 *      row is read.
 *   3. a verb existing that should not. There is no POST and no PATCH, and a
 *      test says so rather than leaving it to be noticed.
 *
 * The relationship rules themselves are proven against real rows in
 * athleteDevelopmentBlocks.pg.test.ts and softDeletedAthleteAccess.pg.test.ts.
 * Nothing here re-asserts them with mocks.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteDevelopmentBlocks', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteDevelopmentBlocks');
  return { ...actual, listDevelopmentBlocksForAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteDevelopmentBlockObjectives', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteDevelopmentBlockObjectives');
  return { ...actual, listObjectivesForBlock: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockListBlocks = listDevelopmentBlocksForAthlete as jest.Mock;
const mockListObjectives = listObjectivesForBlock as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-athlete-a',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
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
    title: 'Winter technical block',
    training_emphasis: 'Guard recovery off the jab.',
    starts_on: '2026-09-01',
    ends_on: '2026-10-13',
    status: 'draft',
    created_by_account_id: 'acct-coach-a',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function objective(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    objective_id: 'obj-1',
    block_id: 'blk-1',
    domain: 'technical',
    objective: 'Jab off the back foot under pressure, not just off the front.',
    status: 'draft',
    created_by_account_id: 'acct-coach-a',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/athlete/development-blocks${query}`);

describe('who may reach this route', () => {
  test.each(['athlete', 'parent'])('the %s role is served', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockListBlocks.mockResolvedValue([]);

    const response = await GET(getRequest(role === 'parent' ? '?athlete_id=ath-1' : ''));

    expect(response.status).toBe(200);
  });

  test.each(['coach', 'organization_admin', 'admin', 'volunteer', 'staff', 'board', 'platform_owner'])(
    'the %s role is refused, and nothing is read',
    async (role) => {
      /* Staff are not refused because they may not see a block -- a coach
         plainly may, and does, on their own route. They are refused because
         this is the FAMILY's view of the plan, and a surface that serves
         everybody is a surface whose audience nobody can state. Keeping the
         two apart is what lets each say plainly who it is for. */
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      const response = await GET(getRequest('?athlete_id=ath-1'));

      expect(response.status).toBe(403);
      expect(mockAssertAccess).not.toHaveBeenCalled();
      expect(mockListBlocks).not.toHaveBeenCalled();
    },
  );

  test('the route offers no way to write, at all', () => {
    /* Not a gated POST -- no POST. Reading is not writing: an athlete marking
       their own block 'completed' is the coach judgment this table refuses to
       compute, and a guardian editing a coach's plan is not in the gym's
       authority model. The data layer would refuse both; this offers no verb
       to refuse. */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const handlers = require('./route');
    expect(typeof handlers.GET).toBe('function');
    expect(handlers.POST).toBeUndefined();
    expect(handlers.PATCH).toBeUndefined();
    expect(handlers.PUT).toBeUndefined();
    expect(handlers.DELETE).toBeUndefined();
  });
});

describe('an athlete reads their own plan', () => {
  test('the subject is the session\'s athlete, and the blocks come back whole', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListBlocks.mockResolvedValue([block()]);
    mockListObjectives.mockResolvedValue([objective()]);

    const payload = await (await GET(getRequest())).json();

    expect(mockAssertAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-athlete-a', role: 'athlete' }),
      'ath-1',
    );
    expect(payload.blocks).toHaveLength(1);
    expect(payload.blocks[0].block_id).toBe('blk-1');
    expect(payload.blocks[0].objectives).toHaveLength(1);
  });

  test('an athlete_id in the query string is IGNORED, not validated', async () => {
    /* The difference matters. A validated parameter is a check that can be
       written wrong, skipped, or made permissive later; an ignored one has no
       path to being trusted at all. An athlete asking for a sibling's plan
       gets their own, and the sibling's id reaches nothing. */
    mockRequirePrincipal.mockResolvedValue(principal({ athleteId: 'ath-1' }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockListBlocks.mockResolvedValue([]);

    await GET(getRequest('?athlete_id=ath-sibling'));

    expect(mockAssertAccess).toHaveBeenCalledWith(expect.anything(), 'ath-1');
    expect(mockListBlocks).toHaveBeenCalledWith(expect.anything(), 'ath-1');
    expect(JSON.stringify(mockListBlocks.mock.calls)).not.toContain('ath-sibling');
  });

  test('an athlete account with no athlete record is told so, and reads nothing', async () => {
    // A provisioning fault, not a request fault: there is no record to show
    // and no id worth guessing at.
    mockRequirePrincipal.mockResolvedValue(principal({ athleteId: null }));

    const response = await GET(getRequest());

    expect(response.status).toBe(400);
    expect(mockAssertAccess).not.toHaveBeenCalled();
    expect(mockListBlocks).not.toHaveBeenCalled();
  });
});

describe('a guardian reads their child\'s plan', () => {
  test('the named child is put through the access gate before any row is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({
      accountId: 'acct-parent-a', role: 'parent', athleteId: null,
    }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockListBlocks.mockResolvedValue([]);

    await GET(getRequest('?athlete_id=ath-1'));

    expect(mockAssertAccess).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'parent', accountId: 'acct-parent-a' }),
      'ath-1',
    );
  });

  test('a child they are not linked to is refused, and nothing is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', athleteId: null }));
    mockAssertAccess.mockRejectedValue(new Error('Forbidden: parent not linked to athlete'));

    const response = await GET(getRequest('?athlete_id=ath-not-mine'));

    expect(response.status).toBe(403);
    expect(mockListBlocks).not.toHaveBeenCalled();
  });

  test('naming no child is a 400, not a silent read of somebody', async () => {
    // A parent may hold links to several children, so there is no sensible
    // default and picking one would be inventing an answer.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', athleteId: null }));

    const response = await GET(getRequest());

    expect(response.status).toBe(400);
    expect(mockAssertAccess).not.toHaveBeenCalled();
    expect(mockListBlocks).not.toHaveBeenCalled();
  });
});

describe('what the family actually sees', () => {
  test('the coach\'s words arrive verbatim, and body composition is not withheld', async () => {
    /* THE OWNER DECISION, ASSERTED. 2026-08-28: everything, verbatim. If a
       later change starts filtering domains, softening text, or dropping the
       tenth domain from this response, this fails and names it. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListBlocks.mockResolvedValue([block({
      training_emphasis: '  Stop backing straight up when the pressure comes.  ',
    })]);
    mockListObjectives.mockResolvedValue([
      objective({ objective_id: 'obj-1', domain: 'technical' }),
      objective({
        objective_id: 'obj-2',
        domain: 'nutrition_body_composition',
        objective: 'Eat a real breakfast before morning conditioning.',
      }),
    ]);

    const payload = await (await GET(getRequest())).json();

    expect(payload.blocks[0].training_emphasis)
      .toBe('  Stop backing straight up when the pressure comes.  ');
    expect(payload.blocks[0].objectives.map((row: { domain: string }) => row.domain))
      .toEqual(['technical', 'nutrition_body_composition']);
    expect(payload.blocks[0].objectives[1].objective)
      .toBe('Eat a real breakfast before morning conditioning.');
  });

  test('every block carries its own objectives, in one response', async () => {
    // A family view is small and read once. Attaching them here means a
    // screen does not make a request per block the way an authoring panel
    // does -- and means a partial render can never show a block with its
    // objectives still missing.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListBlocks.mockResolvedValue([
      block({ block_id: 'blk-1' }),
      block({ block_id: 'blk-2' }),
    ]);
    mockListObjectives.mockImplementation(async (_actor: unknown, blockId: string) => [
      objective({ objective_id: `obj-${blockId}`, block_id: blockId }),
    ]);

    const payload = await (await GET(getRequest())).json();

    expect(mockListObjectives).toHaveBeenCalledTimes(2);
    expect(payload.blocks.map((b: { objectives: Array<{ objective_id: string }> }) =>
      b.objectives[0].objective_id)).toEqual(['obj-blk-1', 'obj-blk-2']);
  });

  test('nothing computed reaches the family', async () => {
    /* Sharper here than on the coach's own surface. "Three of five completed"
       shown to a CHILD is a score about that child, produced by arithmetic
       rather than by a coach. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListBlocks.mockResolvedValue([block()]);
    mockListObjectives.mockResolvedValue([
      objective({ objective_id: 'obj-1', status: 'completed' }),
      objective({ objective_id: 'obj-2', status: 'draft' }),
    ]);

    const payload = await (await GET(getRequest())).json();

    expect(Object.keys(payload).sort()).toEqual(['blocks', 'ok']);
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      'completed_count', 'percent', 'progress', 'score', 'rating', 'grade',
      'adherence', 'compliance', 'readiness', 'on_track',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('a family receives exactly these fields, and no stored column beyond them', async () => {
    /* A forbidden-substring sweep catches the words we thought of. This
       catches the ones we did not: a new column on either table reaches this
       response the moment it exists unless someone changes this list, which
       is the point of pinning the set rather than a denylist. The coach route
       has held its blocks key set exactly this way since it shipped; the
       surface that serves MINORS was the one without it. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListBlocks.mockResolvedValue([block()]);
    mockListObjectives.mockResolvedValue([objective()]);

    const payload = await (await GET(getRequest())).json();

    expect(Object.keys(payload.blocks[0]).sort()).toEqual([
      'block_id', 'ends_on', 'objectives', 'starts_on', 'status', 'title',
      'training_emphasis',
    ]);
    expect(Object.keys(payload.blocks[0].objectives[0]).sort()).toEqual([
      'domain', 'objective', 'objective_id', 'status',
    ]);
  });

  test('no staff account id and no tenancy id reach a family', async () => {
    /* The response used to spread the stored row, so created_by_account_id,
       organization_id, created_at and updated_at all travelled to an athlete
       or a parent. Neither screen rendered them -- and a page not rendering a
       field is not the same as a family not receiving it; the id sat in the
       JSON one devtools panel away.

       DevelopmentBlockPlanView's header already called this out in so many
       words: an account id "is not a name, and printing a raw staff
       identifier to a family is a leak dressed as attribution". This asserts
       the response agrees with the component that reads it.

       Both fixtures carry acct-coach-a and org-1, so this fails loudly if the
       projection is ever replaced by a spread again. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListBlocks.mockResolvedValue([block()]);
    mockListObjectives.mockResolvedValue([objective()]);

    const serialized = JSON.stringify(await (await GET(getRequest())).json());

    expect(serialized).not.toContain('acct-coach-a');
    expect(serialized).not.toContain('created_by_account_id');
    expect(serialized).not.toContain('organization_id');
    expect(serialized).not.toContain('created_at');
    expect(serialized).not.toContain('updated_at');
    // The coach's words themselves are untouched by the projection -- the
    // owner decision of 2026-08-28 was about these, and they are all here.
    expect(serialized).toContain('Guard recovery off the jab.');
    expect(serialized).toContain('Jab off the back foot under pressure');
  });
});
