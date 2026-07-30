import {
  interpretShadowFeedbackReviewResponse,
  isShadowFeedbackResolvable,
  selectShadowFeedbackReviewQueue,
} from './shadowFeedbackReview';

function item(overrides: Partial<{
  feedback_id: number;
  correlation_type: string | null;
  human_review_required: boolean;
}> = {}) {
  return {
    feedback_id: 41,
    correlation_type: 'shadow_message' as string | null,
    human_review_required: true,
    ...overrides,
  };
}

describe('selectShadowFeedbackReviewQueue', () => {
  test('keeps only feedback still awaiting human review', () => {
    const queue = selectShadowFeedbackReviewQueue([
      item({ feedback_id: 1, human_review_required: true }),
      item({ feedback_id: 2, human_review_required: false }),
      item({ feedback_id: 3, human_review_required: true }),
    ]);

    expect(queue.map((entry) => entry.feedback_id)).toEqual([1, 3]);
  });

  test('returns an empty queue rather than throwing on an empty projection', () => {
    expect(selectShadowFeedbackReviewQueue([])).toEqual([]);
  });
});

describe('isShadowFeedbackResolvable', () => {
  test('accepts feedback correlated to a durable shadow message', () => {
    expect(isShadowFeedbackResolvable(item({ correlation_type: 'shadow_message' }))).toBe(true);
  });

  // resolveShadowFeedbackReview joins pilot.shadow_chat_messages on
  // correlation_type = 'shadow_message', so these can never resolve and must
  // not be offered as actionable controls.
  test.each([['shadow_event'], [null], ['']])('rejects correlation_type %p', (correlationType) => {
    expect(isShadowFeedbackResolvable(item({ correlation_type: correlationType }))).toBe(false);
  });
});

describe('interpretShadowFeedbackReviewResponse', () => {
  test('treats a successful approval as resolved', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 200,
      payload: { ok: true, decision: 'approve', learningPromoted: true, alreadyResolved: false },
      feedbackId: 41,
      decision: 'approve',
    });

    expect(outcome).toEqual({ kind: 'resolved', decision: 'approve', alreadyResolved: false });
  });

  test('preserves the already-resolved flag so a retry is not reported as a fresh decision', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 200,
      payload: { ok: true, decision: 'approve', learningPromoted: true, alreadyResolved: true },
      feedbackId: 41,
      decision: 'approve',
    });

    expect(outcome).toEqual({ kind: 'resolved', decision: 'approve', alreadyResolved: true });
  });

  test('treats a rejection as resolved without requiring learningPromoted', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 200,
      payload: { ok: true, decision: 'reject', learningPromoted: false, alreadyResolved: false },
      feedbackId: 41,
      decision: 'reject',
    });

    expect(outcome).toEqual({ kind: 'resolved', decision: 'reject', alreadyResolved: false });
  });

  // The endpoint returns 503 + retryable when the review committed but durable
  // learning promotion did not. Collapsing this into a generic failure would
  // strand the signal with no way for the reviewer to finish it.
  test('classifies a recorded-but-unpromoted approval as retry_required', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 503,
      payload: {
        ok: false,
        decision: 'approve',
        learningPromoted: false,
        retryable: true,
        error: 'The review was recorded, but durable learning promotion must be retried.',
      },
      feedbackId: 41,
      decision: 'approve',
    });

    expect(outcome).toEqual({
      kind: 'retry_required',
      message: 'The review was recorded, but durable learning promotion must be retried.',
    });
  });

  test('still reports retry_required when the 503 body carries no error text', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 503,
      payload: { ok: false, retryable: true },
      feedbackId: 41,
      decision: 'approve',
    });

    expect(outcome.kind).toBe('retry_required');
    expect(outcome.kind === 'retry_required' && outcome.message).toContain('must be retried');
  });

  test('does not treat a non-retryable 503 as retry_required', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 503,
      payload: { ok: false, error: 'SHADOW runtime unavailable' },
      feedbackId: 41,
      decision: 'approve',
    });

    expect(outcome).toEqual({ kind: 'failed', message: 'SHADOW runtime unavailable' });
  });

  test('classifies a hidden-not-found as not_eligible', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 404,
      payload: null,
      feedbackId: 41,
      decision: 'approve',
    });

    expect(outcome.kind).toBe('not_eligible');
    expect(outcome.kind === 'not_eligible' && outcome.message).toContain('#41');
  });

  test('surfaces a server error message verbatim instead of swallowing it', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 400,
      payload: { ok: false, error: 'feedbackId and a supported decision are required' },
      feedbackId: 41,
      decision: 'approve',
    });

    expect(outcome).toEqual({
      kind: 'failed',
      message: 'feedbackId and a supported decision are required',
    });
  });

  test('fails closed when the body is unparseable', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 500,
      payload: null,
      feedbackId: 41,
      decision: 'reject',
    });

    expect(outcome).toEqual({ kind: 'failed', message: 'Failed to reject feedback #41.' });
  });

  // A 200 with ok:false must never be read as success.
  test('fails closed on a 200 that does not confirm ok', () => {
    const outcome = interpretShadowFeedbackReviewResponse({
      status: 200,
      payload: { ok: false, error: 'unexpected' },
      feedbackId: 41,
      decision: 'approve',
    });

    expect(outcome).toEqual({ kind: 'failed', message: 'unexpected' });
  });
});
