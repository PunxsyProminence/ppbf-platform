import { assertApprovedBar, barFor, citationsFrom } from './learningPolicies';
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

  // Pinned whole against the report's section 1 table as Jason approved it
  // (row ids in learningPolicyApprovedV1.ts), so any changed number or flag is a
  // deliberate, reviewed edit rather than drift.
  test('the numbers are the report\'s minimum / default / strict columns, every one', () => {
    expect(APPROVED_PATTERN_FORMATION_V1).toEqual({
      currentWithinDays: 84,
      tiers: {
        emerging: {
          minimumSessions: 3, minimumCodedChances: 5, minimumShare: 0.8, minimumContexts: 1, minimumSpanDays: 7,
          observers: { minimumCoaches: 1, minimumSessionsPerCoach: null, coachesMustAgree: false, orDoubleCodedShare: null },
          lapseAfterMisses: 5,
        },
        pattern: {
          minimumSessions: 5, minimumCodedChances: 8, minimumShare: 0.8, minimumContexts: 2, minimumSpanDays: 14,
          observers: { minimumCoaches: 2, minimumSessionsPerCoach: null, coachesMustAgree: false, orDoubleCodedShare: 0.2 },
          lapseAfterMisses: 3,
        },
        established: {
          minimumSessions: 7, minimumCodedChances: 12, minimumShare: 0.9, minimumContexts: 3, minimumSpanDays: 28,
          observers: { minimumCoaches: 2, minimumSessionsPerCoach: 3, coachesMustAgree: true, orDoubleCodedShare: null },
          lapseAfterMisses: 2,
        },
      },
    });
    expect(APPROVED_ATHLETE_LESSON_V1).toEqual({
      baselinePoints: 5,
      afterPoints: 5,
      effectRule: { method: 'conservative_dual_criterion', shiftSd: 0.25, alpha: 0.05, immediacyFirstPoints: 3 },
      baselineTrendScreenMaxNap: 0.85,
      requireDeliveryRecorded: true,
      requireSameObserversAndTiming: true,
      delayedProbe: { minimumHours: 24, withinDays: 7 },
      labels: {
        improved_after: { demonstrations: 1, staggered: false, delayedProbe: false },
        likely_worked: { demonstrations: 2, staggered: true, delayedProbe: true },
        worked_replicated: { demonstrations: 3, staggered: true, delayedProbe: true },
      },
      followUpWeeks: [1, 4, 12],
      regressionAfterConsecutive: 3,
      regressionWhenEffectRuleFails: true,
      recheckAfterAbsenceDays: 14,
    });
    expect(APPROVED_OBSERVER_CALIBRATION_V1).toEqual({
      minimumAgreement: 0.8,
      minimumKappa: 0.6,
      minimumPairedJudgments: 30,
      ongoingDoubleCodedShare: 0.2,
      ongoingDoubleCodedScope: 'every_phase',
      belowBar: 'stop_counting',
      uncalibrated: 'unverified',
    });
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

  test('a harder tier never asks less of who saw it, and a stronger label never drops a condition', () => {
    const coaches = clone(APPROVED_PATTERN_FORMATION_V1);
    coaches.tiers.established.observers.minimumCoaches = 1;
    expect(() => barFor('pattern_formation', coaches)).toThrow('tiers.established.observers.minimumCoaches');
    const agree = clone(APPROVED_PATTERN_FORMATION_V1);
    agree.tiers.pattern.observers.coachesMustAgree = true;
    expect(() => barFor('pattern_formation', agree)).not.toThrow();
    agree.tiers.established.observers.coachesMustAgree = false;
    expect(() => barFor('pattern_formation', agree)).toThrow('tiers.established.observers.coachesMustAgree');
    const each = clone(APPROVED_PATTERN_FORMATION_V1);
    each.tiers.pattern.observers.minimumSessionsPerCoach = 4;
    expect(() => barFor('pattern_formation', each)).toThrow('tiers.established.observers.minimumSessionsPerCoach');
    const probe = clone(APPROVED_ATHLETE_LESSON_V1);
    probe.labels.worked_replicated.delayedProbe = false;
    expect(() => barFor('athlete_lesson', probe)).toThrow('labels.worked_replicated.delayedProbe');
    const staggered = clone(APPROVED_ATHLETE_LESSON_V1);
    staggered.labels.worked_replicated.staggered = false;
    expect(() => barFor('athlete_lesson', staggered)).toThrow('labels.worked_replicated.staggered');
  });

  test('every rule can be met: no window too short, no test that passes anything', () => {
    const currency = clone(APPROVED_PATTERN_FORMATION_V1);
    currency.currentWithinDays = 7;
    expect(() => barFor('pattern_formation', currency)).toThrow('currentWithinDays');
    const alpha = clone(APPROVED_ATHLETE_LESSON_V1);
    alpha.effectRule.alpha = 1;
    expect(() => barFor('athlete_lesson', alpha)).toThrow('effectRule.alpha');
    const window = clone(APPROVED_ATHLETE_LESSON_V1);
    window.delayedProbe.minimumHours = 200;
    expect(() => barFor('athlete_lesson', window)).toThrow('delayedProbe.minimumHours');
    const immediacy = clone(APPROVED_ATHLETE_LESSON_V1);
    immediacy.effectRule.immediacyFirstPoints = 9;
    expect(() => barFor('athlete_lesson', immediacy)).toThrow('effectRule.immediacyFirstPoints');
    const kappa = clone(APPROVED_OBSERVER_CALIBRATION_V1);
    kappa.minimumKappa = 1;
    expect(() => barFor('observer_calibration', kappa)).toThrow('minimumKappa');
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

describe('only the approved v1 bar and sources can be put in force (OD-2026-10-18-003)', () => {
  test('the approved bar and sources of each kind pass, as a client would send them', () => {
    expect(() => assertApprovedBar('pattern_formation', clone(APPROVED_PATTERN_FORMATION_V1), citationsFrom(clone(APPROVED_CITATIONS_V1.pattern_formation)))).not.toThrow();
    expect(() => assertApprovedBar('athlete_lesson', clone(APPROVED_ATHLETE_LESSON_V1), citationsFrom(clone(APPROVED_CITATIONS_V1.athlete_lesson)))).not.toThrow();
    expect(() => assertApprovedBar('observer_calibration', clone(APPROVED_OBSERVER_CALIBRATION_V1), citationsFrom(clone(APPROVED_CITATIONS_V1.observer_calibration)))).not.toThrow();
  });

  test('a well-formed bar with other numbers is refused', () => {
    const looser = clone(APPROVED_PATTERN_FORMATION_V1);
    looser.tiers.emerging.minimumSessions = 1;
    expect(barFor('pattern_formation', looser)).toEqual(looser);
    expect(() => assertApprovedBar('pattern_formation', looser, citationsFrom(APPROVED_CITATIONS_V1.pattern_formation)))
      .toThrow('Only the approved numbers');
    expect(() => assertApprovedBar('athlete_lesson', APPROVED_PATTERN_FORMATION_V1, citationsFrom(APPROVED_CITATIONS_V1.athlete_lesson)))
      .toThrow('Only the approved numbers');
  });

  test("other sources, fewer sources, or another kind's sources are refused", () => {
    const bar = APPROVED_OBSERVER_CALIBRATION_V1;
    expect(() => assertApprovedBar('observer_calibration', bar, [{ source: 'x' }])).toThrow('Only the approved cited sources');
    expect(() => assertApprovedBar('observer_calibration', bar, citationsFrom(APPROVED_CITATIONS_V1.observer_calibration.slice(1))))
      .toThrow('Only the approved cited sources');
    expect(() => assertApprovedBar('observer_calibration', bar, citationsFrom(APPROVED_CITATIONS_V1.athlete_lesson)))
      .toThrow('Only the approved cited sources');
  });
});
