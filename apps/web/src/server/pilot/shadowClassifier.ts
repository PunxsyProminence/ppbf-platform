// shadowClassifier.ts
// Classifies SHADOW requests as Quick Round or Heavy Bag based on complexity heuristics
// Quick Round: Fast, synchronous, lightweight context
// Heavy Bag: Deep reasoning, asynchronous (async-default + sync-on-demand)

import type { PilotRole } from './contracts';

export type ShadowTier = 'quick_round' | 'heavy_bag';

export interface ShadowClassification {
  tier: ShadowTier;
  complexity: number; // 0–1 normalized score
  topic: string; // e.g., 'technique', 'medical', 'psychology', 'strategy'
  confidence: number; // 0–1, how confident we are in this classification
  reasoning: string; // Explanation of why this tier was chosen
  requiresManualOverride: boolean; // True if uncertain or boundary case
  suggestedContextDepth: 'lightweight' | 'full'; // Context building directive
}

/**
 * Complexity scoring heuristic:
 * - Message length (shorter = quick, longer = deep)
 * - Keywords indicating complexity (multi-step, trade-offs, edge cases)
 * - Role-based baseline adjustment (coaches default higher complexity)
 * - Recency markers (how fresh is the knowledge needed)
 * - Topic risk profile (high-risk topics get elevated complexity)
 */
const HIGH_RISK_MESSAGE_PATTERNS = [
  /\bconcussion\b/i,
  /\bmedical\s+clearance\b/i,
  /\breturn[-\s]+to[-\s]+play\b/i,
  /\bsurger(?:y|ies)\b/i,
  /\bprescription\b/i,
  /\b(?:cut(?:ting)?\s+weight|weight\s+cut(?:ting)?)\b/i,
  /\b(?:suicid(?:e|al)|self[-\s]+harm|mental\s+health)\b/i,
];

function calculateComplexityScore(message: string, role: PilotRole): number {
  let score = 0;

  // 1. Message length (max score: 0.2)
  //    Quick queries are typically < 100 chars, complex ones > 300
  const wordCount = message.split(/\s+/).length;
  if (wordCount < 20) score += 0.05;
  else if (wordCount < 50) score += 0.1;
  else if (wordCount < 100) score += 0.15;
  else score += 0.2; // Verbose = potentially complex

  // 2. Complexity keywords (max score: 0.3)
  const complexityKeywords = [
    /multi.?(step|faceted|dimensional|modal)/i,
    /trade.?off|trade-off/i,
    /edge\s+case/i,
    /nuance|subtle|context.?dependent/i,
    /contradictory|conflicting|tension/i,
    /(what|how|why).{0,20}(if|when).{0,20}(then|else)/i, // Conditional logic
    /compare|contrast|versus|vs\./i,
    /exception|special\s+case/i,
    /given.*constraint|with.*limitation/i,
  ];

  const matchedKeywords = complexityKeywords.filter((kw) => kw.test(message)).length;
  score += Math.min(matchedKeywords * 0.05, 0.3);

  // 3. High-risk topics (elevated to Heavy Bag baseline)
  if (HIGH_RISK_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    score += 0.6;
  }

  // 4. Role-based baseline adjustment
  // Coaches asking questions → default higher complexity (more decision-making)
  // Athletes → typically quicker queries
  const roleAdjustment: Record<PilotRole, number> = {
    coach: 0.15,
    admin: 0.1,
    athlete: -0.05,
    parent: 0.0,
    // Board accounts are denied from SHADOW chat at the route boundary.
    // Keep classification neutral if this helper is called independently.
    board: 0.0,
    organization_admin: 0.1,
    platform_owner: 0.05,
    volunteer: -0.05,
    staff: 0.05,
  };
  score += roleAdjustment[role] || 0;

  // Clamp to 0–1
  return Math.max(0, Math.min(1, score));
}

/**
 * Detect the primary topic/domain of the query
 */
