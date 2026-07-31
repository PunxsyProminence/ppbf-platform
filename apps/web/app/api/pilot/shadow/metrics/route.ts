import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { query, queryOne } from '@/src/server/pilot/db';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import { getGrowthMetrics } from '@/src/server/pilot/shadowMetrics';
import { calculateProfileCompleteness, classifyProfileTier } from '@/src/server/pilot/shadowProfiling';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import type { ShadowUserProfileRow } from '@/src/server/pilot/shadowUserProfile';
import { evaluateShadowUnlockState } from '@/src/server/pilot/shadowUnlocks';

export const runtime = 'nodejs';

interface Availability {
  unavailableReasons: Record<string, string>;
}

export interface OrgMetrics {
  period: string;
  effectiveness: Availability & {
    avgRecommendationScore: number | null;
    libraryUtilization: number | null;
    topicsWithGoodCoverage: string[];
    concernedTopics: string[];
  };
  engagement: Availability & {
    dailyActiveUsers: number;
    avgMessagesPerSession: number | null;
    feedbackRate: number | null;
    usersByTier: { bronze: number; silver: number; gold: number };
    newUsersThisPeriod: number;
  };
  safety: Availability & {
    highRiskFlagCount: number;
    escalationsToHuman: number;
    flaggedTopicsNeedingReview: string[];
  };
  growth: Availability & {
    avgComplexityProgression: number | null;
    profileCompletionRate: number | null;
    tierAdvancementCount: number | null;
    totalInteractions: number;
    positiveOutcomeRate: number | null;
    // Rendered by the admin console's SHADOW Intelligence panel. These lived
    // in getGrowthMetrics all along, but the OrgMetrics restructure stopped
    // exposing them and the panel silently blanked (audit AS-1) -- the panel
    // now binds to this interface by import, so a future shape change is a
    // compile error there instead of a NaN tile.
    filterRate: number | null;
    avgSatisfaction: number | null;
    reviewedOutcomes: number;
    researchRequirementsCreated: number;
    researchRequirementsClosed: number;
    newLibraryPatterns: number;
  };
  // Named viewerUnlocks because the counters behind unlock state are
  // PER-USER (user_high_quality_interactions), evaluated for the requesting
  // account -- two admins opening the same org dashboard legitimately see
  // different values. The old name "unlocks" presented the viewer's own
  // progress as an organization fact.
  viewerUnlocks: {
    strongPersonalization: boolean;
    autoLibraryUpdates: boolean;
    aggressiveResearchGeneration: boolean;
    fineTuningPipelineReady: boolean;
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'platform_owner']);
    await assertShadowRuntimeReadiness({
      requiredTables: [
        'shadow_feedback',
        'shadow_learning_events',
        'shadow_user_profiles',
        'shadow_recommendation_effectiveness',
        'shadow_research_requirements',
        'shadow_library_review_flags',
        'shadow_chat_sessions',
        'shadow_chat_messages',
        'shadow_human_review_queue',
      ],
    });

    const url = new URL(request.url);
    const days = parseSafeLimit(url.searchParams.get('days'), 30, 365);
    if (days === null) {
      return NextResponse.json({ ok: false, error: 'Invalid days' }, { status: 400 });
    }
    const userId = url.searchParams.get('userId');

    if (userId) {
      if (
        principal.role === 'platform_owner'
        || !userId.trim()
        || userId.length > 200
      ) {
        return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
      }
      const activeOrganizationAccount = await queryOne<{ account_id: string }>(
        `SELECT a.account_id
         FROM pilot.accounts a
         JOIN pilot.organization_memberships m
           ON m.account_id = a.account_id
          AND m.organization_id = $2
          AND m.active_flag = true
         WHERE a.account_id = $1
           AND a.active_flag = true
         LIMIT 1`,
        [userId, principal.organizationId],
      );
      if (!activeOrganizationAccount) {
        return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
      }
      const metrics = await getUserMetrics(principal.organizationId, userId);
      return NextResponse.json({ ok: true, metrics });
    }

    const metrics = await getOrgMetrics(principal.organizationId, principal.accountId, days);
    return NextResponse.json({ ok: true, metrics });
  } catch (error) {
    if (error instanceof Error && error.message === 'SHADOW_PROFILE_NOT_FOUND') {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }
    return jsonError(error);
  }
}

