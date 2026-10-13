// listAthleteIdsCheckedInToday (F-040): which athletes have their own check-in
// for the gym's today. Pinned here: the day is the GYM's day (not UTC), the
// read is scoped to the organization and the given athletes, it returns ids
// only, and an empty audience reads nothing.

import { listAthleteIdsCheckedInToday } from './athleteCheckIns';
import { query } from './db';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

test('reads the gym day, not the UTC day: 03:00 UTC on Mar 15 is still Mar 14 at the gym', async () => {
  mockQuery.mockResolvedValue([{ athlete_id: 'ath-2' }]);

  const ids = await listAthleteIdsCheckedInToday('org-1', ['ath-1', 'ath-2'], '2026-03-15T03:00:00.000Z');

  expect(ids).toEqual(['ath-2']);
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toMatch(/from pilot\.athlete_check_ins/);
  expect(sql).toMatch(/organization_id = \$1/);
  expect(sql).toMatch(/athlete_id = any\(\$2::text\[\]\)/);
  expect(sql).toMatch(/checked_in_on = \$3::date/);
  expect(sql).not.toMatch(/energy|soreness|motivation|\*/);
  expect(params).toEqual(['org-1', ['ath-1', 'ath-2'], '2026-03-14']);
});

test('an empty audience reads nothing', async () => {
  expect(await listAthleteIdsCheckedInToday('org-1', [])).toEqual([]);
  expect(mockQuery).not.toHaveBeenCalled();
});
