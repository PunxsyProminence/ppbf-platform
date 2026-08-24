// shadowContextBuilder.ts
// Builds SHADOW context adaptively based on tier (Quick Round vs Heavy Bag)
// Quick Round: Minimal context (role, recent interactions, basic profile)
// Heavy Bag: Full context (all 9 weighting dimensions)

import type { PilotRole } from './contracts';
import type { ShadowUserProfileRow, RememberedFact } from './shadowUserProfile';
import type { ShadowQueryType } from './shadowContextWeights';
import { detectQueryType } from './shadowContextWeights';
import { describeFactSupport } from './shadowPersonalizationGate';

export interface ShadowContextBuilderInput {
  tier: 'quick_round' | 'heavy_bag';
  userProfile: ShadowUserProfileRow;
  userMessage: string;
  userRole: PilotRole;
  organizationId: string;
  athleteId?: string;
  /**
   * Whether the `strong_personalization` feature is unlocked for this request.
   *
   * REQUIRED, not optional, and deliberately so. This builder used to take no
   * such argument and emitted the user's inferred communication style and their
   * remembered facts on every call -- while the chat route checked the flag
   * around a *different* prompt fragment and believed the feature gated. Making
   * it required means a caller that has not decided cannot compile, which is
   * the only version of this gate that a future call site cannot walk past.
   *
   * Resolve it with `personalizationAllowed(unlockState)`; do not re-derive it.
   */
  personalizationEnabled: boolean;
}

export interface ShadowContextOutput {
  context: string;
  metadata: {
    tier: 'quick_round' | 'heavy_bag';
    topicType: ShadowQueryType;
    contextItemCount: number;
    totalWeight: number;
    includesAthleteData: boolean;
    includesResearchRequirements: boolean;
  };
}

/**
 * How a stored `communication_style` is stated to the model.
 *
 * PREFERENCE LANGUAGE ONLY. These strings describe what a person appeared to
 * want from an answer. They must not describe how a person learns.
 *
 * 'example-heavy' read "Learns best through examples" until 2026-08-23. That is
 * a learning-style claim -- a contested construct with no support in the
 * evidence base, and one this platform has no instrument to measure. What the
 * system actually observed was answer-format feedback: someone rated replies
 * that opened with an example. "Wanted examples first" and "learns best through
 * examples" are not the same sentence, and the second one, said about a child,
 * is a claim about their mind rather than about their last few clicks.
 */
const STYLE_PREFERENCE: Record<string, string> = {
  concise: 'Has preferred brief, direct answers',
  detailed: 'Has preferred comprehensive explanations',
  'example-heavy': 'Has preferred answers that open with a concrete example',
  unknown: 'No preference recorded',
};

/**
 * Quick Round context: Minimal, fast-track
 * - User role (decision-making authority) — always
 * - Recent topics (avoid repetition, show continuity) — always
 * - Communication preference — ONLY when personalization is unlocked
 * - No athlete-specific data, no research context
 *
 * INTERACTION COUNT IS NOT EXPERTISE. This built a
 * novice/intermediate/expert label from `interaction_count` -- 50 turns made
 * someone an "expert" -- and put it in the prompt as a fact about the person.
 * Nothing about how often someone opens a chat window evidences what they know
 * about boxing, coaching, or a child in front of them, and a coach labelled
 * "novice" to the model gets different answers for having been busy. The raw
 * count stays, because it is a true and unremarkable fact; the grade is gone.
 */
function buildQuickRoundContext(input: ShadowContextBuilderInput): string {
  const profile = input.userProfile;

  const userProfileSection = [
    `## User Profile`,
    `- Authenticated Role: ${input.userRole}`,
    `- Interaction History: ${profile.interaction_count} previous interactions`,
  ];

  const communicationSection = input.personalizationEnabled
    && profile.communication_style && profile.communication_style !== 'unknown'
    ? [
        `## Communication Preference`,
        `- ${STYLE_PREFERENCE[profile.communication_style] || STYLE_PREFERENCE.unknown}`,
      ]
    : [];

  const topicsSection = profile.recent_topics && profile.recent_topics.length > 0
    ? [`## Recent Discussion Topics`, `- ${profile.recent_topics.slice(-5).join(', ')}`]
    : [];

  const sections = [
    ...userProfileSection,
    '',
    ...communicationSection,
    ...(communicationSection.length > 0 ? [''] : []),
    ...topicsSection,
    ...(topicsSection.length > 0 ? [''] : []),
  ];

  return sections.join('\n');
}

/**
 * Heavy Bag context: deeper user-owned context for reasoning.
 * Athlete records and research evidence are supplied only by separately
 * authorized retrieval paths; this builder never implies that they exist.
 */
function buildHeavyBagContext(input: ShadowContextBuilderInput): string {
  const profile = input.userProfile;
  const queryType = detectQueryType(input.userMessage);

  const sections = buildHeavyBagSections(profile, input, queryType);
  return sections.join('\n');
}

function buildHeavyBagSections(profile: ShadowUserProfileRow, input: ShadowContextBuilderInput, queryType: ShadowQueryType): string[] {
  const userContextSection = [
    `## User Context`,
    `- Authenticated Role: ${input.userRole}`,
    `- Organization: ${input.organizationId}`,
    `- Interaction Count: ${profile.interaction_count}`,
    `- Last Interaction: ${profile.last_interaction_at || 'Never'}`,
  ];

  const communicationSection = buildCommunicationSection(profile, input.personalizationEnabled);
  const factsSection = buildFactsSection(profile, input.personalizationEnabled);
  const topicsSection = buildTopicsSection(profile);
  const athleteSection = buildAthleteSection(profile, input);
  const querySection = buildQuerySection(queryType);
  const authoritySection = buildAuthoritySection(input.userRole);

  return [
    ...userContextSection,
    '',
    ...communicationSection,
    ...(communicationSection.length > 0 ? [''] : []),
    ...factsSection,
    ...(factsSection.length > 0 ? [''] : []),
    ...topicsSection,
    ...(topicsSection.length > 0 ? [''] : []),
    ...athleteSection,
    ...(athleteSection.length > 0 ? [''] : []),
    ...querySection,
    '',
    ...authoritySection,
    '',
  ];
}

