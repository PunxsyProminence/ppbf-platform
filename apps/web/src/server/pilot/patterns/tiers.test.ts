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
import { assessPairCalibration, pairKey } from './inference/reliability';
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

const tiersOf = (
  observations: BehaviourObservation[],
  calibration = true,
  options: { calibrationReadings?: BehaviourObservation[]; asOf?: string } = {},
) => evaluatePatternTiers({
  organizationId: ORG,
  athleteId: ATHLETE,
  behaviourKey: BEHAVIOUR,
  observations,
  // The gym's record of this behaviour; here, the athlete's own unless a case says otherwise.
  calibrationReadings: options.calibrationReadings ?? observations,
  bar: APPROVED_PATTERN_FORMATION_V1,
  calibration: calibration ? APPROVED_OBSERVER_CALIBRATION_V1 : null,
  asOf: options.asOf ?? AS_OF,
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

describe('review fixes', () => {
  test('two coaches not yet calibrated who disagree still withhold', () => {
    const disputed = [
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ];
    const result = tiersOf([...emergingEvidence(), ...disputed], false);
    expect(result.withheld).toContain('ATTEMPT_DISPUTED');
    expect(result.tier).toBeNull();
  });

  test('a third coach does not undo a calibrated pair', () => {
    const third = [0, 10, 20].map((day) => chance(day, { observerAccountId: 'coach-c' }));
    const result = tiersOf([...establishedEvidence(), ...calibrationHistory(), ...third]);
    expect(result.counts.coaches).toBe(3);
    expect(result.tier).toBe('established');
  });

  test('a pair is calibrated on the gym\'s record of the behaviour, every athlete', () => {
    // The 30 double-coded attempts, 10 on each of three athletes, outside the currency window.
    const athletes = ['athlete-1', 'athlete-2', 'athlete-3'];
    const gym = calibrationHistory().map((row, index) => ({ ...row, athleteId: athletes[Math.floor(index / 2) % 3] }));
    const evidence = establishedEvidence();
    expect(tiersOf(evidence, true, { calibrationReadings: [...evidence, ...gym] }).tier).toBe('established');
    // Only this athlete's 10: too few paired judgments.
    expect(tiersOf(evidence, true, { calibrationReadings: [...evidence, ...gym.filter((row) => row.athleteId === ATHLETE)] }).tier)
      .toBe('pattern');
  });

  test('two athletes\' "rep-1" in the same session are two attempts, not one paired judgment', () => {
    const readings = [
      chance(0, { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      chance(0, { opportunityKey: 'rep-1', observerAccountId: 'coach-b', athleteId: 'athlete-2' }),
    ];
    expect(assessPairCalibration(readings, APPROVED_OBSERVER_CALIBRATION_V1).size).toBe(0);
  });

  test('a coach who scored one attempt both ways gives no verdict on it, whatever the order', () => {
    const a1 = chance(0, { opportunityKey: 'rep-1', observerAccountId: 'coach-a' });
    const a2 = chance(0, { opportunityKey: 'rep-1', observerAccountId: 'coach-a', polarity: 'counterexample' });
    const b = chance(0, { opportunityKey: 'rep-1', observerAccountId: 'coach-b' });
    for (const order of [[a1, a2, b], [a2, a1, b]]) {
      expect(assessPairCalibration(order, APPROVED_OBSERVER_CALIBRATION_V1).get(pairKey('coach-a', 'coach-b'))).toBeUndefined();
    }
  });

  test('film or a model alone is not a coded chance', () => {
    const model = [4, 4, 9, 9].map((day) => chance(day, {
      observerAccountId: null, interpretation: 'ai_proposed',
      source: { type: 'computer_vision', quality: 'high', referenceId: `clip-${day}` },
    }));
    const result = tiersOf([chance(0), ...model]);
    expect(result.counts.codedChances).toBe(1);
    expect(result.tier).toBeNull();
  });

  test('a coach who only recorded misses did not see it', () => {
    const rows = [
      chance(0), chance(0), chance(3, { taskContextKey: 'task-sparring' }), chance(6), chance(9),
      chance(12), chance(15), chance(15, { taskContextKey: 'task-sparring' }),
      chance(12, { observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ];
    const result = tiersOf(rows);
    expect(result.counts.coaches).toBe(1);
    expect(result.singleObserver).toBe(true);
    expect(result.standings.pattern.shortfalls).toContain('observers');
  });

  test('span is in the gym\'s calendar days: a week across the clock change is a week', () => {
    // 6pm at the gym on Monday 8 March 2027 (EST) and Monday 15 March 2027 (EDT).
    const at = (observedAt: string, sessionId: string) => chance(0, { observedAt, sessionId });
    const rows = [
      at('2027-03-08T23:00:00.000Z', 's1'), at('2027-03-08T23:10:00.000Z', 's1'),
      at('2027-03-11T23:00:00.000Z', 's2'), at('2027-03-11T23:10:00.000Z', 's2'),
      at('2027-03-15T22:00:00.000Z', 's3'),
    ];
    const result = tiersOf(rows, true, { asOf: '2027-03-20T12:00:00.000Z' });
    expect(result.counts.spanDays).toBe(7);
    expect(result.tier).toBe('emerging');
  });
});
