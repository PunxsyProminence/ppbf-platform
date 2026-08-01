import { query, queryOne } from './db';
import type { PilotRole } from './contracts';
import type { OutcomeSignal } from './shadowLearningLoop';

export interface ShadowFeedbackInput {
  organizationId: string;
  accountId: string;
  role: string;
  shadowEventId?: number | null;
  recommendationRef?: string | null;
  helpful: boolean;
  rating?: number | null;
  comment?: string | null;
  outcomeSignal?: string | null;
  correlationType?: 'shadow_message' | 'shadow_event' | null;
  correlationId?: string | null;
  verificationState?: FeedbackVerificationState;
  humanReviewRequired?: boolean;
}

export type FeedbackVerificationState = 'unverified' | 'durable_client' | 'human_reviewed';
export type ShadowFeedbackReviewDecision = 'approve' | 'reject';

export function normalizeShadowFeedbackId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function requireShadowFeedbackId(value: unknown): number {
  const feedbackId = normalizeShadowFeedbackId(value);
  if (feedbackId === null) {
    throw new Error('INVALID_SHADOW_FEEDBACK_ID');
  }
  return feedbackId;
}

export interface ShadowFeedbackReviewContext {
  feedbackId: number;
  organizationId: string;
  accountId: string;
  role: PilotRole;
  messageId: string;
  topic: string;
  sessionType: string;
  outcomeSignal: OutcomeSignal;
  userNote: string | null;
  decision: ShadowFeedbackReviewDecision;
  alreadyResolved: boolean;
}

export interface ShadowFeedbackCorrelation {
  verified: boolean;
  learningEligible: boolean;
  correlationType: 'shadow_message' | 'shadow_event' | null;
  correlationId: string | null;
  messageId: string | null;
  shadowEventId: number | null;
  sessionType: string;
  topic: string;
  reason: string | null;
}

export interface ShadowFeedbackRow {
  feedback_id: number;
  organization_id: string;
  account_id: string;
  role: string;
  shadow_event_id: number | null;
  recommendation_ref: string | null;
  helpful: boolean;
  rating: number | null;
  comment: string | null;
  outcome_signal: string | null;
  correlation_type: string | null;
  correlation_id: string | null;
  verification_state: FeedbackVerificationState;
  human_review_required: boolean;
  created_at: string;
}

export interface ShadowFeedbackSummary {
  total_responses: number;
  helpful_count: number;
  satisfaction_rate: number;
  avg_rating: number | null;
}

export interface RecordedShadowFeedback {
  feedbackId: number;
  created: boolean;
  verificationState: FeedbackVerificationState;
  humanReviewRequired: boolean;
  outcomeSignal: OutcomeSignal;
  comment: string | null;
}