function buildCommunicationSection(
  profile: ShadowUserProfileRow,
  personalizationEnabled: boolean,
): string[] {
  if (!personalizationEnabled) return [];
  return profile.communication_style && profile.communication_style !== 'unknown'
    ? [
        `## Answer Format Preference`,
        `- ${STYLE_PREFERENCE[profile.communication_style] || STYLE_PREFERENCE.unknown}`,
      ]
    : [];
}

/**
 * Remembered facts, described by how often they were observed.
 *
 * NOT A PROBABILITY. This rendered `(confidence: 80%)` from a stored 0.8 that a
 * developer typed into a switch statement -- see `describeFactSupport`. An
 * ordinal word replaces it, derived from the observation count rather than the
 * weight, because the count is the only part of a remembered fact that was ever
 * actually counted.
 */
function buildFactsSection(
  profile: ShadowUserProfileRow,
  personalizationEnabled: boolean,
): string[] {
  if (!personalizationEnabled) return [];
  if (!profile.remembered_facts || !Array.isArray(profile.remembered_facts) || profile.remembered_facts.length === 0) {
    return [];
  }
  return [
    `## Observed Preferences For This User`,
    `- These are observations, not settings this person chose, and not claims about them.`,
    ...profile.remembered_facts.slice(0, 10).map((fact: RememberedFact) => {
      return `- ${fact.key}: ${fact.value} (support: ${describeFactSupport(fact.observationCount)})`;
    }),
  ];
}

function buildTopicsSection(profile: ShadowUserProfileRow): string[] {
  return profile.recent_topics && profile.recent_topics.length > 0
    ? [`## Discussion Topics`, `- Recent topics: ${profile.recent_topics.slice(0, 10).join(', ')}`]
    : [];
}

function buildAthleteSection(profile: ShadowUserProfileRow, input: ShadowContextBuilderInput): string[] {
  return input.athleteId && profile.athlete_ids_discussed?.includes(input.athleteId)
    ? [
        `## Authorized Subject Reference`,
        `- Subject identifier: ${input.athleteId}`,
        `- No athlete record data is present in this profile context.`,
      ]
    : [];
}

function buildQuerySection(queryType: ShadowQueryType): string[] {
  return [
    `## Query Classification`,
    `- Type: ${queryType}`,
    `- Tier: Heavy Bag (full reasoning enabled)`,
  ];
}

function buildAuthoritySection(userRole: PilotRole): string[] {
  const authorityMap: Record<PilotRole, string> = {
    coach: 'May use records only for athletes currently assigned to this coach; may provide coaching guidance but not medical diagnosis or clearance',
    admin: 'Organization-scoped administration; athlete records require a separate successful subject authorization check',
    athlete: 'May use only the authenticated athlete’s own record when separately authorized',
    parent: 'May use only records for an athlete linked to this parent when separately authorized',
    board: 'Aggregate governance only; SHADOW chat and athlete-record context are not authorized for this role',
    organization_admin: 'Organization-scoped administration; athlete records require a separate successful subject authorization check',
    platform_owner: 'Platform governance only; organization-private athlete records are denied by default',
    volunteer: 'General organization support only; no athlete-record access by default',
    staff: 'General organization operations only; no athlete-record access by default',
  };
  return [
    `## Role-Based Decision Authority`,
    `- ${authorityMap[userRole] || 'Standard access'}`,
  ];
}

/**
 * Main context builder: selects Quick or Heavy context based on tier
 */
export function buildShadowContext(input: ShadowContextBuilderInput): ShadowContextOutput {
  const tier = input.tier;

  // Board accounts use the dedicated, aggregate-only Board workspace. If this
  // context helper is reached outside the guarded chat route, return no
  // profile, athlete, coaching, or remembered-fact context.
  if (input.userRole === 'board') {
    return {
      context: buildAuthoritySection('board').join('\n'),
      metadata: {
        tier,
        topicType: 'general',
        contextItemCount: 1,
        totalWeight: 0,
        includesAthleteData: false,
        includesResearchRequirements: false,
      },
    };
  }

  const queryType = detectQueryType(input.userMessage);

  let context: string;
  let contextItemCount: number;
  let totalWeight: number;

  if (tier === 'quick_round') {
    context = buildQuickRoundContext(input);
    contextItemCount = 4; // Approximate: role, style, topics, questions
    totalWeight = 0.4; // Light weighting
  } else {
    context = buildHeavyBagContext(input);
    contextItemCount = 10; // Full: user, facts, topics, questions, athlete, query type, etc.
    totalWeight = 0.85; // Heavy weighting
  }

  return {
    context,
    metadata: {
      tier,
      topicType: queryType,
      contextItemCount,
      totalWeight,
      includesAthleteData: false,
      includesResearchRequirements: false,
    },
  };
}

/**
 * Get concise stats on context for logging/telemetry
 */
export function getContextStats(output: ShadowContextOutput) {
  return {
    tier: output.metadata.tier,
    itemCount: output.metadata.contextItemCount,
    totalWeight: output.metadata.totalWeight,
    topicType: output.metadata.topicType,
  };
}
