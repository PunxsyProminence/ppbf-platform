import { query, queryOne } from './db';

export type RecommendationVerificationState = 'unverified' | 'durable_client' | 'human_reviewed';

export interface RecommendationEffectivenessInput {
  organizationId: string;
  userId: string;
  // What kind of recommendation this outcome grades (e.g. the session type
  // that produced it). This used to be the ACTOR ROLE, silently written into
  // the NOT NULL recommendation_type column -- any future query grouping by
  // recommendation type would have bucketed by coach/athlete instead.
  recommendationType: string;
  feedbackId?: number | null;
  recommendationId?: string;
  outcome: 'improved' | 'neutral' | 'degraded' | 'unknown';
  effectivenessScore?: number | null;
  verificationState: RecommendationVerificationState;
  humanReviewRequired: boolean;
}

export interface GrowthMetrics {
  period: string;
  totalInteractions: number;
  avgSatisfaction: number | null;
  avgEffectiveness: number | null;
  // Renamed from recommendationsMade: the count is COUNT(*) of human-reviewed
  // effectiveness rows -- reviewed outcomes -- and was rendered as
  // "Recommendations", implying SHADOW's output volume when it is the review
  // throughput.
  reviewedOutcomes: number;
  researchRequirementsCreated: number;
  researchRequirementsClosed: number;
  newLibraryPatterns: number;
  filterRate: number | null;
  positiveOutcomeRate: number | null;
  unavailableReasons: Record<string, string>;
}

export async function recordRecommendationEffectiveness(
  data: RecommendationEffectivenessInput,
): Promise<void> {
  const outcomeToScore: Record<RecommendationEffectivenessInput['outcome'], number | null> = {
    improved: 1,
    neutral: 0.5,
    degraded: 0,
    unknown: null,
  };
  const score = data.effectivenessScore ?? outcomeToScore[data.outcome];
  if (score != null && (!Number.isFinite(score) || score < 0 || score > 1)) {
    throw new Error('Effectiveness score must be between 0 and 1');
  }

  await query(
    `INSERT INTO pilot.shadow_recommendation_effectiveness
       (organization_id, account_id, feedback_id, recommendation_id,
        recommendation_type, outcome, effectiveness_score,
        verification_state, human_review_required, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (feedback_id)
     DO UPDATE SET
       outcome = CASE
         WHEN pilot.shadow_recommendation_effectiveness.verification_state = 'human_reviewed'
          AND EXCLUDED.verification_state <> 'human_reviewed'
         THEN pilot.shadow_recommendation_effectiveness.outcome
         ELSE EXCLUDED.outcome
       END,
       effectiveness_score = CASE
         WHEN pilot.shadow_recommendation_effectiveness.verification_state = 'human_reviewed'
          AND EXCLUDED.verification_state <> 'human_reviewed'
         THEN pilot.shadow_recommendation_effectiveness.effectiveness_score
         ELSE EXCLUDED.effectiveness_score
       END,
       verification_state = CASE
         WHEN pilot.shadow_recommendation_effectiveness.verification_state = 'human_reviewed'
         THEN 'human_reviewed'
         ELSE EXCLUDED.verification_state
       END,
       human_review_required = CASE
         WHEN pilot.shadow_recommendation_effectiveness.verification_state = 'human_reviewed'
         THEN pilot.shadow_recommendation_effectiveness.human_review_required
         ELSE EXCLUDED.human_review_required
       END,
       -- Every read of this table windows human_reviewed rows on created_at,
       -- but created_at was stamped at FEEDBACK time and never refreshed --
       -- so approving feedback older than the dashboard window silently
       -- excluded it from every counter, in this window and all later ones.
       -- The reviewed outcome materially comes into existence at approval,
       -- so the row is restamped the first time it reaches human_reviewed.
       created_at = CASE
         WHEN pilot.shadow_recommendation_effectiveness.verification_state <> 'human_reviewed'
          AND EXCLUDED.verification_state = 'human_reviewed'
         THEN NOW()
         ELSE pilot.shadow_recommendation_effectiveness.created_at
       END`,
    [
      data.organizationId,
      data.userId,
      data.feedbackId ?? null,
      data.recommendationId || null,
      data.recommendationType,
      data.outcome,
      score,
      data.verificationState,
      data.humanReviewRequired,
    ],
  );
}

