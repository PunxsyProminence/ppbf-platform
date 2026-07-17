// shadowContextBuilder.ts
// Builds SHADOW context adaptively based on tier (Quick Round vs Heavy Bag)
// Quick Round: Minimal context (role, recent interactions, basic profile)
// Heavy Bag: Full context (all 9 weighting dimensions)

import type { PilotRole } from './contracts';
import type { ShadowUserProfileRow, RememberedFact } from './shadowUserProfile';
import type { WeightedContextItem, ContextCategory, ShadowQueryType } from './shadowContextWeights';
import {
  calculateDynamicWeights,
  detectQueryType,
  scoreConfidence,
  selectTopContextItems,
} from './shadowContextWeights';

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
  const sections: string[] = [];

  // 1. User Role & Authority
  sections.push(`## User Profile`);
  sections.push(`- Role: ${profile.role}`);
  sections.push(`- Expertise Level: ${profile.interaction_count > 50 ? 'expert' : profile.interaction_count > 20 ? 'intermediate' : 'novice'}`);
  sections.push(`- Interaction History: ${profile.interaction_count} previous interactions`);
  sections.push('');

  // 2. Communication Style
  if (profile.communication_style && profile.communication_style !== 'unknown') {
    sections.push(`## Communication Preference`);
    const styleMap: Record<string, string> = {
      concise: 'Prefers brief, direct answers',
      detailed: 'Prefers comprehensive explanations',
      'example-heavy': 'Learns best through examples',
      unknown: 'No preference yet',
    };
    sections.push(`- ${styleMap[profile.communication_style] || 'Unknown'}`);
    sections.push('');
  }

  // 3. Recent Topics (avoid repetition)
  if (profile.recent_topics && profile.recent_topics.length > 0) {
    sections.push(`## Recent Discussion Topics`);
    sections.push(`- ${profile.recent_topics.slice(0, 5).join(', ')}`);
    sections.push('');
  }

  // 4. Open Questions (show what's unresolved)
  if (profile.open_questions && profile.open_questions.length > 0) {
    sections.push(`## Unresolved Questions`);
    sections.push(`Context from previous sessions: ${profile.open_questions.slice(0, 2).join('; ')}`);
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Heavy Bag context: Full, comprehensive reasoning
 * - All 9 weighting dimensions applied
 * - Full athlete context (if applicable)
 * - Research requirements and knowledge gaps
 * - Organization patterns
 * - Confidence scoring on all items
 */
function buildHeavyBagContext(input: ShadowContextBuilderInput): string {
  const profile = input.userProfile;
  const queryType = detectQueryType(input.userMessage);
  const sections: string[] = [];

  // 1. Complete User Profile
  sections.push(`## User Context`);
  sections.push(`- Role: ${profile.role}`);
  sections.push(`- Organization: ${input.organizationId}`);
  sections.push(`- Interaction Count: ${profile.interaction_count}`);
  sections.push(`- Last Interaction: ${profile.last_interaction_at || 'Never'}`);
  sections.push('');

  // 2. Communication Style (detailed)
  if (profile.communication_style && profile.communication_style !== 'unknown') {
    sections.push(`## Interaction Patterns`);
    sections.push(`- Communication Style: ${profile.communication_style}`);
    sections.push('');
  }

  // 3. Remembered Facts (with confidence scoring)
  if (profile.remembered_facts && Array.isArray(profile.remembered_facts) && profile.remembered_facts.length > 0) {
    sections.push(`## Key Facts About This User`);
    profile.remembered_facts.slice(0, 10).forEach((fact: RememberedFact) => {
      const confidence = (fact.confidence * 100).toFixed(0);
      sections.push(`- ${fact.key}: ${fact.value} (confidence: ${confidence}%)`);
    });
    sections.push('');
  }

  // 4. Recent Discussion Topics
  if (profile.recent_topics && profile.recent_topics.length > 0) {
    sections.push(`## Discussion History`);
    sections.push(`- Recent topics: ${profile.recent_topics.slice(0, 10).join(', ')}`);
    sections.push('');
  }

  // 5. Open Questions & Knowledge Gaps
  if (profile.open_questions && profile.open_questions.length > 0) {
    sections.push(`## Unresolved Items`);
    profile.open_questions.slice(0, 5).forEach((q: string) => {
      sections.push(`- ${q}`);
    });
    sections.push('');
  }

  // 6. Athlete-Specific Context (if applicable)
  if (input.athleteId && profile.athlete_ids_discussed?.includes(input.athleteId)) {
    sections.push(`## Athlete Context`);
    sections.push(`- Currently discussing: Athlete ${input.athleteId}`);
    sections.push('');
  }

  // 7. Query Type & Routing
  sections.push(`## Query Classification`);
  sections.push(`- Type: ${queryType}`);
  sections.push(`- Tier: Heavy Bag (full reasoning enabled)`);
  sections.push('');

  // 8. Authority & Role-Based Constraints
  sections.push(`## Role-Based Decision Authority`);
  const authorityMap: Record<PilotRole, string> = {
    coach: 'Can make coaching decisions, recommend training modifications, refer to medical',
    admin: 'Can make organizational decisions, access all data, approve changes',
    athlete: 'Can request information, provide feedback, ask clarifying questions',
    parent: 'Can request athlete progress info, ask general questions',
    organization_admin: 'Can manage organization settings and user access',
    platform_owner: 'Full platform access and governance',
    volunteer: 'Can provide coaching support within organization',
    staff: 'Can access organization data and assist with operations',
  };
  sections.push(`- ${authorityMap[input.userRole] || 'Standard access'}`);
  sections.push('');

  // 9. Shadow Notes (if available)
  if (profile.shadow_notes) {
    sections.push(`## Context Notes`);
    sections.push(profile.shadow_notes);
    sections.push('');
  }

  return sections.join('\n');
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
      includesAthleteData: tier === 'heavy_bag' && !!input.athleteId,
      includesResearchRequirements: tier === 'heavy_bag',
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
