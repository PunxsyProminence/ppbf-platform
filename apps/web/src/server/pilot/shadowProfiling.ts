// shadowProfiling.ts — Bronze / Silver / Gold trust-progress badges.
// Badges describe relationship maturity; they must never gate SHADOW capabilities.

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
    contextSections: 12,
    maxRememberedFacts: 15,
    includesAthleteHistory: true,
    includesPatternInsights: true,
    includesCrossSessionMemory: true,
    systemPromptPersonalization: 'full',
    scoutReportEligible: false,
    description: 'New relationship. Badge only; capabilities are controlled by server policy.',
  },
  silver: {
    tier: 'silver',
    label: 'Silver — Building Trust',
    contextSections: 12,
    maxRememberedFacts: 15,
    includesAthleteHistory: true,
    includesPatternInsights: true,
    includesCrossSessionMemory: true,
    systemPromptPersonalization: 'full',
    scoutReportEligible: false,
    description: 'Developing relationship. Badge only; capabilities are controlled by server policy.',
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
    scoutReportEligible: false,
    description: 'Established relationship. Badge only; capabilities are controlled by server policy.',
  },
};

// ─── Tier Classification ──────────────────────────────────────────────────────

export interface ProfileTierResult {
  tier: ProfileTier;
  config: ProfileTierConfig;
  score: number;          // 0–75 composite score (see classifyProfileTier)
  reasons: string[];      // Why this tier was assigned
  nextTierAt: number | null; // Interactions needed to level up (null = already Gold)
}

/**
 * Score the user's profile and assign a Bronze/Silver/Gold tier.
 *
 * Scoring factors (max 75):
 *   - Interaction count     (0–40 pts) — written on every chat turn
 *   - Remembered facts      (0–20 pts) — written ONLY by human-reviewed
 *     feedback approval (the learning loop's trust gate)
 *   - Recent topics count   (0–15 pts) — written on every chat turn
 *
 * Two factors this docstring used to advertise are gone, because nothing
 * could ever write them: communication_style (+10) had no caller for its
 * setter, and open_questions (±15) had writers no production path invoked.
 * Removing them changes no user's tier -- unwritten columns scored zero for
 * everyone -- it makes the advertised model match the real one. Verified by
 * measurement during the behavioral audit: organic chat use alone caps at 55
 * (Silver, deliberately); Gold (>= 65) requires facts that a human reviewer
 * approved, which is the trust story the badges are meant to tell.
 */
function scoreInteractionCount(ic: number, reasons: string[]): number {
  if (ic >= 50) { reasons.push(`${ic} interactions (max score)`); return 40; }
  if (ic >= 20) { reasons.push(`${ic} interactions (mid score)`); return 25; }
  if (ic >= 5)  { reasons.push(`${ic} interactions (early)`); return 10; }
  reasons.push(`${ic} interactions (new user)`);
  return 0;
}

/**
 * Profile completeness on the metrics surface. Counts only factors with a
 * production writer: recent_topics (chat turns) and remembered_facts
 * (human-approved learning). communication_style, open_questions, and
 * shadow_notes were advertised factors nothing could ever write -- profiles
 * are born 'unknown'/empty/null and stay that way (the same dead factors #83
 * removed from tier scoring) -- so counting them capped this metric at 0.4
 * while advertising a scale of 1.0. Must stay in step with the SQL average
 * in the metrics route.
 */
export function calculateProfileCompleteness(
  profile: Pick<ShadowUserProfileRow, 'recent_topics' | 'remembered_facts'>,
): number {
  let score = 0;
  if (profile.recent_topics?.length > 0) score += 0.5;
  if (profile.remembered_facts?.length > 0) score += 0.5;
  return Math.min(1, score);
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

export function classifyProfileTier(profile: ShadowUserProfileRow): ProfileTierResult {
  const reasons: string[] = [];
  let score = 0;

  score += scoreInteractionCount(profile.interaction_count, reasons);
  score += scoreRememberedFacts(profile.remembered_facts ?? [], reasons);
  score += scoreTopics((profile.recent_topics ?? []).length, reasons);

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
  }

  return lines.join('\n');
}

// ─── Scout Report Eligibility ─────────────────────────────────────────────────