async function getOrgMetrics(
  organizationId: string,
  accountId: string,
  days: number,
): Promise<OrgMetrics> {
  const [growthMetrics, tierCounts, operational, concernedTopics, unlockState] = await Promise.all([
    getGrowthMetrics(organizationId, days),
    getTierCounts(organizationId),
    getOperationalMetrics(organizationId, days),
    getConcernedTopics(organizationId),
    evaluateShadowUnlockState({ organizationId, accountId }).catch(() => null),
  ]);

  return {
    period: growthMetrics.period,
    effectiveness: {
      avgRecommendationScore:
        growthMetrics.avgEffectiveness == null
          ? null
          : Math.round(growthMetrics.avgEffectiveness * 100),
      libraryUtilization: null,
      topicsWithGoodCoverage: [],
      concernedTopics,
      unavailableReasons: {
        ...(
          growthMetrics.avgEffectiveness == null
            ? { avgRecommendationScore: 'NO_HUMAN_REVIEWED_OUTCOMES_IN_PERIOD' }
            : {}
        ),
        libraryUtilization: 'LIBRARY_USAGE_EVENTS_NOT_AVAILABLE',
        topicsWithGoodCoverage: 'COVERAGE_THRESHOLD_NOT_DEFINED',
      },
    },
    engagement: {
      dailyActiveUsers: operational.dailyActiveUsers,
      avgMessagesPerSession: operational.avgMessagesPerSession,
      feedbackRate:
        growthMetrics.totalInteractions > 0
          ? operational.feedbackCount / growthMetrics.totalInteractions
          : null,
      usersByTier: tierCounts,
      newUsersThisPeriod: operational.newUsers,
      unavailableReasons: {
        ...(operational.avgMessagesPerSession == null
          ? { avgMessagesPerSession: 'NO_DURABLE_CONVERSATIONS_IN_PERIOD' }
          : {}),
        ...(growthMetrics.totalInteractions === 0
          ? { feedbackRate: 'NO_CHAT_INTERACTIONS_IN_PERIOD' }
          : {}),
      },
    },
    safety: {
      highRiskFlagCount: operational.highRiskReviews,
      escalationsToHuman: operational.escalations,
      flaggedTopicsNeedingReview: concernedTopics,
      unavailableReasons: {},
    },
    growth: {
      avgComplexityProgression: null,
      profileCompletionRate: operational.avgProfileCompleteness,
      tierAdvancementCount: null,
      totalInteractions: growthMetrics.totalInteractions,
      positiveOutcomeRate: growthMetrics.positiveOutcomeRate,
      filterRate: growthMetrics.filterRate,
      avgSatisfaction: growthMetrics.avgSatisfaction,
      reviewedOutcomes: growthMetrics.reviewedOutcomes,
      researchRequirementsCreated: growthMetrics.researchRequirementsCreated,
      researchRequirementsClosed: growthMetrics.researchRequirementsClosed,
      newLibraryPatterns: growthMetrics.newLibraryPatterns,
      unavailableReasons: {
        avgComplexityProgression: 'COMPLEXITY_HISTORY_NOT_STORED',
        tierAdvancementCount: 'TIER_TRANSITION_HISTORY_NOT_STORED',
        ...growthMetrics.unavailableReasons,
        ...(operational.avgProfileCompleteness == null
          ? { profileCompletionRate: 'NO_PERSONAL_SHADOW_PROFILES' }
          : {}),
      },
    },
    viewerUnlocks: {
      strongPersonalization:
        unlockState?.features.strong_personalization?.unlocked ?? false,
      autoLibraryUpdates:
        unlockState?.features.auto_library_updates?.unlocked ?? false,
      aggressiveResearchGeneration:
        unlockState?.features.aggressive_research_generation?.unlocked ?? false,
      fineTuningPipelineReady:
        unlockState?.features.fine_tuning_pipeline?.unlocked ?? false,
    },
  };
}