export async function recordShadowFeedback(input: ShadowFeedbackInput): Promise<RecordedShadowFeedback> {
  if (
    !input.correlationType
    || !input.correlationId
    || (input.verificationState !== 'durable_client' && input.verificationState !== 'human_reviewed')
  ) {
    throw new Error('DURABLE_FEEDBACK_CORRELATION_REQUIRED');
  }
  const row = await queryOne<{
    feedback_id: number | string;
    created: boolean;
    verification_state: FeedbackVerificationState;
    human_review_required: boolean;
    outcome_signal: OutcomeSignal;
    comment: string | null;
  }>(
    `INSERT INTO pilot.shadow_feedback (
       organization_id, account_id, role, shadow_event_id, recommendation_ref,
       helpful, rating, comment, outcome_signal, correlation_type,
       correlation_id, verification_state, human_review_required, created_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13, NOW()
     )
     ON CONFLICT (organization_id, account_id, correlation_id)
       WHERE correlation_type = 'shadow_message' AND correlation_id IS NOT NULL
     DO UPDATE SET
       -- Editable until reviewed (owner decision 2026-07-31). The old no-op
       -- here meant a corrected thumbs-up silently changed nothing while the
       -- route returned ok:true. A rating still awaiting review now takes the
       -- user's CURRENT judgment; once the review is resolved -- rejected or
       -- promoted -- the row is part of the learning audit trail and stays
       -- exactly what the reviewer saw.
       helpful = CASE
         WHEN pilot.shadow_feedback.verification_state = 'durable_client'
          AND pilot.shadow_feedback.human_review_required = true
         THEN EXCLUDED.helpful
         ELSE pilot.shadow_feedback.helpful
       END,
       rating = CASE
         WHEN pilot.shadow_feedback.verification_state = 'durable_client'
          AND pilot.shadow_feedback.human_review_required = true
         THEN EXCLUDED.rating
         ELSE pilot.shadow_feedback.rating
       END,
       comment = CASE
         WHEN pilot.shadow_feedback.verification_state = 'durable_client'
          AND pilot.shadow_feedback.human_review_required = true
         THEN EXCLUDED.comment
         ELSE pilot.shadow_feedback.comment
       END,
       outcome_signal = CASE
         WHEN pilot.shadow_feedback.verification_state = 'durable_client'
          AND pilot.shadow_feedback.human_review_required = true
         THEN EXCLUDED.outcome_signal
         ELSE pilot.shadow_feedback.outcome_signal
       END
     RETURNING
       feedback_id,
       (xmax = 0) AS created,
       verification_state,
       human_review_required,
       outcome_signal,
       comment`,
    [
      input.organizationId,
      input.accountId,
      input.role,
      input.shadowEventId ?? null,
      input.recommendationRef ?? null,
      input.helpful,
      input.rating ?? null,
      input.comment ?? null,
      input.outcomeSignal ?? null,
      input.correlationType ?? null,
      input.correlationId ?? null,
      input.verificationState ?? 'unverified',
      input.humanReviewRequired ?? true,
    ],
  );

  if (!row) {
    throw new Error('Failed to record feedback');
  }

  return {
    feedbackId: requireShadowFeedbackId(row.feedback_id),
    created: row.created,
    verificationState: row.verification_state,
    humanReviewRequired: row.human_review_required,
    outcomeSignal: row.outcome_signal,
    comment: row.comment,
  };
}

