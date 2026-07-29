import { NextRequest } from 'next/server';

import { PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  getShadowFeedbackSummary,
  hasDurableHumanReviewedLearningEvent,
  recordShadowFeedback,
  resolveShadowFeedbackReview,
  verifyShadowFeedbackCorrelation,
} from '@/src/server/pilot/shadowFeedback';
import { processLearningSignal } from '@/src/server/pilot/shadowLearningLoop';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowFeedback', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowFeedback');
  return {
    ...actual,
    getShadowFeedbackSummary: jest.fn(),
    listShadowFeedback: jest.fn(),
    recordShadowFeedback: jest.fn(),
    hasDurableHumanReviewedLearningEvent: jest.fn(),
    resolveShadowFeedbackReview: jest.fn(),
    verifyShadowFeedbackCorrelation: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/shadowLearningLoop', () => ({
  processLearningSignal: jest.fn(),
}));

// Only the enforcer is mocked; the pure resolver and message helper stay REAL so
// the route applies the same limits it ships with.
jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn().mockResolvedValue(undefined) };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);
const mockResolveReview = jest.mocked(resolveShadowFeedbackReview);
const mockProcessLearning = jest.mocked(processLearningSignal);
const mockHasDurableLearning = jest.mocked(hasDurableHumanReviewedLearningEvent);
const mockRecordFeedback = jest.mocked(recordShadowFeedback);
const mockVerifyCorrelation = jest.mocked(verifyShadowFeedbackCorrelation);
const mockGetSummary = jest.mocked(getShadowFeedbackSummary);

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'reviewer-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'session-token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/feedback', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const durableReview = {
  feedbackId: 41,
  organizationId: 'org-1',
  accountId: 'feedback-author-1',
  role: 'athlete' as const,
  messageId: '00000000-0000-4000-8000-000000000041',
  topic: 'defense',
  sessionType: 'heavy_bag',
  outcomeSignal: 'thumbs_up' as const,
  userNote: 'This helped.',
  decision: 'approve' as const,
  alreadyResolved: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockReadiness.mockResolvedValue(undefined);
  mockResolveReview.mockResolvedValue(durableReview);
  mockHasDurableLearning.mockResolvedValue(true);
  mockVerifyCorrelation.mockResolvedValue({
    verified: true,
    learningEligible: true,
    correlationType: 'shadow_message',
    correlationId: durableReview.messageId,
    messageId: durableReview.messageId,
    shadowEventId: null,
    sessionType: 'heavy_bag',
    topic: 'defense',
    reason: null,
  });
  mockRecordFeedback.mockResolvedValue({
    feedbackId: 41,
    created: true,
    verificationState: 'durable_client',
    humanReviewRequired: true,
    outcomeSignal: 'thumbs_up',
    comment: null,
  });
  mockGetSummary.mockResolvedValue({
    total_responses: 1,
    helpful_count: 1,
    satisfaction_rate: 1,
    avg_rating: null,
  });
  mockProcessLearning.mockResolvedValue({
    profileUpdated: false,
    metricsRecorded: true,
    libraryFlagged: false,
    factsExtracted: 0,
    humanReviewRequired: true,
    actions: [],
  });
});

