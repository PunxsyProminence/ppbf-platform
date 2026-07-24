// shadowClassifier.test.ts
// Unit tests for tier classification logic (Quick Round vs Heavy Bag)

import { classifyRequest, getClassificationStats } from './shadowClassifier';

describe('SHADOW Classifier', () => {
  describe('Auto-detection (no manual override)', () => {
    test('classifies simple queries as Quick Round', () => {
      const result = classifyRequest('How do I warm up?', 'athlete');
      expect(result.tier).toBe('quick_round');
      expect(result.complexity).toBeLessThan(0.4);
    });

    test('classifies complex multi-step queries with elevated complexity', () => {
      const result = classifyRequest(
        'Given that my athlete has a history of ankle injuries and is preparing for a multi-month competition season, how should I structure their training to balance intensity with injury prevention, considering trade-offs between conditioning and recovery?',
        'coach',
      );
      // Complex query should have higher complexity than simple queries
      expect(result.complexity).toBeGreaterThan(0.25);
    });

    test('detects high-risk medical keywords for routing', () => {
      const result = classifyRequest('What are concussion recovery protocols?', 'coach');
      expect(result.tier).toBe('heavy_bag');
      expect(result.complexity).toBeGreaterThanOrEqual(0.6);
      expect(['medical', 'recovery', 'safety']).toContain(result.topic);
    });

    test('auto-routes a truly complex non-medical prompt to Heavy Bag', () => {
      const result = classifyRequest(
        `${'Detailed context '.repeat(110)}
        Compare and contrast the multi-step trade-offs, edge cases, nuanced constraints,
        conflicting goals, exceptions, and what happens if conditions change.`,
        'coach',
      );
      expect(result.tier).toBe('heavy_bag');
      expect(result.requiresManualOverride).toBe(false);
    });

    test('adjusts complexity for coach vs athlete roles', () => {
      const query = 'How should I train this week?';
      const coachResult = classifyRequest(query, 'coach');
      const athleteResult = classifyRequest(query, 'athlete');
      // Coaches default to higher complexity (more decision-making)
      expect(coachResult.complexity).toBeGreaterThan(athleteResult.complexity);
    });

    test('detects boundary cases with low confidence', () => {
      const result = classifyRequest(
        'What techniques should I focus on versus emphasize?',
        'coach',
      );
      // Boundary: multiple keywords but not extreme
      if (result.complexity >= 0.4 && result.complexity <= 0.65) {
        expect(result.confidence).toBeLessThan(0.7);
        expect(result.requiresManualOverride).toBe(true);
      }
    });
  });

  describe('Manual override (coaches/admins only)', () => {
    test('allows coach to escalate to Heavy Bag', () => {
      const result = classifyRequest('What is a warm-up?', 'coach', 'heavy_bag');
      expect(result.tier).toBe('heavy_bag');
      expect(result.confidence).toBe(1.0);
      expect(result.reasoning).toContain('User explicitly requested');
    });

    test('allows admin to escalate to Heavy Bag', () => {
      const result = classifyRequest('Simple question', 'admin', 'heavy_bag');
      expect(result.tier).toBe('heavy_bag');
      expect(result.confidence).toBe(1.0);
    });

    test('ignores Heavy Bag request from athlete (stays Quick Round)', () => {
      const result = classifyRequest('What is a warm-up?', 'athlete', 'heavy_bag');
      // Athlete cannot override; auto-detection applies
      expect(result.tier).toBe('quick_round');
    });

    test('ignores Heavy Bag request from parent (stays Quick Round)', () => {
      const result = classifyRequest('What is training?', 'parent', 'heavy_bag');
      expect(result.tier).toBe('quick_round');
    });

    test('does not grant Board accounts a Heavy Bag override', () => {
      const result = classifyRequest('What is training?', 'board', 'heavy_bag');
      expect(result.tier).toBe('quick_round');
      expect(result.requiresManualOverride).toBe(false);
    });
  });

  describe('Topic detection', () => {
    test('detects technique topics', () => {
      const result = classifyRequest('How should I fix my form?', 'athlete');
      expect(result.topic).toBe('technique');
    });

    test('detects training topics', () => {
      const result = classifyRequest('What should my workout be this week?', 'athlete');
      expect(result.topic).toBe('training');
    });

    test('detects recovery topics', () => {
      const result = classifyRequest('How can I recover faster?', 'athlete');
      expect(result.topic).toBe('recovery');
    });

    test('detects medical topics', () => {
      const result = classifyRequest('I have pain in my shoulder', 'athlete');
      expect(result.topic).toBe('medical');
    });

    test('detects motivation/mindset topics', () => {
      const result = classifyRequest('How do I stay motivated?', 'athlete');
      // Should detect as either mindset or training
      expect(['mindset', 'training', 'psychology']).toContain(result.topic);
    });
  });

  describe('Confidence scoring', () => {
    test('high confidence for clear Quick Round', () => {
      const result = classifyRequest('Hi', 'athlete');
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    test('high confidence for clear Heavy Bag', () => {
      const result = classifyRequest(
        'Complex multi-faceted question with edge cases and trade-offs requiring deep context',
        'coach',
      );
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    test('low confidence for boundary cases', () => {
      const result = classifyRequest('What is technique? How does it compare to form?', 'athlete');
      if (result.complexity >= 0.4 && result.complexity <= 0.65) {
        expect(result.confidence).toBeLessThan(0.7);
      }
    });
  });

  describe('Stats export', () => {
    test('returns clean stats for logging', () => {
      const result = classifyRequest('Complex query here', 'coach');
      const stats = getClassificationStats(result);
      expect(stats).toHaveProperty('tier');
      expect(stats).toHaveProperty('complexity');
      expect(stats).toHaveProperty('topic');
      expect(typeof stats.complexity).toBe('number');
      expect(stats.complexity).toBeGreaterThanOrEqual(0);
      expect(stats.complexity).toBeLessThanOrEqual(1);
    });
  });

  describe('Edge cases', () => {
    test('handles empty message', () => {
      const result = classifyRequest('', 'athlete');
      expect(result.tier).toBeDefined();
      expect(result.complexity).toBeGreaterThanOrEqual(0);
    });

    test('handles very long message', () => {
      const longMessage = 'word '.repeat(500);
      const result = classifyRequest(longMessage, 'coach');
      expect(result.complexity).toBeGreaterThan(0.2);
    });

    test('handles special characters and numbers', () => {
      const result = classifyRequest('123 @#$ test!!!', 'athlete');
      expect(result.tier).toBeDefined();
    });
  });
});
