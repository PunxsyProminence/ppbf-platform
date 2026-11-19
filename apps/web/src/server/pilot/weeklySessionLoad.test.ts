// The weekly load read and the load-jump comparison behind Rule 6.
//
// What these pin:
//   * the SQL counts ONLY athlete post-session self-reports with both RPE and
//     minutes, inside one organization, over exactly 5 weekly buckets;
//   * the rule stays silent below LOAD_JUMP_MIN_PRIOR_WEEKS of history;
//   * "usual week" averages only the prior weeks that carry load;
//   * the ratio comes from the formula engine's CORE-13.
//
// Mocked-pool limits, stated rather than implied: the SQL tests prove the text
// and bind parameters this module SENDS, not what Postgres returns for them.

import { query } from './db';
import { deriveSuggestions } from './progressionSuggestions';
import {
  classifyLoadWeek,
  getWeeklyLoadCoverage,
  getWeeklySessionLoads,
  LOAD_JUMP_MIN_PRIOR_WEEKS,
  LOAD_JUMP_PRIOR_WEEKS,
  LOAD_JUMP_RATIO,
  RATED_SHARE_MIN,
  REST_WEEK_MIN_MARKED_DAYS,
  readFamilyLoadNumbers,
  readLoadJumps,
  readLoadWeekCoverage,
  type WeeklyCoverageRow,
  type WeeklyLoadRow,
} from './weeklySessionLoad';

