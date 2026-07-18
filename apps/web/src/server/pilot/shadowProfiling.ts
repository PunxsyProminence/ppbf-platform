// shadowProfiling.ts — Bronze / Silver / Gold Profiling Tiers
// Determines personalization depth based on interaction history and profile richness.
// Bronze = new users, Silver = developing relationship, Gold = trusted expert.

import type { ShadowUserProfileRow, RememberedFact } from './shadowUserProfile';

// ─── Tier Definitions ─────────────────────────────────────────────────────────

export type ProfileTier = 'bronze' | 'silver' | 'gold';


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
function scoreInteractionCount(ic: number, reasons: string[]): number {
  if (ic >= 50) { reasons.push(`${ic} interactions (max score)`); return 40; }
  if (ic >= 20) { reasons.push(`${ic} interactions (mid score)`); return 25; }
  if (ic >= 5)  { reasons.push(`${ic} interactions (early)`); return 10; }
  reasons.push(`${ic} interactions (new user)`);
  return 0;
}

function scoreRememberedFacts(facts: RememberedFact[], reasons: string[]): number {
  const factCount = facts.length;
  const highConf = facts.filter((f) => f.confidence >= 0.7).length;
  if (highConf >= 5)                      { reasons.push(`${highConf} high-confidence facts`); return 20; }
  if (highConf >= 2 || factCount >= 3)    { reasons.push(`${factCount} facts (${highConf} high-confidence)`); return 12; }
  if (factCount > 0)                      { reasons.push(`${factCount} fact(s) recorded`); return 5; }
  return 0;
}

function scoreTopics(topicCount: number, reasons: string[]): number {
  if (topicCount >= 8) { reasons.push(`${topicCount} recent topics (broad engagement)`); return 15; }
  if (topicCount >= 4) { reasons.push(`${topicCount} recent topics`); return 8; }
  if (topicCount > 0)  { reasons.push(`${topicCount} recent topic(s)`); return 3; }
  return 0;
}

function scoreOpenQuestions(qCount: number, reasons: string[]): number {
  if (qCount >= 3) { reasons.push(`${qCount} open questions (deep engagement)`); return 15; }
  if (qCount >= 1) { reasons.push(`${qCount} open question(s)`); return 8; }
  return 0;
}

export function classifyProfileTier(profile: ShadowUserProfileRow): ProfileTierResult {
  const reasons: string[] = [];
  let score = 0;

  score += scoreInteractionCount(profile.interaction_count, reasons);
  score += scoreRememberedFacts(profile.remembered_facts ?? [], reasons);

  if (profile.communication_style && profile.communication_style !== 'unknown') {
    score += 10;
    reasons.push(`communication style known: ${profile.communication_style}`);
  }

  score += scoreTopics((profile.recent_topics ?? []).length, reasons);
  score += scoreOpenQuestions((profile.open_questions ?? []).length, reasons);

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
