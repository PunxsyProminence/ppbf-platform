import type { ShadowUserProfileRow } from './shadowUserProfile';
import {
  TIER_CONFIGS,
  buildPersonalizationPrompt,
  checkScoutReportEligibility,
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

  test('keeps Scout Reports unavailable until the secure worker exists', () => {
    const eligibility = checkScoutReportEligibility(
      { ...profile, interaction_count: 100 },
      classifyProfileTier({ ...profile, interaction_count: 100 }),
    );

    expect(eligibility).toEqual(expect.objectContaining({
      eligible: false,
      requiredInteractions: 0,
    }));
    expect(eligibility.reason).toContain('secure reviewed worker');
  });
});
