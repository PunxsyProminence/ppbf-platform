import { query, queryOne } from './db';

export interface ShadowFeedbackInput {
  organizationId: string;
  accountId: string;
  role: string;
  shadowEventId?: number | null;
  recommendationRef?: string | null;
  helpful: boolean;
  rating?: number | null;
  comment?: string | null;
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
  created_at: string;
}

export interface ShadowFeedbackSummary {
  total_responses: number;
  helpful_count: number;
  satisfaction_rate: number;
  avg_rating: number | null;
}

export async function recordShadowFeedback(input: ShadowFeedbackInput): Promise<{ feedbackId: number }> {
  const row = await queryOne<{ feedback_id: number }>(
    `INSERT INTO pilot.shadow_feedback (
       organization_id, account_id, role, shadow_event_id, recommendation_ref,
       helpful, rating, comment, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING feedback_id`,
    [
      input.organizationId,
      input.accountId,
      input.role,
      input.shadowEventId ?? null,
      input.recommendationRef ?? null,
      input.helpful,
      input.rating ?? null,
      input.comment ?? null,
    ],
  );

  if (!row) {
    throw new Error('Failed to record feedback');
  }

  return { feedbackId: row.feedback_id };
}

export async function getShadowFeedbackSummary(organizationId: string, days = 30): Promise<ShadowFeedbackSummary> {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('Invalid days');
  }

  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));

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
       AND created_at > NOW() - ($2::numeric * INTERVAL '1 day')`,
    [organizationId, safeDays],
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
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('Invalid limit');
  }

  const safeLimit = Math.max(1, Math.min(250, Math.floor(limit)));

  return query<ShadowFeedbackRow>(
    `SELECT feedback_id, organization_id, account_id, role, shadow_event_id,
            recommendation_ref, helpful, rating, comment, created_at
     FROM pilot.shadow_feedback
     WHERE organization_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [organizationId, safeLimit],
  );
}