describe('PATCH /api/pilot/shadow/feedback human review', () => {
  test('uses only organization-scoped durable fields when an admin approves', async () => {
    const response = await PATCH(patchRequest({
      feedbackId: 41,
      decision: 'approve',
      organizationId: 'org-attacker',
      accountId: 'account-attacker',
      role: 'platform_owner',
      messageId: 'attacker-message',
      topic: 'attacker-topic',
      sessionType: 'attacker-session',
      outcomeSignal: 'thumbs_down',
    }));

    expect(response.status).toBe(200);
    expect(mockResolveReview).toHaveBeenCalledWith({
      organizationId: 'org-1',
      feedbackId: 41,
      reviewerAccountId: 'reviewer-1',
      decision: 'approve',
    });
    expect(mockProcessLearning).toHaveBeenCalledWith({
      feedbackId: 41,
      messageId: durableReview.messageId,
      userId: 'feedback-author-1',
      organizationId: 'org-1',
      role: 'athlete',
      topic: 'defense',
      sessionType: 'heavy_bag',
      outcome: 'thumbs_up',
      userNote: 'This helped.',
      verificationState: 'human_reviewed',
    });
  });

  test('rejects and closes the review without invoking learning', async () => {
    mockResolveReview.mockResolvedValueOnce({
      ...durableReview,
      decision: 'reject',
    });

    const response = await PATCH(patchRequest({ feedbackId: 41, decision: 'reject' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      decision: 'reject',
      learningPromoted: false,
    });
    expect(mockProcessLearning).not.toHaveBeenCalled();
  });

  test('returns an already-durable approval without replaying learning', async () => {
    mockResolveReview.mockResolvedValueOnce({
      ...durableReview,
      alreadyResolved: true,
    });

    const response = await PATCH(patchRequest({ feedbackId: 41, decision: 'approve' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      learningPromoted: true,
      alreadyResolved: true,
    });
    expect(mockProcessLearning).not.toHaveBeenCalled();
    expect(mockHasDurableLearning).toHaveBeenCalledWith({
      organizationId: 'org-1',
      feedbackId: 41,
    });
  });

  test('safely repairs an approved review whose durable event is missing', async () => {
    mockResolveReview.mockResolvedValueOnce({
      ...durableReview,
      alreadyResolved: true,
    });
    mockHasDurableLearning
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const response = await PATCH(patchRequest({ feedbackId: 41, decision: 'approve' }));

    expect(response.status).toBe(200);
    expect(mockProcessLearning).toHaveBeenCalledTimes(1);
    expect(mockHasDurableLearning).toHaveBeenCalledTimes(2);
  });

  test('returns a retryable failure when the learning event was not durable', async () => {
    mockHasDurableLearning.mockResolvedValueOnce(false);

    const response = await PATCH(patchRequest({ feedbackId: 41, decision: 'approve' }));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      learningPromoted: false,
      retryable: true,
    });
  });

  test('hides feedback outside the principal organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ organizationId: 'org-2' }));
    mockResolveReview.mockResolvedValueOnce(null);

    const response = await PATCH(patchRequest({ feedbackId: 41, decision: 'approve' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(mockResolveReview).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-2',
    }));
    expect(mockProcessLearning).not.toHaveBeenCalled();
  });

  test('denies non-admin roles before loading review data', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));

    const response = await PATCH(patchRequest({ feedbackId: 41, decision: 'approve' }));

    expect(response.status).toBe(403);
    expect(mockResolveReview).not.toHaveBeenCalled();
    expect(mockProcessLearning).not.toHaveBeenCalled();
  });

  test('rejects malformed review requests', async () => {
    const response = await PATCH(patchRequest({ feedbackId: '41', decision: 'promote' }));

    expect(response.status).toBe(400);
    expect(mockResolveReview).not.toHaveBeenCalled();
  });

  test('normalizes a PostgreSQL bigint feedback id from the API payload', async () => {
    const response = await PATCH(patchRequest({ feedbackId: '41', decision: 'approve' }));

    expect(response.status).toBe(200);
    expect(mockResolveReview).toHaveBeenCalledWith(expect.objectContaining({
      feedbackId: 41,
    }));
  });
});

describe('POST /api/pilot/shadow/feedback idempotency', () => {
  test('does not rerun learning for a repeated open feedback submission', async () => {
    mockRecordFeedback.mockResolvedValueOnce({
      feedbackId: 41,
      created: false,
      verificationState: 'durable_client',
      humanReviewRequired: true,
      outcomeSignal: 'thumbs_up',
      comment: 'Original note',
    });

    const response = await POST(postRequest({
      message_id: durableReview.messageId,
      helpful: false,
      comment: 'Replacement attempt',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockProcessLearning).not.toHaveBeenCalled();
    expect(payload.learning).toMatchObject({
      accepted: false,
      humanReviewRequired: true,
      reason: 'FEEDBACK_ALREADY_RECORDED',
    });
  });

  test('does not downgrade or relearn from feedback after human review', async () => {
    mockRecordFeedback.mockResolvedValueOnce({
      feedbackId: 41,
      created: false,
      verificationState: 'human_reviewed',
      humanReviewRequired: false,
      outcomeSignal: 'thumbs_up',
      comment: 'Reviewed note',
    });

    const response = await POST(postRequest({
      message_id: durableReview.messageId,
      helpful: false,
      comment: 'Attempted change after review',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockProcessLearning).not.toHaveBeenCalled();
    expect(payload.learning).toMatchObject({
      accepted: false,
      humanReviewRequired: false,
      reason: 'FEEDBACK_ALREADY_RESOLVED',
    });
  });
});
