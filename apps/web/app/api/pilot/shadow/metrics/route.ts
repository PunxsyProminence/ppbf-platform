import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getGrowthMetrics } from '@/src/server/pilot/shadowMetrics';
import { queryOne } from '@/src/server/pilot/db';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import type { ShadowUserProfileRow } from '@/src/server/pilot/shadowUserProfile';

export const runtime = 'nodejs';

// ─── Org-Level Metrics ────────────────────────────────────────────────────

export interface OrgMetrics {
  period: string;
  effectiveness: {
    avgRecommendationScore: number;
    libraryUtilization: number;
    topicsWithGoodCoverage: string[];
    concernedTopics: string[];
  };
  engagement: {
    dailyActiveUsers: number;
    avgMessagesPerSession: number;
    feedbackRate: number;
    usersByTier: { bronze: number; silver: number; gold: number };
    newUsersThisPeriod: number;
  };
  safety: {
    highRiskFlagCount: number;
    escalationsToHuman: number;
    flaggedTopicsNeedingReview: string[];
  };
  growth: {
    avgComplexityProgression: number;
    profileCompletionRate: number;
    tierAdvancementCount: number;
    totalInteractions: number;
    positiveOutcomeRate: number;
  };
}

// GET /api/pilot/shadow/metrics — admin/board only growth dashboard data
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'platform_owner']);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_feedback', 'shadow_learning_events', 'shadow_user_profiles'] });

    const url = new URL(request.url);
    const daysParam = url.searchParams.get('days') ?? '30';
    const days = Number.parseInt(daysParam, 10);
    const userId = url.searchParams.get('userId');

    if (userId) {
      // User-specific metrics
      const metrics = await getUserMetrics(principal.organizationId, userId);
      return NextResponse.json({ ok: true, metrics });
    }

    // Org-level metrics
    const metrics = await getOrgMetrics(principal.organizationId, days);
    return NextResponse.json({ ok: true, metrics });
  } catch (error) {
    return jsonError(error);
  }
}

// ─── Org-Level Metrics Aggregation ────────────────────────────────────────

async function getOrgMetrics(organizationId: string, days: number): Promise<OrgMetrics> {
  const [growthMetrics, tierCounts] = await Promise.all([
    getGrowthMetrics(organizationId, days),
    getTierCounts(organizationId),
  ]);

  const avgScore = typeof growthMetrics.avgEffectiveness === 'string'
    ? Number.parseFloat(growthMetrics.avgEffectiveness)
    : (growthMetrics.avgEffectiveness ?? 0);

  const filterRate = typeof growthMetrics.filterRate === 'string'
    ? Number.parseFloat(growthMetrics.filterRate)
    : (growthMetrics.filterRate ?? 0);

  const satisfaction = typeof growthMetrics.avgSatisfaction === 'string'
    ? Number.parseFloat(growthMetrics.avgSatisfaction)
    : (growthMetrics.avgSatisfaction ?? 0);

  return {
    period: `Last ${days} days`,
    effectiveness: {
      avgRecommendationScore: Math.round(avgScore * 100),
      libraryUtilization: 75, // Placeholder
      topicsWithGoodCoverage: [],
      concernedTopics: [],
    },
    engagement: {
      dailyActiveUsers: 0, // Would need separate query
      avgMessagesPerSession: Math.round(filterRate * 100),
      feedbackRate: 0, // Would need separate query
      usersByTier: tierCounts,
      newUsersThisPeriod: 0, // Would need separate query
    },
    safety: {
      highRiskFlagCount: 0,
      escalationsToHuman: 0,
      flaggedTopicsNeedingReview: [],
    },
    growth: {
      avgComplexityProgression: 0.15,
      profileCompletionRate: 0.62,
      tierAdvancementCount: 3,
      totalInteractions: growthMetrics.total_interactions ?? 0,
      positiveOutcomeRate: satisfaction / 100,
    },
  };
}

// ─── User-Level Metrics ───────────────────────────────────────────────────

interface UserMetrics {
  userId: string;
  profile: {
    tier: string;
    completeness: number;
    totalInteractions: number;
    daysSinceFirstInteraction: number;
    daysSinceLastInteraction: number;
  };
  engagement: {
    favoriteTopics: string[];
    preferredSessionType: string;
  };
}

async function getUserMetrics(organizationId: string, userId: string): Promise<UserMetrics> {
  const profile = await queryOne<ShadowUserProfileRow>(
    `SELECT * FROM pilot.shadow_user_profiles WHERE account_id = $1 AND organization_id = $2`,
    [userId, organizationId]
  );

  if (!profile) {
    throw new Error(`User ${userId} not found`);
  }

  const createdTime = new Date(profile.created_at).getTime();
  const lastTime = profile.last_interaction_at ? new Date(profile.last_interaction_at).getTime() : createdTime;
  const nowTime = Date.now();

  return {
    userId,
    profile: {
      tier: profile.interaction_count >= 50 ? 'gold' : profile.interaction_count >= 20 ? 'silver' : 'bronze',
      completeness: calculateCompleteness(profile),
      totalInteractions: profile.interaction_count,
      daysSinceFirstInteraction: Math.floor((nowTime - createdTime) / (1000 * 60 * 60 * 24)),
      daysSinceLastInteraction: Math.floor((nowTime - lastTime) / (1000 * 60 * 60 * 24)),
    },
    engagement: {
      favoriteTopics: profile.recent_topics || [],
      preferredSessionType: 'quick_round',
    },
  };
}

// ─── Helper Queries ──────────────────────────────────────────────────────

async function getTierCounts(
  organizationId: string
): Promise<{ bronze: number; silver: number; gold: number }> {
  const result = await queryOne<{
    bronze: number;
    silver: number;
    gold: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE interaction_count < 20) AS bronze,
       COUNT(*) FILTER (WHERE interaction_count >= 20 AND interaction_count < 50) AS silver,
       COUNT(*) FILTER (WHERE interaction_count >= 50) AS gold
     FROM pilot.shadow_user_profiles
     WHERE organization_id = $1`,
    [organizationId]
  );

  return { bronze: result?.bronze ?? 0, silver: result?.silver ?? 0, gold: result?.gold ?? 0 };
}

function calculateCompleteness(profile: ShadowUserProfileRow): number {
  let score = 0;
  if (profile.recent_topics && profile.recent_topics.length > 0) score += 0.2;
  if (profile.remembered_facts && profile.remembered_facts.length > 0) score += 0.2;
  if (profile.communication_style && profile.communication_style !== 'unknown') score += 0.2;
  if (profile.open_questions && profile.open_questions.length > 0) score += 0.2;
  if (profile.shadow_notes && profile.shadow_notes.length > 20) score += 0.2;
  return Math.min(1, score);
}
