// shadowProfiling.ts — Bronze / Silver / Gold Profiling Tiers
// Determines personalization depth based on interaction history and profile richness.
// Bronze = new users, Silver = developing relationship, Gold = trusted expert.

import type { ShadowUserProfileRow, RememberedFact } from './shadowUserProfile';
import type { PilotRole } from './contracts';

// ─── Tier Definitions ─────────────────────────────────────────────────────────

export type ProfileTier = 'bronze' | 'silver' | 'gold';

export { }; // ensure module isolation

export interface ProfileTierConfig {
  tier: ProfileTier;
  label: string;
  contextSections: number;       // Number of context sections to include
  maxRememberedFacts: number;     // Cap on facts loaded into context
  includesAthleteHistory: boolean;
  includesPatternInsights: boolean;
  includesCrossSessionMemory: boolean;
  systemPromptPersonalization: 'none' | 'light' | 'full';
  scoutReportEligible: boolean;   // Can generate a Scout Report for this user
  description: string;
}

export const TIER_CONFIGS: Record<ProfileTier, ProfileTierConfig> = {
  bronze: {
    tier: 'bronze',
    label: 'Bronze — Getting Started',
    contextSections: 3,
    maxRememberedFacts: 0,
    includesAthleteHistory: false,
    includesPatternInsights: false,
    includesCrossSessionMemory: false,
    systemPromptPersonalization: 'none',
    scoutReportEligible: false,
    description: 'New user. Generic coaching context. No personalization yet.',
  },
  silver: {
    tier: 'silver',
    label: 'Silver — Building Trust',
    contextSections: 6,
    maxRememberedFacts: 5,
    includesAthleteHistory: true,
    includesPatternInsights: false,
    includesCrossSessionMemory: true,
    systemPromptPersonalization: 'light',
    scoutReportEligible: false,
    description: 'Regular user. Light personalization. Session memory active.',
  },
  gold: {
    tier: 'gold',
    label: 'Gold — Deep Partnership',
    contextSections: 12,
    maxRememberedFacts: 15,
    includesAthleteHistory: true,
    includesPatternInsights: true,
    includesCrossSessionMemory: true,
    systemPromptPersonalization: 'full',
    scoutReportEligible: true,
    description: 'Power user. Full personalization. Cross-session pattern memory. Scout Report eligible.',
  },
};

// ─── Tier Classification ──────────────────────────────────────────────────────

export interface ProfileTierResult {
  tier: ProfileTier;
  config: ProfileTierConfig;
  score: number;          // 0–100 composite score
  reasons: string[];      // Why this tier was assigned
  nextTierAt: number | null; // Interactions needed to level up (null = already Gold)
}

/**
 * Score the user's profile and assign a Bronze/Silver/Gold tier.
 *
 * Scoring factors:
 *   - Interaction count     (0–40 pts)
 *   - Remembered facts      (0–20 pts)
 *   - Communication style   (0–10 pts) — style is known = +10
 *   - Recent topics count   (0–15 pts)
 *   - Open questions count  (0–15 pts) — engagement signal
 */
