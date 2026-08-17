// The rules are the product: an arithmetic comparison a coach can check by
// hand. What these pin, rule by rule: each one fires on its threshold, stays
// silent on thin data (a direction read into two check-ins is noise wearing a
// trend's clothes), and defers to work already on the coach's board (an open
// gap of the same type suppresses its suggestion).

import {
  buildGapJustifications,
  deriveSuggestions,
  READINESS_DROP_POINTS,
  READINESS_MIN_CHECKINS_PER_HALF,
  RULE_JUSTIFICATION_FIELDS,
  ruleFromDetectedFrom,
  TRAINING_DAYS_MIN_EARLY,
  type StalledAssignmentRow,
} from './progressionSuggestions';
import type { AthletePerformanceRow } from './performanceAnalytics';

function rollupRow(overrides: Partial<AthletePerformanceRow> = {}): AthletePerformanceRow {
  return {
    athlete_id: 'ath-1',
    sessions_total: 6,
    sessions_completed: 5,
    avg_rpe: 6,
    training_days: 10,
    training_days_early: 5,
    training_days_late: 5,
    readiness_count: 8,
    avg_readiness: 7,
    readiness_early_avg: 7,
    readiness_late_avg: 7,
    readiness_early_count: 4,
    readiness_late_count: 4,
    open_gaps: 0,
    active_assignments: 0,
    avg_assignment_completion: null,
    ...overrides,
  };
}

const NO_STALLED: StalledAssignmentRow[] = [];
const NO_OPEN_GAPS = new Map<string, Set<string>>();

describe('readiness_falling', () => {
  test('fires at exactly the threshold drop with enough check-ins in both halves', () => {
    const suggestions = deriveSuggestions(
      [rollupRow({ readiness_early_avg: 7.0, readiness_late_avg: 7.0 - READINESS_DROP_POINTS })],
      NO_STALLED,
      NO_OPEN_GAPS,
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].rule).toBe('readiness_falling');
    expect(suggestions[0].gap_type).toBe('endurance');
    expect(suggestions[0].evidence.readiness_early_avg).toBe(7);
  });

  test('a smaller drop stays silent', () => {
    const suggestions = deriveSuggestions(
      [rollupRow({ readiness_early_avg: 7.0, readiness_late_avg: 7.0 - READINESS_DROP_POINTS + 0.1 })],
      NO_STALLED,
      NO_OPEN_GAPS,
    );
    expect(suggestions).toHaveLength(0);
  });

  test('a real drop over too few check-ins stays silent', () => {
    const suggestions = deriveSuggestions(
      [rollupRow({
        readiness_early_avg: 8,
        readiness_late_avg: 5,
        readiness_late_count: READINESS_MIN_CHECKINS_PER_HALF - 1,
      })],
      NO_STALLED,
      NO_OPEN_GAPS,
    );
    expect(suggestions).toHaveLength(0);
  });

  test('an open endurance gap suppresses the suggestion', () => {
    const suggestions = deriveSuggestions(
      [rollupRow({ readiness_early_avg: 8, readiness_late_avg: 5 })],
      NO_STALLED,
      new Map([['ath-1', new Set(['endurance'])]]),
    );
    expect(suggestions).toHaveLength(0);
  });
});

describe('training_days_dropping', () => {
  test('fires when a real habit halves', () => {
    const suggestions = deriveSuggestions(
      [rollupRow({ training_days_early: 6, training_days_late: 3 })],
      NO_STALLED,
      NO_OPEN_GAPS,
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].rule).toBe('training_days_dropping');
    expect(suggestions[0].gap_type).toBe('mental');
  });

  test('stays silent when there was no habit to lose', () => {
    const suggestions = deriveSuggestions(
      [rollupRow({ training_days_early: TRAINING_DAYS_MIN_EARLY - 1, training_days_late: 0 })],
      NO_STALLED,
      NO_OPEN_GAPS,
    );
    expect(suggestions).toHaveLength(0);
  });

  test('stays silent when the newer half holds above half', () => {
    const suggestions = deriveSuggestions(
      [rollupRow({ training_days_early: 6, training_days_late: 4 })],
      NO_STALLED,
      NO_OPEN_GAPS,
    );
    expect(suggestions).toHaveLength(0);
  });
});

describe('assignments_stalled', () => {
  const STALLED: StalledAssignmentRow[] = [
    { athlete_id: 'ath-1', stalled_count: 2, oldest_due_date: '2026-08-01' },
  ];

  test('overdue assignments produce one grouped suggestion', () => {
    const suggestions = deriveSuggestions([rollupRow()], STALLED, NO_OPEN_GAPS);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].rule).toBe('assignments_stalled');
    expect(suggestions[0].suggested_description).toContain('2 drill assignments past due');
  });

  test('an open mental gap suppresses it', () => {
    const suggestions = deriveSuggestions(
      [rollupRow()],
      STALLED,
      new Map([['ath-1', new Set(['mental'])]]),
    );
    expect(suggestions).toHaveLength(0);
  });

  test('one mental suggestion per athlete: consistency speaks, stalled folds into it', () => {
    const suggestions = deriveSuggestions(
      [rollupRow({ training_days_early: 6, training_days_late: 0 })],
      STALLED,
      NO_OPEN_GAPS,
    );
    const mental = suggestions.filter((s) => s.gap_type === 'mental');
    expect(mental).toHaveLength(1);
    expect(mental[0].rule).toBe('training_days_dropping');
  });
});

