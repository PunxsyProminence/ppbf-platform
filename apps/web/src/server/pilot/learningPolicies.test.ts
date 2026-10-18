import { barFor, citationsFrom } from './learningPolicies';
import {
  APPROVED_ATHLETE_LESSON_V1,
  APPROVED_CITATIONS_V1,
  APPROVED_OBSERVER_CALIBRATION_V1,
  APPROVED_PATTERN_FORMATION_V1,
} from './learningPolicyApprovedV1';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('the approved v1 bars (Jason 2026-10-18)', () => {
  test('each is a well-formed bar of its kind, and each carries cited sources', () => {
    expect(barFor('pattern_formation', APPROVED_PATTERN_FORMATION_V1)).toEqual(APPROVED_PATTERN_FORMATION_V1);
    expect(barFor('athlete_lesson', APPROVED_ATHLETE_LESSON_V1)).toEqual(APPROVED_ATHLETE_LESSON_V1);
    expect(barFor('observer_calibration', APPROVED_OBSERVER_CALIBRATION_V1)).toEqual(APPROVED_OBSERVER_CALIBRATION_V1);
    for (const citations of Object.values(APPROVED_CITATIONS_V1)) {
      expect(citationsFrom(citations).length).toBeGreaterThanOrEqual(2);
    }
  });

  // Pinned against the report's section 1 table as Jason approved it, so a
  // changed number is a deliberate, reviewed edit rather than drift.
  test('the numbers are the report\'s minimum / default / strict columns', () => {
    const { tiers } = APPROVED_PATTERN_FORMATION_V1;
    expect([tiers.emerging, tiers.pattern, tiers.established].map((tier) => [
      tier.minimumSessions, tier.minimumCodedChances, tier.minimumShare, tier.minimumContexts,
      tier.minimumSpanDays, tier.lapseAfterMisses,
    ])).toEqual([[3, 5, 0.8, 1, 7, 5], [5, 8, 0.8, 2, 14, 3], [7, 12, 0.9, 3, 28, 2]]);
    expect(tiers.pattern.observers).toEqual({
      minimumCoaches: 2, orDoubleCodedShare: 0.2, minimumSessionsPerCoach: null, agreementRequired: true,
    });
    expect(APPROVED_PATTERN_FORMATION_V1.currentWithinDays).toBe(84);
    expect(Object.values(APPROVED_ATHLETE_LESSON_V1.labels).map((label) => label.demonstrations)).toEqual([1, 2, 3]);
    expect(APPROVED_ATHLETE_LESSON_V1.labels.likely_worked).toEqual({ demonstrations: 2, staggered: true, delayedProbe: true });
    expect([APPROVED_OBSERVER_CALIBRATION_V1.minimumAgreement, APPROVED_OBSERVER_CALIBRATION_V1.minimumKappa,
      APPROVED_OBSERVER_CALIBRATION_V1.minimumPairedJudgments]).toEqual([0.8, 0.6, 30]);
    expect(APPROVED_OBSERVER_CALIBRATION_V1.uncalibrated).toBe('unverified');
  });
});

describe('citations', () => {
  test('a bar needs at least one source, each named', () => {
    expect(() => citationsFrom([])).toThrow('at least one cited source');
    expect(() => citationsFrom(undefined)).toThrow('at least one cited source');
    expect(() => citationsFrom([{ note: 'no source' }])).toThrow('names its source');
    expect(() => citationsFrom([{ source: '   ' }])).toThrow('names its source');
    expect(() => citationsFrom(Array.from({ length: 21 }, () => ({ source: 's' })))).toThrow('at most 20');
    expect(citationsFrom([{ source: ' A source ', note: ' a note ' }, { source: 'B' }]))
      .toEqual([{ source: 'A source', note: 'a note' }, { source: 'B' }]);
  });
});

describe('a bar is exactly its kind\'s shape', () => {
  test('no field missing, none extra, at any depth', () => {
    const missing = clone(APPROVED_PATTERN_FORMATION_V1) as unknown as Record<string, unknown>;
    delete missing.currentWithinDays;
    expect(() => barFor('pattern_formation', missing)).toThrow('missing currentWithinDays');
    const extra = clone(APPROVED_PATTERN_FORMATION_V1) as unknown as { tiers: { pattern: Record<string, unknown> } };
    extra.tiers.pattern.minimumOccurrences = 3;
    expect(() => barFor('pattern_formation', extra)).toThrow('parameters.tiers.pattern must be exactly');
    expect(() => barFor('athlete_lesson', APPROVED_PATTERN_FORMATION_V1)).toThrow('parameters must be exactly');
    expect(() => barFor('observer_calibration', [1])).toThrow('an object');
  });

  test('each value of its kind', () => {
    const share = clone(APPROVED_PATTERN_FORMATION_V1);
    share.tiers.emerging.minimumShare = 1.2;
    expect(() => barFor('pattern_formation', share)).toThrow('parameters.tiers.emerging.minimumShare must be a share');
    const method = clone(APPROVED_ATHLETE_LESSON_V1) as unknown as { effectRule: { method: string } };
    method.effectRule.method = 'split_middle';
    expect(() => barFor('athlete_lesson', method)).toThrow("'conservative_dual_criterion'");
    const weeks = clone(APPROVED_ATHLETE_LESSON_V1);
    weeks.followUpWeeks = [4, 1];
    expect(() => barFor('athlete_lesson', weeks)).toThrow('rising order');
    const pairs = clone(APPROVED_OBSERVER_CALIBRATION_V1);
    pairs.minimumPairedJudgments = 1;
    expect(() => barFor('observer_calibration', pairs)).toThrow('at least 2');
  });

  test('each harder tier asks at least as much, and each stronger label needs more demonstrations', () => {
    const tiers = clone(APPROVED_PATTERN_FORMATION_V1);
    tiers.tiers.established.minimumSessions = 4;
    expect(() => barFor('pattern_formation', tiers)).toThrow('tiers.established.minimumSessions');
    const lapse = clone(APPROVED_PATTERN_FORMATION_V1);
    lapse.tiers.established.lapseAfterMisses = 6;
    expect(() => barFor('pattern_formation', lapse)).toThrow('tiers.established.lapseAfterMisses');
    const labels = clone(APPROVED_ATHLETE_LESSON_V1);
    labels.labels.worked_replicated.demonstrations = 2;
    expect(() => barFor('athlete_lesson', labels)).toThrow('labels.worked_replicated.demonstrations');
  });

  test('a refusal is a 400 reason', () => {
    try {
      barFor('observer_calibration', {});
    } catch (error) {
      expect((error as { status?: number }).status).toBe(400);
      return;
    }
    throw new Error('expected a refusal');
  });
});
