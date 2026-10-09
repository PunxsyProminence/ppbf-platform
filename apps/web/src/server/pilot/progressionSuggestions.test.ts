// The rules are the product: an arithmetic comparison a coach can check by
// hand. What these pin, rule by rule: each one fires on its threshold, stays
// silent on thin data (a direction read into two check-ins is noise wearing a
// trend's clothes), and defers to work already on the coach's board (an open
// gap of the same type suppresses its suggestion).

import {
  buildGapJustifications,
  deriveSuggestions,
  familyGapDescription,
  familyGapJustifications,
  READINESS_DROP_POINTS,
  READINESS_MIN_CHECKINS_PER_HALF,
  RULE_JUSTIFICATION_FIELDS,
  ruleFromDetectedFrom,
  TRAINING_DAYS_MIN_EARLY,
  type CompetitionLossRow,
  type StalledAssignmentRow,
  type TransferFailureRow,
} from './progressionSuggestions';
import type { AthletePerformanceRow } from './performanceAnalytics';
import { LOAD_JUMP_RATIO, type LoadJumpReading } from './weeklySessionLoad';
import type { WellnessDecline } from './wellnessTrend';

function loadJump(overrides: Partial<LoadJumpReading> = {}): LoadJumpReading {
  return {
    athlete_id: 'ath-1',
    acute_load: 2000,
    usual_weekly_load: 1000,
    ratio: 2,
    prior_weeks_with_load: 4,
    ...overrides,
  };
}

function rollupRow(overrides: Partial<AthletePerformanceRow> = {}): AthletePerformanceRow {
  return {
    athlete_id: 'ath-1',
    sessions_total: 6,
    sessions_completed: 5,
    avg_rpe: 6,
    avg_session_load: null,
    session_load_count: 0,
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

describe('competition_loss_unresolved', () => {
  const LOSS: CompetitionLossRow[] = [
    {
      athlete_id: 'ath-1',
      loss_count: 2,
      most_recent_lesson_note: 'kept dropping the right hand in round 2',
      most_recent_competition_name: 'Golden Gloves Regional',
      most_recent_competition_date: '2026-08-01',
    },
  ];

  test('a recorded loss produces one grouped suggestion carrying the lesson note', () => {
    const suggestions = deriveSuggestions([rollupRow()], NO_STALLED, NO_OPEN_GAPS, [], LOSS);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].rule).toBe('competition_loss_unresolved');
    expect(suggestions[0].gap_type).toBe('technique');
    expect(suggestions[0].suggested_description).toContain('2 recorded competition losses');
    expect(suggestions[0].suggested_description).toContain('kept dropping the right hand in round 2');
    expect(suggestions[0].evidence.most_recent_lesson_note).toBe('kept dropping the right hand in round 2');
  });

  test('an open technique gap suppresses the suggestion', () => {
    const suggestions = deriveSuggestions(
      [rollupRow()],
      NO_STALLED,
      new Map([['ath-1', new Set(['technique'])]]),
      [],
      LOSS,
    );
    expect(suggestions).toHaveLength(0);
  });

  test('a single loss uses the singular form', () => {
    const suggestions = deriveSuggestions(
      [rollupRow()],
      NO_STALLED,
      NO_OPEN_GAPS,
      [],
      [{ ...LOSS[0], loss_count: 1 }],
    );
    expect(suggestions[0].suggested_description).toContain('1 recorded competition loss,');
  });

  test('no losses means no suggestion', () => {
    expect(deriveSuggestions([rollupRow()], NO_STALLED, NO_OPEN_GAPS, [], [])).toHaveLength(0);
  });
});

test('an athlete with quiet data produces no suggestions at all', () => {
  expect(deriveSuggestions([rollupRow()], NO_STALLED, NO_OPEN_GAPS)).toHaveLength(0);
});

