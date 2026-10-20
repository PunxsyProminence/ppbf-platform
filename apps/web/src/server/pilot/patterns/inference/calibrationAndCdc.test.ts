/**
 * Coach-pair calibration (reliability.ts assessPairCalibration) and the
 * conservative dual-criterion with its baseline trend screen
 * (singleCase.ts conservativeDualCriterion), against hand-worked numbers.
 */

import { assessPairCalibration, pairKey } from './reliability';
import { binomialUpperTail, conservativeDualCriterion } from './singleCase';
import type { BehaviourObservation, ObservationPolarity } from '../types';

function coded(attempt: number, observer: string, polarity: ObservationPolarity): BehaviourObservation {
  return {
    observationId: `${observer}-${attempt}`,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    behaviourKey: 'drops_lead_hand_after_jab',
    sessionId: 'session-1',
    taskContextKey: 'task-mitts',
    taskConstraint: 'controlled',
    fatigueContext: 'unknown',
    observedAt: '2026-06-01T10:00:00.000Z',
    source: { type: 'coach_tag', quality: 'moderate', referenceId: `r-${observer}-${attempt}` },
    observerAccountId: observer,
    interpretation: 'human_observed',
    polarity,
    attribution: { target: 'athlete', certainty: 'probable' },
    opportunityKey: `rep-${attempt}`,
  };
}

describe('coach-pair calibration', () => {
  // Ten attempts: both "present" 4, both "absent" 4, one split each way.
  // Agreement .8; each coach says present half the time, so chance .5 and
  // kappa .6 -- exactly the approved default bar.
  const plan: [ObservationPolarity, ObservationPolarity][] = [
    ...Array.from({ length: 4 }, () => ['occurrence', 'occurrence'] as [ObservationPolarity, ObservationPolarity]),
    ...Array.from({ length: 4 }, () => ['counterexample', 'counterexample'] as [ObservationPolarity, ObservationPolarity]),
    ['occurrence', 'counterexample'],
    ['counterexample', 'occurrence'],
  ];
  const readings = plan.flatMap(([a, b], index) => [coded(index, 'coach-a', a), coded(index, 'coach-b', b)]);

  test('agreement, Cohen kappa, and present/absent agreement for one pair', () => {
    const pair = assessPairCalibration(readings, { minimumAgreement: 0.8, minimumKappa: 0.6, minimumPairedJudgments: 10 })
      .get(pairKey('coach-b', 'coach-a'));
    expect(pair?.pairedJudgments).toBe(10);
    expect(pair?.observedAgreement).toBeCloseTo(0.8, 10);
    expect(pair?.kappa).toBeCloseTo(0.6, 10);
    expect(pair?.presentAgreement).toBeCloseTo(0.8, 10);
    expect(pair?.absentAgreement).toBeCloseTo(0.8, 10);
    expect(pair?.calibrated).toBe(true);
  });

  test('too few judgments, or a kappa chance cannot be separated from, is not calibrated', () => {
    const bar = { minimumAgreement: 0.8, minimumKappa: 0.6, minimumPairedJudgments: 30 };
    expect(assessPairCalibration(readings, bar).get(pairKey('coach-a', 'coach-b'))?.calibrated).toBe(false);
    const allPresent = [0, 1, 2].flatMap((index) => [coded(index, 'coach-a', 'occurrence'), coded(index, 'coach-b', 'occurrence')]);
    const degenerate = assessPairCalibration(allPresent, { ...bar, minimumPairedJudgments: 2 }).get(pairKey('coach-a', 'coach-b'));
    expect(degenerate?.kappa).toBeNull();
    expect(degenerate?.calibrated).toBe(false);
  });

  test('readings with no attempt key, or from a model, never pair', () => {
    const unkeyed = readings.map((reading) => ({ ...reading, opportunityKey: null }));
    expect(assessPairCalibration(unkeyed, { minimumAgreement: 0, minimumKappa: 0, minimumPairedJudgments: 1 }).size).toBe(0);
    const model = readings.map((reading) => (reading.observerAccountId === 'coach-b'
      ? { ...reading, interpretation: 'ai_proposed' as const } : reading));
    expect(assessPairCalibration(model, { minimumAgreement: 0, minimumKappa: 0, minimumPairedJudgments: 1 }).size).toBe(0);
  });
});

describe('conservative dual-criterion', () => {
  const rule = {
    baselinePoints: 5, afterPoints: 5, shiftSd: 0.25, alpha: 0.05, immediacyFirstPoints: 3, baselineTrendScreenMaxNap: 0.85,
  };

  test('the binomial tail is exact', () => {
    expect(binomialUpperTail(5, 5)).toBeCloseTo(1 / 32, 12);
    expect(binomialUpperTail(4, 5)).toBeCloseTo(6 / 32, 12);
    expect(binomialUpperTail(0, 5)).toBe(1);
  });

  test('a fault that fell away after the lesson, at once and every time: an effect', () => {
    const result = conservativeDualCriterion([5, 6, 5, 6, 5], [2, 1, 2, 1, 2], 'decrease', rule);
    expect(result.verdict).toBe('effect');
    expect(result.pointsBeyondBothLines).toBe(5);
    expect(result.pValue).toBeCloseTo(1 / 32, 12);
    expect(result.immediacy).toBe(true);
  });

  test('no change is no effect; four of five is not enough for five points', () => {
    expect(conservativeDualCriterion([5, 6, 5, 6, 5], [5, 6, 5, 6, 5], 'decrease', rule).verdict).toBe('no_effect');
    expect(conservativeDualCriterion([5, 6, 5, 6, 5], [2, 1, 2, 1, 6], 'decrease', rule).verdict).toBe('no_effect');
  });

  test('an athlete already improving before the lesson gives it no credit', () => {
    const result = conservativeDualCriterion([9, 8, 3, 2, 1], [1, 1, 1, 1, 1], 'decrease', rule);
    expect(result.verdict).toBe('baseline_already_improving');
    expect(result.baselineTrendNap).toBe(1);
  });

  test('too few points on either side is too few', () => {
    expect(conservativeDualCriterion([5, 6, 5], [1, 1, 1, 1, 1], 'decrease', rule).verdict).toBe('too_few_points');
    expect(conservativeDualCriterion([5, 6, 5, 6, 5], [1, 1, 1], 'decrease', rule).verdict).toBe('too_few_points');
  });
});
