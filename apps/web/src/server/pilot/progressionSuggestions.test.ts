// The rules are the product: an arithmetic comparison a coach can check by
// hand. What these pin, rule by rule: each one fires on its threshold, stays
// silent on thin data (a direction read into two check-ins is noise wearing a
// trend's clothes), and defers to work already on the coach's board (an open
// gap of the same type suppresses its suggestion).

import {
  deriveSuggestions,
  READINESS_DROP_POINTS,
  READINESS_MIN_CHECKINS_PER_HALF,
  TRAINING_DAYS_MIN_EARLY,
  type StalledAssignmentRow,
  type TransferFailureRow,
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

describe('transfer_check_failed', () => {
  const FAILURE: TransferFailureRow = {
    athlete_id: 'ath-1',
    metric_kind: 'jab_cross',
    controlled_makes: 8,
    controlled_misses: 1,
    live_makes: 1,
    live_misses: 5,
  };

  test('a not_transferring readout produces a skill-gap suggestion', () => {
    const suggestions = deriveSuggestions([rollupRow()], NO_STALLED, NO_OPEN_GAPS, [FAILURE]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].rule).toBe('transfer_check_failed');
    expect(suggestions[0].gap_type).toBe('skill');
    expect(suggestions[0].athlete_id).toBe('ath-1');
    expect(suggestions[0].suggested_description).toContain('jab_cross');
    expect(suggestions[0].evidence).toEqual({
      metric_kind: 'jab_cross',
      controlled_makes: 8,
      controlled_misses: 1,
      live_makes: 1,
      live_misses: 5,
    });
  });

  test('two failing metrics for the same athlete produce two separate suggestions', () => {
    const second: TransferFailureRow = { ...FAILURE, metric_kind: 'low_kick' };
    const suggestions = deriveSuggestions([rollupRow()], NO_STALLED, NO_OPEN_GAPS, [FAILURE, second]);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.evidence.metric_kind).sort()).toEqual(['jab_cross', 'low_kick']);
  });

  test('an open skill gap suppresses the suggestion', () => {
    const suggestions = deriveSuggestions(
      [rollupRow()],
      NO_STALLED,
      new Map([['ath-1', new Set(['skill'])]]),
      [FAILURE],
    );
    expect(suggestions).toHaveLength(0);
  });

  test('no transfer failures means no suggestion, same as any other quiet rule', () => {
    expect(deriveSuggestions([rollupRow()], NO_STALLED, NO_OPEN_GAPS, [])).toHaveLength(0);
  });
});

test('an athlete with quiet data produces no suggestions at all', () => {
  expect(deriveSuggestions([rollupRow()], NO_STALLED, NO_OPEN_GAPS)).toHaveLength(0);
});
