// shadowProfileProgression.ts — Tier progression (Bronze → Silver → Gold)
// Manages profile tier advancement based on interaction count and feature adoption

import { query } from './db';
import type { ShadowUserProfileRow } from './shadowUserProfile';

export type UserProfileTier = 'bronze' | 'silver' | 'gold';

export interface TierThresholds {
  bronze: { minInteractions: number; minCompleteness: number };
  silver: { minInteractions: number; minCompleteness: number };
  gold: { minInteractions: number; minCompleteness: number };
}

export interface TierFeatures {
  tier: UserProfileTier;
  features: Array<{
    name: string;
    enabled: boolean;
    reason?: string;
  }>;
}

// Default tier progression thresholds
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  bronze: { minInteractions: 1, minCompleteness: 0.1 }, // Just got started
  silver: { minInteractions: 20, minCompleteness: 0.5 }, // Regular user with profile 50% complete
  gold: { minInteractions: 50, minCompleteness: 0.8 }, // Power user, highly engaged
};

/**
 * Classify user into a tier based on interaction count and profile completeness
 * Automatically advances user to next tier when thresholds are met
 */
export async function getUserProfileTier(
  profile: ShadowUserProfileRow,
  thresholds = DEFAULT_TIER_THRESHOLDS
): Promise<UserProfileTier> {
  const completeness = calculateProfileCompleteness(profile);

  if (profile.interaction_count >= thresholds.gold.minInteractions && 
      completeness >= thresholds.gold.minCompleteness) {
    return 'gold';
  }

  if (profile.interaction_count >= thresholds.silver.minInteractions && 
      completeness >= thresholds.silver.minCompleteness) {
    return 'silver';
  }

  return 'bronze';
}

/**
 * Calculate how complete a user's profile is (0–1)
 * Bronze: just has basic facts
 * Silver: has learning style + preferences
 * Gold: complete with biometric opt-in + all personalization data
 */
function calculateProfileCompleteness(profile: ShadowUserProfileRow): number {
  let score = 0;
  const maxScore = 10;

  // Has recent topics (5%)
  if (profile.recent_topics && profile.recent_topics.length > 0) score += 0.5;

  // Has remembered facts (5%)
  if (profile.remembered_facts && profile.remembered_facts.length > 0) score += 0.5;

  // Has communication style preference (10%)
  if (profile.communication_style && profile.communication_style !== 'unknown') score += 1;

  // Has shadow notes indicating coach feedback (10%)
  if (profile.shadow_notes && profile.shadow_notes.length > 20) score += 1;

  // Has open questions (5%)
  if (profile.open_questions && profile.open_questions.length > 0) score += 0.5;

  // Has athlete discussions (20%)
  if (profile.athlete_ids_discussed && profile.athlete_ids_discussed.length >= 3) score += 2;

  // Has recent interactions in last 7 days (20%)
  if (profile.last_interaction_at) {
    const lastInteractionTime = new Date(profile.last_interaction_at).getTime();
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    if (now - lastInteractionTime < sevenDaysMs) score += 2;
  }

  // Has many facts (10%)
  if (profile.remembered_facts?.length >= 5) score += 1;

  // Has high-confidence facts (10%)
  if (profile.remembered_facts?.some(f => f.confidence >= 0.8)) score += 1;

  return Math.min(1, score / maxScore);
}

/**
 * Get available features for a tier
 */
export function getTierFeatures(tier: UserProfileTier): TierFeatures {
  const baseFeatures = {
    basic_feedback: { enabled: true, reason: 'All users' },
    quick_round: { enabled: true, reason: 'Fast AI responses' },
    static_library: { enabled: true, reason: 'Public knowledge base' },
  };

  const silverAddOns = {
    learning_style_detection: { enabled: true, reason: 'Adaptive tone & complexity' },
    heavy_bag_async: { enabled: true, reason: 'Deep analysis requests' },
    personalized_library: { enabled: true, reason: 'Curated to your topics' },
    preference_inference: { enabled: true, reason: 'Style learned from history' },
  };

  const goldAddOns = {
    biometric_signals: { enabled: true, reason: 'Integrated data streams' },
    prediction_model: { enabled: true, reason: 'Personalized projections' },
    video_analysis: { enabled: true, reason: 'Phase 4 beta: Pose + technique' },
    research_collab: { enabled: true, reason: 'Suggest research topics' },
    advanced_metrics: { enabled: true, reason: 'Performance dashboards' },
  };

  let features = { ...baseFeatures };

  if (tier === 'silver' || tier === 'gold') {
    features = { ...features, ...silverAddOns };
  }

  if (tier === 'gold') {
    features = { ...features, ...goldAddOns };
  }

  return {
    tier,
    features: Object.entries(features).map(([name, config]) => ({
      name,
      ...config,
    })),
  };
}

/**
 * Check if a user has access to a specific feature
 */
export function hasFeature(tier: UserProfileTier, featureName: string): boolean {
  const tierFeatures = getTierFeatures(tier);
  return tierFeatures.features.some(f => f.name === featureName && f.enabled);
}

/**
 * Get human-readable tier description
 */
export function getTierDescription(tier: UserProfileTier): string {
  const descriptions: Record<UserProfileTier, string> = {
    bronze: '🥉 Bronze — Just Getting Started\nYou\'re new to SHADOW. Try Quick Rounds and build your profile.',
    silver: '🥈 Silver — Regular User\nYou\'ve got experience with SHADOW. Heavy Bag and personalization unlocked.',
    gold: '🥇 Gold — Power User\nYou\'re deeply engaged. Advanced features and biometric signals available.',
  };
  return descriptions[tier];
}

/**
 * Get what\'s needed to reach the next tier
 */
export async function getNextTierRequirements(
  profile: ShadowUserProfileRow,
  thresholds = DEFAULT_TIER_THRESHOLDS
): Promise<{ nextTier: UserProfileTier | null; requirements: string[] }> {
  const currentTier = await getUserProfileTier(profile, thresholds);
  const completeness = calculateProfileCompleteness(profile);

  if (currentTier === 'gold') {
    return { nextTier: null, requirements: [] };
  }

  const requirements: string[] = [];
  const nextTier = currentTier === 'bronze' ? 'silver' : 'gold';
  const nextThresholds = thresholds[nextTier];

  if (profile.interaction_count < nextThresholds.minInteractions) {
    const remaining = nextThresholds.minInteractions - profile.interaction_count;
    requirements.push(`Complete ${remaining} more SHADOW interactions`);
  }

  if (completeness < nextThresholds.minCompleteness) {
    const percentMissing = Math.round((1 - completeness) * 100);
    requirements.push(`Complete ${percentMissing}% more of your profile (add topics, preferences, athlete list)`);
  }

  return { nextTier, requirements };
}

/**
 * Emit a tier-up notification when user advances
 */
export async function notifyTierAdvancement(
  userId: string,
  organizationId: string,
  oldTier: UserProfileTier,
  newTier: UserProfileTier
): Promise<void> {
  const message = `🎉 You've advanced to ${getTierDescription(newTier)
    .split('\n')[0]}! New features unlocked.`;

  await query(
    `INSERT INTO pilot.shadow_events (
       organization_id, account_id, event_type, event_data, created_at
     ) VALUES ($1, $2, $3, $4, NOW())`,
    [
      organizationId,
      userId,
      'tier_advancement',
      JSON.stringify({ oldTier, newTier, message }),
    ]
  ).catch(() => {
    // Non-critical — don't fail if event logging fails
  });
}