export async function verifyShadowFeedbackCorrelation(input: {
  organizationId: string;
  accountId: string;
  messageId?: string | null;
  shadowEventId?: number | null;
}): Promise<ShadowFeedbackCorrelation> {
  if (input.messageId) {
    const message = await queryOne<{
      message_id: string;
      response_state: 'ok' | 'filtered' | null;
      session_type: string;
      topic: string;
    }>(
      `SELECT m.message_id, m.response_state, m.session_type, m.topic
       FROM pilot.shadow_chat_messages m
       JOIN pilot.shadow_chat_sessions s
         ON s.conversation_id = m.conversation_id
        AND s.organization_id = m.organization_id
        AND s.account_id = m.account_id
       WHERE m.message_id = $1
         AND m.organization_id = $2
         AND m.account_id = $3
         AND m.role = 'assistant'
         AND s.deleted_at IS NULL`,
      [input.messageId, input.organizationId, input.accountId],
    );

    if (message) {
      return {
        verified: true,
        learningEligible: message.response_state === 'ok',
        correlationType: 'shadow_message',
        correlationId: message.message_id,
        messageId: message.message_id,
        shadowEventId: null,
        sessionType: message.session_type,
        topic: message.topic,
        reason: message.response_state === 'ok' ? null : 'FILTERED_RESPONSE_NOT_LEARNING_ELIGIBLE',
      };
    }
  }

  if (input.shadowEventId != null && Number.isSafeInteger(input.shadowEventId) && input.shadowEventId > 0) {
    const event = await queryOne<{
      shadow_event_id: number;
      event_name: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT shadow_event_id, event_name, payload
       FROM pilot.shadow_events
       WHERE shadow_event_id = $1
         AND organization_id = $2
         AND actor_account_id = $3`,
      [input.shadowEventId, input.organizationId, input.accountId],
    );

    if (event) {
      const filtered = event.payload?.filtered === true;
      const isChatResponse = event.event_name === 'shadow_chat_response';
      return {
        verified: true,
        learningEligible: isChatResponse && !filtered,
        correlationType: 'shadow_event',
        correlationId: String(event.shadow_event_id),
        messageId: null,
        shadowEventId: event.shadow_event_id,
        sessionType: typeof event.payload?.sessionType === 'string' ? event.payload.sessionType : 'quick_round',
        topic: typeof event.payload?.topic === 'string' ? event.payload.topic : 'general',
        reason: !isChatResponse
          ? 'EVENT_NOT_A_CHAT_RESPONSE'
          : filtered
            ? 'FILTERED_RESPONSE_NOT_LEARNING_ELIGIBLE'
            : null,
      };
    }
  }

  return {
    verified: false,
    learningEligible: false,
    correlationType: null,
    correlationId: null,
    messageId: null,
    shadowEventId: null,
    sessionType: 'quick_round',
    topic: 'general',
    reason: 'DURABLE_CORRELATION_REQUIRED',
  };
}

/**
 * Resolve a feedback review from durable server-owned records.
 *
 * The client supplies only a feedback id and a decision. Every field used by
 * the learning loop is reloaded by this organization-scoped statement from
 * the feedback row and its exact durable assistant message. The conditional
 * update also makes retries idempotent while preventing a later request from
 * reversing an already-recorded decision.
 *
 * Returns 'reject_only' when the feedback exists but its answer was filtered
 * or its conversation was deleted: such feedback can be rejected (clearing it
 * from the queue) but never approved, because learning must not be promoted
 * from a filtered answer or an erased conversation.
 */
export async function resolveShadowFeedbackReview(input: {
  organizationId: string;
  feedbackId: number;
  reviewerAccountId: string;
  decision: ShadowFeedbackReviewDecision;
}): Promise<ShadowFeedbackReviewContext | 'reject_only' | null> {
  const row = await queryOne<{
    feedback_id: number | string;
    organization_id: string;
    account_id: string;
    role: PilotRole;
    message_id: string;
    topic: string;
    session_type: string;
    outcome_signal: OutcomeSignal;
    user_note: string | null;
    already_resolved: boolean;
  }>(
    `WITH scoped_feedback AS (
       SELECT
         f.feedback_id,
         f.organization_id,
         f.account_id,
         f.role,
         f.outcome_signal,
         f.comment AS user_note,
         f.verification_state,
         f.human_review_required,
         m.message_id,
         m.topic,
         m.session_type,
         -- Learning may only be promoted from an unfiltered answer in a live
         -- session, but that is an APPROVE gate, not an existence gate. When
         -- these two conditions lived in the joins, feedback on a filtered
         -- answer (or a later-deleted session) matched nothing at all -- so
         -- Approve AND Reject both 404ed and the item sat in the review
         -- queue forever, silently capping every learning counter behind it.
         (m.response_state = 'ok' AND s.deleted_at IS NULL) AS learning_eligible
       FROM pilot.shadow_feedback f
       JOIN pilot.shadow_chat_messages m
         ON m.message_id::text = f.correlation_id
        AND m.organization_id = f.organization_id
        AND m.account_id = f.account_id
        AND m.role = 'assistant'
       JOIN pilot.shadow_chat_sessions s
         ON s.conversation_id = m.conversation_id
        AND s.organization_id = m.organization_id
        AND s.account_id = m.account_id
       WHERE f.feedback_id = $1
         AND f.organization_id = $2
         AND f.correlation_type = 'shadow_message'
         AND f.correlation_id IS NOT NULL
         AND f.role IN (
           'platform_owner', 'organization_admin', 'admin', 'coach',
           'athlete', 'parent', 'volunteer', 'staff'
         )
         AND f.outcome_signal IN (
           'thumbs_up', 'thumbs_down', 'followed_advice', 'ignored_advice',
           'asked_followup', 'session_ended', 'escalated_to_human'
         )
     ),
     resolved_feedback AS (
       UPDATE pilot.shadow_feedback f
       SET verification_state = CASE
             WHEN $3 = 'approve' THEN 'human_reviewed'
             ELSE 'durable_client'
           END,
           human_review_required = false,
           reviewed_by_account_id = COALESCE(f.reviewed_by_account_id, $4),
           reviewed_at = COALESCE(f.reviewed_at, NOW())
       FROM scoped_feedback scoped
       WHERE f.feedback_id = scoped.feedback_id
         AND f.organization_id = scoped.organization_id
         AND ($3 = 'reject' OR scoped.learning_eligible)
         AND (
           (
             scoped.human_review_required = true
             AND scoped.verification_state = 'durable_client'
           )
           OR (
             scoped.human_review_required = false
             AND (
               ($3 = 'approve' AND scoped.verification_state = 'human_reviewed')
               OR ($3 = 'reject' AND scoped.verification_state = 'durable_client')
             )
           )
         )
       RETURNING
         f.feedback_id,
         f.organization_id,
         f.account_id,
         f.role,
         scoped.message_id,
         scoped.topic,
         scoped.session_type,
         scoped.outcome_signal,
         scoped.user_note,
         NOT scoped.human_review_required AS already_resolved
     )
     SELECT
       feedback_id,
       organization_id,
       account_id,
       role,
       message_id,
       topic,
       session_type,
       outcome_signal,
       user_note,
       already_resolved
     FROM resolved_feedback`,
    [
      input.feedbackId,
      input.organizationId,
      input.decision,
      input.reviewerAccountId,
    ],
  );

  if (!row) {
    // An approve that matched nothing may be a reject-only item rather than
    // a missing one -- tell those apart so the reviewer gets an honest
    // "this can only be rejected" instead of an unexplained 404.
    if (input.decision === 'approve') {
      const rejectOnly = await queryOne<{ present: boolean }>(
        `SELECT true AS present
         FROM pilot.shadow_feedback f
         JOIN pilot.shadow_chat_messages m
           ON m.message_id::text = f.correlation_id
          AND m.organization_id = f.organization_id
          AND m.account_id = f.account_id
          AND m.role = 'assistant'
         JOIN pilot.shadow_chat_sessions s
           ON s.conversation_id = m.conversation_id
          AND s.organization_id = m.organization_id
          AND s.account_id = m.account_id
         WHERE f.feedback_id = $1
           AND f.organization_id = $2
           AND f.correlation_type = 'shadow_message'
           AND (m.response_state IS DISTINCT FROM 'ok' OR s.deleted_at IS NOT NULL)
         LIMIT 1`,
        [input.feedbackId, input.organizationId],
      );
      if (rejectOnly?.present === true) {
        return 'reject_only';
      }
    }
    return null;
  }

  return {
    feedbackId: requireShadowFeedbackId(row.feedback_id),
    organizationId: row.organization_id,
    accountId: row.account_id,
    role: row.role,
    messageId: row.message_id,
    topic: row.topic,
    sessionType: row.session_type,
    outcomeSignal: row.outcome_signal,
    userNote: row.user_note,
    decision: input.decision,
    alreadyResolved: row.already_resolved,
  };
}

export async function hasDurableHumanReviewedLearningEvent(input: {
  organizationId: string;
  feedbackId: number;
}): Promise<boolean> {
  const row = await queryOne<{ present: boolean }>(
    `SELECT true AS present
     FROM pilot.shadow_learning_events
     WHERE organization_id = $1
       AND feedback_id = $2
       AND verification_state = 'human_reviewed'
     LIMIT 1`,
    [input.organizationId, input.feedbackId],
  );
  return row?.present === true;
}

export async function getShadowFeedbackSummary(organizationId: string, days = 30): Promise<ShadowFeedbackSummary> {
  const row = await queryOne<{
    total_responses: string;
    helpful_count: string;
    avg_rating: string | null;
  }>(
    `SELECT
       COUNT(*) AS total_responses,
       COUNT(*) FILTER (WHERE helpful = true) AS helpful_count,
       AVG(rating) AS avg_rating
     FROM pilot.shadow_feedback
     WHERE organization_id = $1
       AND verification_state IN ('durable_client', 'human_reviewed')
       AND correlation_type = 'shadow_message'
       AND correlation_id IS NOT NULL
       AND created_at > NOW() - ($2 || ' days')::INTERVAL`,
    [organizationId, String(days)],
  );

  const total = parseInt(row?.total_responses ?? '0', 10);
  const helpful = parseInt(row?.helpful_count ?? '0', 10);

  return {
    total_responses: total,
    helpful_count: helpful,
    satisfaction_rate: total > 0 ? helpful / total : 0,
    avg_rating: row?.avg_rating != null ? parseFloat(row.avg_rating) : null,
  };
}

export async function listShadowFeedback(organizationId: string, limit = 50): Promise<ShadowFeedbackRow[]> {
  const rows = await query<Omit<ShadowFeedbackRow, 'feedback_id'> & {
    feedback_id: number | string;
  }>(
    `SELECT feedback_id, organization_id, account_id, role, shadow_event_id,
            recommendation_ref, helpful, rating, comment, outcome_signal,
            correlation_type, correlation_id, verification_state,
            human_review_required, created_at
     FROM pilot.shadow_feedback
     WHERE organization_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [organizationId, limit],
  );
  return rows.map((row) => ({
    ...row,
    feedback_id: requireShadowFeedbackId(row.feedback_id),
  }));
}