async function getOperationalMetrics(organizationId: string, days: number): Promise<{
  dailyActiveUsers: number;
  feedbackCount: number;
  newUsers: number;
  avgMessagesPerSession: number | null;
  highRiskReviews: number;
  escalations: number;
  avgProfileCompleteness: number | null;
}> {
  const row = await queryOne<{
    daily_active_users: string;
    feedback_count: string;
    new_users: string;
    avg_messages_per_session: string | null;
    high_risk_reviews: string;
    escalations: string;
    avg_profile_completeness: string | null;
  }>(
    `SELECT
       (SELECT COUNT(DISTINCT user_id)
        FROM pilot.shadow_chat_audit
        WHERE organization_id = $1
          AND created_at > NOW() - INTERVAL '1 day') AS daily_active_users,
       (SELECT COUNT(*)
        FROM pilot.shadow_feedback
        WHERE organization_id = $1
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS feedback_count,
       (SELECT COUNT(*)
        FROM pilot.shadow_user_profiles
        WHERE organization_id = $1
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS new_users,
       (SELECT AVG(message_count)
        FROM (
          SELECT COUNT(*) FILTER (WHERE m.role = 'assistant')::numeric AS message_count
          FROM pilot.shadow_chat_sessions s
          JOIN pilot.shadow_chat_messages m
            ON m.conversation_id = s.conversation_id
           AND m.organization_id = s.organization_id
           AND m.account_id = s.account_id
          WHERE s.organization_id = $1
            AND m.created_at > NOW() - ($2 * INTERVAL '1 day')
          GROUP BY s.conversation_id
        ) conversation_counts) AS avg_messages_per_session,
       (SELECT COUNT(*)
        FROM pilot.shadow_human_review_queue
        WHERE organization_id = $1
          AND severity IN ('high', 'critical')
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS high_risk_reviews,
       -- Escalations count the human-review queue: every row there is a real
       -- "a human needs to look at this" event, written by queueHumanReview
       -- on filtered requests, filtered responses, and safety handoffs. The
       -- previous source was structurally zero twice over: it counted
       -- learning events with outcome_signal 'escalated_to_human', which no
       -- code path emits, additionally filtered to verification states that
       -- client signals never reach (behavioral audit BC follow-up). The
       -- high_risk_reviews tile above remains the high/critical subset of
       -- this same queue, so the two numbers stay distinct and both true.
       (SELECT COUNT(*)
        FROM pilot.shadow_human_review_queue
        WHERE organization_id = $1
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS escalations,
       -- Completeness counts only factors something can actually write:
       -- recent_topics (chat turns) and remembered_facts (human-approved
       -- learning). communication_style, open_questions, and shadow_notes
       -- have no production writer -- profiles are born 'unknown'/empty/null
       -- and stay that way (the same dead factors #83 removed from tier
       -- scoring) -- so counting them capped this "average" at 0.4 while
       -- advertising a scale of 1.0.
       (SELECT AVG((
          (CASE WHEN cardinality(recent_topics) > 0 THEN 1 ELSE 0 END) +
          (CASE WHEN jsonb_array_length(remembered_facts) > 0 THEN 1 ELSE 0 END)
        )::numeric / 2)
        FROM pilot.shadow_user_profiles
        WHERE organization_id = $1) AS avg_profile_completeness`,
    [organizationId, days],
  );

  return {
    dailyActiveUsers: Number.parseInt(row?.daily_active_users ?? '0', 10),
    feedbackCount: Number.parseInt(row?.feedback_count ?? '0', 10),
    newUsers: Number.parseInt(row?.new_users ?? '0', 10),
    avgMessagesPerSession:
      row?.avg_messages_per_session != null
        ? Number.parseFloat(row.avg_messages_per_session)
        : null,
    highRiskReviews: Number.parseInt(row?.high_risk_reviews ?? '0', 10),
    escalations: Number.parseInt(row?.escalations ?? '0', 10),
    avgProfileCompleteness:
      row?.avg_profile_completeness != null
        ? Number.parseFloat(row.avg_profile_completeness)
        : null,
  };
}

