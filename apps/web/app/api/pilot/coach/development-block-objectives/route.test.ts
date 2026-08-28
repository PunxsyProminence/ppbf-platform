import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import {
  FULL_SPECTRUM_DOMAINS,
  OBJECTIVE_STATUSES,
  addBlockObjective,
  listObjectivesForBlock,
  setBlockObjectiveStatus,
} from '@/src/server/pilot/athleteDevelopmentBlockObjectives';
import { getDevelopmentBlock } from '@/src/server/pilot/athleteDevelopmentBlocks';
import { ForbiddenError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { DOMAIN_LABEL } from '@/app/coach/development-blocks/page';

/*
 * The coach API over block objectives.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. The module is mocked, so nothing here
 * watches an objective get filtered out by an access rule -- the rule does not
 * live in this file. It lives in athleteDevelopmentBlockObjectives.ts, which
 * resolves every read and write through getDevelopmentBlock, and it is proven
 * against real rows in athleteDevelopmentBlockObjectives.pg.test.ts, where an
 * unassigned coach of the same gym reads an empty list and a linked guardian
 * reads their own child's objectives and no one else's.
 *
 * What IS asserted here is the part only this layer can get wrong:
 *
 *   - no path reaches an objective without the principal being handed down,
 *     and the identity handed down is the SESSION's, never one the caller
 *     sent -- not the organization, not the author;
 *   - "no objectives" and "not your block" are different answers, because the
 *     module answers [] for both and a coach reading their own athlete's
 *     block is owed better than an empty list that reads as "nothing planned";
 *   - the domain and status vocabularies are refused at the edge, so a body
 *     carrying an unknown value never reaches the data layer;
 *   - the fields this route deliberately cannot patch stay unpatchable.
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
  return {
    ...actual,
    addBlockObjective: jest.fn(),
    listObjectivesForBlock: jest.fn(),
    setBlockObjectiveStatus: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetBlock = getDevelopmentBlock as jest.Mock;
const mockAdd = addBlockObjective as jest.Mock;
const mockList = listObjectivesForBlock as jest.Mock;
const mockSetStatus = setBlockObjectiveStatus as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
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
    title: 'Winter technical block',
    training_emphasis: 'Guard recovery off the jab.',
    starts_on: '2026-09-01',
    ends_on: '2026-10-13',
    status: 'draft',
    created_by_account_id: 'acct-coach-a',
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
  new NextRequest(`http://localhost/api/pilot/coach/development-block-objectives${query}`);

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/development-block-objectives', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function patchRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/development-block-objectives', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

describe('who may reach this route at all', () => {
  test.each(['coach', 'organization_admin', 'admin'])('the %s role is served', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
    mockGetBlock.mockResolvedValue(block());
    mockList.mockResolvedValue([]);

    const response = await GET(getRequest('?block_id=blk-1'));

    expect(response.status).toBe(200);
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'])(
    'the %s role is refused on every verb, and nothing is read or written',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      const read = await GET(getRequest('?block_id=blk-1'));
      const write = await POST(postRequest({
        block_id: 'blk-1', domain: 'technical', objective: 'Something',
      }));
      const move = await PATCH(patchRequest({ objective_id: 'obj-1', status: 'active' }));

      expect([read.status, write.status, move.status]).toEqual([403, 403, 403]);
      expect(mockGetBlock).not.toHaveBeenCalled();
      expect(mockList).not.toHaveBeenCalled();
      expect(mockAdd).not.toHaveBeenCalled();
      expect(mockSetStatus).not.toHaveBeenCalled();
    },
  );

  test('the athlete and guardian refusal is this route\'s scope, not the read decision', async () => {
    /* The owner decision of 2026-08-28 put athletes and guardians INSIDE the
       read boundary, and the data layer serves them: getBlockObjective and
       listObjectivesForBlock both answer for an athlete about themselves and
       for a linked guardian about their child.

       They are refused HERE because this is the coach's authoring surface,
       not because they may not read. An athlete- or guardian-facing read
       surface is a separate slice with its own safeguarding decisions -- what
       a minor sees of a coach's raw words, and whether a body-composition
       objective about them is part of it -- and until those are made, the
       narrower answer is the honest one. */
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-1' }));

    const response = await GET(getRequest('?block_id=blk-1'));

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('reading a block\'s objectives', () => {
  test('the principal is handed down, and the rows come back as the module gave them', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockList.mockResolvedValue([objective(), objective({ objective_id: 'obj-2', domain: 'mental' })]);

    const payload = await (await GET(getRequest('?block_id=blk-1'))).json();

    expect(mockGetBlock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-coach-a', organizationId: 'org-1', role: 'coach' }),
      'blk-1',
    );
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-coach-a', organizationId: 'org-1' }),
      'blk-1',
    );
    expect(payload.objectives.map((row: { objective_id: string }) => row.objective_id))
      .toEqual(['obj-1', 'obj-2']);
  });

  test('a block that cannot be opened is a 404, and its objectives are never read', async () => {
    /* The distinction this route exists to draw. listObjectivesForBlock
       answers [] for another gym's block, for an athlete this coach cannot
       reach, and for a block id that never existed -- correctly, because a
       data-layer read must not disclose which. A coach looking at their own
       athlete's block is owed a different answer from "nothing planned here",
       so the parent is read first and 404 covers all three. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(null);

    const response = await GET(getRequest('?block_id=blk-elsewhere'));

    expect(response.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an empty block is a 200 with an empty list, not a 404', async () => {
    // The other half of the same distinction: a reachable block with nothing
    // planned yet is a real, ordinary state and must not read as missing.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockList.mockResolvedValue([]);

    const response = await GET(getRequest('?block_id=blk-1'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.objectives).toEqual([]);
  });

  test('a missing block_id is refused before anything is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await GET(getRequest());

    expect(response.status).toBe(400);
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  test('the read is scoped to the principal\'s organization, never a supplied one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-mine' }));
    mockGetBlock.mockResolvedValue(block());
    mockList.mockResolvedValue([]);

    await GET(getRequest('?block_id=blk-1&organization_id=org-theirs'));

    expect(mockGetBlock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-mine' }),
      'blk-1',
    );
    expect(JSON.stringify(mockList.mock.calls)).not.toContain('org-theirs');
  });
});

describe('the domain picker', () => {
  test('it offers exactly the ten Full Spectrum domains and the four statuses', async () => {
    /* Served rather than duplicated. Ten values owned by a migration are ten
       chances for a client's private copy to drift, and a domain offered by a
       screen that the database refuses fails the write outright. */
    mockRequirePrincipal.mockResolvedValue(principal());

    const payload = await (await GET(getRequest('?domains=options'))).json();

    expect(payload.domains).toEqual([...FULL_SPECTRUM_DOMAINS]);
    expect(payload.statuses).toEqual([...OBJECTIVE_STATUSES]);
    expect(payload.domains).toHaveLength(10);
  });

  test('it reads no block and applies no athlete gate', async () => {
    /* A domain label is a platform constant, identical in every gym, carrying
       nothing about anybody. Gating the picker on a block would be theatre --
       and would need a block id the picker has no business asking for. WHICH
       block an objective may be attached to is the athlete question, and POST
       answers it against that block's own athlete. */
    mockRequirePrincipal.mockResolvedValue(principal());

    await GET(getRequest('?domains=options'));

    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  test('nutrition_body_composition is among them, and is the tenth', async () => {
    // Admitted by owner decision 2026-08-28. Pinned so that removing it is a
    // deliberate edit rather than a drift, and so that its presence stays
    // visible to whoever reads this file next.
    mockRequirePrincipal.mockResolvedValue(principal());

    const payload = await (await GET(getRequest('?domains=options'))).json();

    expect(payload.domains).toContain('nutrition_body_composition');
    expect(payload.domains[9]).toBe('nutrition_body_composition');
  });
});

describe('adding an objective', () => {
  test('a coach adds one, attributed to the session and never to a supplied author', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-really-me' }));
    mockAdd.mockResolvedValue(objective());

    const response = await POST(postRequest({
      block_id: 'blk-1',
      domain: 'conditioning',
      objective: 'Three hard rounds without the pace dropping in the third.',
      status: 'active',
      created_by_account_id: 'acct-somebody-else',
      organization_id: 'org-theirs',
    }));

    expect(response.status).toBe(201);
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ accountId: 'acct-really-me', organizationId: 'org-1' }),
      blockId: 'blk-1',
      domain: 'conditioning',
      objective: 'Three hard rounds without the pace dropping in the third.',
      status: 'active',
    }));
    // Neither forged value reaches the module in any argument at all.
    expect(JSON.stringify(mockAdd.mock.calls)).not.toContain('acct-somebody-else');
    expect(JSON.stringify(mockAdd.mock.calls)).not.toContain('org-theirs');
  });

  test('an unknown domain is refused at the edge, and never reaches the data layer', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    for (const domain of ['weight_cut', 'vibes', 'Technical', '']) {
      const response = await POST(postRequest({
        block_id: 'blk-1', domain, objective: 'Something',
      }));
      expect(response.status).toBe(400);
    }
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('weight_cut is refused here as it is everywhere else', async () => {
    /* Admitting nutrition_body_composition as a DOMAIN LABEL did not admit a
       weight-cutting vocabulary. shadowAuthority.ts still refuses 'weight_cut'
       in conversation, the database CHECK refuses it as a domain, and so does
       this route. Three layers, one answer. */
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest({
      block_id: 'blk-1', domain: 'weight_cut', objective: 'Cut to 132 by the October show.',
    }));

    expect(response.status).toBe(400);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('a body-composition objective IS accepted, because the owner admitted it', async () => {
    // The paired control. Without it, the refusals above would also pass for
    // a route that rejected the tenth domain outright.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAdd.mockResolvedValue(objective({ domain: 'nutrition_body_composition' }));

    const response = await POST(postRequest({
      block_id: 'blk-1',
      domain: 'nutrition_body_composition',
      objective: 'Eat a real breakfast before morning conditioning.',
    }));

    expect(response.status).toBe(201);
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'nutrition_body_composition' }),
    );
  });

  test('an unknown status is refused rather than stored', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest({
      block_id: 'blk-1', domain: 'technical', objective: 'Something', status: 'archived',
    }));

    expect(response.status).toBe(400);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('a missing block_id is refused before any access check', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest({ domain: 'technical', objective: 'Something' }));

    expect(response.status).toBe(400);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('an account that may not author here gets 403, not 404', async () => {
    /* The module throws before it looks at the block, so a caller with no
       standing in this organization learns nothing about which blocks exist.
       The route must pass that through rather than flattening it into the
       not-found answer. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAdd.mockRejectedValue(new ForbiddenError(
      'This account may not author development block objectives in this organization.',
      'BLOCK_OBJECTIVE_CREATOR_NOT_PERMITTED',
    ));

    const response = await POST(postRequest({
      block_id: 'blk-1', domain: 'technical', objective: 'Something',
    }));

    expect(response.status).toBe(403);
  });

  test('a block the writer cannot open is a 404, and is not distinguishable from a missing one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAdd.mockResolvedValue(null);

    const response = await POST(postRequest({
      block_id: 'blk-elsewhere', domain: 'technical', objective: 'Something',
    }));

    expect(response.status).toBe(404);
  });
});

describe('moving an objective through its lifecycle', () => {
  test('the principal is handed down with the new status', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockSetStatus.mockResolvedValue(objective({ status: 'completed' }));

    const response = await PATCH(patchRequest({ objective_id: 'obj-1', status: 'completed' }));

    expect(response.status).toBe(200);
    expect(mockSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-coach-a', organizationId: 'org-1' }),
      'obj-1',
      'completed',
    );
  });

  test.each([...OBJECTIVE_STATUSES])('the %s status is accepted, and none of them advances itself', async (status) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockSetStatus.mockResolvedValue(objective({ status }));

    const response = await PATCH(patchRequest({ objective_id: 'obj-1', status }));

    expect(response.status).toBe(200);
    expect(mockSetStatus).toHaveBeenCalledWith(expect.anything(), 'obj-1', status);
  });

  test('an unknown status is refused rather than stored', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    for (const status of ['archived', 'in_progress', 'ACTIVE', '']) {
      const response = await PATCH(patchRequest({ objective_id: 'obj-1', status }));
      expect(response.status).toBe(400);
    }
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  test('the domain and the coach\'s own words are not patchable', async () => {
    /* The omissions are the design. Re-domaining an objective silently
       reassigns what a coach said about one part of an athlete's development
       to another; rewriting the sentence in place destroys the record this
       table exists to keep verbatim. A wrong objective is cancelled and a new
       one written, which is why 'cancelled' is in the vocabulary at all. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockSetStatus.mockResolvedValue(objective());

    await PATCH(patchRequest({
      objective_id: 'obj-1',
      status: 'active',
      domain: 'nutrition_body_composition',
      objective: 'Something else entirely.',
      block_id: 'blk-9',
      created_by_account_id: 'acct-somebody-else',
    }));

    // setBlockObjectiveStatus takes exactly three arguments and none of them
    // is a patch object, so there is nowhere for a smuggled field to land.
    expect(mockSetStatus).toHaveBeenCalledWith(expect.anything(), 'obj-1', 'active');
    const call = JSON.stringify(mockSetStatus.mock.calls);
    expect(call).not.toContain('Something else entirely');
    expect(call).not.toContain('blk-9');
    expect(call).not.toContain('acct-somebody-else');
  });

  test('a missing objective_id is refused before anything is written', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await PATCH(patchRequest({ status: 'active' }));

    expect(response.status).toBe(400);
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  test('an objective the caller cannot reach is a 404', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockSetStatus.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ objective_id: 'obj-elsewhere', status: 'active' }));

    expect(response.status).toBe(404);
  });

  test('an account that may not move an objective gets 403', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockSetStatus.mockRejectedValue(new ForbiddenError(
      'This account may not modify development block objectives in this organization.',
      'BLOCK_OBJECTIVE_WRITER_NOT_PERMITTED',
    ));

    const response = await PATCH(patchRequest({ objective_id: 'obj-1', status: 'completed' }));

    expect(response.status).toBe(403);
  });
});

describe('nothing computed reaches the caller', () => {
  test('the response carries the stored rows and no roll-up', async () => {
    /* "Three of five objectives completed" is arithmetic, not coaching. This
       route returns rows; if a later change adds a count, a proportion or a
       grade to the response, this fails and names the key. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockList.mockResolvedValue([
      objective({ objective_id: 'obj-1', status: 'completed' }),
      objective({ objective_id: 'obj-2', status: 'draft' }),
    ]);

    const payload = await (await GET(getRequest('?block_id=blk-1'))).json();

    expect(Object.keys(payload).sort()).toEqual(['objectives', 'ok']);
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      'completed_count', 'total', 'percent', 'progress', 'score', 'rating',
      'adherence', 'compliance', 'grade', 'readiness',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('the screen can name every domain the route serves', () => {
  test('DOMAIN_LABEL covers exactly the Full Spectrum vocabulary', () => {
    /* THE PIN, and it lives here rather than beside the page for a mundane
       reason worth writing down: importing this module from a jsdom test
       pulls in `pg`, which needs a TextEncoder jsdom does not provide. This
       file runs under node and can hold both sides.

       What it guards is the seam the route deliberately created. The page
       holds no copy of the ten values -- it renders whatever ?domains=options
       returns, so it can never offer a domain the database would refuse. The
       cost of that is the opposite failure: a domain added to the migration
       and served to a screen with no label for it, which would render to a
       coach as a raw snake_case slug on a record about a child. Equality in
       BOTH directions is what makes that impossible. */
    expect(Object.keys(DOMAIN_LABEL).sort()).toEqual([...FULL_SPECTRUM_DOMAINS].sort());
  });

  test('every label is human text, not the stored value passed through', () => {
    // A label identical to its key is the shape a lazy addition takes, and it
    // reads to a coach as a bug rather than as a category.
    for (const domain of FULL_SPECTRUM_DOMAINS) {
      expect(DOMAIN_LABEL[domain]).toBeTruthy();
      expect(DOMAIN_LABEL[domain]).not.toBe(domain);
      expect(DOMAIN_LABEL[domain]).not.toMatch(/_/);
    }
  });
});
