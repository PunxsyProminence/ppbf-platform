// shadowContextWeights.ts — query-type detection for the Heavy Bag prompt.
//
// This module once carried a full dynamic-weighting system (category weights,
// role multipliers, confidence decay, top-K selection). None of it was ever
// reachable in production: its only consumer was buildUserShadowContext in
// shadowUserProfile.ts, itself a complete implementation with zero callers
// (audit 2026-07-31 finding F8; owner decision: delete, git history keeps
// both implementations). What remains is the one part production uses --
// detectQueryType, consumed by shadowContextBuilder for the Heavy Bag
// prompt's query-type line and context metadata.

export type ShadowQueryType =
  | 'mindset'
  | 'technique'
  | 'training'
  | 'recovery'
  | 'pattern'
  | 'safety'
  | 'general';

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

  // Ties resolve to safety. "weight cut" is a keyword in BOTH training and
  // safety; the old insertion-order tie-break sent it to training every
  // time, so the one category that exists to catch risk lost exactly the
  // queries it shares with another list.
  const winner = (Object.entries(scores) as [ShadowQueryType, number][])
    .sort((a, b) => (b[1] - a[1])
      || (a[0] === 'safety' ? -1 : b[0] === 'safety' ? 1 : 0))[0];
  return winner[1] > 0 ? winner[0] : 'general';
}