async function getConcernedTopics(organizationId: string): Promise<string[]> {
  const rows = await query<{ topic: string }>(
    `SELECT topic
     FROM pilot.shadow_library_review_flags
     WHERE organization_id = $1 AND review_state = 'pending'
     ORDER BY last_flagged_at DESC
     LIMIT 20`,
    [organizationId],
  );
  return rows.map((row) => row.topic);
}

interface UserMetrics extends Availability {
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
    preferredSessionType: string | null;
  };
}

async function getUserMetrics(organizationId: string, userId: string): Promise<UserMetrics> {
  const profile = await queryOne<ShadowUserProfileRow>(
    `SELECT *
     FROM pilot.shadow_user_profiles
     WHERE account_id = $1 AND organization_id = $2`,
    [userId, organizationId],
  );
  if (!profile) throw new Error('SHADOW_PROFILE_NOT_FOUND');

  const preferredSession = await queryOne<{ session_type: string }>(
    `SELECT session_type
     FROM pilot.shadow_chat_sessions
     WHERE organization_id = $1
       AND account_id = $2
       AND deleted_at IS NULL
     GROUP BY session_type
     ORDER BY COUNT(*) DESC, session_type ASC
     LIMIT 1`,
    [organizationId, userId],
  );

  const createdTime = new Date(profile.created_at).getTime();
  const lastTime = profile.last_interaction_at
    ? new Date(profile.last_interaction_at).getTime()
    : createdTime;
  const nowTime = Date.now();

  let tierLevel: 'bronze' | 'silver' | 'gold' = 'bronze';
  if (profile.interaction_count >= 50) tierLevel = 'gold';
  else if (profile.interaction_count >= 20) tierLevel = 'silver';

  return {
    userId,
    profile: {
      tier: tierLevel,
      completeness: calculateProfileCompleteness(profile),
      totalInteractions: profile.interaction_count,
      daysSinceFirstInteraction: Math.floor((nowTime - createdTime) / 86_400_000),
      daysSinceLastInteraction: Math.floor((nowTime - lastTime) / 86_400_000),
    },
    engagement: {
      favoriteTopics: profile.recent_topics || [],
      preferredSessionType: preferredSession?.session_type ?? null,
    },
    unavailableReasons: preferredSession
      ? {}
      : { preferredSessionType: 'NO_DURABLE_CONVERSATIONS' },
  };
}

async function getTierCounts(
  organizationId: string,
): Promise<{ bronze: number; silver: number; gold: number }> {
  // Classified with the SAME function the chat route uses per turn
  // (classifyProfileTier: multi-factor score, thresholds 30/65). This used to
  // be a second, contradictory definition -- interaction_count alone at 20/50
  // -- so the dashboard could call a user Gold while their chat badge said
  // Silver. The audit found a third copy in getScorecard, now deleted. One
  // authority remains, and this query deliberately fetches rows and runs it
  // rather than re-encoding it in SQL where it could drift again.
  const profiles = await query<ShadowUserProfileRow>(
    `SELECT * FROM pilot.shadow_user_profiles WHERE organization_id = $1`,
    [organizationId],
  );
  const counts = { bronze: 0, silver: 0, gold: 0 };
  for (const profile of profiles) {
    counts[classifyProfileTier(profile).tier] += 1;
  }
  return counts;
}


