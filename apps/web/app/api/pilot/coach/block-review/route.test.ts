import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  getDevelopmentBlock,
  hasBlockWriteMembership,
} from '@/src/server/pilot/athleteDevelopmentBlocks';
import { blockEvidence, listBlockReviews, recordBlockReview } from '@/src/server/pilot/blockReview';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
 * The coach API for plan versus what was actually recorded.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately leaves to Postgres. The
 * evidence queries, the five-state vocabulary and the deviations rule are
 * proven against a real database in blockReview.pg.test.ts, and the athlete
 * relationship rules in athleteIdsForCoach.pg.test.ts. Nothing here restates
 * them with mocks. What is only assertable HERE is the wiring:
 *
 *   -- every path goes through the block gate, with the actor untouched;
 *   -- the evidence read is scoped to the athlete and window the BLOCK
 *      names, never to anything in the request;
 *   -- a failed read reaches the caller as a failure, never as zeroes;
 *   -- the response carries no comparison between the plan and the record.
 *
 * That last one is the build order's own refusal -- "Do not invent an
 * adherence percentage" -- asserted at the surface where a number would
 * actually be assembled.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteDevelopmentBlocks', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteDevelopmentBlocks');
  return {
    ...actual,
    getDevelopmentBlock: jest.fn(),
    hasBlockWriteMembership: jest.fn(async () => true),
  };
});

