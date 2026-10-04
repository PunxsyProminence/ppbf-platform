import {
  type AthleteContactCapRow,
  checkEntryAgainstCap,
  entryCapWarnings,
  isHardOrOpen,
} from './athleteContactCaps';

// checkEntryAgainstCap is pure: the cap a coach set, one saved entry, and the
// raw count of hard/open gym days in the 7 ending on the entry's day (entry
// included). It only describes; nothing here can refuse an entry.

function cap(overrides: Partial<AthleteContactCapRow> = {}): AthleteContactCapRow {
  return {
    cap_id: 'cap-1',
    athlete_id: 'ath-1',
    highest_allowed_stage: 'controlled_sparring',
    max_hard_open_sessions_per_7_days: 2,
    note: '',
    set_by_account_id: 'coach-1',
    set_by_role: 'coach',
    set_at: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

const DAY = '2026-10-03';
const kinds = (warnings: { kind: string }[]) => warnings.map((w) => w.kind);

describe('stage against the highest allowed stage', () => {
  test('above the cap warns, naming both stages', () => {
    const [warning] = checkEntryAgainstCap(cap(), { contactStage: 'open_sparring', sparringType: 'play', sparringDay: DAY }, 0);
    expect(warning.kind).toBe('stage_above_cap');
    expect(warning.message).toContain('Open sparring');
    expect(warning.message).toContain('Controlled sparring');
    expect(warning.message).toContain('The coach decides');
  });

  test.each(['none', 'light_technical', 'conditioned', 'controlled_sparring'] as const)(
    '%s, at or below the cap, does not warn',
    (stage) => {
      expect(checkEntryAgainstCap(cap(), { contactStage: stage, sparringType: 'play', sparringDay: DAY }, 0)).toEqual([]);
    },
  );

  test('a cap of "none" makes any sparring stage above it a warning', () => {
    expect(kinds(checkEntryAgainstCap(
      cap({ highest_allowed_stage: 'none' }),
      { contactStage: 'light_technical', sparringType: 'technical', sparringDay: DAY },
      0,
    ))).toEqual(['stage_above_cap']);
  });

  test('no stage recorded is said, not guessed', () => {
    expect(kinds(checkEntryAgainstCap(cap(), { contactStage: null, sparringType: 'technical', sparringDay: DAY }, 0)))
      .toEqual(['stage_not_recorded']);
  });

  test('no stage limit set: the stage is never checked', () => {
    expect(checkEntryAgainstCap(
      cap({ highest_allowed_stage: null }),
      { contactStage: 'open_sparring', sparringType: 'play', sparringDay: DAY },
      0,
    )).toEqual([]);
  });
});

describe('hard or open gym days against the 7-day most', () => {
  const hard = { contactStage: 'controlled_sparring' as const, sparringType: 'hard', sparringDay: DAY };

  test('at the most is not over', () => {
    expect(checkEntryAgainstCap(cap(), hard, 2)).toEqual([]);
  });

  test('over the most warns, says sessions = gym days, and names the day and both numbers', () => {
    const [warning] = checkEntryAgainstCap(cap(), hard, 3);
    expect(warning.kind).toBe('hard_open_days_over_cap');
    expect(warning.message).toContain('3 hard or open sparring sessions');
    expect(warning.message).toContain(`ending ${DAY}`);
    expect(warning.message).toContain('sessions = gym days');
    expect(warning.message).toContain('the coach-set most is 2');
  });

  test('a most of 0: the first hard day warns', () => {
    expect(kinds(checkEntryAgainstCap(cap({ max_hard_open_sessions_per_7_days: 0 }), hard, 1)))
      .toEqual(['hard_open_days_over_cap']);
  });

  test('an entry that is not hard or open does not go over, however heavy the week', () => {
    expect(checkEntryAgainstCap(
      cap(),
      { contactStage: 'light_technical', sparringType: 'technical', sparringDay: DAY },
      5,
    )).toEqual([]);
  });

  test('open sparring counts as open even when its type is not "hard"', () => {
    expect(isHardOrOpen({ contactStage: 'open_sparring', sparringType: 'game' })).toBe(true);
    expect(isHardOrOpen({ contactStage: 'controlled_sparring', sparringType: 'hard' })).toBe(true);
    expect(isHardOrOpen({ contactStage: 'controlled_sparring', sparringType: 'conditioned' })).toBe(false);
  });

  test('no day limit set: never checked', () => {
    expect(checkEntryAgainstCap(cap({ max_hard_open_sessions_per_7_days: null }), hard, 9)).toEqual([]);
  });
});

describe('entryCapWarnings: an empty list never means "could not check"', () => {
  const hard = { contactStage: 'controlled_sparring' as const, sparringType: 'hard', sparringDay: DAY };

  test('a cap that could not be read says so, whatever the entry', () => {
    expect(kinds(entryCapWarnings({ state: 'unknown', cap: null }, hard, 0))).toEqual(['cap_unknown']);
  });

  test('no cap set: nothing to warn about', () => {
    expect(entryCapWarnings({ state: 'none', cap: null }, hard, 5)).toEqual([]);
  });

  test('a failed count: the day limit is reported as not checked, never as within it', () => {
    expect(kinds(entryCapWarnings({ state: 'set', cap: cap() }, hard, null))).toEqual(['days_not_counted']);
  });

  test('a failed count on an entry that is not hard or open: nothing to check, nothing said', () => {
    expect(entryCapWarnings(
      { state: 'set', cap: cap() },
      { contactStage: 'light_technical', sparringType: 'technical', sparringDay: DAY },
      null,
    )).toEqual([]);
  });

  test('a counted entry is checked as checkEntryAgainstCap checks it', () => {
    expect(kinds(entryCapWarnings({ state: 'set', cap: cap() }, hard, 3))).toEqual(['hard_open_days_over_cap']);
  });
});
