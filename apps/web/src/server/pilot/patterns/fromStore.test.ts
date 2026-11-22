/**
 * Stored behaviour reports into the tier engine (fromStore.ts; PATTERN-1b,
 * PunxsyProminence/ppbf-platform#2082). The mapping is what makes the engine's
 * pair and attempt rules see real rows: a stored episode is the engine's
 * attempt (LL-W4), so two coaches' reports of one episode are a paired
 * judgment. No bar in force: no evaluation, and the reason.
 */

import { randomUUID } from 'node:crypto';

import type { LearningPolicyRow, PolicyKind } from '../learningPolicies';
import {
  APPROVED_CITATIONS_V1,
  APPROVED_OBSERVER_CALIBRATION_V1,
  APPROVED_PATTERN_FORMATION_V1,
} from '../learningPolicyApprovedV1';
import { evaluateStoredPatternStanding, observationFromStored, type StoredBehaviourReading } from './fromStore';

const ORG = 'org-1';
const ATHLETE = 'athlete-1';
const TEAMMATE = 'athlete-2';
const KEY = 'bk_fixture';
const AS_OF = '2026-07-01T00:00:00.000Z';

let serial = 0;
function stored(overrides: Partial<StoredBehaviourReading> = {}): StoredBehaviourReading {
  serial += 1;
  return {
    observation_id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
    athlete_id: ATHLETE,
    behaviour_key: KEY,
    episode_id: `ep:${randomUUID()}`,
    session_key: 'day:2026-06-01',
    task_context_key: 'context:session',
    task_constraint: 'controlled',
    fatigue_context: 'unknown',
    polarity: 'occurrence',
    attribution_target: 'athlete',
    attribution_certainty: 'probable',
    source_type: 'coach_tag',
    source_quality: 'moderate',
    interpretation: 'human_observed',
    observer_account_id: 'coach-a',
    supersedes_observation_id: null,
    observed_at: new Date('2026-06-01T22:00:00.000Z'),
    ...overrides,
  };
}

function policy(kind: PolicyKind, overrides: Partial<LearningPolicyRow> = {}): LearningPolicyRow {
  const parameters = kind === 'pattern_formation' ? APPROVED_PATTERN_FORMATION_V1 : APPROVED_OBSERVER_CALIBRATION_V1;
  return {
    policy_id: `policy-${kind}`,
    policy_kind: kind,
    version: 1,
    parameters,
    citations: APPROVED_CITATIONS_V1[kind],
    ratified_by_account_id: 'office-1',
    ratified_by_role: 'organization_admin',
    ratified_at: '2026-05-01T00:00:00.000Z',
    status: 'active',
    supersedes_policy_id: null,
    ...overrides,
  };
}

/** Emerging evidence for the athlete from coach-a: five reports over three gym days in one context. */
function emerging(): StoredBehaviourReading[] {
  return ['2026-06-01', '2026-06-01', '2026-06-05', '2026-06-05', '2026-06-10'].map((day) => stored({
    session_key: `day:${day}`, observed_at: new Date(`${day}T22:00:00.000Z`),
  }));
}

/** Thirty episodes coach-a and coach-b both reported, on the teammate, in January: a calibrated pair. */
function pairedHistory(shareEpisodes = true): StoredBehaviourReading[] {
  const rows: StoredBehaviourReading[] = [];
  for (let i = 0; i < 30; i += 1) {
    const at = { athlete_id: TEAMMATE, session_key: 'day:2026-01-10', observed_at: new Date('2026-01-10T22:00:00.000Z'),
      polarity: (i < 20 ? 'occurrence' : 'counterexample') as StoredBehaviourReading['polarity'] };
    const episode = `ep:${randomUUID()}`;
    rows.push(
      stored({ ...at, episode_id: episode, observer_account_id: 'coach-a' }),
      stored({ ...at, episode_id: shareEpisodes ? episode : `ep:${randomUUID()}`, observer_account_id: 'coach-b' }),
    );
  }
  return rows;
}

const standing = (gymReadings: StoredBehaviourReading[], activePolicies: LearningPolicyRow[]) => evaluateStoredPatternStanding({
  organizationId: ORG, athleteId: ATHLETE, behaviourKey: KEY, asOf: AS_OF, activePolicies, gymReadings,
});
const BOTH = () => [policy('pattern_formation'), policy('observer_calibration')];

