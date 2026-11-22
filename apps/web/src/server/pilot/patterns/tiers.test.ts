/**
 * The approved bar applied (tiers.ts), with the approved v1 numbers
 * (learningPolicyApprovedV1.ts, pinned to the research report there). Each
 * case builds evidence that meets one tier exactly, or misses it for one
 * reason, so the standing and its shortfalls can be read off.
 *
 * Who counts and what a dispute does follow Overwatch's answers on the
 * PATTERN-1 plan (PunxsyProminence/ppbf-platform#2082, 2026-11-21): Q1 A, a
 * coach's reading counts only when that coach is in a calibrated pair on this
 * behaviour (OD-2026-10-17-027 ruling 3 as written), so most cases here carry
 * a calibration history; Q4 A, a disputed attempt is left out and listed, and
 * only film contradicting a coach withholds.
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
function calibrationHistory(first = 'coach-a', second = 'coach-b'): BehaviourObservation[] {
  const rows: BehaviourObservation[] = [];
  for (let i = 0; i < 30; i += 1) {
    const polarity = i < 20 ? 'occurrence' : 'counterexample';
    const at = {
      sessionId: `old-${first}-${second}-${i}`, observedAt: '2026-01-10T10:00:00.000Z', opportunityKey: `cal-${i}`, polarity,
    } as const;
    rows.push(chance(0, { ...at, observerAccountId: first }), chance(0, { ...at, observerAccountId: second }));
  }
  return rows;
}

const idsOf = (rows: readonly BehaviourObservation[]) => rows.map((row) => row.observationId).sort();

describe('the approved tiers', () => {
  test('emerging: three sessions in one drill, one calibrated coach -- context-specific and single-observer', () => {
    const result = tiersOf([...emergingEvidence(), ...calibrationHistory()]);
    expect(result.tier).toBe('emerging');
    expect(result.singleObserver).toBe(true);
    expect(result.standings.pattern.shortfalls).toEqual(['sessions', 'coded_chances', 'contexts', 'span', 'observers']);
  });

  test('a pattern: 5 sessions, 7 of 8 chances, 2 drills, 15 days, 2 calibrated coaches', () => {
    const result = tiersOf([...patternEvidence(), ...calibrationHistory()]);
    expect(result.counts).toEqual(expect.objectContaining({ sessions: 5, codedChances: 8, occurrences: 7, contexts: 3, coaches: 2 }));
    expect(result.tier).toBe('pattern');
    expect(result.standings.established.met).toBe(false);
  });

  test('established needs the two coaches to be a calibrated pair; each calibrated only with a third, it stays a pattern', () => {
    const evidence = establishedEvidence();
    expect(tiersOf([...evidence, ...calibrationHistory()]).tier).toBe('established');
    const notTogether = tiersOf([...evidence, ...calibrationHistory('coach-a', 'coach-c'), ...calibrationHistory('coach-b', 'coach-c')]);
    expect(notTogether.unverifiedObservationIds).toEqual([]);
    expect(notTogether.tier).toBe('pattern');
    expect(notTogether.standings.established.shortfalls).toEqual(['observers']);
  });

  test('not until calibrated: coaches in no calibrated pair are shown, not counted', () => {
    const doubled = [
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-b' }),
    ];
    const evidence = [...emergingEvidence(), ...doubled];
    const result = tiersOf(evidence);
    expect(result.unverifiedObservationIds).toEqual(idsOf(evidence));
    expect(result.counts.codedChances).toBe(0);
    expect(result.tier).toBeNull();
    // With a calibrated history the double-coded attempt counts once.
    const calibrated = tiersOf([...evidence, ...calibrationHistory()]);
    expect(calibrated.unverifiedObservationIds).toEqual([]);
    expect(calibrated.counts.codedChances).toBe(6);
  });

  test('a pattern lapses after the latest chances all missed', () => {
    const misses = [21, 22, 23].map((day) => chance(day, { polarity: 'counterexample', taskContextKey: 'task-bag' }));
    const result = tiersOf([...patternEvidence(), ...misses, ...calibrationHistory()]);
    expect(result.counts.trailingMisses).toBe(3);
    expect(result.standings.pattern.shortfalls).toContain('lapsed');
    expect(result.tier).not.toBe('pattern');
  });

  test('evidence older than the currency window is history, not the athlete now', () => {
    const old = emergingEvidence().map((row) => ({ ...row, observedAt: '2026-02-01T10:00:00.000Z' }));
    const result = tiersOf([...old, ...calibrationHistory()]);
    expect(result.counts.codedChances).toBe(0);
    expect(result.tier).toBeNull();
  });

  test('an attempt read both ways is left out and listed for a person; the tiers stand on the rest', () => {
    const disputed = [
      chance(12, { opportunityKey: 'rep-9', observerAccountId: 'coach-a' }),
      chance(12, { opportunityKey: 'rep-9', observerAccountId: 'coach-a', polarity: 'counterexample' }),
    ];
    const result = tiersOf([...patternEvidence(), ...disputed, ...calibrationHistory()]);
    expect(result.disputed).toEqual({ attempts: 1, observationIds: idsOf(disputed) });
    expect(result.withheld).toEqual([]);
    expect(result.counts.codedChances).toBe(8);
    expect(result.tier).toBe('pattern');
    expect(result.humanReviewRequired).toBe(true);
  });
});

describe('review fixes', () => {
  test('two coaches not yet calibrated who disagree: the attempt is listed for a person and withholds nothing', () => {
    const disputed = [
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-c' }),
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-d', polarity: 'counterexample' }),
    ];
    const result = tiersOf([...emergingEvidence(), ...disputed, ...calibrationHistory()]);
    expect(result.disputed).toEqual({ attempts: 0, observationIds: [] });
    expect(result.uncountedDissent).toEqual({ attempts: 1, observationIds: idsOf(disputed) });
    expect(result.unverifiedObservationIds).toEqual(idsOf(disputed));
    expect(result.withheld).toEqual([]);
    expect(result.tier).toBe('emerging');
  });

  test('a third coach does not undo a calibrated pair', () => {
    // coach-c is calibrated with coach-a only, so its readings count, and coach-a and coach-b are still a calibrated pair.
    const third = [0, 10, 20].map((day) => chance(day, { observerAccountId: 'coach-c' }));
    const result = tiersOf([...establishedEvidence(), ...calibrationHistory(), ...calibrationHistory('coach-a', 'coach-c'), ...third]);
    expect(result.counts.coaches).toBe(3);
    expect(result.tier).toBe('established');
  });

  test('a pair is calibrated on the gym\'s record of the behaviour, every athlete', () => {
    // The 30 double-coded attempts, 10 on each of three athletes, outside the currency window.
    const athletes = ['athlete-1', 'athlete-2', 'athlete-3'];
    const gym = calibrationHistory().map((row, index) => ({ ...row, athleteId: athletes[Math.floor(index / 2) % 3] }));
    const evidence = establishedEvidence();
    expect(tiersOf(evidence, true, { calibrationReadings: [...evidence, ...gym] }).tier).toBe('established');
    // Only this athlete's 10: too few paired judgments, so no pair is calibrated and nothing counts.
    const thin = tiersOf(evidence, true, { calibrationReadings: [...evidence, ...gym.filter((row) => row.athleteId === ATHLETE)] });
    expect(thin.tier).toBeNull();
    expect(thin.unverifiedObservationIds).toEqual(idsOf(evidence));
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
    const result = tiersOf([chance(0), ...model, ...calibrationHistory()]);
    expect(result.counts.codedChances).toBe(1);
    expect(result.tier).toBeNull();
  });

  test('a coach who only recorded misses did not see it', () => {
    const rows = [
      chance(0), chance(0), chance(3, { taskContextKey: 'task-sparring' }), chance(6), chance(9),
      chance(12), chance(15), chance(15, { taskContextKey: 'task-sparring' }),
      chance(12, { observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ];
    const result = tiersOf([...rows, ...calibrationHistory()]);
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
    const result = tiersOf([...rows, ...calibrationHistory()], true, { asOf: '2027-03-20T12:00:00.000Z' });
    expect(result.counts.spanDays).toBe(7);
    expect(result.tier).toBe('emerging');
  });
});

describe('who counts before calibration (Overwatch Q1 A on #2082; OD-2026-10-17-027 ruling 3)', () => {
  test('no ratified calibration bar: nothing counts, every coach reading is shown as unverified, and the result says so', () => {
    const evidence = patternEvidence();
    const result = tiersOf([...evidence, ...calibrationHistory()], false);
    expect(result.calibrationBarInForce).toBe(false);
    expect(result.unverifiedObservationIds).toEqual(idsOf(evidence));
    expect(result.counts.codedChances).toBe(0);
    expect(result.tier).toBeNull();
    expect(tiersOf([...evidence, ...calibrationHistory()]).calibrationBarInForce).toBe(true);
  });

  test('a lone coach in no calibrated pair counts toward nothing, not even emerging', () => {
    const evidence = emergingEvidence();
    const result = tiersOf(evidence);
    expect(result.calibrationBarInForce).toBe(true);
    expect(result.unverifiedObservationIds).toEqual(idsOf(evidence));
    expect(result.counts.codedChances).toBe(0);
    expect(result.singleObserver).toBe(false);
    expect(result.tier).toBeNull();
  });

  test('two coaches who never coded the same attempt are no calibrated pair: their readings count for nothing', () => {
    const result = tiersOf(patternEvidence());
    expect(result.counts.coaches).toBe(0);
    expect(result.tier).toBeNull();
  });

  test('unverified readings are counted separately, in attempts and in how many showed', () => {
    const shownOnly = [chance(20, { observerAccountId: 'coach-c' }), chance(21, { observerAccountId: 'coach-c', polarity: 'counterexample' })];
    const result = tiersOf([...emergingEvidence(), ...shownOnly, ...calibrationHistory()]);
    expect(result.unverifiedObservationIds).toEqual(idsOf(shownOnly));
    expect(result.unverifiedCounts).toEqual({ codedChances: 2, occurrences: 1 });
    expect(result.counts.codedChances).toBe(5);
    expect(result.tier).toBe('emerging');
  });

  test('a reading with no attempt named is judged by its coach like any other', () => {
    const keyless = chance(20, { observerAccountId: 'coach-c', opportunityKey: undefined });
    const result = tiersOf([...emergingEvidence(), keyless, ...calibrationHistory()]);
    expect(result.unverifiedObservationIds).toEqual([keyless.observationId]);
  });

  test('an attempt coded together counts only when that pair is calibrated, even if each is calibrated with someone else', () => {
    const together = [
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-c' }),
    ];
    const history = [...calibrationHistory('coach-a', 'coach-b'), ...calibrationHistory('coach-b', 'coach-c')];
    const result = tiersOf([...emergingEvidence(), ...together, ...history]);
    expect(result.unverifiedObservationIds).toEqual(idsOf(together));
    expect(result.counts.codedChances).toBe(5);
  });

  test('a person\'s reading with no coach named does not count', () => {
    const nameless = chance(20, { observerAccountId: null });
    const result = tiersOf([...emergingEvidence(), nameless, ...calibrationHistory()]);
    expect(result.unverifiedObservationIds).toEqual([nameless.observationId]);
    expect(result.counts.codedChances).toBe(5);
  });
});

describe('disputed attempts (Overwatch Q4 A on #2082)', () => {
  test('two calibrated coaches who disagree: the attempt counts for neither side', () => {
    const disputed = [
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ];
    const result = tiersOf([...emergingEvidence(), ...disputed, ...calibrationHistory()]);
    expect(result.disputed).toEqual({ attempts: 1, observationIds: idsOf(disputed) });
    expect(result.counts).toEqual(expect.objectContaining({ codedChances: 5, occurrences: 5, sessions: 3 }));
    expect(result.withheld).toEqual([]);
    expect(result.tier).toBe('emerging');
  });

  test('a coach whose only sighting was a disputed attempt did not see it', () => {
    const disputed = [
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-b' }),
      chance(20, { opportunityKey: 'rep-1', observerAccountId: 'coach-a', polarity: 'counterexample' }),
    ];
    const result = tiersOf([...emergingEvidence(), ...disputed, ...calibrationHistory()]);
    expect(result.counts.coaches).toBe(1);
    expect(result.singleObserver).toBe(true);
  });

  test('film contradicting a coach still withholds every tier', () => {
    const contradicted = [
      chance(12, { opportunityKey: 'rep-v', observerAccountId: 'coach-a' }),
      chance(12, {
        opportunityKey: 'rep-v', observerAccountId: null, interpretation: 'ai_proposed', polarity: 'counterexample',
        source: { type: 'computer_vision', quality: 'high', referenceId: 'clip-v' },
      }),
    ];
    const result = tiersOf([...patternEvidence(), ...contradicted, ...calibrationHistory()]);
    expect(result.withheld).toEqual(['VIDEO_CONTRADICTS_OBSERVER']);
    // The model's reading does not count, so it does not take the coach's reading out of the counts; it is listed.
    expect(result.disputed.attempts).toBe(0);
    expect(result.uncountedDissent).toEqual({ attempts: 1, observationIds: idsOf(contradicted) });
    expect(result.standings.pattern).toEqual({ met: false, shortfalls: [] });
    expect(result.tier).toBeNull();
  });
});

describe('a reading that does not count changes no count (review fixes on #2092)', () => {
  /** Pattern evidence plus two more coach misses: 7 shown of 10, a share of 0.7, so no tier. */
  const missKeys = ['miss-1', 'miss-2'];
  function seventyPercent(): BehaviourObservation[] {
    return [
      ...patternEvidence(),
      chance(16, { opportunityKey: 'miss-1', polarity: 'counterexample' }),
      chance(17, { opportunityKey: 'miss-2', polarity: 'counterexample', observerAccountId: 'coach-b' }),
    ];
  }
  /** One more reading on each of the two misses, made the same day as the miss. */
  const onTheMisses = (overrides: Partial<BehaviourObservation>) => missKeys.map((key, index) => chance(16 + index, {
    opportunityKey: key, ...overrides,
  }));
  const model = (polarity: BehaviourObservation['polarity']): Partial<BehaviourObservation> => ({
    observerAccountId: null, interpretation: 'ai_proposed', polarity,
    source: { type: 'imported', quality: 'moderate', referenceId: 'model-run' },
  });

  test('the base case: 7 of 10 is below the 80% share, so no tier', () => {
    const result = tiersOf([...seventyPercent(), ...calibrationHistory()]);
    expect(result.counts).toEqual(expect.objectContaining({ codedChances: 10, occurrences: 7 }));
    expect(result.tier).toBeNull();
  });

  test.each([
    ['a person naming no coach agrees with the misses', { observerAccountId: null, polarity: 'counterexample' as const }],
    ['a coach in no calibrated pair agrees with the misses', { observerAccountId: 'coach-z', polarity: 'counterexample' as const }],
    ['a coach in no calibrated pair says the misses showed', { observerAccountId: 'coach-z', polarity: 'occurrence' as const }],
    ['a model agrees with the misses', model('counterexample')],
    ['a model says the misses showed', model('occurrence')],
  ])('%s: the misses still count and the tier does not move', (_label, overrides) => {
    const extra = onTheMisses(overrides);
    const result = tiersOf([...seventyPercent(), ...extra, ...calibrationHistory()]);
    expect(result.counts).toEqual(expect.objectContaining({ codedChances: 10, occurrences: 7 }));
    expect(result.disputed.attempts).toBe(0);
    expect(result.tier).toBeNull();
  });

  test('dissent that does not count is listed for a person', () => {
    const base = seventyPercent();
    const extra = onTheMisses(model('occurrence'));
    const result = tiersOf([...base, ...extra, ...calibrationHistory()]);
    const misses = base.filter((row) => missKeys.includes(row.opportunityKey ?? ''));
    expect(result.uncountedDissent).toEqual({ attempts: 2, observationIds: idsOf([...misses, ...extra]) });
  });

  test('two models disagreeing on an attempt no person coded: not a coded chance, so not listed', () => {
    const models = [
      chance(12, { ...model('occurrence'), opportunityKey: 'rep-m' }),
      chance(12, { ...model('counterexample'), opportunityKey: 'rep-m' }),
    ];
    const result = tiersOf([...emergingEvidence(), ...models, ...calibrationHistory()]);
    expect(result.disputed).toEqual({ attempts: 0, observationIds: [] });
    expect(result.uncountedDissent).toEqual({ attempts: 0, observationIds: [] });
    expect(result.tier).toBe('emerging');
  });

  test('a calibrated coach disputing a miss still leaves that attempt out (Q4 A)', () => {
    const extra = [chance(16, { opportunityKey: 'miss-1', observerAccountId: 'coach-b', polarity: 'occurrence' })];
    const result = tiersOf([...seventyPercent(), ...extra, ...calibrationHistory()]);
    expect(result.disputed.attempts).toBe(1);
    expect(result.counts).toEqual(expect.objectContaining({ codedChances: 9, occurrences: 7 }));
  });

  test('a lapse stands whatever a model or an uncalibrated coach says about the misses', () => {
    const misses = [21, 22, 23].map((day) => chance(day, { opportunityKey: `lapse-${day}`, polarity: 'counterexample', taskContextKey: 'task-bag' }));
    const lapsed = tiersOf([...patternEvidence(), ...misses, ...calibrationHistory()]);
    expect(lapsed.standings.pattern.shortfalls).toContain('lapsed');
    for (const overrides of [model('occurrence'), { observerAccountId: 'coach-z', polarity: 'occurrence' as const }]) {
      const dissent = misses.map((miss) => chance(0, { ...miss, observationId: `${miss.observationId}-x`, ...overrides }));
      const result = tiersOf([...patternEvidence(), ...misses, ...dissent, ...calibrationHistory()]);
      expect(result.counts.trailingMisses).toBe(3);
      expect(result.tier).toBe(lapsed.tier);
    }
  });

  test('film contradicting a coach in no calibrated pair still withholds', () => {
    const contradicted = [
      chance(12, { opportunityKey: 'rep-v', observerAccountId: 'coach-c' }),
      chance(12, {
        opportunityKey: 'rep-v', observerAccountId: null, interpretation: 'ai_proposed', polarity: 'counterexample',
        source: { type: 'computer_vision', quality: 'high', referenceId: 'clip-v' },
      }),
    ];
    const result = tiersOf([...patternEvidence(), ...contradicted, ...calibrationHistory()]);
    expect(result.withheld).toEqual(['VIDEO_CONTRADICTS_OBSERVER']);
    expect(result.tier).toBeNull();
  });

  test('film contradicting a coach withholds whatever the coach\'s reading was sourced from', () => {
    const contradicted = [
      chance(12, { opportunityKey: 'rep-w', source: { type: 'imported', quality: 'moderate', referenceId: 'sheet-1' } }),
      chance(12, {
        opportunityKey: 'rep-w', observerAccountId: null, interpretation: 'ai_proposed', polarity: 'counterexample',
        source: { type: 'computer_vision', quality: 'high', referenceId: 'clip-w' },
      }),
    ];
    const result = tiersOf([...patternEvidence(), ...contradicted, ...calibrationHistory()]);
    expect(result.withheld).toEqual(['VIDEO_CONTRADICTS_OBSERVER']);
    expect(result.tier).toBeNull();
  });

  test('two calibrated coaches both coding from film who disagree: a dispute between people, left out, not withheld', () => {
    const fromFilm = { type: 'computer_vision', quality: 'high', referenceId: 'clip-f' } as const;
    const disputed = [
      chance(12, { opportunityKey: 'rep-f', source: fromFilm }),
      chance(12, { opportunityKey: 'rep-f', source: fromFilm, observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ];
    const result = tiersOf([...patternEvidence(), ...disputed, ...calibrationHistory()]);
    expect(result.withheld).toEqual([]);
    expect(result.disputed.attempts).toBe(1);
    expect(result.tier).toBe('pattern');
  });

  test('whose fault it was is reported over the counted attempts only', () => {
    const modelOnly = [4, 9].map((day) => chance(day, {
      ...model('occurrence'), opportunityKey: `m-${day}`, attribution: { target: 'coach_cue', certainty: 'probable' },
    }));
    const withBar = tiersOf([...emergingEvidence(), ...modelOnly, ...calibrationHistory()]);
    expect(withBar.attribution.tally.coach_cue).toBe(0);
    expect(withBar.attribution.athleteShare).toBe(1);
    const noBar = tiersOf([...emergingEvidence(), ...modelOnly, ...calibrationHistory()], false);
    expect(noBar.attribution.athleteShare).toBeNull();
  });

  test('a calibration bar passed as undefined is no bar: nothing counts and the result says so', () => {
    const result = evaluatePatternTiers({
      organizationId: ORG, athleteId: ATHLETE, behaviourKey: BEHAVIOUR,
      observations: emergingEvidence(), calibrationReadings: calibrationHistory(),
      bar: APPROVED_PATTERN_FORMATION_V1,
      calibration: undefined as unknown as null,
      asOf: AS_OF,
    });
    expect(result.calibrationBarInForce).toBe(false);
    expect(result.counts.codedChances).toBe(0);
  });
});