test('an athlete with quiet data produces no suggestions at all', () => {
  expect(deriveSuggestions([rollupRow()], NO_STALLED, NO_OPEN_GAPS)).toHaveLength(0);
});

// The athlete/parent-facing justification slice (getGapJustifications' pure
// half): only a gap whose detected_from names a rule with a non-empty field
// list gets a justification, and it gets exactly that rule's fields -- never
// the full rollup, and never a field another rule owns.
describe('ruleFromDetectedFrom', () => {
  test('reads the rule out of a confirmed-suggestion gap', () => {
    expect(ruleFromDetectedFrom('deterministic_rule:readiness_falling')).toBe('readiness_falling');
    expect(ruleFromDetectedFrom('deterministic_rule:training_days_dropping')).toBe('training_days_dropping');
    expect(ruleFromDetectedFrom('deterministic_rule:assignments_stalled')).toBe('assignments_stalled');
  });

  test('a manual gap has no rule', () => {
    expect(ruleFromDetectedFrom('coach_observation')).toBeNull();
    expect(ruleFromDetectedFrom('manual_observation')).toBeNull();
    expect(ruleFromDetectedFrom(null)).toBeNull();
    expect(ruleFromDetectedFrom(undefined)).toBeNull();
  });

  test('an unrecognised rule name is treated as no rule', () => {
    expect(ruleFromDetectedFrom('deterministic_rule:some_future_rule')).toBeNull();
  });
});

describe('buildGapJustifications', () => {
  test('a readiness_falling gap gets only readiness fields', () => {
    const row = rollupRow({
      avg_readiness: 6.1,
      readiness_count: 9,
      readiness_early_avg: 7.5,
      readiness_late_avg: 5.5,
      readiness_early_count: 4,
      readiness_late_count: 5,
      training_days: 12,
      avg_rpe: 6.8,
    });
    const result = buildGapJustifications(row, [
      { gap_id: 'gap-1', detected_from: 'deterministic_rule:readiness_falling' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      gap_id: 'gap-1',
      rule: 'readiness_falling',
      fields: {
        avg_readiness: 6.1,
        readiness_count: 9,
        readiness_early_avg: 7.5,
        readiness_late_avg: 5.5,
        readiness_early_count: 4,
        readiness_late_count: 5,
      },
    });
    // Never any field the rule did not use, including ones the rollup carries.
    expect(result[0].fields).not.toHaveProperty('training_days');
    expect(result[0].fields).not.toHaveProperty('avg_rpe');
    expect(result[0].fields).not.toHaveProperty('sessions_total');
  });

  test('a training_days_dropping gap gets only training-days fields', () => {
    const row = rollupRow({ training_days: 14, training_days_early: 9, training_days_late: 3 });
    const result = buildGapJustifications(row, [
      { gap_id: 'gap-2', detected_from: 'deterministic_rule:training_days_dropping' },
    ]);

    expect(result).toEqual([
      {
        gap_id: 'gap-2',
        rule: 'training_days_dropping',
        fields: { training_days: 14, training_days_early: 9, training_days_late: 3 },
      },
    ]);
  });

  test('an assignments_stalled gap gets no fields at all -- nothing in the rollup backs it', () => {
    const result = buildGapJustifications(rollupRow(), [
      { gap_id: 'gap-3', detected_from: 'deterministic_rule:assignments_stalled' },
    ]);
    expect(result).toHaveLength(0);
  });

  test('a manually-created gap gets no justification', () => {
    const result = buildGapJustifications(rollupRow(), [
      { gap_id: 'gap-4', detected_from: 'coach_observation' },
      { gap_id: 'gap-5', detected_from: null },
    ]);
    expect(result).toHaveLength(0);
  });

  test('a mix of gaps yields only the eligible ones, each scoped to its own rule', () => {
    const row = rollupRow({ readiness_early_avg: 8, readiness_late_avg: 6, training_days_early: 5, training_days_late: 1 });
    const result = buildGapJustifications(row, [
      { gap_id: 'gap-manual', detected_from: 'coach_observation' },
      { gap_id: 'gap-readiness', detected_from: 'deterministic_rule:readiness_falling' },
      { gap_id: 'gap-training', detected_from: 'deterministic_rule:training_days_dropping' },
      { gap_id: 'gap-stalled', detected_from: 'deterministic_rule:assignments_stalled' },
    ]);

    expect(result.map((r) => r.gap_id)).toEqual(['gap-readiness', 'gap-training']);
  });

  test('no rollup row for the athlete means no justification for anyone', () => {
    const result = buildGapJustifications(undefined, [
      { gap_id: 'gap-1', detected_from: 'deterministic_rule:readiness_falling' },
    ]);
    expect(result).toHaveLength(0);
  });

  test('the field allowlist is exhaustive over the rule vocabulary and never spans rules', () => {
    expect(Object.keys(RULE_JUSTIFICATION_FIELDS).sort()).toEqual(
      ['assignments_stalled', 'readiness_falling', 'training_days_dropping'].sort(),
    );
    const readinessFields = new Set(RULE_JUSTIFICATION_FIELDS.readiness_falling);
    const trainingFields = new Set(RULE_JUSTIFICATION_FIELDS.training_days_dropping);
    for (const field of trainingFields) expect(readinessFields.has(field)).toBe(false);
  });
});
