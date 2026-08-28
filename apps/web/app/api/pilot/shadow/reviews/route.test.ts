import { NextRequest } from 'next/server';

import { GET, PATCH } from './route';
import { listHumanReviews, updateHumanReview } from '@/src/server/pilot/shadowConversations';
import { requirePrincipal } from '@/src/server/pilot/http';

/**
 * The route test this endpoint shipped without.
 *
 * That absence is part of the story rather than an aside. This route is the
 * read-and-triage half of the SHADOW human-review queue -- the queue that
 * receives a severity:'critical' ticket when a member's chat trips the safety
 * boundary on chest pain, fainting, loss of consciousness or an urgent personal
 * symptom. The write side has tests. The read side had none, no caller, and no
 * page, so nothing anywhere would have gone red to say a critical escalation
 * was reaching no human. A route with no test and no caller is invisible twice
 * over.
 *
 * These tests pin the three properties that make the queue safe to act on: it
 * is org-scoped, it is admin-gated, and it refuses a status it does not
 * understand rather than guessing.
 */

jest.mock('@/src/server/pilot/shadowConversations', () => ({
  listHumanReviews: jest.fn(),
  updateHumanReview: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listHumanReviews);
const mockUpdate = jest.mocked(updateHumanReview);

function principal(role: string, organizationId = 'org-a') {
  return {
    accountId: 'acct-caller',
    role,
    organizationId,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as never;
}

const REVIEW_ID = '11111111-2222-4333-8444-555555555555';

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/shadow/reviews', () => {
  test('an org admin reads open tickets, scoped to their own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    mockList.mockResolvedValueOnce([
      {
        review_id: REVIEW_ID,
        severity: 'critical',
        category: 'urgent_personal_symptom',
        summary: 'A SHADOW chat request was withheld by the pre-generation safety boundary.',
        status: 'open',
      },
    ] as never);

    const response = await GET(
      new NextRequest('https://example.test/api/pilot/shadow/reviews'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reviews).toHaveLength(1);
    // The organization comes from the principal, never from the query string --
    // the caller cannot ask for another gym's queue.
    expect(mockList).toHaveBeenCalledWith('org-a', 'open');
  });

  test('a caller-supplied organization_id is ignored, not honoured', async () => {
    // The first draft of this file asserted only that listHumanReviews was
    // called with 'org-a' when no query string was present -- which a route
    // that read `searchParams.get('organization_id') ?? principal.organizationId`
    // would also satisfy, because the fallback fires when nothing is supplied.
    // A mutation proving exactly that passed. This is the case that fails it:
    // the parameter is present, points at another gym, and must be ignored.
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin', 'org-a'));
    mockList.mockResolvedValueOnce([] as never);

    await GET(
      new NextRequest(
        'https://example.test/api/pilot/shadow/reviews?organization_id=org-victim',
      ),
    );

    expect(mockList).toHaveBeenCalledWith('org-a', 'open');
    expect(mockList).not.toHaveBeenCalledWith('org-victim', expect.anything());
  });

  test('status defaults to open, so the queue that matters is what loads first', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));
    mockList.mockResolvedValueOnce([] as never);

    await GET(new NextRequest('https://example.test/api/pilot/shadow/reviews'));

    expect(mockList).toHaveBeenCalledWith(expect.any(String), 'open');
  });

  test('an unsupported status is refused rather than guessed at', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));

    const response = await GET(
      new NextRequest('https://example.test/api/pilot/shadow/reviews?status=everything'),
    );

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('a coach cannot read the queue', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await GET(
      new NextRequest('https://example.test/api/pilot/shadow/reviews'),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/pilot/shadow/reviews', () => {
  function patch(body: unknown) {
    return new NextRequest('https://example.test/api/pilot/shadow/reviews', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  test('a triage decision records who made it, on their own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    mockUpdate.mockResolvedValueOnce(true as never);

    const response = await PATCH(patch({ reviewId: REVIEW_ID, status: 'resolved' }));

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      organizationId: 'org-a',
      reviewId: REVIEW_ID,
      reviewerId: 'acct-caller',
      status: 'resolved',
    });
  });

  test("'open' is not a transition, so one reviewer cannot undo another's resolution", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));

    const response = await PATCH(patch({ reviewId: REVIEW_ID, status: 'open' }));

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a non-uuid review id is not distinguishable from one that does not exist', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));

    const response = await PATCH(patch({ reviewId: 'not-a-uuid', status: 'resolved' }));

    // hiddenNotFound: a caller probing ids learns nothing from the shape of the
    // refusal.
    expect(response.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a ticket belonging to another organization reads as not found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin', 'org-b'));
    mockUpdate.mockResolvedValueOnce(false as never);

    const response = await PATCH(patch({ reviewId: REVIEW_ID, status: 'dismissed' }));

    expect(response.status).toBe(404);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-b' }),
    );
  });

  test('a coach cannot triage', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await PATCH(patch({ reviewId: REVIEW_ID, status: 'resolved' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
