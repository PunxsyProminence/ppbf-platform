/**
 * The approved bar applied (tiers.ts), with the approved v1 numbers
 * (learningPolicyApprovedV1.ts, pinned to the research report there). Each
 * case builds evidence that meets one tier exactly, or misses it for one
 * reason, so the standing and its shortfalls can be read off.
 */

import {
  APPROVED_OBSERVER_CALIBRATION_V1,
  APPROVED_PATTERN_FORMATION_V1,
} from '../learningPolicyApprovedV1';
import { evaluatePatternTiers } from './tiers';
import type { BehaviourObservation } from './types';

const ORG = 'org-1';
const ATHLETE = 'athlete-1';
const BEHAVIOUR = 'drops_lead_hand_after_jab';
const AS_OF = '2026-07-01T00:00:00.000Z';

let serial = 0;
function chance(day: number, overrides: Partial<BehaviourObservation> = {}): BehaviourObservation {
  serial += 1;
  return {
    observationId: `obs-${serial}`,
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    sessionId: `session-${day}`,
    taskContextKey: 'task-mitts',
    taskConstraint: 'controlled',
    fatigueContext: 'unknown',
    observedAt: new Date(Date.parse('2026-06-01T10:00:00.000Z') + day * 86_400_000).toISOString(),
    source: { type: 'coach_tag', quality: 'moderate', referenceId: `ref-${serial}` },
    observerAccountId: 'coach-a',
    interpretation: 'human_observed',
    polarity: 'occurrence',
    attribution: { target: 'athlete', certainty: 'probable' },
    ...overrides,
  };
}

const tiersOf = (observations: BehaviourObservation[], calibration = true) => evaluatePatternTiers({
  organizationId: ORG,
  athleteId: ATHLETE,
  behaviourKey: BEHAVIOUR,
  observations,
  bar: APPROVED_PATTERN_FORMATION_V1,
  calibration: calibration ? APPROVED_OBSERVER_CALIBRATION_V1 : null,
  asOf: AS_OF,
});

/** Five chances over three sessions in one drill, nine days, one coach: emerging. */
function emergingEvidence(): BehaviourObservation[] {
  return [chance(0), chance(0), chance(4), chance(4), chance(9)];
}

/** Eight chances (seven showed) over five sessions, two drills, fifteen days, two coaches: a pattern. */
function patternEvidence(): BehaviourObservation[] {
  return [
    chance(0), chance(3, { observerAccountId: 'coach-b' }), chance(6, { taskContextKey: 'task-sparring', taskConstraint: 'live' }),
    chance(9, { observerAccountId: 'coach-b' }), chance(15, { taskContextKey: 'task-sparring' }), chance(15),
    chance(9, { polarity: 'counterexample' }), chance(15, { observerAccountId: 'coach-b', taskContextKey: 'task-bag' }),
  ];
}

/** Twelve chances (eleven showed) over seven sessions, three drills, 28+ days, two coaches with 3+ sessions each. */
function establishedEvidence(): BehaviourObservation[] {
  const days = [0, 5, 10, 15, 20, 25, 29];
  const rows: BehaviourObservation[] = [];
  days.forEach((day, index) => {
    const coach = index % 2 === 0 ? 'coach-a' : 'coach-b';
    const task = ['task-mitts', 'task-sparring', 'task-bag'][index % 3];
    rows.push(chance(day, { observerAccountId: coach, taskContextKey: task }));
    if (index < 5) rows.push(chance(day, { observerAccountId: coach, taskContextKey: task }));
  });
  rows[3] = { ...rows[3], polarity: 'counterexample' };
  return rows;
}

/** Thirty attempts both coaches coded alike, long ago (outside the currency window): a calibrated pair. */
function calibrationHistory(): BehaviourObservation[] {
  const rows: BehaviourObservation[] = [];
  for (let i = 0; i < 30; i += 1) {
    const polarity = i < 20 ? 'occurrence' : 'counterexample';
    const at = { sessionId: `old-${i}`, observedAt: '2026-01-10T10:00:00.000Z', opportunityKey: `cal-${i}`, polarity } as const;
    rows.push(chance(0, { ...at, observerAccountId: 'coach-a' }), chance(0, { ...at, observerAccountId: 'coach-b' }));
  }
  return rows;
}

describe('the approved tiers', () => {
  test('emerging: three sessions in one drill, one coach -- context-specific and single-observer', () => {
    const result = tiersOf(emergingEvidence());
    expect(result.tier).toBe('emerging');
    expect(result.singleObserver).toBe(true);
    expect(result.standings.pattern.shortfalls).toEqual(['sessions', 'coded_chances', 'contexts', 'span', 'observers']);
  });

  test('a pattern: 5 sessions, 7 of 8 chances, 2 drills, 15 days, 2 coaches', () => {
    const result = tiersOf(patternEvidence());
    expect(result.counts).toEqual(expect.objectContaining({ sessions: 5, codedChances: 8, occurrences: 7, contexts: 3, coaches: 2 }));
    expect(result.tier).toBe('pattern');
    expect(result.standings.established.met).toBe(false);
  });

  test('established needs the two coaches to be a calibrated pair; without one it stays a pattern', () => {
    const evidence = establishedEvidence();
    expect(tiersOf([...evidence, ...calibrationHistory()]).tier).toBe('established');
    const uncalibrated = tiersOf(evidence);
    expect(uncalibrated.tier).toBe('pattern');
    expect(uncalibrated.standings.established.shortfalls).toEqual(['observers']);
  });

  test('not until calibrated: an attempt two uncalibrated coaches coded is shown, not counted', () => {
    const doubled = [
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-b' }),
    ];
    const result = tiersOf([...emergingEvidence(), ...doubled], false);
    expect(result.unverifiedObservationIds).toHaveLength(2);
    expect(result.counts.codedChances).toBe(5);
    // With a calibrated history the same attempt counts once.
    const calibrated = tiersOf([...emergingEvidence(), ...doubled, ...calibrationHistory()]);
    expect(calibrated.unverifiedObservationIds).toEqual([]);
    expect(calibrated.counts.codedChances).toBe(6);
  });

  test('a pattern lapses after the latest chances all missed', () => {
    const misses = [21, 22, 23].map((day) => chance(day, { polarity: 'counterexample', taskContextKey: 'task-bag' }));
    const result = tiersOf([...patternEvidence(), ...misses]);
    expect(result.counts.trailingMisses).toBe(3);
    expect(result.standings.pattern.shortfalls).toContain('lapsed');
    expect(result.tier).not.toBe('pattern');
  });

  test('evidence older than the currency window is history, not the athlete now', () => {
    const old = emergingEvidence().map((row) => ({ ...row, observedAt: '2026-02-01T10:00:00.000Z' }));
    const result = tiersOf(old);
    expect(result.counts.codedChances).toBe(0);
    expect(result.tier).toBeNull();
  });

  test('an attempt read both ways withholds every tier until a person looks', () => {
    const disputed = [
      chance(12, { opportunityKey: 'rep-9', observerAccountId: 'coach-a' }),
      chance(12, { opportunityKey: 'rep-9', observerAccountId: 'coach-a', polarity: 'counterexample' }),
    ];
    const result = tiersOf([...patternEvidence(), ...disputed]);
    expect(result.withheld).toContain('ATTEMPT_DISPUTED');
    expect(result.tier).toBeNull();
    expect(result.humanReviewRequired).toBe(true);
  });
});
