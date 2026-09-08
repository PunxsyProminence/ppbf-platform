import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getAttemptForReview, listReviews, recordReview } from '@/src/server/pilot/trainingAttempts';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// BASE-06 coach attempt review. What these pin: the NEW review mutation is
// coach-only (org_admin/admin/athlete/parent are all refused, unlike the
// existing attempt read/write); the access gate runs on the ATTEMPT'S athlete
// before any write; an attempt in another organization is a hidden not-found,
// never an existence leak; and the client never supplies a verdict.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/trainingAttempts', () => {
  const actual = jest.requireActual('@/src/server/pilot/trainingAttempts');
  return { ...actual, getAttemptForReview: jest.fn(), recordReview: jest.fn(), listReviews: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockGetAttempt = getAttemptForReview as jest.Mock;
const mockRecordReview = recordReview as jest.Mock;
const mockListReviews = listReviews as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-coach',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/training-attempts/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const getRequest = (query: string) =>
  new NextRequest(`http://localhost/api/pilot/training-attempts/review?${query}`);

const confirmBody = { attempt_id: 'att-1', review_state: 'confirmed' };

describe('only a coach may record a review', () => {
  test.each(['organization_admin', 'admin', 'athlete', 'parent'] as const)(
    'a %s is refused and nothing is written',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role, athleteId: role === 'athlete' ? 'ath-1' : undefined }));

      const response = await POST(postRequest(confirmBody));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockGetAttempt).not.toHaveBeenCalled();
      expect(mockRecordReview).not.toHaveBeenCalled();
    },
  );

  test('an unauthenticated caller is refused before any work', async () => {
    mockRequirePrincipal.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));

    const response = await POST(postRequest(confirmBody));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockRecordReview).not.toHaveBeenCalled();
  });
});

describe('the attempt access gate runs before any write', () => {
  test('an unassigned coach is refused on the attempt\'s athlete, nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetAttempt.mockResolvedValue({ athlete_id: 'ath-1', direction: 'at_least' });
    mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    const response = await POST(postRequest(confirmBody));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ role: 'coach' }), 'ath-1');
    expect(mockRecordReview).not.toHaveBeenCalled();
  });

  test('an attempt in another organization is a hidden not-found, never leaked', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetAttempt.mockResolvedValue(null);

    const response = await POST(postRequest(confirmBody));

    expect(response.status).toBe(404);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockRecordReview).not.toHaveBeenCalled();
  });
});

describe('an authorized coach records a review', () => {
  beforeEach(() => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetAttempt.mockResolvedValue({ athlete_id: 'ath-1', direction: 'at_least' });
    mockAccess.mockResolvedValue(undefined);
    mockRecordReview.mockResolvedValue({ review_id: 'rev-1', review_state: 'confirmed' });
  });

  test('confirm succeeds and passes the coach as the reviewer', async () => {
    const response = await POST(postRequest({ attempt_id: 'att-1', review_state: 'confirmed' }));

    expect(response.status).toBe(200);
    expect(mockRecordReview).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      attemptId: 'att-1',
      reviewState: 'confirmed',
      reviewedByAccountId: 'acct-coach',
    }));
  });

  test('correct passes the corrected numbers and never a verdict', async () => {
    const response = await POST(postRequest({
      attempt_id: 'att-1',
      review_state: 'corrected',
      corrected_target_value: 10,
      corrected_achieved_value: 10,
      reason: 'miscount confirmed on film for this set',
    }));

    expect(response.status).toBe(200);
    const passed = mockRecordReview.mock.calls[0][0] as Record<string, unknown>;
    expect(passed).toMatchObject({
      reviewState: 'corrected',
      correctedTargetValue: 10,
      correctedAchievedValue: 10,
      reason: 'miscount confirmed on film for this set',
    });
    expect(Object.keys(passed)).not.toContain('correctedMade');
    expect(Object.keys(passed)).not.toContain('made');
  });

  test('an unknown review_state is refused', async () => {
    const response = await POST(postRequest({ attempt_id: 'att-1', review_state: 'vibes' }));
    expect(response.status).toBe(400);
    expect(mockRecordReview).not.toHaveBeenCalled();
  });

  test('a corrected review with no achieved value is refused before writing', async () => {
    const response = await POST(postRequest({ attempt_id: 'att-1', review_state: 'corrected', reason: 'no numbers supplied at all here' }));
    expect(response.status).toBe(400);
    expect(mockRecordReview).not.toHaveBeenCalled();
  });

  test('a dispute with no reason is refused before writing', async () => {
    const response = await POST(postRequest({ attempt_id: 'att-1', review_state: 'disputed' }));
    expect(response.status).toBe(400);
    expect(mockRecordReview).not.toHaveBeenCalled();
  });
});

describe('review history read', () => {
  test('an authorized coach reads the history for an attempt', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetAttempt.mockResolvedValue({ athlete_id: 'ath-1', direction: 'at_least' });
    mockAccess.mockResolvedValue(undefined);
    mockListReviews.mockResolvedValue([{ review_id: 'rev-1', review_state: 'disputed' }]);

    const response = await GET(getRequest('attempt_id=att-1'));

    expect(response.status).toBe(200);
    expect(mockListReviews).toHaveBeenCalledWith('org-1', 'att-1');
  });

  test('an athlete cannot read review history', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-1' }));

    const response = await GET(getRequest('attempt_id=att-1'));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockListReviews).not.toHaveBeenCalled();
  });
});