describe('a stored report as the engine reads it', () => {
  test('the stored episode is the attempt and the stored session key is the session (LL-W4)', () => {
    const row = stored({ supersedes_observation_id: 'earlier-1', polarity: 'counterexample', source_quality: 'high' });
    expect(observationFromStored(ORG, row)).toEqual({
      observationId: row.observation_id,
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: KEY,
      sessionId: 'day:2026-06-01',
      taskContextKey: 'context:session',
      taskConstraint: 'controlled',
      fatigueContext: 'unknown',
      observedAt: '2026-06-01T22:00:00.000Z',
      opportunityKey: row.episode_id,
      source: { type: 'coach_tag', quality: 'high', referenceId: row.observation_id },
      observerAccountId: 'coach-a',
      interpretation: 'human_observed',
      polarity: 'counterexample',
      attribution: { target: 'athlete', certainty: 'probable' },
      supersedesObservationId: 'earlier-1',
    });
  });

  test('a time given as text reads the same as one given as a Date; an unreadable one is left for the engine to refuse', () => {
    expect(observationFromStored(ORG, stored({ observed_at: '2026-06-01T18:00:00-04:00' })).observedAt).toBe('2026-06-01T22:00:00.000Z');
    expect(observationFromStored(ORG, stored({ observed_at: 'not a time' })).observedAt).toBe('not a time');
  });

  test('the coach\'s note is not carried into the engine', () => {
    const row = { ...stored(), note: 'free text a coach typed' } as StoredBehaviourReading;
    expect(observationFromStored(ORG, row)).not.toHaveProperty('note');
  });
});

describe('the bars in force', () => {
  test('no pattern bar in force: no evaluation, and the reason', () => {
    for (const policies of [[], [policy('observer_calibration')], [policy('pattern_formation', { status: 'superseded' })]]) {
      const result = standing(emerging(), policies);
      expect(result.evaluation).toBeNull();
      expect(result.notEvaluated).toBe('no_pattern_bar_in_force');
    }
  });

  test('a stored bar that is not its kind\'s shape is not used: no evaluation, and the reason', () => {
    expect(standing(emerging(), [policy('pattern_formation', { parameters: {} as never })]).notEvaluated)
      .toBe('pattern_bar_unreadable');
    expect(standing(emerging(), [policy('pattern_formation'), policy('observer_calibration', { parameters: {} as never })]).notEvaluated)
      .toBe('calibration_bar_unreadable');
  });

  test('a pattern bar and no calibration bar: evaluated, nothing counts, and it says no calibration bar is in force', () => {
    const result = standing([...emerging(), ...pairedHistory()], [policy('pattern_formation')]);
    expect(result.notEvaluated).toBeNull();
    expect(result.evaluation?.calibrationBarInForce).toBe(false);
    expect(result.evaluation?.tier).toBeNull();
    expect(result.bars).toEqual({ pattern: { policyId: 'policy-pattern_formation', version: 1 }, calibration: null });
  });

  test('the result names the bars it used, the newest in force of each kind', () => {
    const result = standing(emerging(), [
      policy('pattern_formation', { policy_id: 'p-old', version: 1, status: 'superseded' }),
      policy('pattern_formation', { policy_id: 'p-new', version: 2 }),
      policy('observer_calibration', { policy_id: 'c-1', version: 1 }),
    ]);
    expect(result.bars).toEqual({ pattern: { policyId: 'p-new', version: 2 }, calibration: { policyId: 'c-1', version: 1 } });
  });
});

describe('stored reports through the engine', () => {
  test('two coaches\' reports of the same stored episodes calibrate the pair, so the athlete\'s readings count', () => {
    const result = standing([...emerging(), ...pairedHistory()], BOTH());
    expect(result.evaluation?.tier).toBe('emerging');
    expect(result.evaluation?.counts.codedChances).toBe(5);
    expect(result.evaluation?.unverifiedObservationIds).toEqual([]);
  });

  test('the same reports with no shared episode are no paired judgment: nothing counts', () => {
    const result = standing([...emerging(), ...pairedHistory(false)], BOTH());
    expect(result.evaluation?.tier).toBeNull();
    expect(result.evaluation?.unverifiedObservationIds).toHaveLength(5);
  });

  test('only this athlete\'s reports are evaluated; the gym\'s others only calibrate; another behaviour\'s are not read', () => {
    const otherBehaviour = emerging().map((row) => ({ ...row, behaviour_key: 'bk_other' }));
    const teammate = emerging().map((row) => ({ ...row, athlete_id: TEAMMATE }));
    const result = standing([...emerging(), ...pairedHistory(), ...otherBehaviour, ...teammate], BOTH());
    expect(result.evaluation?.athleteId).toBe(ATHLETE);
    expect(result.evaluation?.counts.codedChances).toBe(5);
  });
});