// The athlete/parent-facing justification slice (getGapJustifications' pure
// half): only a gap whose detected_from names a rule with a non-empty field
// list gets a justification, and it gets exactly that rule's fields -- never
// the full rollup, and never a field another rule owns.
describe('load_jumped', () => {
  const NONE: never[] = [];

  test('fires at exactly the ratio threshold, with the numbers a coach can check', () => {
    const suggestions = deriveSuggestions([], NO_STALLED, NO_OPEN_GAPS, NONE, NONE, [loadJump({ ratio: LOAD_JUMP_RATIO })]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].rule).toBe('load_jumped');
    expect(suggestions[0].gap_type).toBe('endurance');
    expect(suggestions[0].evidence).toEqual({
      acute_load: 2000,
      usual_weekly_load: 1000,
      ratio: 2,
      ratio_shown: '2.0',
      prior_weeks_with_load: 4,
    });
    expect(suggestions[0].suggested_description).toContain('2000 over the last 7 days');
    expect(suggestions[0].suggested_description).toContain('usual week of 1000');
    expect(suggestions[0].suggested_description).toContain('unvalidated');
  });

  test('silent just below the threshold', () => {
    const suggestions = deriveSuggestions([], NO_STALLED, NO_OPEN_GAPS, NONE, NONE, [loadJump({ ratio: LOAD_JUMP_RATIO - 0.01 })]);
    expect(suggestions).toEqual([]);
  });

  test('an open endurance gap suppresses it', () => {
    const open = new Map([['ath-1', new Set(['endurance'])]]);
    expect(deriveSuggestions([], NO_STALLED, open, NONE, NONE, [loadJump()])).toEqual([]);
  });

  // Since Rule 7 (OD-2026-10-04-015): a readiness drop alongside a load jump
  // is "load up, wellness down", one recovery card in place of both.
  test('readiness falling with a load jump is one Rule 7 card, not Rules 1 and 6 side by side', () => {
    const suggestions = deriveSuggestions(
      [rollupRow({ readiness_early_avg: 7.0, readiness_late_avg: 7.0 - READINESS_DROP_POINTS })],
      NO_STALLED,
      NO_OPEN_GAPS,
      NONE,
      NONE,
      [loadJump(), loadJump({ athlete_id: 'ath-2' })],
    );
    expect(suggestions.map((s) => [s.athlete_id, s.rule])).toEqual([
      ['ath-2', 'load_jumped'],
      ['ath-1', 'load_up_wellness_down'],
    ]);
  });

  test('the wording is a prompt to look, never a diagnosis, limit or deload order', () => {
    const [suggestion] = deriveSuggestions([], NO_STALLED, NO_OPEN_GAPS, NONE, NONE, [loadJump({ ratio: 3.4 })]);
    expect(suggestion.suggested_description).toMatch(/Worth a look\.$/);
    expect(suggestion.suggested_description).not.toMatch(/deload|reduce|injur|risk|limit|overtrain|readiness/i);
  });
});

