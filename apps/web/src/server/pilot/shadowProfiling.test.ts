import type { ShadowUserProfileRow } from './shadowUserProfile';
import {
  TIER_CONFIGS,
  buildPersonalizationPrompt,
  classifyProfileTier,
} from './shadowProfiling';

const profile: ShadowUserProfileRow = {
  profile_id: 1,
  account_id: 'account-1',
  organization_id: 'org-1',
  role: 'athlete',
  interaction_count: 0,
  last_interaction_at: null,
  recent_topics: ['footwork'],
  athlete_ids_discussed: [],
  open_questions: [],
  remembered_facts: [{
    key: 'stance',
    value: 'orthodox',
    confidence: 0.9,
    updatedAt: '2026-07-23T00:00:00.000Z',
  }],
  communication_style: 'concise',
  shadow_notes: null,
  created_at: '2026-07-23T00:00:00.000Z',
  updated_at: '2026-07-23T00:00:00.000Z',
};

describe('SHADOW profile badges', () => {
  test('do not gate personalization or memory capabilities by badge', () => {
    for (const config of Object.values(TIER_CONFIGS)) {
      expect(config).toEqual(expect.objectContaining({
        contextSections: 12,
        maxRememberedFacts: 15,
        includesAthleteHistory: true,
        includesPatternInsights: true,
        includesCrossSessionMemory: true,
        systemPromptPersonalization: 'full',
        scoutReportEligible: false,
      }));
    }

    const bronze = classifyProfileTier(profile);
    expect(bronze.tier).toBe('bronze');
    expect(buildPersonalizationPrompt(profile, bronze)).toContain('stance: orthodox');
  });

  test('organic chat use alone caps at Silver -- Gold requires human-reviewed facts, by design', () => {
    // Every factor an ordinary chat turn can write, maxed: 50+ interactions
    // (40 pts) and 8+ recent topics (15 pts) = 55, below the Gold line at 65.
    // This ceiling is deliberate: the badge's top tier means a human reviewer
    // approved learning about this user, not merely heavy usage. Pinned so a
    // future factor change moves this line consciously.
    const organicMax = classifyProfileTier({
      ...profile,
      interaction_count: 50,
      recent_topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
      remembered_facts: [],
    });
    expect(organicMax.score).toBe(55);
    expect(organicMax.tier).toBe('silver');

    // Five high-confidence facts -- writable only through the learning
    // loop's human-review approval -- cross the line.
    const reviewed = classifyProfileTier({
      ...profile,
      interaction_count: 50,
      recent_topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
      remembered_facts: Array.from({ length: 5 }, (_, i) => ({
        key: `fact-${i}`,
        value: 'v',
        confidence: 0.8,
        updatedAt: '2026-07-23T00:00:00.000Z',
      })),
    });
    expect(reviewed.score).toBe(75);
    expect(reviewed.tier).toBe('gold');
  });

  test('the removed factors stay removed: style and open questions do not score', () => {
    // communication_style (+10) and open_questions (±15) were advertised
    // factors nothing could ever write (no production caller for either
    // setter -- behavioral audit BC-6). They were removed rather than left as
    // dead weight in the advertised model; identical profiles differing only
    // in those columns must score identically.
    const withDeadFactors = classifyProfileTier({
      ...profile,
      communication_style: 'concise',
      open_questions: ['q1', 'q2', 'q3'],
    });
    const withoutDeadFactors = classifyProfileTier({
      ...profile,
      communication_style: 'unknown',
      open_questions: [],
    });
    expect(withDeadFactors.score).toBe(withoutDeadFactors.score);
  });
});
