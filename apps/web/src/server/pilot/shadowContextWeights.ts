// shadowContextWeights.ts
// Merged from VS implementation + Grok confidence/decay improvements

// ── Types ─────────────────────────────────────────────────────────────────────

export type ContextCategory =
  | 'communication_style'
  | 'remembered_facts'
  | 'open_questions'
  | 'athlete_data'
  | 'org_patterns'
  | 'research_requirements'
  | 'role_framing';

export type ShadowQueryType =
  | 'mindset'
  | 'technique'
  | 'training'
  | 'recovery'
  | 'pattern'
  | 'safety'
  | 'general';

// Enhanced item with confidence + calculated priority (from Grok)
export interface WeightedContextItem {
  category: ContextCategory;
  content: string;
  weight: number;
  confidence: number;    // 0–1: how reliable/fresh this piece of context is
  priority: number;      // weight × confidence — used for sorting
  timestamp?: Date;
}

// ── Weight Configuration ──────────────────────────────────────────────────────

const BASE_WEIGHTS: Record<ContextCategory, number> = {
  role_framing:          0.90,
  communication_style:   0.60,
  remembered_facts:      0.75,
  open_questions:        0.55,
  athlete_data:          0.70,
  org_patterns:          0.80,
  research_requirements: 0.65,
};

const ROLE_ADJUSTMENTS: Partial<Record<string, Partial<Record<ContextCategory, number>>>> = {
  coach: {
    org_patterns:          0.15,
    athlete_data:          0.20,
    role_framing:          0.10,
    research_requirements: 0.10,
    remembered_facts:      0.05,
  },
  athlete: {
    remembered_facts:      0.20,
    communication_style:   0.25,
    open_questions:        0.15,
    org_patterns:         -0.40,
    research_requirements:-0.30,
  },
  organization_admin: {
    org_patterns:          0.15,
    research_requirements: 0.20,
    athlete_data:         -0.40,
  },
  admin: {
    org_patterns:          0.15,
    research_requirements: 0.20,
    athlete_data:         -0.40,
  },
  parent: {
    communication_style:   0.20,
    athlete_data:          0.10,
    org_patterns:         -0.30,
    research_requirements:-0.20,
  },
};

const QUERY_BOOSTS: Partial<Record<ShadowQueryType, Partial<Record<ContextCategory, number>>>> = {
  mindset:  { remembered_facts: 0.20, communication_style: 0.15, open_questions: 0.10 },
  pattern:  { org_patterns: 0.20, research_requirements: 0.15, athlete_data: 0.10 },
  technique:{ athlete_data: 0.15, org_patterns: 0.10 },
  training: { athlete_data: 0.20, org_patterns: 0.15 },
  recovery: { athlete_data: 0.25, research_requirements: 0.10 },
  safety:   { org_patterns: 0.15, research_requirements: 0.20, athlete_data: 0.10 },
  general:  {},
};

// ── Confidence Decay (from Grok) ──────────────────────────────────────────────

interface DecayConfig {
  halfLifeDays: number;
  minConfidence: number;
  decayModel: 'linear' | 'exponential';
}

const DECAY_CONFIGS: Record<ContextCategory, DecayConfig> = {
  communication_style:   { halfLifeDays: 90,  minConfidence: 0.30, decayModel: 'exponential' },
  remembered_facts:      { halfLifeDays: 60,  minConfidence: 0.25, decayModel: 'exponential' },
  open_questions:        { halfLifeDays: 14,  minConfidence: 0.10, decayModel: 'linear' },
  athlete_data:          { halfLifeDays: 30,  minConfidence: 0.20, decayModel: 'exponential' },
  org_patterns:          { halfLifeDays: 180, minConfidence: 0.40, decayModel: 'exponential' },
  research_requirements: { halfLifeDays: 45,  minConfidence: 0.20, decayModel: 'linear' },
  role_framing:          { halfLifeDays: 365, minConfidence: 0.80, decayModel: 'exponential' }, // role rarely changes
};

export function applyConfidenceDecay(
  initialConfidence: number,
  timestamp: Date,
  category: ContextCategory,
): number {
  const config = DECAY_CONFIGS[category];
  const ageInDays = (Date.now() - timestamp.getTime()) / (1000 * 3600 * 24);
  if (ageInDays <= 0) return initialConfidence;

  const decayed = config.decayModel === 'exponential'
    ? initialConfidence * Math.exp(-(Math.log(2) / config.halfLifeDays) * ageInDays)
    : initialConfidence * (1 - (1 / (config.halfLifeDays * 2)) * ageInDays);

  return Math.max(config.minConfidence, Math.min(1, decayed));
}

