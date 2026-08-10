jest.mock('./db', () => ({
  query: jest.fn(),
}));

import {
  getClassAttendanceRoster,
  getOrganizationAttendanceSummary,
  getWeeklyAttendanceTrend,
} from './attendanceReporting';
import { query } from './db';

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('getOrganizationAttendanceSummary', () => {
  test('computes attendance_rate from present/absent only, excluding excused', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        athlete_id: 'ATH-1',
        full_name: 'Jordan Test',
        present_count: 3,
        absent_count: 1,
        excused_count: 2,
        total_marked: 6,
        last_marked_at: '2026-08-01T00:00:00.000Z',
      },
    ]);

    const [row] = await getOrganizationAttendanceSummary('org-1');

    // 3 present / (3 present + 1 absent) = 0.75. The two excused marks do
    // not enter the denominator -- an excused absence is not a claim of
    // unreliability the way an unexcused one is.
    expect(row.attendance_rate).toBe(0.75);
    expect(row.total_marked).toBe(6);
  });

  test('an athlete with only excused marks (or none at all) gets a null rate, not 0', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        athlete_id: 'ATH-2',
        full_name: 'Never Marked',
        present_count: 0,
        absent_count: 0,
        excused_count: 0,
        total_marked: 0,
        last_marked_at: null,
      },
    ]);

    const [row] = await getOrganizationAttendanceSummary('org-1');

    expect(row.attendance_rate).toBeNull();
  });

  test('passes null (not undefined) for the org-wide case so the SQL null check matches', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getOrganizationAttendanceSummary('org-1');

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', null, null]);
  });

  test('a coach-scoped call passes the coach account id and since timestamp through', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getOrganizationAttendanceSummary('org-1', {
      coachAccountId: 'acct-coach-1',
      sinceIso: '2026-07-01T00:00:00.000Z',
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('from pilot.athletes ath');
    expect(sql).toContain('pilot.scheduler_attendance');
    expect(params).toEqual(['org-1', 'acct-coach-1', '2026-07-01T00:00:00.000Z']);
  });

  // A mark with no live registration appears on no class roster, so counting
  // it here would put a number on the dashboard no drill-down can explain.
  test('only registration-backed marks count toward the summary', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getOrganizationAttendanceSummary('org-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('join pilot.scheduler_registrations reg');
    expect(sql).toContain("reg.status = 'registered'");
  });
});

describe('getClassAttendanceRoster', () => {
  test('queries the registration/attendance join scoped to the organization and class', async () => {
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ATH-1', full_name: 'Jordan Test', status: null, method: null, note: null, checked_in_at: null },
    ]);

    const roster = await getClassAttendanceRoster('org-1', 'class-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('pilot.scheduler_registrations');
    expect(sql).toContain("r.status = 'registered'");
    expect(params).toEqual(['org-1', 'class-1']);
    // A registered athlete never checked in comes back with status: null,
    // not a fabricated 'absent'.
    expect(roster[0].status).toBeNull();
  });
});

describe('getWeeklyAttendanceTrend', () => {
  test('computes attendance_rate per week from present/absent only, excluding excused', async () => {
    mockQuery.mockResolvedValueOnce([
      { week_start: '2026-07-27', present_count: 6, absent_count: 2, excused_count: 1, total_marked: 9 },
    ]);

    const [week] = await getWeeklyAttendanceTrend('org-1');

    expect(week.attendance_rate).toBe(0.75);
    expect(week.total_marked).toBe(9);
  });

  test('a week with only excused marks gets a null rate, not 0', async () => {
    mockQuery.mockResolvedValueOnce([
      { week_start: '2026-07-27', present_count: 0, absent_count: 0, excused_count: 3, total_marked: 3 },
    ]);

    const [week] = await getWeeklyAttendanceTrend('org-1');

    expect(week.attendance_rate).toBeNull();
  });

  test('only registration-backed marks count, same as the org summary', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getWeeklyAttendanceTrend('org-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('join pilot.scheduler_registrations reg');
    expect(sql).toContain("reg.status = 'registered'");
  });

  test('buckets by the class start_at, not the mark timestamp', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getWeeklyAttendanceTrend('org-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("date_trunc('week', c.start_at)");
  });

  // Round 9 review: the window must exclude the current, still-in-progress
  // week, not just bound from below -- otherwise it silently returns
  // weeks + 1 buckets whenever the current week already has marked
  // attendance. A mocked query result can't catch the real date_trunc/
  // interval arithmetic (see attendanceReporting.pg.test.ts), but it can at
  // least pin that the upper-bound clause is present in the SQL sent.
  test('the window excludes the current in-progress week', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getWeeklyAttendanceTrend('org-1', { weeks: 8 });

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("c.start_at < date_trunc('week', now())");
  });

  test('weeks defaults to 8 and is clamped to a sane range', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await getWeeklyAttendanceTrend('org-1');
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 8, null]);

    mockQuery.mockResolvedValueOnce([]);
    await getWeeklyAttendanceTrend('org-1', { weeks: 500 });
    expect(mockQuery.mock.calls[1][1]).toEqual(['org-1', 52, null]);

    mockQuery.mockResolvedValueOnce([]);
    await getWeeklyAttendanceTrend('org-1', { weeks: 0 });
    expect(mockQuery.mock.calls[2][1]).toEqual(['org-1', 1, null]);
  });

  test('a coach scope narrows to their own classes, same ownership test as the org summary', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getWeeklyAttendanceTrend('org-1', { coachAccountId: 'coach-1' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('c.coach_account_id = $3');
    expect(params).toEqual(['org-1', 8, 'coach-1']);
  });
});