describe('load_up_wellness_down', () => {
  const NONE: never[] = [];
  const READINESS_DROP = rollupRow({ readiness_early_avg: 7.0, readiness_late_avg: 7.0 - READINESS_DROP_POINTS });

  function decline(overrides: Partial<WellnessDecline> = {}): WellnessDecline {
    return {
      athlete_id: 'ath-1',
      item: 'energy',
      direction: 'higher_is_better',
      recent_avg: 2.5,
      prior_avg: 4.0,
      recent_count: 3,
      prior_count: 10,
      ...overrides,
    };
  }

  function derive(
    rollup: AthletePerformanceRow[],
    jumps: LoadJumpReading[],
    declines: WellnessDecline[],
    open: Map<string, Set<string>> = NO_OPEN_GAPS,
  ) {
    return deriveSuggestions(rollup, NO_STALLED, open, NONE, NONE, jumps, declines);
  }

  test('a load jump with energy falling becomes one recovery suggestion, in Jason\'s wording, replacing load_jumped', () => {
    const suggestions = derive([], [loadJump({ acute_load: 640, usual_weekly_load: 300, ratio: 2.13 })], [decline()]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].rule).toBe('load_up_wellness_down');
    expect(suggestions[0].gap_type).toBe('recovery');
    expect(suggestions[0].suggested_description).toBe(
      'Load up, wellness down: 640 this week vs a usual 300 (2.1x); energy 4.0 → 2.5. '
        + 'Session RPE x minutes, unvalidated. Consider whether a lighter week fits.',
    );
    expect(suggestions[0].evidence).toEqual({
      acute_load: 640,
      usual_weekly_load: 300,
      ratio: 2.13,
      prior_weeks_with_load: 4,
      energy_prior_avg: 4,
      energy_recent_avg: 2.5,
      energy_prior_count: 10,
      energy_recent_count: 3,
    });
  });

  test('soreness rising counts too, and every signal that held is shown', () => {
    const [suggestion] = derive(
      [READINESS_DROP],
      [loadJump()],
      [decline(), decline({ item: 'soreness', direction: 'higher_is_worse', prior_avg: 2.0, recent_avg: 3.5 })],
    );
    expect(suggestion.suggested_description).toContain('energy 4.0 → 2.5; soreness 2.0 → 3.5; readiness 7.0 → 6.0.');
    expect(suggestion.evidence).toMatchObject({ soreness_prior_avg: 2, soreness_recent_avg: 3.5, readiness_late_avg: 6 });
  });

  test('a readiness drop alone is enough, and Rule 1 then stays silent for that athlete', () => {
    const suggestions = derive([READINESS_DROP], [loadJump()], []);
    expect(suggestions.map((s) => s.rule)).toEqual(['load_up_wellness_down']);
    expect(suggestions[0].suggested_description).toContain('readiness 7.0 → 6.0');
  });

  test('a load jump with no down signal stays Rule 6, unchanged', () => {
    const suggestions = derive([rollupRow()], [loadJump()], []);
    expect(suggestions.map((s) => s.rule)).toEqual(['load_jumped']);
  });

  test('a wellness drop with no load jump says nothing here', () => {
    expect(derive([], [loadJump({ ratio: LOAD_JUMP_RATIO - 0.01 })], [decline()])).toEqual([]);
    expect(derive([], [], [decline()])).toEqual([]);
  });

  test('another athlete\'s decline does not pair with this athlete\'s jump', () => {
    const suggestions = derive([], [loadJump()], [decline({ athlete_id: 'ath-2' })]);
    expect(suggestions.map((s) => [s.athlete_id, s.rule])).toEqual([['ath-1', 'load_jumped']]);
  });

  test('an open recovery gap silences Rules 7, 6 and 1: the coach already confirmed it', () => {
    const open = new Map([['ath-1', new Set(['recovery'])]]);
    expect(derive([READINESS_DROP], [loadJump()], [decline()], open)).toEqual([]);
  });

  test('a recovery gap filed for another reason leaves a plain readiness drop (no load jump) to Rule 1', () => {
    const open = new Map([['ath-1', new Set(['recovery'])]]);
    expect(derive([READINESS_DROP], [], [], open).map((s) => s.rule)).toEqual(['readiness_falling']);
  });

  test('an open endurance gap does not silence it: a different bucket of work', () => {
    const open = new Map([['ath-1', new Set(['endurance'])]]);
    expect(derive([], [loadJump()], [decline()], open).map((s) => s.rule)).toEqual(['load_up_wellness_down']);
  });

  test('the wording offers a lighter week to weigh; it never orders a deload, sets a limit or diagnoses', () => {
    const [suggestion] = derive([READINESS_DROP], [loadJump({ ratio: 3.4 })], [decline()]);
    expect(suggestion.suggested_description).toMatch(/Consider whether a lighter week fits\.$/);
    expect(suggestion.suggested_description).toContain('unvalidated');
    expect(suggestion.suggested_description).not.toMatch(
      /deload|must|should|reduce|cut|rest|injur|risk|limit|overtrain|unsafe|stop/i,
    );
  });
});

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

  // This list is maintained BY HAND on purpose, and it is the second half of
  // the speed bump RULE_JUSTIFICATION_FIELDS's Record type creates: adding a
  // rule to SuggestionRule breaks the compiler there and breaks this
  // assertion here, so nobody can extend the rule vocabulary without making
  // an explicit decision about what an athlete or parent is shown as that
  // rule's justification. transfer_check_failed maps to [] because its
  // evidence comes from pilot.training_attempts, not the Performance
  // Analytics rollup -- see the module comment.
  test('the field allowlist is exhaustive over the rule vocabulary and never spans rules', () => {
    expect(Object.keys(RULE_JUSTIFICATION_FIELDS).sort()).toEqual(
      [
        'assignments_stalled',
        'competition_loss_unresolved',
        'load_jumped',
        'load_up_wellness_down',
        'readiness_falling',
        'training_days_dropping',
        'transfer_check_failed',
      ].sort(),
    );
    const readinessFields = new Set(RULE_JUSTIFICATION_FIELDS.readiness_falling);
    const trainingFields = new Set(RULE_JUSTIFICATION_FIELDS.training_days_dropping);
    for (const field of trainingFields) expect(readinessFields.has(field)).toBe(false);
  });
});