export async function getGrowthMetrics(
  organizationId: string,
  days = 30,
): Promise<GrowthMetrics> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));

  const row = await queryOne<{
    total_interactions: string;
    filtered_interactions: string;
    avg_satisfaction: string | null;
    avg_effectiveness: string | null;
    positive_outcomes: string;
    reviewed_outcomes: string;
    research_created: string;
    research_closed: string;
    new_patterns: string;
  }>(
    `SELECT
       COUNT(*) AS total_interactions,
       COUNT(*) FILTER (WHERE was_filtered) AS filtered_interactions,
       (SELECT AVG(rating)
        FROM pilot.shadow_feedback
        WHERE organization_id = $1
          AND verification_state IN ('durable_client', 'human_reviewed')
          AND correlation_type = 'shadow_message'
          AND correlation_id IS NOT NULL
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS avg_satisfaction,
       (SELECT AVG(effectiveness_score)
        FROM pilot.shadow_recommendation_effectiveness
        WHERE organization_id = $1
          AND verification_state = 'human_reviewed'
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS avg_effectiveness,
       (SELECT COUNT(*)
        FROM pilot.shadow_recommendation_effectiveness
        WHERE organization_id = $1
          AND verification_state = 'human_reviewed'
          AND outcome = 'improved'
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS positive_outcomes,
       (SELECT COUNT(*)
        FROM pilot.shadow_recommendation_effectiveness
        WHERE organization_id = $1
          AND verification_state = 'human_reviewed'
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS reviewed_outcomes,
       (SELECT COUNT(*)
        FROM pilot.shadow_research_requirements
        WHERE organization_id = $1
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS research_created,
       (SELECT COUNT(*)
        FROM pilot.shadow_research_requirements
        WHERE organization_id = $1
          AND status = 'resolved'
          AND resolved_at > NOW() - ($2 * INTERVAL '1 day')) AS research_closed,
       (SELECT COUNT(*)
        FROM pilot.shadow_library_sources
        WHERE organization_id = $1
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS new_patterns
     FROM pilot.shadow_chat_audit
     WHERE organization_id = $1
       AND created_at > NOW() - ($2 * INTERVAL '1 day')`,
    [organizationId, safeDays],
  );

  const totalInteractions = Number.parseInt(row?.total_interactions ?? '0', 10);
  const filteredInteractions = Number.parseInt(row?.filtered_interactions ?? '0', 10);
  const reviewedOutcomes = Number.parseInt(row?.reviewed_outcomes ?? '0', 10);
  const positiveOutcomes = Number.parseInt(row?.positive_outcomes ?? '0', 10);
  const avgEffectiveness =
    row?.avg_effectiveness != null ? Number.parseFloat(row.avg_effectiveness) : null;
  const unavailableReasons: Record<string, string> = {};
  if (totalInteractions === 0) {
    unavailableReasons.filterRate = 'NO_CHAT_INTERACTIONS_IN_PERIOD';
  }
  if (avgEffectiveness == null) {
    unavailableReasons.avgEffectiveness = 'NO_HUMAN_REVIEWED_OUTCOMES_IN_PERIOD';
  }
  if (reviewedOutcomes === 0) {
    unavailableReasons.positiveOutcomeRate = 'NO_HUMAN_REVIEWED_OUTCOMES_IN_PERIOD';
  }
  // avg_satisfaction is AVG(rating), and no shipped client sends a rating --
  // the feedback UI is thumbs only. Without this reason code the tile
  // rendered a bare em dash indefinitely with nothing saying why.
  if (row?.avg_satisfaction == null) {
    unavailableReasons.avgSatisfaction = 'RATING_INPUT_NOT_BUILT';
  }

  return {
    period: `Last ${safeDays} days`,
    totalInteractions,
    filterRate: totalInteractions > 0 ? filteredInteractions / totalInteractions : null,
    avgSatisfaction:
      row?.avg_satisfaction != null ? Number.parseFloat(row.avg_satisfaction) : null,
    avgEffectiveness,
    reviewedOutcomes,
    researchRequirementsCreated: Number.parseInt(row?.research_created ?? '0', 10),
    researchRequirementsClosed: Number.parseInt(row?.research_closed ?? '0', 10),
    newLibraryPatterns: Number.parseInt(row?.new_patterns ?? '0', 10),
    positiveOutcomeRate: reviewedOutcomes > 0 ? positiveOutcomes / reviewedOutcomes : null,
    unavailableReasons,
  };
}
