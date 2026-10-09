import { NextRequest } from 'next/server';

import { GET, PATCH } from './route';
import { listHumanReviews, loadHumanReviewExchange, updateHumanReview } from '@/src/server/pilot/shadowConversations';
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
  loadHumanReviewExchange: jest.fn(),
  updateHumanReview: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listHumanReviews);
const mockUpdate = jest.mocked(updateHumanReview);
const mockExchange = jest.mocked(loadHumanReviewExchange);

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
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
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

  test('platform_owner cannot read the queue -- it is gym business (OD-2026-10-05-024 ruling 3)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await GET(
      new NextRequest('https://example.test/api/pilot/shadow/reviews'),
    );

    expect(response.status).toBe(403);
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

/**
 * The one exchange behind a ticket (OD-2026-10-07-009 question card 2 item 4,
 * "That one exchange"). The route's part is small and must stay small: the
 * ticket id is the only input, the organization and the reader come from the
 * principal, and the same role gate applies as to the queue itself.
 */
describe('GET /api/pilot/shadow/reviews?reviewId=', () => {
  const EXCHANGE = {
    recorded: true,
    subject: { accountId: 'acct-9', role: 'athlete', ageBand: 'under_18' },
    userMessage: { messageId: 'u1', content: 'my chest hurts when i skip', createdAt: '2026-08-01T12:00:00.000Z' },
    assistantMessage: { messageId: 'a1', content: 'Tell a coach now.', createdAt: '2026-08-01T12:00:00.001Z', responseState: 'filtered' },
  } as const;

  test('an org admin reads the exchange behind one of their own tickets, as the reader on record', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', 'org-a'));
    mockExchange.mockResolvedValueOnce(EXCHANGE as never);

    const response = await GET(
      new NextRequest(`https://example.test/api/pilot/shadow/reviews?reviewId=${REVIEW_ID}`),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.exchange).toEqual(EXCHANGE);
    expect(mockExchange).toHaveBeenCalledWith({
      organizationId: 'org-a',
      reviewId: REVIEW_ID,
      reader: { accountId: 'acct-caller', role: 'organization_admin' },
    });
    // The list is not read on this path, and the list's organization/status
    // parameters cannot leak into it.
    expect(mockList).not.toHaveBeenCalled();
  });

  test('only the ticket id crosses: message and conversation parameters are not inputs', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin', 'org-a'));
    mockExchange.mockResolvedValueOnce({ recorded: false, reason: 'no_message_on_ticket' } as never);

    await GET(
      new NextRequest(
        `https://example.test/api/pilot/shadow/reviews?reviewId=${REVIEW_ID}&messageId=other&conversationId=other&organization_id=org-victim`,
      ),
    );

    expect(mockExchange).toHaveBeenCalledTimes(1);
    expect(mockExchange.mock.calls[0][0]).toEqual({
      organizationId: 'org-a',
      reviewId: REVIEW_ID,
      reader: { accountId: 'acct-caller', role: 'admin' },
    });
  });

  test('a ticket of another organization reads as not found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin', 'org-a'));
    mockExchange.mockResolvedValueOnce(null);
    const response = await GET(
      new NextRequest(`https://example.test/api/pilot/shadow/reviews?reviewId=${REVIEW_ID}`),
    );
    expect(response.status).toBe(404);
  });

  test('a non-uuid review id is not distinguishable from one that does not exist, and is not looked up', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin', 'org-a'));
    const response = await GET(
      new NextRequest('https://example.test/api/pilot/shadow/reviews?reviewId=not-a-uuid'),
    );
    expect(response.status).toBe(404);
    expect(mockExchange).not.toHaveBeenCalled();
  });

  test('platform_owner cannot read an exchange (OD-2026-10-05-024 ruling 3)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner', 'org-a'));
    const response = await GET(
      new NextRequest(`https://example.test/api/pilot/shadow/reviews?reviewId=${REVIEW_ID}`),
    );
    expect(response.status).toBe(403);
    expect(mockExchange).not.toHaveBeenCalled();
  });

  test('a coach cannot read an exchange', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', 'org-a'));
    const response = await GET(
      new NextRequest(`https://example.test/api/pilot/shadow/reviews?reviewId=${REVIEW_ID}`),
    );
    expect(response.status).toBe(403);
    expect(mockExchange).not.toHaveBeenCalled();
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

  test('platform_owner cannot triage (OD-2026-10-05-024 ruling 3)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await PATCH(patch({ reviewId: REVIEW_ID, status: 'resolved' }));

    expect(response.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a coach cannot triage', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await PATCH(patch({ reviewId: REVIEW_ID, status: 'resolved' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
