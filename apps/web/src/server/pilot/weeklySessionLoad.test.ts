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
import {
  getWeeklySessionLoads,
  LOAD_JUMP_MIN_PRIOR_WEEKS,
  LOAD_JUMP_PRIOR_WEEKS,
  LOAD_JUMP_RATIO,
  readFamilyLoadNumbers,
  readLoadJumps,
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
    const [reading] = readLoadJumps(ORG, [week(0, 2000), week(1, 900), week(2, 1000), week(3, 1100), week(4, 1000)]);
    expect(reading).toEqual({
      athlete_id: 'ath-1',
      acute_load: 2000,
      usual_weekly_load: 1000,
      ratio: 2,
      prior_weeks_with_load: 4,
    });
  });

  test('exactly LOAD_JUMP_MIN_PRIOR_WEEKS prior weeks is enough; one fewer is silent', () => {
    const enough = readLoadJumps(ORG, [week(0, 3000), week(1, 1000), week(2, 1000), week(3, 1000)]);
    expect(enough).toHaveLength(1);
    expect(enough[0].prior_weeks_with_load).toBe(LOAD_JUMP_MIN_PRIOR_WEEKS);

    const thin = readLoadJumps(ORG, [week(0, 3000), week(1, 1000), week(2, 1000)]);
    expect(thin).toEqual([]);
  });

  test('a prior week with no load is unknown, not zero: it is left out of the average', () => {
    // Weeks 1, 2, 4 carry 1000; week 3 has nothing logged. Usual = 1000, not 750.
    const [reading] = readLoadJumps(ORG, [week(0, 2000), week(1, 1000), week(2, 1000), week(4, 1000)]);
    expect(reading.usual_weekly_load).toBe(1000);
    expect(reading.ratio).toBe(2);
    expect(reading.prior_weeks_with_load).toBe(3);
  });

  test('nothing logged this week reads as 0 against the usual week', () => {
    const [reading] = readLoadJumps(ORG, [week(1, 1000), week(2, 1000), week(3, 1000)]);
    expect(reading.acute_load).toBe(0);
    expect(reading.ratio).toBe(0);
  });

  test('buckets outside 0..4 are ignored, and athletes are read separately', () => {
    const readings = readLoadJumps(ORG, [
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
    expect(readLoadJumps(ORG, rows)[0].ratio).toBe(2);
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
