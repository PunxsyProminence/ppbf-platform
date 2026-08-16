import { assessStratifiedAttribution } from './attribution';
import type { PatternInferencePolicy } from './policy';
import type { BehaviourObservation } from '../types';

const policy: PatternInferencePolicy = {
  policyVersion: 'inference-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  recurrencePrior: { priorOccurrences: 1, priorNonOccurrences: 3 },
  sequentialTest: { nullRate: 0.2, alternativeRate: 0.6, falsePromotionRate: 0.05, missedPatternRate: 0.2 },
  posteriorWidth: { credibleMass: 0.9, maximumCredibleWidth: 0.4 },
  stratifiedAttribution: { concentration: 1, minimumStratumSize: 2 },
  drift: { ewmaLambda: 0.3, cusumSlack: 0.1, cusumThreshold: 0.4, minimumHistorySessions: 3 },
};

function obs(index: number, overrides: Partial<BehaviourObservation> = {}): BehaviourObservation {
  return {
    observationId: `obs-${index}`,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    behaviourKey: 'drops_lead_hand_after_jab',
    sessionId: `session-${index}`,
    taskContextKey: 'task-mitts',
    taskConstraint: 'controlled',
    fatigueContext: 'fresh',
    observedAt: `2026-06-${String(index).padStart(2, '0')}T10:00:00.000Z`,
    source: { type: 'coach_tag', quality: 'high', referenceId: `ref-${index}` },
    observerAccountId: 'coach-a',
    interpretation: 'human_observed',
    polarity: 'occurrence',
    attribution: { target: 'athlete', certainty: 'probable' },
    ...overrides,
  };
}

describe('stratified attribution (§2.4)', () => {
  test('agreeing strata produce no disagreement', () => {
    const result = assessStratifiedAttribution([
      obs(1, { taskConstraint: 'controlled' }),
      obs(2, { taskConstraint: 'controlled' }),
      obs(3, { taskConstraint: 'live' }),
      obs(4, { taskConstraint: 'live' }),
    ], policy);

    expect(result.disagreement).toBe(false);
    expect(result.reasons).not.toContain('STRATA_DISAGREEMENT');
  });

  test('strata naming different culprits yields attribution_unresolved', () => {
    // Controlled drills blame the athlete; live rounds blame the coach's cue.
    // Pooled, "athlete" would win 2-2 on a tiebreak. Split, nobody wins.
    const result = assessStratifiedAttribution([
      obs(1, { taskConstraint: 'controlled', attribution: { target: 'athlete', certainty: 'probable' } }),
      obs(2, { taskConstraint: 'controlled', attribution: { target: 'athlete', certainty: 'probable' } }),
      obs(3, { taskConstraint: 'live', attribution: { target: 'coach_cue', certainty: 'probable' } }),
      obs(4, { taskConstraint: 'live', attribution: { target: 'coach_cue', certainty: 'probable' } }),
    ], policy);

    expect(result.disagreement).toBe(true);
    expect(result.disagreeingAxes).toContain('task_constraint');
    expect(result.reasons).toContain('STRATA_DISAGREEMENT');
  });

  test('a thin stratum is not a second opinion', () => {
    // One dissenting observation against four: below minimumStratumSize, so it
    // is reported as thin rather than allowed to contest the finding.
    const result = assessStratifiedAttribution([
      obs(1, { taskConstraint: 'controlled' }),
      obs(2, { taskConstraint: 'controlled' }),
      obs(3, { taskConstraint: 'controlled' }),
      obs(4, { taskConstraint: 'live', attribution: { target: 'coach_cue', certainty: 'uncertain' } }),
    ], policy);

    expect(result.disagreement).toBe(false);
    const liveStratum = result.strata.find((s) => s.axis === 'task_constraint' && s.key === 'live');
    expect(liveStratum?.eligible).toBe(false);
  });

  test('fatigue-only breakdown implicates the load stratum, not the athlete', () => {
    // Ten fatigued rounds where it happens every time; ten fresh rounds where
    // it never does. The intervals do not overlap.
    const fatigued = Array.from({ length: 10 }, (_, i) => obs(i + 1, {
      fatigueContext: 'fatigued',
      sessionId: `session-f${i}`,
    }));
    const fresh = Array.from({ length: 10 }, (_, i) => obs(i + 11, {
      fatigueContext: 'fresh',
      sessionId: `session-r${i}`,
      polarity: 'counterexample',
    }));

    const result = assessStratifiedAttribution([...fatigued, ...fresh], policy);
    expect(result.loadImplicated).toBe(true);
    expect(result.reasons).toContain('LOAD_STRATUM_IMPLICATED');
  });

  test('an even spread across fatigue states implicates no load stratum', () => {
    const result = assessStratifiedAttribution([
      obs(1, { fatigueContext: 'fresh' }),
      obs(2, { fatigueContext: 'fresh' }),
      obs(3, { fatigueContext: 'fatigued' }),
      obs(4, { fatigueContext: 'fatigued' }),
    ], policy);
    expect(result.loadImplicated).toBe(false);
  });

  test('unknown fatigue is not a stratum', () => {
    // A gap in the record must not become a condition the athlete was in.
    const result = assessStratifiedAttribution([
      obs(1, { fatigueContext: 'unknown' }),
      obs(2, { fatigueContext: 'unknown' }),
    ], policy);
    expect(result.strata.filter((s) => s.axis === 'fatigue_context')).toHaveLength(0);
  });

  test('the attribution prior is symmetric across targets', () => {
    // With no occurrences the posterior must not favour the athlete.
    const result = assessStratifiedAttribution([
      obs(1, { polarity: 'counterexample' }),
      obs(2, { polarity: 'counterexample' }),
    ], policy);
    const stratum = result.strata.find((s) => s.axis === 'task_constraint');
    const masses = Object.values(stratum!.attributionPosterior);
    expect(Math.max(...masses) - Math.min(...masses)).toBeCloseTo(0, 12);
    expect(stratum!.leadingTarget).toBeNull();
  });

  test('is order-independent', () => {
    const observations = [obs(1), obs(2, { taskConstraint: 'live' }), obs(3)];
    const a = assessStratifiedAttribution(observations, policy);
    const b = assessStratifiedAttribution([...observations].reverse(), policy);
    expect(a.strata.map((s) => `${s.axis}:${s.key}`)).toEqual(b.strata.map((s) => `${s.axis}:${s.key}`));
  });

  test('refuses without a ratified policy', () => {
    expect(() => assessStratifiedAttribution([obs(1)], undefined as unknown as PatternInferencePolicy))
      .toThrow(/INFERENCE_POLICY_MISSING/);
  });
});