export function classifyProfileTier(profile: ShadowUserProfileRow): ProfileTierResult {
  const reasons: string[] = [];
  let score = 0;

  // ── Factor 1: Interaction Count ──────────────────────────────────────────
  const ic = profile.interaction_count;
  if (ic >= 50) {
    score += 40;
    reasons.push(`${ic} interactions (max score)`);
  } else if (ic >= 20) {
    score += 25;
    reasons.push(`${ic} interactions (mid score)`);
  } else if (ic >= 5) {
    score += 10;
    reasons.push(`${ic} interactions (early)`);
  } else {
    reasons.push(`${ic} interactions (new user)`);
  }

  // ── Factor 2: Remembered Facts ───────────────────────────────────────────
  const factCount = (profile.remembered_facts ?? []).length;
  const highConfidenceFacts = (profile.remembered_facts ?? []).filter(
    (f: RememberedFact) => f.confidence >= 0.7,
  ).length;
  if (highConfidenceFacts >= 5) {
    score += 20;
    reasons.push(`${highConfidenceFacts} high-confidence facts`);
  } else if (highConfidenceFacts >= 2 || factCount >= 3) {
    score += 12;
    reasons.push(`${factCount} facts (${highConfidenceFacts} high-confidence)`);
  } else if (factCount > 0) {
    score += 5;
    reasons.push(`${factCount} fact(s) recorded`);
  }

  // ── Factor 3: Communication Style ────────────────────────────────────────
  if (profile.communication_style && profile.communication_style !== 'unknown') {
    score += 10;
    reasons.push(`communication style known: ${profile.communication_style}`);
  }

  // ── Factor 4: Recent Topics ──────────────────────────────────────────────
  const topicCount = (profile.recent_topics ?? []).length;
  if (topicCount >= 8) {
    score += 15;
    reasons.push(`${topicCount} recent topics (broad engagement)`);
  } else if (topicCount >= 4) {
    score += 8;
    reasons.push(`${topicCount} recent topics`);
  } else if (topicCount > 0) {
    score += 3;
    reasons.push(`${topicCount} recent topic(s)`);
  }

  // ── Factor 5: Open Questions ─────────────────────────────────────────────
  const qCount = (profile.open_questions ?? []).length;
  if (qCount >= 3) {
    score += 15;
    reasons.push(`${qCount} open questions (deep engagement)`);
  } else if (qCount >= 1) {
    score += 8;
    reasons.push(`${qCount} open question(s)`);
  }

  // ── Assign Tier ──────────────────────────────────────────────────────────
  let tier: ProfileTier;
  let nextTierAt: number | null;

  if (score >= 65) {
    tier = 'gold';
    nextTierAt = null;
  } else if (score >= 30) {
    tier = 'silver';
    nextTierAt = 65;
  } else {
    tier = 'bronze';
    nextTierAt = 30;
  }

  return {
    tier,
    config: TIER_CONFIGS[tier],
    score,
    reasons,
    nextTierAt,
  };
}

// ─── Personalization Prompt Builder ──────────────────────────────────────────

/**
 * Builds a personalization prefix for the system prompt based on tier.
 * Appended to the base SHADOW_SYSTEM_PROMPT before sending to the LLM.
 */
export function buildPersonalizationPrompt(
  profile: ShadowUserProfileRow,
  tierResult: ProfileTierResult,
): string {
  const { config } = tierResult;

  if (config.systemPromptPersonalization === 'none') {
    return '';
  }

  const lines: string[] = [
    '',
    '## User Intelligence (Personalization)',
    `- Profile Tier: ${tierResult.config.label}`,
    `- Role: ${profile.role}`,
    `- Interactions: ${profile.interaction_count}`,
  ];

  // Light personalization: style + recent topics only
  if (profile.communication_style !== 'unknown') {
    const styleGuide: Record<string, string> = {
      concise: 'Keep responses brief and direct. Use bullet points.',
      detailed: 'Provide thorough explanations with examples.',
      'example-heavy': 'Lead with concrete examples before theory.',
    };
    const guide = styleGuide[profile.communication_style];
    if (guide) lines.push(`- Communication Preference: ${guide}`);
  }

  if (config.systemPromptPersonalization === 'full') {
    // Gold tier: include facts and open questions
    const facts = (profile.remembered_facts ?? [])
      .filter((f: RememberedFact) => f.confidence >= 0.6)
      .slice(0, config.maxRememberedFacts);

    if (facts.length > 0) {
      lines.push('', '### Key Facts About This User');
      facts.forEach((f: RememberedFact) => {
        lines.push(`- ${f.key}: ${f.value} (confidence: ${Math.round(f.confidence * 100)}%)`);
      });
    }

    const questions = (profile.open_questions ?? []).slice(0, 3);
    if (questions.length > 0) {
      lines.push('', '### Open Questions to Address When Relevant');
      questions.forEach((q: string) => lines.push(`- ${q}`));
    }
  }

  return lines.join('\n');
}

// ─── Scout Report Eligibility ─────────────────────────────────────────────────

export interface ScoutReportEligibility {
  eligible: boolean;
  reason: string;
  requiredInteractions: number;
  currentInteractions: number;
}

export function checkScoutReportEligibility(
  profile: ShadowUserProfileRow,
  tierResult: ProfileTierResult,
): ScoutReportEligibility {
  if (!tierResult.config.scoutReportEligible) {
    return {
      eligible: false,
      reason: `${tierResult.config.label} tier — reach Gold tier to generate Scout Reports`,
      requiredInteractions: 50,
      currentInteractions: profile.interaction_count,
    };
  }

  if (profile.interaction_count < 20) {
    return {
      eligible: false,
      reason: 'Insufficient interaction history for meaningful Scout Report',
      requiredInteractions: 20,
      currentInteractions: profile.interaction_count,
    };
  }

  return {
    eligible: true,
    reason: 'Gold tier with sufficient history — Scout Report available',
    requiredInteractions: 20,
    currentInteractions: profile.interaction_count,
  };
}