// Confidence scoring: decay + source type bonus
export function scoreConfidence(
  category: ContextCategory,
  initialConfidence: number,
  timestamp?: Date,
  sourceType?: 'verified_pattern' | 'observation' | 'profile' | 'raw_data',
  dataPoints?: number,
): number {
  let confidence = timestamp
    ? applyConfidenceDecay(initialConfidence, timestamp, category)
    : initialConfidence;

  if (sourceType === 'verified_pattern') confidence += 0.20;
  if (dataPoints && dataPoints >= 30) confidence += 0.10;

  return Math.max(0, Math.min(1, confidence));
}

// ── Query Type Detection ──────────────────────────────────────────────────────

const QUERY_KEYWORDS: Record<ShadowQueryType, string[]> = {
  mindset: [
    'mental', 'mindset', 'tough', 'quit', 'suck', 'uncomfortable',
    'motivation', 'discipline', 'give up', 'push through', 'embrace',
    'scared', 'nervous', 'confidence', 'focus', 'pressure', 'attitude',
    'fear', 'psych', 'believe', 'commit', 'doubt',
  ],
  technique: [
    'jab', 'cross', 'hook', 'uppercut', 'footwork', 'angle',
    'head movement', 'slip', 'roll', 'parry', 'feint', 'setup',
    'combination', 'punch', 'defense', 'offense', 'guard', 'stance',
    'pivot', 'cut off', 'range', 'timing', 'counter',
  ],
  training: [
    'sparring', 'roadwork', 'volume', 'rounds', 'pyramid',
    'conditioning', 'bag work', 'mitts', 'session', 'program',
    'how many', 'how often', 'frequency', 'drills', 'weight cut',
    'weight class', 'cardio', 'strength', 'workout',
  ],
  recovery: [
    'recovery', 'sleep', 'tired', 'sore', 'overtrain', 'rest',
    'hurt', 'pain', 'fatigue', 'burnout', 'deload', 'ache',
    'exhausted', 'worn out', 'worn down', 'not recovering',
  ],
  pattern: [
    'usually', 'normally', 'pattern', 'what works', 'most athletes',
    'tend to', 'common', 'often', 'effectiveness', 'correlation',
    'data', 'we see', 'typically', 'historically', 'track record',
    'show me', 'statistics',
  ],
  safety: [
    'safe', 'injur', 'concuss', 'clearance', 'return to play',
    'medical', 'risk', 'danger', 'emergency', 'doctor',
    'hospital', 'bruise', 'bleed', 'broken', 'weight cut',
  ],
  general: [],
};

export function detectQueryType(message: string): ShadowQueryType {
  const m = message.toLowerCase().trim();
  const scores = {} as Record<ShadowQueryType, number>;
  for (const key of Object.keys(QUERY_KEYWORDS) as ShadowQueryType[]) scores[key] = 0;

  for (const [type, keywords] of Object.entries(QUERY_KEYWORDS) as [ShadowQueryType, string[]][]) {
    for (const kw of keywords) {
      if (m.includes(kw)) scores[type] += 2;
    }
  }

  if (/how do i|what should i/i.test(m)) {
    if (scores.mindset > 0)   scores.mindset += 1;
    if (scores.technique > 0) scores.technique += 1;
  }
  if (/show me|what does.*data|data.*show|how.*performing/i.test(m)) {
    scores.pattern += 1;
  }

  const winner = (Object.entries(scores) as [ShadowQueryType, number][])
    .sort((a, b) => b[1] - a[1])[0];
  return winner[1] > 0 ? winner[0] : 'general';
}

// ── Weight Calculation ────────────────────────────────────────────────────────

export function calculateDynamicWeights(
  role: string,
  queryType: ShadowQueryType,
): Record<ContextCategory, number> {
  const weights = { ...BASE_WEIGHTS } as Record<ContextCategory, number>;

  for (const [cat, delta] of Object.entries(ROLE_ADJUSTMENTS[role] ?? {})) {
    const key = cat as ContextCategory;
    weights[key] = Math.max(0, (weights[key] ?? 0) + delta);
  }
  for (const [cat, delta] of Object.entries(QUERY_BOOSTS[queryType] ?? {})) {
    const key = cat as ContextCategory;
    weights[key] = Math.max(0, (weights[key] ?? 0) + delta);
  }

  const max = Math.max(...Object.values(weights), 0.001);
  for (const key of Object.keys(weights) as ContextCategory[]) {
    weights[key] = weights[key] / max;
  }
  return weights;
}

// ── Item Selection ────────────────────────────────────────────────────────────

export function selectTopContextItems(
  items: WeightedContextItem[],
  maxItems = 8,
  minPriority = 0.2,
): WeightedContextItem[] {
  return items
    .filter(item => item.priority >= minPriority && item.content.trim().length > 0)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxItems);
}