jest.mock('@/src/server/pilot/blockReview', () => {
  const actual = jest.requireActual('@/src/server/pilot/blockReview');
  return {
    ...actual,
    listBlockReviews: jest.fn(async () => []),
    blockEvidence: jest.fn(async () => []),
    recordBlockReview: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetBlock = getDevelopmentBlock as jest.Mock;
const mockMembership = hasBlockWriteMembership as jest.Mock;
const mockListReviews = listBlockReviews as jest.Mock;
const mockEvidence = blockEvidence as jest.Mock;
const mockRecord = recordBlockReview as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

beforeEach(() => {
  mockMembership.mockResolvedValue(true);
  mockListReviews.mockResolvedValue([]);
  mockEvidence.mockResolvedValue([]);
  mockRecord.mockResolvedValue(review());
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
    target_competition_id: null,
    target_wrestling_event_id: null,
    created_by_account_id: 'acct-coach-a',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    review_id: 'rev-1',
    block_id: 'blk-a',
    adherence_state: 'delivered_with_deviations',
    deviations: 'Two weeks lost to a hall closure.',
    reason: 'Venue.',
    what_worked: 'Round-three output held.',
    what_did_not: 'Southpaw work never started.',
    next_adjustment: 'Move southpaw work forward.',
    reviewed_by_account_id: 'acct-coach-a',
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function source(key: string, recorded: number, undated = 0) {
  return { key, label: `${key} recorded`, recorded, undated, recent: [] };
}

function getRequest(qs: string) {
  return new NextRequest(`http://localhost/api/pilot/coach/block-review${qs}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/block-review', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('the block gate is on every path, and gets the actor untouched', () => {
  test.each([
    ['read', () => GET(getRequest('?block_id=blk-a'))],
    ['record a review', () => POST(postRequest({ block_id: 'blk-a' }))],
  ])('%s clears the block first, with the caller\'s own actor', async (_name, call) => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block());

    await call();

    /* THE SAME OBJECT, not one that merely looks similar. The gate decides
       access from the whole actor, so a route that rebuilt or widened it on
       the way in -- the one escalation this hand-off invites -- must fail
       here. objectContaining would let a changed role through. */
    expect(mockGetBlock).toHaveBeenCalledWith(actor, 'blk-a');
  });

  test.each([
    ['read', () => GET(getRequest('?block_id=blk-a'))],
    ['record a review', () => POST(postRequest({ block_id: 'blk-a' }))],
  ])('%s is a 404 when the block is not reachable, and does no work', async (_name, call) => {
    mockRequirePrincipal.mockResolvedValue(principal());
    // Null is BOTH "no such block" and "not your athlete". The caller cannot
    // tell which, and this route must not make them distinguishable.
    mockGetBlock.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(404);
    expect(mockEvidence).not.toHaveBeenCalled();
    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each([
    ['read', () => GET(getRequest('?block_id=blk-a'))],
    ['record a review', () => POST(postRequest({ block_id: 'blk-a' }))],
  ])('%s refuses a role with no business reviewing a block', async (_name, call) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete' }));
    mockGetBlock.mockResolvedValue(block());

    const response = await call();

    expect(response.status).toBe(403);
    // The role check runs BEFORE the gate: an athlete must not be able to
    // probe block ids at all.
    expect(mockGetBlock).not.toHaveBeenCalled();
  });

  test.each([
    ['read', (qs: string) => GET(getRequest(qs))],
  ])('%s without a block_id is a 400, not a whole-gym read', async (_name, call) => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await call('');

    expect(response.status).toBe(400);
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(mockEvidence).not.toHaveBeenCalled();
  });

  test('recording without a block_id is a 400, not a review of nothing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest({ adherence_state: 'delivered_as_planned' }));

    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('the evidence read is scoped by the block, not by the request', () => {
  test('the athlete and the window come from the block the gate returned', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block({ athlete_id: 'ath-1' }));

    /* The query string names a DIFFERENT child and a wider window. Both are
       ignored: a caller who could steer either of these would read another
       athlete's training record through a block they legitimately hold. */
    await GET(getRequest('?block_id=blk-a&athlete_id=ath-someone-else'
      + '&starts_on=1900-01-01&ends_on=2999-12-31'));

    expect(mockEvidence).toHaveBeenCalledWith(
      'org-1', 'ath-1', 'blk-a', '2026-08-01', '2026-09-30',
    );
  });

  test('the organization comes from the session, never from the caller', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-1' }));
    mockGetBlock.mockResolvedValue(block());

    await GET(getRequest('?block_id=blk-a&organization_id=org-2'));

    expect(mockEvidence.mock.calls[0][0]).toBe('org-1');
    expect(mockListReviews).toHaveBeenCalledWith('org-1', 'blk-a');
  });

  test('a failed evidence read is a failure, never six zeroes', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockEvidence.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const response = await GET(getRequest('?block_id=blk-a'));

    /* THE HONESTY RULE, at the one surface where breaking it is easiest and
       worst: a caught-and-defaulted read would render as "nothing recorded",
       which is exactly what an athlete with no logged training looks like.
       The two must never be confusable, so the read is not caught. */
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('"recorded":0');
  });
});

describe('the response reports, and does not evaluate', () => {
  test('the two halves come back separately and neither is compared to the other', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockListReviews.mockResolvedValue([review()]);
    mockEvidence.mockResolvedValue([source('sessions', 3), source('training_attempts', 0)]);

    const response = await GET(getRequest('?block_id=blk-a'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reviews).toHaveLength(1);
    expect(body.evidence).toHaveLength(2);

    /* No key anywhere in this response compares the plan to the record. A
       percentage, a coverage figure or a computed verdict would be a
       machine's judgement of a coach's work with a child, and it would be
       believed precisely because it looked measured. */
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          keys.add(key);
          walk(nested);
        }
      }
    };
    walk(body);
    for (const forbidden of [
      'adherence_percentage', 'percent', 'percentage', 'ratio', 'coverage',
      'completion', 'score', 'on_track', 'verdict', 'shortfall', 'expected',
      'compliance', 'grade',
    ]) {
      expect([forbidden, keys.has(forbidden)]).toEqual([forbidden, false]);
    }
    // `adherence_state` survives that sweep and must: it is the HUMAN's
    // chosen word, carried through unchanged, not a derived figure.
    expect(body.reviews[0].adherence_state).toBe('delivered_with_deviations');
  });

  test('a zero source is returned as a zero and never as an absence', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockEvidence.mockResolvedValue([source('activity_log', 0)]);

    const body = await (await GET(getRequest('?block_id=blk-a'))).json();

    // The source is still there, saying zero. Dropping empty sources would
    // turn "nobody recorded anything" into a source that does not exist.
    expect(body.evidence).toEqual([source('activity_log', 0)]);
  });
});

describe('recording a review', () => {
  test('the coach\'s words and chosen state reach the module unaltered', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockGetBlock.mockResolvedValue(block());

    const response = await POST(postRequest({
      block_id: 'blk-a',
      adherence_state: 'under_delivered',
      deviations: 'Two weeks lost to a hall closure.',
      reason: 'Venue.',
      what_worked: 'Round-three output held.',
      what_did_not: 'Southpaw work never started.',
      next_adjustment: 'Move southpaw work forward.',
    }));

    expect(response.status).toBe(201);
    expect(mockRecord).toHaveBeenCalledWith({
      organizationId: 'org-1',
      blockId: 'blk-a',
      reviewedByAccountId: 'acct-coach-a',
      adherenceState: 'under_delivered',
      deviations: 'Two weeks lost to a hall closure.',
      reason: 'Venue.',
      whatWorked: 'Round-three output held.',
      whatDidNot: 'Southpaw work never started.',
      nextAdjustment: 'Move southpaw work forward.',
    });
  });

  test('an omitted state is left undecided, not guessed from the words', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());

    await POST(postRequest({
      block_id: 'blk-a',
      what_did_not: 'Almost none of it happened.',
    }));

    /* Undefined, so the module's own default -- 'unknown' -- applies. A route
       that read those words and chose 'not_delivered' would be the machine
       making the judgement the order reserves for a human. */
    expect(mockRecord.mock.calls[0][0].adherenceState).toBeUndefined();
  });

  test('the reviewer is the session account, never a name in the body', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach-a' }));
    mockGetBlock.mockResolvedValue(block());

    await POST(postRequest({
      block_id: 'blk-a',
      reviewed_by_account_id: 'acct-someone-else',
      organization_id: 'org-2',
    }));

    // Attribution is the point of the record: a judgement about a child's
    // training says who made it, and only the session can say that.
    expect(mockRecord.mock.calls[0][0].reviewedByAccountId).toBe('acct-coach-a');
    expect(mockRecord.mock.calls[0][0].organizationId).toBe('org-1');
  });

  test('a deactivated membership cannot author a review, even with a valid session', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    mockMembership.mockResolvedValue(false);

    const response = await POST(postRequest({ block_id: 'blk-a' }));

    expect(response.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
    // Asked about the membership HERE, not about the account's home gym.
    expect(mockMembership).toHaveBeenCalledWith('acct-coach-a', 'org-1');
  });

  test('the module\'s own refusal reaches the coach as the reason, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetBlock.mockResolvedValue(block());
    const { ValidationError } = jest.requireActual('@/src/server/pilot/errors');
    mockRecord.mockRejectedValue(new ValidationError(
      'Recording "delivered with deviations" means saying what the deviations were.',
      'BLOCK_REVIEW_INVALID',
    ));

    const response = await POST(postRequest({
      block_id: 'blk-a',
      adherence_state: 'delivered_with_deviations',
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('deviations');
  });
});