// Jason 2026-10-05 ("A: Plain text"): athletes and parents read one plain
// sentence for a confirmed load_jumped gap; coaches keep the stored text.
describe('familyGapDescription', () => {
  const NONE: never[] = [];
  const RULE6 = 'deterministic_rule:load_jumped';

  function confirmed(reading: Partial<LoadJumpReading>) {
    const [s] = deriveSuggestions([], NO_STALLED, NO_OPEN_GAPS, NONE, NONE, [loadJump(reading)]);
    return { gap_description: s.suggested_description, detected_from: `deterministic_rule:${s.rule}`, detection_data: s.evidence };
  }

  test('a confirmed load jump reads as Jason\'s sentence, verbatim', () => {
    expect(familyGapDescription(confirmed({ acute_load: 2400, ratio: 2.4 }))).toBe(
      'Your training this week was about 2.4 times your usual week. Your coach is keeping an eye on it.',
    );
  });

  test('the ratio is the one the coach text shows, not a second rounding of the stored 2-decimal ratio', () => {
    // 2.449 shows as 2.4 to the coach; the stored ratio is 2.45, which
    // would round again to 2.5.
    const gap = confirmed({ acute_load: 2449, ratio: 2.449 });
    expect(gap.gap_description).toContain('(2.4x');
    expect(gap.detection_data.ratio).toBe(2.45);
    expect(familyGapDescription(gap)).toBe(
      'Your training this week was about 2.4 times your usual week. Your coach is keeping an eye on it.',
    );
  });

  test('a gap confirmed before ratio_shown existed falls back to its stored ratio, rounded to one decimal', () => {
    expect(familyGapDescription({
      gap_description: 'Training load jumped (coach text with no ratio in it). Worth a look.',
      detected_from: RULE6,
      detection_data: { acute_load: 2100, usual_weekly_load: 1000, ratio: 2.1, prior_weeks_with_load: 4 },
    })).toBe('Your training this week was about 2.1 times your usual week. Your coach is keeping an eye on it.');
  });

  test('a gap confirmed before ratio_shown existed takes the ratio its own coach text shows, not a second rounding', () => {
    expect(familyGapDescription({
      gap_description: 'Training load jumped: 2449 over the last 7 days against a usual week of 1000 (2.4x, averaged over 4 of the 4 weeks before; session RPE x minutes, unvalidated). Worth a look.',
      detected_from: RULE6,
      detection_data: { acute_load: 2449, usual_weekly_load: 1000, ratio: 2.45, prior_weeks_with_load: 4 },
    })).toBe('Your training this week was about 2.4 times your usual week. Your coach is keeping an eye on it.');
  });

  test.each([
    ['no detection data', null],
    ['empty detection data', {}],
    ['a ratio that is not a number', { ratio: 'lots' }],
    ['a zero ratio', { ratio: 0 }],
    ['a malformed ratio_shown and no ratio', { ratio_shown: 'about two' }],
  ])('never invents a ratio: %s returns the stored text', (_label, detection_data) => {
    expect(familyGapDescription({
      gap_description: 'stored coach text',
      detected_from: RULE6,
      detection_data: detection_data as Record<string, unknown> | null,
    })).toBe('stored coach text');
  });

  test.each([
    'deterministic_rule:readiness_falling',
    'deterministic_rule:load_up_wellness_down',
    'coach_observation',
    null,
  ])('every other gap (%s) keeps its stored text', (detected_from) => {
    expect(familyGapDescription({
      gap_description: 'stored coach text',
      detected_from,
      detection_data: { ratio: 2.4, ratio_shown: '2.4' },
    })).toBe('stored coach text');
  });
});

describe('familyGapJustifications', () => {
  test('each justified gap becomes one plain sentence; the rule and the fields do not travel', () => {
    const items = familyGapJustifications([
      { gap_id: 'g-r', rule: 'readiness_falling', fields: { avg_readiness: 6.1, readiness_late_avg: 5.5 } },
      { gap_id: 'g-t', rule: 'training_days_dropping', fields: { training_days: 10 } },
    ]);
    expect(items).toEqual([
      { gap_id: 'g-r', explanation: 'Your check-ins have been lower lately than they were earlier in the month. Your coach is keeping an eye on it.' },
      { gap_id: 'g-t', explanation: 'You have trained on fewer days lately than you did earlier in the month. Your coach is keeping an eye on it.' },
    ]);
    const text = JSON.stringify(items);
    expect(text).not.toContain('rule');
    expect(text).not.toContain('fields');
    expect(text).not.toContain('6.1');
  });

  test('a rule with no family sentence is dropped rather than named', () => {
    expect(familyGapJustifications([{ gap_id: 'g-6', rule: 'load_jumped', fields: {} }])).toEqual([]);
  });
});
