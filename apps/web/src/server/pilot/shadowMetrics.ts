import { query, queryOne } from './db';

export interface RecommendationEffectivenessInput {
  organizationId: string;
  userId: string;
  role: string;
  recommendationId?: string;
  outcome: 'improved' | 'neutral' | 'degraded' | 'unknown';
  effectivenessScore?: number;
}

export interface GrowthMetrics {
  period: string;
  totalInteractions: number;
  avgSatisfaction: number | null;
  avgEffectiveness: number | null;
  recommendationsMade: number;
  researchRequirementsCreated: number;
  researchRequirementsClosed: number;
  newLibraryPatterns: number;
  filterRate: number;
}

export async function recordRecommendationEffectiveness(
  data: RecommendationEffectivenessInput,
): Promise<void> {
  const outcomeToScore: Record<string, number> = {
    improved: 1.0,
    neutral:  0.5,
    degraded: 0.0,
    unknown:  0.5,
  };

  await query(
    `INSERT INTO pilot.shadow_recommendation_effectiveness
       (organization_id, recommendation_id, recommendation_type,
        outcome, effectiveness_score, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      data.organizationId,
      data.recommendationId || null,
      data.role,                                              // maps to recommendation_type
      data.outcome,
      data.effectivenessScore ?? outcomeToScore[data.outcome],
    ],
  );
}

export async function getGrowthMetrics(
  organizationId: string,
  days = 30,
): Promise<GrowthMetrics> {
  // Parameterized interval using integer days (safe from injection)
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));

  const row = await queryOne<{
    total_interactions: string;
    filter_rate: string;
    avg_satisfaction: string | null;
    avg_effectiveness: string | null;
    recommendations_made: string;
    research_created: string;
    research_closed: string;
    new_patterns: string;
  }>(
    `SELECT
       COUNT(*)                                               AS total_interactions,
       ROUND(AVG(CASE WHEN was_filtered THEN 1 ELSE 0 END)::numeric, 4)
                                                             AS filter_rate,
       (SELECT ROUND(AVG(rating)::numeric, 2)
        FROM   pilot.shadow_feedback
        WHERE  organization_id = $1
        AND    created_at > NOW() - ($2 || ' days')::INTERVAL) AS avg_satisfaction,
       (SELECT ROUND(AVG(effectiveness_score)::numeric, 2)
        FROM   pilot.shadow_recommendation_effectiveness
        WHERE  organization_id = $1
        AND    created_at > NOW() - ($2 || ' days')::INTERVAL) AS avg_effectiveness,
       (SELECT COUNT(*)
        FROM   pilot.shadow_recommendation_effectiveness
        WHERE  organization_id = $1
        AND    created_at > NOW() - ($2 || ' days')::INTERVAL) AS recommendations_made,
       (SELECT COUNT(*)
        FROM   pilot.shadow_research_requirements
        WHERE  organization_id = $1
        AND    created_at > NOW() - ($2 || ' days')::INTERVAL) AS research_created,
       (SELECT COUNT(*)
        FROM   pilot.shadow_research_requirements
        WHERE  organization_id = $1
        AND    status = 'closed'
        AND    closed_at > NOW() - ($2 || ' days')::INTERVAL) AS research_closed,
       (SELECT COUNT(*)
        FROM   pilot.shadow_library_sources
        WHERE  organization_id = $1
        AND    created_at > NOW() - ($2 || ' days')::INTERVAL) AS new_patterns
     FROM pilot.shadow_events
     WHERE organization_id = $1
       AND created_at > NOW() - ($2 || ' days')::INTERVAL`,
    [organizationId, String(safeDays)],
  );

  return {
    period:                     `Last ${safeDays} days`,
    totalInteractions:          parseInt(row?.total_interactions ?? '0', 10),
    filterRate:                 parseFloat(row?.filter_rate ?? '0'),
    avgSatisfaction:            row?.avg_satisfaction != null ? parseFloat(row.avg_satisfaction) : null,
    avgEffectiveness:           row?.avg_effectiveness != null ? parseFloat(row.avg_effectiveness) : null,
    recommendationsMade:        parseInt(row?.recommendations_made ?? '0', 10),
    researchRequirementsCreated:parseInt(row?.research_created ?? '0', 10),
    researchRequirementsClosed: parseInt(row?.research_closed ?? '0', 10),
    newLibraryPatterns:         parseInt(row?.new_patterns ?? '0', 10),
  };
}
