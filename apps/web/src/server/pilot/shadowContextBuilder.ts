// shadowContextBuilder.ts
// Builds SHADOW context adaptively based on tier (Quick Round vs Heavy Bag)
// Quick Round: Minimal context (role, recent interactions, basic profile)
// Heavy Bag: Full context (all 9 weighting dimensions)

import type { PilotRole } from './contracts';
import type { ShadowUserProfileRow, RememberedFact } from './shadowUserProfile';
import type { ShadowQueryType } from './shadowContextWeights';
import { detectQueryType } from './shadowContextWeights';

export interface ShadowContextBuilderInput {
  tier: 'quick_round' | 'heavy_bag';
  userProfile: ShadowUserProfileRow;
  userMessage: string;
  userRole: PilotRole;
  organizationId: string;
  athleteId?: string;
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
 * Quick Round context: Minimal, fast-track
 * - User role (decision-making authority)
 * - Communication style (response format preference)
 * - Recent topics (avoid repetition, show continuity)
 * - Interaction count (expertise level)
 * - No athlete-specific data, no research context
 */
function buildQuickRoundContext(input: ShadowContextBuilderInput): string {
  const profile = input.userProfile;
  
  const getExpertiseLevel = (interactionCount: number): string => {
    if (interactionCount > 50) return 'expert';
    if (interactionCount > 20) return 'intermediate';
    return 'novice';
  };
  const expertiseLevel = getExpertiseLevel(profile.interaction_count);

  const styleMap: Record<string, string> = {
    concise: 'Prefers brief, direct answers',
    detailed: 'Prefers comprehensive explanations',
    'example-heavy': 'Learns best through examples',
    unknown: 'No preference yet',
  };

  const userProfileSection = [
    `## User Profile`,
    `- Authenticated Role: ${input.userRole}`,
    `- Expertise Level: ${expertiseLevel}`,
    `- Interaction History: ${profile.interaction_count} previous interactions`,
  ];

  const communicationSection = profile.communication_style && profile.communication_style !== 'unknown'
    ? [
        `## Communication Preference`,
        `- ${styleMap[profile.communication_style] || 'Unknown'}`,
      ]
    : [];

  const topicsSection = profile.recent_topics && profile.recent_topics.length > 0
    ? [`## Recent Discussion Topics`, `- ${profile.recent_topics.slice(-5).join(', ')}`]
    : [];

  const questionsSection = profile.open_questions && profile.open_questions.length > 0
    ? [
        `## Unresolved Questions`,
        `Context from previous sessions: ${profile.open_questions.slice(0, 2).join('; ')}`,
      ]
    : [];

  const sections = [
    ...userProfileSection,
    '',
    ...communicationSection,
    ...(communicationSection.length > 0 ? [''] : []),
    ...topicsSection,
    ...(topicsSection.length > 0 ? [''] : []),
    ...questionsSection,
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

  const communicationSection = buildCommunicationSection(profile);
  const factsSection = buildFactsSection(profile);
  const topicsSection = buildTopicsSection(profile);
  const questionsSection = buildQuestionsSection(profile);
  const athleteSection = buildAthleteSection(profile, input);
  const querySection = buildQuerySection(queryType);
  const authoritySection = buildAuthoritySection(input.userRole);
  const notesSection = profile.shadow_notes ? [`## Context Notes`, profile.shadow_notes] : [];

  return [
    ...userContextSection,
    '',
    ...communicationSection,
    ...(communicationSection.length > 0 ? [''] : []),
    ...factsSection,
    ...(factsSection.length > 0 ? [''] : []),
    ...topicsSection,
    ...(topicsSection.length > 0 ? [''] : []),
    ...questionsSection,
    ...(questionsSection.length > 0 ? [''] : []),
    ...athleteSection,
    ...(athleteSection.length > 0 ? [''] : []),
    ...querySection,
    '',
    ...authoritySection,
    '',
    ...notesSection,
  ];
}

function buildCommunicationSection(profile: ShadowUserProfileRow): string[] {
  return profile.communication_style && profile.communication_style !== 'unknown'
    ? [`## Interaction Patterns`, `- Communication Style: ${profile.communication_style}`]
    : [];
}

function buildFactsSection(profile: ShadowUserProfileRow): string[] {
  if (!profile.remembered_facts || !Array.isArray(profile.remembered_facts) || profile.remembered_facts.length === 0) {
    return [];
  }
  return [
    `## Key Facts About This User`,
    ...profile.remembered_facts.slice(0, 10).map((fact: RememberedFact) => {
      const confidence = (fact.confidence * 100).toFixed(0);
      return `- ${fact.key}: ${fact.value} (confidence: ${confidence}%)`;
    }),
  ];
}

function buildTopicsSection(profile: ShadowUserProfileRow): string[] {
  return profile.recent_topics && profile.recent_topics.length > 0
    ? [`## Discussion Topics`, `- Recent topics: ${profile.recent_topics.slice(0, 10).join(', ')}`]
    : [];
}

function buildQuestionsSection(profile: ShadowUserProfileRow): string[] {
  return profile.open_questions && profile.open_questions.length > 0
    ? [
        `## Unresolved Items`,
        ...profile.open_questions.slice(0, 5).map((q: string) => `- ${q}`),
      ]
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