jest.mock('./db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.Mock;
const ORG = 'org-1';

afterEach(() => {
  jest.clearAllMocks();
});

function week(week_index: number, week_load: number, athlete_id = 'ath-1'): WeeklyLoadRow {
  return { athlete_id, week_index, week_load, session_count: 1, week_minutes: 60 };
}

function cover(week_index: number, attended: number, rated: number, marked_days = 0, athlete_id = 'ath-1'): WeeklyCoverageRow {
  return { athlete_id, week_index, attended, rated, marked_days };
}

/** Every week that has a load row is fully rated; every other week has nothing. */
function fullyLogged(rows: readonly WeeklyLoadRow[]): WeeklyCoverageRow[] {
  return rows.map((row) => cover(row.week_index, 1, 1, 0, row.athlete_id));
}

function jumps(rows: WeeklyLoadRow[], coverage: WeeklyCoverageRow[] = fullyLogged(rows)) {
  return readLoadJumps(ORG, rows, coverage);
}

describe('the rule as Jason set it', () => {
  test('threshold 2.0x, usual week over the 4 weeks before, at least 3 of them', () => {
    expect(LOAD_JUMP_RATIO).toBe(2.0);
    expect(LOAD_JUMP_PRIOR_WEEKS).toBe(4);
    expect(LOAD_JUMP_MIN_PRIOR_WEEKS).toBe(3);
  });
});

describe('getWeeklySessionLoads SQL', () => {
  test('no athletes, no query', async () => {
    expect(await getWeeklySessionLoads(ORG, [])).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('counts only athlete post-session self-reports with both RPE and minutes', async () => {
    mockQuery.mockResolvedValue([]);
    await getWeeklySessionLoads(ORG, ['ath-1']);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    const text = sql.replace(/\s+/g, ' ');

    expect(text).toContain("rpe_method = 'athlete_post_session_self_report'");
    expect(text).toContain('rpe is not null and duration_minutes is not null');
    expect(text).toContain('sum(rpe * duration_minutes)');
    // The family wording's minutes are summed over the same filtered rows.
    expect(text).toContain('sum(duration_minutes)::float8 as week_minutes');
  });

  test('scoped to one organization and the given athletes, over 5 weekly buckets ending the gym day', async () => {
    mockQuery.mockResolvedValue([]);
    const asOf = new Date('2026-10-05T02:30:00Z');
    await getWeeklySessionLoads(ORG, ['ath-1', 'ath-2'], asOf);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const text = sql.replace(/\s+/g, ' ');

    expect(text).toContain('from pilot.sessions');
    expect(text).toContain('organization_id = $1 and athlete_id = any($2::text[])');
    expect(text).toContain("date <= ($4::timestamptz at time zone 'America/New_York')::date");
    expect(text).not.toContain('current_date');
    expect(params).toEqual([ORG, ['ath-1', 'ath-2'], LOAD_JUMP_PRIOR_WEEKS + 1, asOf.toISOString()]);
  });
});

describe('readLoadJumps', () => {
  test('this week against the average of the prior weeks, through CORE-13', () => {
    const [reading] = jumps([week(0, 2000), week(1, 900), week(2, 1000), week(3, 1100), week(4, 1000)]);
    expect(reading).toEqual({
      athlete_id: 'ath-1',
      acute_load: 2000,
      usual_weekly_load: 1000,
      ratio: 2,
      prior_weeks_with_load: 4,
    });
  });

  test('exactly LOAD_JUMP_MIN_PRIOR_WEEKS prior weeks is enough; one fewer is silent', () => {
    const enough = jumps([week(0, 3000), week(1, 1000), week(2, 1000), week(3, 1000)]);
    expect(enough).toHaveLength(1);
    expect(enough[0].prior_weeks_with_load).toBe(LOAD_JUMP_MIN_PRIOR_WEEKS);

    const thin = jumps([week(0, 3000), week(1, 1000), week(2, 1000)]);
    expect(thin).toEqual([]);
  });

  test('a prior week with no load is unknown, not zero: it is left out of the average', () => {
    // Weeks 1, 2, 4 carry 1000; week 3 has nothing logged. Usual = 1000, not 750.
    const [reading] = jumps([week(0, 2000), week(1, 1000), week(2, 1000), week(4, 1000)]);
    expect(reading.usual_weekly_load).toBe(1000);
    expect(reading.ratio).toBe(2);
    expect(reading.prior_weeks_with_load).toBe(3);
  });

  test('nothing logged this week is unknown, not 0: the ratio stays silent (R6-b2)', () => {
    expect(jumps([week(1, 1000), week(2, 1000), week(3, 1000)])).toEqual([]);
  });

  test('buckets outside 0..4 are ignored, and athletes are read separately', () => {
    const readings = jumps([
      week(0, 2000, 'ath-1'),
      week(1, 1000, 'ath-1'),
      week(2, 1000, 'ath-1'),
      week(5, 1000, 'ath-1'),
      week(0, 500, 'ath-2'),
      week(1, 500, 'ath-2'),
      week(2, 500, 'ath-2'),
      week(3, 500, 'ath-2'),
    ]);
    expect(readings.map((r) => r.athlete_id)).toEqual(['ath-2']);
    expect(readings[0].ratio).toBe(1);
  });

  test('numeric strings from the driver are read as numbers', () => {
    const rows = [week(0, 2000), week(1, 1000), week(2, 1000), week(3, 1000)].map((row) => ({
      ...row,
      week_load: String(row.week_load) as unknown as number,
    }));
    expect(jumps(rows)[0].ratio).toBe(2);
  });
});

// OD-2026-11-17-004 (OW25-31 A): the numbers an under-18 and their parents read.
describe('readFamilyLoadNumbers', () => {
  function bucket(week_index: number, session_count: number, week_minutes: number, week_load = session_count * 300, athlete_id = 'ath-1'): WeeklyLoadRow {
    return { athlete_id, week_index, week_load, session_count, week_minutes };
  }

  test('this week against the low-high range of the usual weeks', () => {
    expect(readFamilyLoadNumbers([
      bucket(0, 6, 410), bucket(1, 3, 180), bucket(2, 4, 240), bucket(3, 3, 200), bucket(4, 4, 220),
    ], 'ath-1')).toEqual({
      this_week: { sessions: 6, minutes: 410 },
      usual: { sessions_low: 3, sessions_high: 4, minutes_low: 180, minutes_high: 240 },
    });
  });

  test('the usual weeks are the ones Rule 6 averages: an empty week is skipped, not read as zero', () => {
    const numbers = readFamilyLoadNumbers([
      bucket(0, 5, 300), bucket(1, 3, 150), bucket(2, 0, 0, 0), bucket(3, 2, 120), bucket(4, 3, 160),
    ], 'ath-1');
    expect(numbers?.usual).toEqual({ sessions_low: 2, sessions_high: 3, minutes_low: 120, minutes_high: 160 });
  });

  test('silent below the same minimum of usual weeks Rule 6 needs', () => {
    expect(readFamilyLoadNumbers([bucket(0, 5, 300), bucket(1, 3, 150), bucket(2, 2, 120)], 'ath-1')).toBeNull();
  });

  test.each([
    ['no row for this week', [bucket(1, 3, 150), bucket(2, 2, 120), bucket(3, 3, 160)]],
    ['no load this week', [bucket(0, 2, 60, 0), bucket(1, 3, 150), bucket(2, 2, 120), bucket(3, 3, 160)]],
    ['a value that is not a number', [bucket(0, 5, Number.NaN), bucket(1, 3, 150), bucket(2, 2, 120), bucket(3, 3, 160)]],
  ])('never a made-up number: %s gives null', (_label, rows) => {
    expect(readFamilyLoadNumbers(rows, 'ath-1')).toBeNull();
  });

  test('another athlete and buckets outside 0..4 are ignored; minutes are whole; driver strings are read as numbers', () => {
    const numbers = readFamilyLoadNumbers([
      { ...bucket(0, 5, 300.4), session_count: '5' as unknown as number },
      bucket(1, 3, 150), bucket(2, 2, 120), bucket(3, 3, 160),
      bucket(5, 1, 10), bucket(1, 9, 900, 2700, 'ath-2'),
    ], 'ath-1');
    expect(numbers).toEqual({
      this_week: { sessions: 5, minutes: 300 },
      usual: { sessions_low: 2, sessions_high: 3, minutes_low: 120, minutes_high: 160 },
    });
  });
});

// Lane R6-b2 (OD-2026-11-17-004): a per-week share of rated sessions, and a
// ratio that stays silent otherwise; no imputed numbers.
describe('week status: attended, rated and rest-marked', () => {
  test('the thresholds: 3 of 4 rated; a rest week needs 4 of 7 days marked (Overwatch 2026-11-19)', () => {
    expect(RATED_SHARE_MIN).toBe(0.75);
    expect(REST_WEEK_MIN_MARKED_DAYS).toBe(4);
  });

  test.each([
    ['nothing attended, nothing marked', 0, 0, 0, 'not_logged'],
    ['nothing attended, 1 day marked: no rest week', 0, 0, 1, 'not_logged'],
    ['nothing attended, 3 days marked: no rest week', 0, 0, 3, 'not_logged'],
    ['nothing attended, 4 days marked', 0, 0, 4, 'rest_marked'],
    ['nothing attended, the whole week marked', 0, 0, 7, 'rest_marked'],
    ['every session rated', 3, 3, 0, 'logged'],
    ['3 of 4 rated', 4, 3, 0, 'logged'],
    ['2 of 3 rated', 3, 2, 0, 'partly_logged'],
    ['none of 2 rated', 2, 0, 0, 'partly_logged'],
    ['attended on marked days: the sessions decide', 2, 0, 3, 'partly_logged'],
    ['attended on marked days, all rated', 2, 2, 3, 'logged'],
  ] as const)('%s -> %s', (_label, attended, rated, marked, status) => {
    expect(classifyLoadWeek(attended, rated, marked)).toBe(status);
  });

  test('readLoadWeekCoverage gives all 5 weeks, newest first; a week with no row is nothing known', () => {
    const weeks = readLoadWeekCoverage([cover(0, 3, 3), cover(2, 0, 0, 7), cover(1, 9, 9, 0, 'ath-2')], 'ath-1');
    expect(weeks.map((w) => [w.week_index, w.status])).toEqual([
      [0, 'logged'], [1, 'not_logged'], [2, 'rest_marked'], [3, 'not_logged'], [4, 'not_logged'],
    ]);
    expect(weeks[1]).toEqual({ week_index: 1, attended: 0, rated: 0, marked_days: 0, status: 'not_logged' });
  });
});

describe('readLoadJumps speaks only on complete weeks', () => {
  const steady = [week(0, 2000), week(1, 1000), week(2, 1000), week(3, 1000), week(4, 1000)];

  test('no coverage at all: silent, never a guess', () => {
    expect(readLoadJumps(ORG, steady, [])).toEqual([]);
  });

  test('this week partly rated: silent', () => {
    const coverage = [cover(0, 3, 2), cover(1, 1, 1), cover(2, 1, 1), cover(3, 1, 1), cover(4, 1, 1)];
    expect(readLoadJumps(ORG, steady, coverage)).toEqual([]);
  });

  test('this week at exactly 3 of 4 rated: speaks', () => {
    const coverage = [cover(0, 4, 3), cover(1, 1, 1), cover(2, 1, 1), cover(3, 1, 1), cover(4, 1, 1)];
    expect(readLoadJumps(ORG, steady, coverage)).toHaveLength(1);
  });

  test('any usual week partly rated: silent (it would pull the usual week down)', () => {
    const coverage = [cover(0, 1, 1), cover(1, 3, 1), cover(2, 1, 1), cover(3, 1, 1), cover(4, 1, 1)];
    expect(readLoadJumps(ORG, steady, coverage)).toEqual([]);
  });

  test('a marked rest week counts as a recorded 0 in the usual week', () => {
    const rows = [week(0, 2000), week(1, 1500), week(2, 1500), week(4, 1500)];
    const coverage = [cover(0, 2, 2), cover(1, 2, 2), cover(2, 2, 2), cover(3, 0, 0, 7), cover(4, 2, 2)];
    const [reading] = readLoadJumps(ORG, rows, coverage);
    expect(reading.usual_weekly_load).toBe(1125); // (1500 + 1500 + 0 + 1500) / 4
    expect(reading.prior_weeks_with_load).toBe(4);
    expect(reading.ratio).toBeCloseTo(1.78, 2);
  });

  test('an unlogged usual week (no mark) is still left out, not read as 0', () => {
    const rows = [week(0, 2000), week(1, 1000), week(2, 1000), week(4, 1000)];
    const coverage = [cover(0, 2, 2), cover(1, 2, 2), cover(2, 2, 2), cover(3, 0, 0, 0), cover(4, 2, 2)];
    const [reading] = readLoadJumps(ORG, rows, coverage);
    expect(reading.usual_weekly_load).toBe(1000);
    expect(reading.prior_weeks_with_load).toBe(3);
  });

  test('rest weeks fill the 3-week floor, but at least one usual week must be logged with load', () => {
    const allRest = [cover(0, 2, 2), cover(1, 0, 0, 7), cover(2, 0, 0, 7), cover(3, 0, 0, 7), cover(4, 0, 0, 0)];
    expect(readLoadJumps(ORG, [week(0, 2000)], allRest)).toEqual([]);
    const twoKnown = [cover(0, 2, 2), cover(1, 2, 2), cover(2, 0, 0, 7), cover(3, 0, 0, 0), cover(4, 0, 0, 0)];
    expect(readLoadJumps(ORG, [week(0, 2000), week(1, 1000)], twoKnown)).toEqual([]);
  });

  // Reviewer B / Overwatch 2026-11-19: the weeks roll forward a day at a
  // time, so a 7-day mark read 3 days later sits 4 days in one week and 3 in
  // the next. It is ONE rest week, never two zeros.
  test('a 7-day mark straddling two weeks (4 + 3 days) counts as exactly one rest week', () => {
    const rows = [week(0, 1000), week(3, 1000), week(4, 1000)];
    const coverage = [cover(0, 2, 2), cover(1, 0, 0, 4), cover(2, 0, 0, 3), cover(3, 2, 2), cover(4, 2, 2)];
    const [reading] = readLoadJumps(ORG, rows, coverage);
    expect(reading.prior_weeks_with_load).toBe(3); // weeks 1 (rest), 3, 4; week 2 is unknown
    expect(reading.usual_weekly_load).toBeCloseTo(2000 / 3, 6);
  });

  test('a 1-3 day mark in an empty week makes no rest week: that week stays unknown', () => {
    const rows = [week(0, 2000), week(1, 1000), week(2, 1000)];
    const coverage = [cover(0, 2, 2), cover(1, 2, 2), cover(2, 2, 2), cover(3, 0, 0, 3), cover(4, 0, 0, 0)];
    expect(readLoadJumps(ORG, rows, coverage)).toEqual([]); // only 2 known usual weeks
  });

  // Overwatch 2026-11-19: the small-usual case is the intended flag after a
  // break (Q3): 1 logged week + 2 marked rest weeks + a heavy week back.
  test('back from a break: 1 logged week + 2 rest weeks + a heavy week speaks, as the coach-only Rule 6 card', () => {
    const rows = [week(0, 1500), week(3, 1500)];
    const coverage = [cover(0, 3, 3), cover(1, 0, 0, 7), cover(2, 0, 0, 7), cover(3, 3, 3), cover(4, 0, 0, 0)];
    const readings = readLoadJumps(ORG, rows, coverage);
    expect(readings).toEqual([{ athlete_id: 'ath-1', acute_load: 1500, usual_weekly_load: 500, ratio: 3, prior_weeks_with_load: 3 }]);
    expect(readings[0].ratio).toBeGreaterThanOrEqual(LOAD_JUMP_RATIO);

    // Through the rule: a suggestion for the coach to confirm (nothing is
    // filed until they do), with today's coach text unchanged.
    const [suggestion] = deriveSuggestions([], [], new Map(), [], [], readings, []);
    expect(suggestion).toMatchObject({ athlete_id: 'ath-1', rule: 'load_jumped', gap_type: 'endurance' });
    expect(suggestion.suggested_description).toBe(
      'Training load jumped: 1500 over the last 7 days against a usual week of 500 '
      + '(3.0x, averaged over 3 of the 4 weeks before; session RPE x minutes, unvalidated). Worth a look.',
    );
  });
});

describe('getWeeklyLoadCoverage SQL', () => {
  test('no athletes, no query', async () => {
    expect(await getWeeklyLoadCoverage(ORG, [])).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('attendance from the reconciled register only, rest marks live only, one organization, the same 5 buckets', async () => {
    mockQuery.mockResolvedValue([]);
    const asOf = new Date('2026-11-19T17:00:00Z');
    await getWeeklyLoadCoverage(ORG, ['ath-1'], asOf);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const text = sql.replace(/\s+/g, ' ');

    expect(text).toContain('from pilot.attendance_reconciled');
    expect(text).not.toMatch(/pilot\.(attendance|scheduler_attendance|activity_log)\b(?!_)/);
    expect(text).toContain("status = 'present'");
    expect(text).toContain('join pilot.athlete_rest_marks m on m.organization_id = $1');
    expect(text).toContain('m.cleared_at is null');
    // An open session dated today is not counted yet.
    expect(text).toContain("(completed_flag = false and date = ($4::timestamptz at time zone 'America/New_York')::date)");
    // Rated = Rule 6's own sessions.
    expect(text).toContain("rpe_method = 'athlete_post_session_self_report' and rpe is not null and duration_minutes is not null");
    expect(text).toContain("((($4::timestamptz at time zone 'America/New_York')::date - w.day) / 7)::int as week_index");
    expect(text).toContain('organization_id = $1 and athlete_id = any($2::text[])');
    expect(text).not.toContain('current_date');
    expect(params).toEqual([ORG, ['ath-1'], LOAD_JUMP_PRIOR_WEEKS + 1, asOf.toISOString()]);
  });
});
