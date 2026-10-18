// shadowClassifier.ts
// Classifies SHADOW requests as Quick Round or Heavy Bag based on complexity heuristics
// Quick Round: Fast, synchronous, lightweight context
// Heavy Bag: Deep reasoning, asynchronous (async-default + sync-on-demand)

import type { PilotRole } from './contracts';

export type ShadowTier = 'quick_round' | 'heavy_bag';

// Hoisted out of classifyRequest so pilotOpsReadiness.ts can report the real
// values rather than a second, driftable copy. Exporting changes nothing
// about how they're used below -- these are the same thresholds, just named.
export const QUICK_ROUND_COMPLEXITY_THRESHOLD = 0.4;
export const HEAVY_BAG_COMPLEXITY_THRESHOLD = 0.6;

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
    // Whole words: "tension" sits inside "extension", and "how", "if" and
    // "then" inside "show", "different" and "strengthen", so a plain request
    // about a jab or a leg day scored as conflicting and conditional.
    /\b(?:contradictory|conflicting|tensions?)\b/i,
    /\b(?:what|how|why)\b.{0,20}\b(?:if|when)\b.{0,20}\b(?:then|else)\b/i, // Conditional logic
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
 * Detect the primary topic/domain of the query.
 *
 * WHOLE WORDS. These were bare substrings, so a topic word anywhere inside a
 * longer word decided the topic: "rest" in "wrestling" filed a wrestling
 * question under recovery, "form" in "performance" and "information" under
 * technique, "set" in "upset" and "train" in "strain" under training, "pain"
 * in "painting" under medical. The topic is not used to pick a model, but it
 * is stored as the message topic, the review category and the profile's
 * recent topics, and those are written back into later prompts -- so a stray
 * match became a standing statement about what the person asks about.
 *
 * The vocabulary is the same; each word now matches whole, with its plain
 * inflections listed (train, trains, trained, training, trainer), plus the
 * compounds and prefixed forms the substring match used to catch correctly
 * (headgear, biomechanics, painkiller, overtraining, reinjury, unsafe,
 * safeguarding). "injury prevention" is checked before medical:
 * it was listed under safety but could never match, because "injury" won
 * first.
 */
const TOPIC_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['technique', /\b(?:forms?|postures?|(?:bio)?mechanics|movements?|position(?:s|ed|ing|al)?|grip(?:s|ped|ping)?|stances?)\b/],
  ['training', /\b(?:(?:over|re)?train(?:s|ed|ing|er|ers|ee|ees)?|workouts?|sessions?|sets?|rep(?:s|etitions?)?|exercis(?:e|es|ed|ing)|drill(?:s|ed|ing)?)\b/],
  ['recovery', /\b(?:recover(?:s|ed|ing|y)?|rest(?:s|ed|ing)?|sleep(?:s|ing|y|less)?|soreness|doms|fatigu(?:e|ed|ing)|nutrition(?:al|ist)?)\b/],
  ['safety', /\binjury prevention\b/],
  ['medical', /\b(?:(?:re)?injur(?:y|ies|ed)|pain(?:s|ful|killers?)?|hurt(?:s|ing)?|medical(?:ly)?|doctors?|clinic(?:s|al)?|treatments?)\b/],
  ['mindset', /\b(?:mental(?:ly|ity)?|psychology|(?:un|re)?focus(?:ed|es|ing)?|confidence|motivation(?:al)?|fear(?:s|ful|less)?|anxiety)\b/],
  ['strategy', /\b(?:strateg(?:y|ies)|plan(?:s|ned|ning|ner|ners)?|goals?|approach(?:es)?|method(?:s|ology)?|systems?)\b/],
  ['competition', /\b(?:competitions?|meets?|events?|perform(?:s|ed|ing|er|ers|ance|ances)?|record(?:s|ed|ing)?|rankings?)\b/],
  ['safety', /\b(?:(?:un)?safe(?:ly|r|st|ty)?|safeguard(?:s|ed|ing)?|risk(?:s|y)?|danger(?:s|ous|ously)?|emergenc(?:y|ies))\b/],
  ['equipment', /\b(?:equipment|(?:head)?gear|shoes?|uniforms?|technology|devices?)\b/],
];

function detectTopic(message: string, role: PilotRole): string {
  const msg = message.toLowerCase();

  for (const [topic, pattern] of TOPIC_PATTERNS) {
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
  // Measured before the manual-tier branches, because an honored override
  // changes which TIER runs, not how complex the message actually is.
  const topic = detectTopic(message, role);
  const complexity = calculateComplexityScore(message, role);

  // If user explicitly requested Heavy Bag (coach/admin only), honor it.
  //
  // complexity was hardcoded to 0.9 here (audit F2) while the quick_round
  // mirror below already reported the measured value -- an asymmetry that
  // marks it as an oversight rather than a decision. The 0.9 reached both the
  // model, as a "Complexity Score: 0.90" prompt line (shadowHeavyBag.ts), and
  // the user, as the response's complexity field. Asking for the deeper model
  // is not evidence that the question was hard, and a reviewer reading 0.90
  // against a one-line message is reading a number nothing measured.
  //
  // Reporting the measured value changes no routing: heavyBagRoute takes
  // complexity only to interpolate it into its rationale string and never
  // branches on it, so the honored tier still gets the heavy model. The
  // override itself stays recorded in `reasoning`.
  if (userManualTier === 'heavy_bag' && (role === 'coach' || role === 'admin' || role === 'organization_admin' || role === 'platform_owner')) {
    return {
      tier: 'heavy_bag',
      complexity,
      topic,
      confidence: 1.0,
      reasoning: 'User explicitly requested Heavy Bag session',
      requiresManualOverride: false,
      suggestedContextDepth: 'full',
    };
  }

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
  const quickThreshold = QUICK_ROUND_COMPLEXITY_THRESHOLD;
  const heavyThreshold = HEAVY_BAG_COMPLEXITY_THRESHOLD;

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
