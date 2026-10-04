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
  return { athlete_id, week_index, week_load, session_count: 1 };
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
  });

  test('scoped to one organization and the given athletes, over 5 weekly buckets ending today', async () => {
    mockQuery.mockResolvedValue([]);
    await getWeeklySessionLoads(ORG, ['ath-1', 'ath-2']);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const text = sql.replace(/\s+/g, ' ');

    expect(text).toContain('from pilot.sessions');
    expect(text).toContain('organization_id = $1 and athlete_id = any($2::text[])');
    expect(text).toContain('date <= current_date');
    expect(text).toContain('date > current_date - ($3::int * 7)');
    expect(params).toEqual([ORG, ['ath-1', 'ath-2'], LOAD_JUMP_PRIOR_WEEKS + 1]);
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
