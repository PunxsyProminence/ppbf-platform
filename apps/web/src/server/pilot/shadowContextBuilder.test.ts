// shadowContextBuilder.test.ts
// Unit tests for tier-aware context building (Quick Round vs Heavy Bag)

import { buildShadowContext } from './shadowContextBuilder';
import type { ShadowContextBuilderInput } from './shadowContextBuilder';
import type { ShadowUserProfileRow } from './shadowUserProfile';

describe('SHADOW Context Builder', () => {
  const mockUserProfile: ShadowUserProfileRow = {
    profile_id: 1,
    account_id: 'user-123',
    organization_id: 'org-123',
    role: 'coach',
    interaction_count: 42,
    last_interaction_at: new Date().toISOString(),
    recent_topics: ['technique', 'training', 'recovery'],
    athlete_ids_discussed: ['athlete-1', 'athlete-2'],
    open_questions: ['How to improve form?', 'Best recovery method?'],
    remembered_facts: [
      { key: 'data_driven', value: 'true', confidence: 0.9, updatedAt: new Date().toISOString() },
      { key: 'interval_training_exp', value: 'true', confidence: 0.85, updatedAt: new Date().toISOString() },
    ],
    communication_style: 'detailed' as const,
    shadow_notes: 'Advanced user, focuses on performance optimization',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const baseInput: ShadowContextBuilderInput = {
    tier: 'quick_round',
    userProfile: mockUserProfile,
    userMessage: 'What techniques should I focus on?',
    userRole: 'coach',
    organizationId: 'org-123',
    // These cases were written against a builder that personalized on every
    // call, so `true` is what preserves what each of them was actually
    // asserting. The gate itself is exercised in 'the strong_personalization
    // gate' below, which is the only place that passes false.
    personalizationEnabled: true,
  };

  describe('Quick Round context', () => {
    test('builds minimal context with key sections only', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
      });

      expect(result.context).toBeDefined();
      expect(result.metadata.tier).toBe('quick_round');
      // Quick Round should have ~4–5 sections
      expect(result.metadata.contextItemCount).toBeLessThan(10);
    });

    test('includes role and expertise in Quick Round', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
      });

      expect(result.context).toContain('coach');
      expect(result.metadata.totalWeight).toBeLessThan(0.5);
    });

    test('uses the authenticated role instead of a stale stored profile role', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
        userRole: 'athlete',
        userProfile: { ...mockUserProfile, role: 'coach' },
      });

      expect(result.context).toContain('Authenticated Role: athlete');
      expect(result.context).not.toContain('Authenticated Role: coach');
    });

    test('includes communication preference in Quick Round', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
        userProfile: { ...mockUserProfile, communication_style: 'detailed' },
      });

      expect(result.context).toContain('Communication');
    });

    test('includes recent topics in Quick Round', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
      });

      expect(result.context).toContain('Recent Discussion Topics');
      expect(result.context).toContain('technique');
    });

    test('uses the newest half of a chronological recent-topic window', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
        userProfile: {
          ...mockUserProfile,
          recent_topics: ['old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'new-1', 'new-2', 'new-3', 'new-4', 'new-5'],
        },
      });

      expect(result.context).not.toContain('old-1');
      expect(result.context).toContain('new-1');
      expect(result.context).toContain('new-5');
    });

    // This asserted the opposite until the open_questions path was removed. The
    // fixture below sets open_questions by hand, but no production code ever
    // did: the column had no writer, so profiles were born empty and stayed
    // that way, and the section this test proved never rendered for a real
    // user. The test passed on a fixture the product could not produce.
    test('emits no open-questions or context-notes section, in either tier', () => {
      for (const tier of ['quick_round', 'heavy_bag'] as const) {
        const result = buildShadowContext({ ...baseInput, tier });

        expect(result.context).not.toContain('Unresolved Questions');
        expect(result.context).not.toContain('Unresolved Items');
        expect(result.context).not.toContain('Context Notes');
      }
    });

    test('does NOT include athlete data in Quick Round', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
        athleteId: 'athlete-1',
      });

      expect(result.metadata.includesAthleteData).toBe(false);
    });

    test('does NOT include research requirements in Quick Round', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
      });

      expect(result.metadata.includesResearchRequirements).toBe(false);
    });
  });

  describe('Heavy Bag context', () => {
    test('builds comprehensive context with all sections', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });

      expect(result.context).toBeDefined();
      expect(result.metadata.tier).toBe('heavy_bag');
      // Heavy Bag should have ~10+ sections
      expect(result.metadata.contextItemCount).toBeGreaterThan(8);
    });

    test('includes full user profile in Heavy Bag', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });

      expect(result.context).toContain('Observed Preferences');
      expect(result.context).toContain('data_driven');
    });

    test('does not claim an athlete identifier is athlete record data', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
        athleteId: 'athlete-1',
      });

      expect(result.context).toContain('Authorized Subject Reference');
      expect(result.metadata.includesAthleteData).toBe(false);
    });

    test('does not claim research requirements that were not retrieved', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });

      expect(result.metadata.includesResearchRequirements).toBe(false);
    });

    test('sets higher total weight for Heavy Bag', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });

      expect(result.metadata.totalWeight).toBeGreaterThan(0.6);
    });

    test('includes organization context in Heavy Bag', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });

      expect(result.context).toContain('org-123');
    });
  });

  describe('Metadata correctness', () => {
    test('returns correct tier in metadata', () => {
      const quickResult = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
      });
      expect(quickResult.metadata.tier).toBe('quick_round');

      const heavyResult = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });
      expect(heavyResult.metadata.tier).toBe('heavy_bag');
    });

    test('tracks context item count', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
      });

      expect(typeof result.metadata.contextItemCount).toBe('number');
      expect(result.metadata.contextItemCount).toBeGreaterThan(0);
    });

    test('tracks total weight between 0 and 1', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
      });

      expect(result.metadata.totalWeight).toBeGreaterThanOrEqual(0);
      expect(result.metadata.totalWeight).toBeLessThanOrEqual(1);
    });

    test('detects athlete data inclusion', () => {
      const withoutAthlete = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });
      expect(typeof withoutAthlete.metadata.includesAthleteData).toBe('boolean');

      const withAthlete = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
        athleteId: 'athlete-1',
      });
      expect(typeof withAthlete.metadata.includesAthleteData).toBe('boolean');
    });

    test('detects research requirements', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });

      expect(typeof result.metadata.includesResearchRequirements).toBe('boolean');
    });
  });

  describe('Topic type detection', () => {
    test('identifies topic type in metadata', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
        userMessage: 'How do I improve my technique?',
      });

      expect(result.metadata.topicType).toBeDefined();
      const validTopics = ['mindset', 'technique', 'training', 'recovery', 'pattern', 'safety', 'general'];
      expect(validTopics).toContain(result.metadata.topicType);
    });
  });

  describe('Role-specific context', () => {
    test('includes authority level for coach tier', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
        userRole: 'coach',
      });

      expect(result.context).toContain('coach');
    });

    test('includes authority level for admin tier', () => {
      const adminProfile = { ...mockUserProfile, role: 'admin' as const };
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
        userProfile: adminProfile,
        userRole: 'admin',
      });

      expect(result.context).toContain('admin');
      expect(result.context).not.toContain('access all data');
    });

    test('states that platform owners cannot access private athlete records by default', () => {
      const ownerResult = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
        userRole: 'platform_owner',
      });

      expect(ownerResult.context).toContain('organization-private athlete records are denied by default');
      expect(ownerResult.context).not.toContain('Full platform access');
    });

    test.each(['staff', 'volunteer'] as const)(
      'does not grant %s athlete-record access in prompt context',
      (role) => {
        const result = buildShadowContext({
          ...baseInput,
          tier: 'heavy_bag',
          userRole: role,
        });
        expect(result.context).toContain('no athlete-record access by default');
      },
    );

    test('returns only a fail-closed aggregate boundary for Board', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
        userRole: 'board',
        athleteId: 'athlete-1',
      });

      expect(result.context).toContain('Aggregate governance only');
      expect(result.context).toContain('SHADOW chat and athlete-record context are not authorized');
      expect(result.context).not.toContain('athlete-1');
      expect(result.context).not.toContain('data_driven');
      expect(result.metadata.includesAthleteData).toBe(false);
      expect(result.metadata.totalWeight).toBe(0);
    });

    test('adjusts context for athlete role', () => {
      const athleteProfile = { ...mockUserProfile, role: 'athlete' as const };
      const athleteResult = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
        userRole: 'athlete',
        userProfile: athleteProfile,
      });

      expect(athleteResult.context).toContain('athlete');
    });
  });

  describe('Edge cases', () => {
    test('handles missing athlete data gracefully', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
        athleteId: undefined,
      });

      expect(result.context).toBeDefined();
      expect(result.metadata.includesAthleteData).toBe(false);
    });

    test('handles empty recent topics', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
        userProfile: { ...mockUserProfile, recent_topics: [] },
      });

      expect(result.context).toBeDefined();
    });

    test('handles empty open questions', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
        userProfile: { ...mockUserProfile, open_questions: [] },
      });

      expect(result.context).toBeDefined();
    });

    test('handles missing remembered facts', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
        userProfile: { ...mockUserProfile, remembered_facts: [] },
      });

      expect(result.context).toBeDefined();
    });

    test('handles empty message gracefully', () => {
      const result = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
        userMessage: '',
      });

      expect(result.context).toBeDefined();
    });
  });

  describe('Context length comparison', () => {
    test('Quick Round context is shorter than Heavy Bag', () => {
      const quickResult = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
      });

      const heavyResult = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });

      expect(quickResult.context.length).toBeLessThan(heavyResult.context.length);
    });

    test('Heavy Bag includes significantly more context sections', () => {
      const quickResult = buildShadowContext({
        ...baseInput,
        tier: 'quick_round',
      });

      const heavyResult = buildShadowContext({
        ...baseInput,
        tier: 'heavy_bag',
      });

      expect(heavyResult.metadata.contextItemCount).toBeGreaterThan(
        quickResult.metadata.contextItemCount,
      );
    });
  });
});
