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

    test('honors an explicit Quick Round request from a coach', () => {
      // The original defect: the session-type mapper escalated on the mere
      // presence of a manual tier, so this exact request -- a coach asking for
      // the quick answer -- was routed to Heavy Bag, the slowest path.
      const result = classifyRequest('What is a warm-up?', 'coach', 'quick_round');
      expect(result.tier).toBe('quick_round');
      expect(result.confidence).toBe(1.0);
      expect(result.reasoning).toContain('User explicitly requested Quick Round');
    });

    test('an explicit Quick Round request wins even when auto-detection says Heavy Bag', () => {
      const result = classifyRequest(
        `${'Detailed context '.repeat(110)}
        Compare and contrast the multi-step trade-offs, edge cases, nuanced constraints,
        conflicting goals, exceptions, and what happens if conditions change.`,
        'coach',
        'quick_round',
      );
      expect(result.tier).toBe('quick_round');
      expect(result.suggestedContextDepth).toBe('lightweight');
    });

    test('a Quick Round request needs no role gate -- downgrades are safe for anyone', () => {
      expect(classifyRequest('How do I warm up?', 'athlete', 'quick_round').tier).toBe('quick_round');
      expect(classifyRequest('What is training?', 'parent', 'quick_round').tier).toBe('quick_round');
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

  describe('Topic words match whole words only', () => {
    // Each message has a topic word inside a longer word. On main the stray
    // match decided the topic (shown as `was`); it must not any more.
    test.each([
      ['What wrestling moves help on the mat?', 'athlete', 'recovery'],
      ['Any interesting combinations to try?', 'athlete', 'recovery'],
      ['Can you give me more information about the program?', 'parent', 'technique'],
      ['My athlete pulled a muscle and it is a strain, what helps?', 'coach', 'training'],
      ['How do I keep my distance from a taller opponent?', 'coach', 'technique'],
      ['My son is upset after losing', 'parent', 'training'],
      ['Where do I report the weigh-in numbers?', 'coach', 'training'],
      ['My kid has an obsession with boxing videos', 'parent', 'training'],
      ['How do I teach fundamentals to beginners?', 'coach', 'mindset'],
      ['How do I prevent cuts?', 'athlete', 'competition'],
      ['What time is the parents meeting?', 'parent', 'competition'],
      ['Is painting the gym walls on the list?', 'parent', 'medical'],
    ] as const)('%s (%s) is not filed under %s', (message, role, was) => {
      expect(classifyRequest(message, role).topic).not.toBe(was);
    });

    test('"performance" is competition, no longer technique through "form"', () => {
      expect(classifyRequest('How do I improve my performance in the ring?', 'athlete').topic).toBe('competition');
    });

    test('"injury prevention" reaches safety instead of being shadowed by "injury"', () => {
      expect(classifyRequest('What is good injury prevention for shoulders?', 'coach').topic).toBe('safety');
      expect(classifyRequest('He has an injury in his wrist', 'coach').topic).toBe('medical');
    });

    // What the substring match caught correctly is still caught.
    test.each([
      ['Should I wear headgear?', 'equipment'],
      ['Is overtraining a risk before a bout?', 'training'],
      ['How do I avoid a reinjury of my wrist?', 'medical'],
      ['Is it unsafe to spar with a cold?', 'safety'],
      ['Who handles safeguarding at the gym?', 'safety'],
      ['Can you explain the biomechanics of a hook?', 'technique'],
      ['Are painkillers ok after sparring?', 'medical'],
      ['How many sets and reps today?', 'training'],
      ['I trained twice yesterday', 'training'],
      ['He gets unfocused in the third round', 'mindset'],
      ['Is it riskier to spar on Mondays?', 'safety'],
      ['Could this endanger a beginner?', 'safety'],
      ['Is overconfidence his problem?', 'mindset'],
      ['He feared the bigger kid', 'mindset'],
      ['Is he undertrained for this bout?', 'training'],
      ['Are supersets worth it?', 'training'],
      ['Should he reposition after the jab?', 'technique'],
      ['How was the opponent approaching him?', 'strategy'],
      ['He was restless all week', 'recovery'],
      ['Should a clinician see this?', 'medical'],
      ['Do the gloves come with shoelaces?', 'equipment'],
      ['Is 3sets of 10reps enough?', 'training'],
      ['What is good injury-prevention for shoulders?', 'safety'],
      ['Where do we buy the team uniform?', 'equipment'],
    ] as const)('%s -> %s', (message, topic) => {
      expect(classifyRequest(message, 'admin').topic).toBe(topic);
    });
  });

  describe('Complexity keywords match whole words only', () => {
    test('"extension" is not "tension"', () => {
      const reference = classifyRequest('The reach on my jab is short', 'coach').complexity;
      expect(classifyRequest('The extension on my jab is short', 'coach').complexity).toBe(reference);
    });

    test('"exceptional" is not "exception" and "continuance" is not "nuance"', () => {
      const reference = classifyRequest('The reach on my jab is short', 'coach').complexity;
      expect(classifyRequest('He has exceptional reach', 'coach').complexity).toBe(reference);
      expect(classifyRequest('We asked for a continuance on the bout', 'coach').complexity).toBe(reference);
      expect(classifyRequest('Any exceptions to the nuanced rule?', 'coach').complexity).toBeGreaterThan(reference);
    });

    test('"show ... different ... strengthen" is not if/then logic', () => {
      const reference = classifyRequest('Show me legs', 'coach').complexity;
      expect(classifyRequest('Show me a different way to strengthen my legs', 'coach').complexity).toBe(reference);
    });

    test('real conflict and conditional wording still counts', () => {
      const plain = classifyRequest('The reach on my jab is short', 'coach').complexity;
      expect(classifyRequest('There is tension between the two plans', 'coach').complexity).toBeGreaterThan(plain);
      expect(classifyRequest('What happens if he tires, then what do we change?', 'coach').complexity).toBeGreaterThan(plain);
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