function detectTopic(message: string, role: PilotRole): string {
  const msg = message.toLowerCase();

  const topicPatterns: [string, RegExp][] = [
    ['technique', /form|posture|mechanics|movement|position|grip|stance/i],
    ['training', /train|workout|session|set|rep|exercise|drill/i],
    ['recovery', /recover|rest|sleep|soreness|doms|fatigue|nutrition/i],
    ['medical', /injury|pain|hurt|medical|doctor|clinic|treatment/i],
    ['mindset', /mental|psychology|focus|confidence|motivation|fear|anxiety/i],
    ['strategy', /strategy|plan|goal|approach|method|system/i],
    ['competition', /competition|meet|event|perform|record|ranking/i],
    ['safety', /safe|risk|danger|emergency|injury prevention/i],
    ['equipment', /equipment|gear|shoe|uniform|technology|device/i],
  ];

  for (const [topic, pattern] of topicPatterns) {
    if (pattern.test(msg)) return topic;
  }

  // Default based on role
  if (role === 'coach') return 'strategy';
  if (role === 'athlete') return 'training';
  if (role === 'parent') return 'recovery';
  return 'general';
}

/**
 * Main classification function
 * Determines if this is a Quick Round (fast sync) or Heavy Bag (async reasoning) query
 */
export function classifyRequest(
  message: string,
  role: PilotRole,
  userManualTier?: ShadowTier,
): ShadowClassification {
  // If user explicitly requested Heavy Bag (coach/admin only), honor it
  if (userManualTier === 'heavy_bag' && (role === 'coach' || role === 'admin' || role === 'organization_admin' || role === 'platform_owner')) {
    return {
      tier: 'heavy_bag',
      complexity: 0.9,
      topic: detectTopic(message, role),
      confidence: 1.0,
      reasoning: 'User explicitly requested Heavy Bag session',
      requiresManualOverride: false,
      suggestedContextDepth: 'full',
    };
  }

  const topic = detectTopic(message, role);
  const complexity = calculateComplexityScore(message, role);

  // The mirror of the heavy_bag escalation above, deliberately without a role
  // gate: an explicit Quick Round request is a downgrade -- cheaper, faster,
  // shallower context -- so anyone may make one. Only the escalation needs
  // authorization. Before this branch existed, an explicit quick_round fell
  // through to organic classification and the session-type mapper escalated on
  // the mere presence of a manual tier, so asking for the quick answer routed
  // to the slowest path in the system.
  if (userManualTier === 'quick_round') {
    return {
      tier: 'quick_round',
      complexity,
      topic,
      confidence: 1.0,
      reasoning: 'User explicitly requested Quick Round session',
      requiresManualOverride: false,
      suggestedContextDepth: 'lightweight',
    };
  }

  // Decision thresholds
  const quickThreshold = 0.4;
  const heavyThreshold = 0.6;

  let tier: ShadowTier;
  let confidence: number;
  let requiresManualOverride: boolean;

  if (complexity < quickThreshold) {
    tier = 'quick_round';
    confidence = Math.max(1 - complexity, 0.8);
    requiresManualOverride = false;
  } else if (complexity >= heavyThreshold) {
    tier = 'heavy_bag';
    confidence = Math.min(complexity, 1.0);
    requiresManualOverride = false;
  } else {
    // Boundary case: default to Quick Round but flag for override
    // (Coaches/Admins can escalate if they sense the query needs depth)
    tier = 'quick_round';
    confidence = 0.5; // Low confidence at boundary
    requiresManualOverride = role === 'coach' || role === 'admin' || role === 'organization_admin' || role === 'platform_owner'; // Offer override option
  }

  // Build reasoning string
  let reasoning = `Complexity score: ${complexity.toFixed(2)}. `;
  if (complexity < quickThreshold) {
    reasoning += 'Straightforward query, lightweight context sufficient.';
  } else if (complexity >= heavyThreshold) {
    reasoning += 'Complex query requiring full context and deep reasoning.';
  } else {
    reasoning += 'Boundary case. Quick Round default with escalation available.';
  }

  return {
    tier,
    complexity,
    topic,
    confidence,
    reasoning,
    requiresManualOverride,
    suggestedContextDepth: tier === 'quick_round' ? 'lightweight' : 'full',
  };
}

/**
 * Get quick stats on a classification for logging/telemetry
 */
export function getClassificationStats(classification: ShadowClassification): {
  tier: ShadowTier;
  complexity: number;
  topic: string;
} {
  return {
    tier: classification.tier,
    complexity: classification.complexity,
    topic: classification.topic,
  };
}
