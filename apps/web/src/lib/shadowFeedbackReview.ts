/**
 * Decision logic for the SHADOW learning-loop human review gate.
 *
 * SHADOW feedback is recorded at `verification_state = 'durable_client'` and is
 * deliberately never learned from until a human approves it. Approval happens
 * through PATCH /api/pilot/shadow/feedback, which is the only caller of
 * `processLearningSignal`.
 *
 * The PATCH endpoint has four materially different outcomes, and the reviewer
 * must be able to tell them apart — a recorded-but-unpromoted review that looks
 * like a success would silently drop a learning signal. This module keeps that
 * branching pure so it can be unit tested without a browser environment.
 */

export interface ShadowFeedbackReviewItem {
  feedback_id: number;
  correlation_type: string | null;
  human_review_required: boolean;
}

export interface ShadowFeedbackReviewPayload {
  ok?: boolean;
  decision?: 'approve' | 'reject';
  learningPromoted?: boolean;
  alreadyResolved?: boolean;
  retryable?: boolean;
  error?: string;
}

export type ShadowFeedbackReviewOutcome =
  /** Decision recorded, and (for approvals) learning durably promoted. */
  | { kind: 'resolved'; decision: 'approve' | 'reject'; alreadyResolved: boolean }
  /** Decision recorded, but downstream learning promotion must be retried. */
  | { kind: 'retry_required'; message: string }
  /** No durable record could be resolved for this feedback id. */
  | { kind: 'not_eligible'; message: string }
  /** Anything else — surfaced verbatim rather than swallowed. */
  | { kind: 'failed'; message: string };

/**
 * Only feedback correlated to a durable assistant message can be resolved:
 * `resolveShadowFeedbackReview` joins `pilot.shadow_chat_messages` on
 * `correlation_type = 'shadow_message'`, so any other correlation type is
 * guaranteed to 404. Offering a button for those would be a dead control.
 */
export function isShadowFeedbackResolvable(item: ShadowFeedbackReviewItem): boolean {
  return item.correlation_type === 'shadow_message';
}

/** The review queue is exactly the feedback still flagged for human review. */
export function selectShadowFeedbackReviewQueue<T extends ShadowFeedbackReviewItem>(items: readonly T[]): T[] {
  return items.filter((item) => item.human_review_required);
}

/**
 * Classify a PATCH response so the caller can react to each outcome distinctly.
 *
 * `status` is the HTTP status and `payload` the parsed JSON body (null when the
 * body was absent or unparseable).
 */
export function interpretShadowFeedbackReviewResponse(input: {
  status: number;
  payload: ShadowFeedbackReviewPayload | null;
  feedbackId: number;
  decision: 'approve' | 'reject';
}): ShadowFeedbackReviewOutcome {
  const { status, payload, feedbackId, decision } = input;

  // Checked before the generic failure branch: a 503 here means the review was
  // committed and only the promotion step failed, so it must stay actionable.
  if (status === 503 && payload?.retryable === true) {
    return {
      kind: 'retry_required',
      message: payload.error
        || `Feedback #${feedbackId} review was recorded, but durable learning promotion must be retried.`,
    };
  }

  if (status === 404) {
    return {
      kind: 'not_eligible',
      message: `Feedback #${feedbackId} is no longer eligible for review — its durable SHADOW message could not be resolved.`,
    };
  }

  if (status < 200 || status >= 300 || payload?.ok !== true) {
    return {
      kind: 'failed',
      message: payload?.error || `Failed to ${decision} feedback #${feedbackId}.`,
    };
  }

  return {
    kind: 'resolved',
    decision: payload.decision ?? decision,
    alreadyResolved: payload.alreadyResolved === true,
  };
}
