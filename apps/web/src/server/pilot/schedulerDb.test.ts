jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

import {
  bulkUpsertSchedulerAttendance,
  listRegisteredAthleteIdsForClass,
  upsertSchedulerAttendance,
  type SchedulerAttendance,
} from './schedulerDb';
import { query } from './db';

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function attendanceRecord(overrides: Partial<SchedulerAttendance> = {}): SchedulerAttendance {
  return {
    attendance_id: 'attendance-1',
    class_id: 'class-1',
    athlete_id: 'ATH-1',
    status: 'present',
    method: 'coach_override',
    checked_in_by_role: 'coach',
    checked_in_by_account_id: 'acct-coach-1',
    note: '',
    checked_in_at: '2026-08-06T12:00:00.000Z',
    updated_at: '2026-08-06T12:00:00.000Z',
    ...overrides,
  };
}

describe('bulkUpsertSchedulerAttendance', () => {
  test('does nothing for an empty batch -- no query at all', async () => {
    await bulkUpsertSchedulerAttendance('org-1', []);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // The whole point of the rewrite: one round trip, not one per athlete, and
  // the database's own ON CONFLICT resolves existence atomically rather than
  // a select-then-write race the caller could lose.
  test('issues exactly one statement for the whole batch, via unnest arrays', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const records = [
      attendanceRecord({ attendance_id: 'a-1', athlete_id: 'ATH-1', status: 'present' }),
      attendanceRecord({ attendance_id: 'a-2', athlete_id: 'ATH-2', status: 'absent' }),
    ];

    await bulkUpsertSchedulerAttendance('org-1', records);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('on conflict (organization_id, class_id, athlete_id) do update');
    expect(String(sql)).toContain('unnest($2::text[])');
    expect(params[0]).toBe('org-1');
    expect(params[1]).toEqual(['a-1', 'a-2']);
    expect(params[4]).toEqual(['present', 'absent']);
  });

  // attendance_id is deliberately not in the SET clause -- Postgres leaves an
  // unlisted column untouched on conflict, so an existing row keeps its own
  // id rather than being overwritten by whichever id this call generated.
  test('does not overwrite attendance_id on conflict', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await bulkUpsertSchedulerAttendance('org-1', [attendanceRecord()]);

    const [sql] = mockQuery.mock.calls[0];
    const setClause = String(sql).split('do update')[1];
    expect(setClause).not.toContain('attendance_id');
  });
});

describe('upsertSchedulerAttendance (single record)', () => {
  // The previous body here was a SELECT then INSERT-or-UPDATE with no
  // transaction: two concurrent check-ins for the same (class, athlete) both
  // saw no row, both INSERTed, and the loser's unique-violation surfaced as
  // an unexplained 500 -- a double-tapped check-in button was enough. The
  // single record is now the one-element case of the same atomic ON CONFLICT
  // statement.
  test('is one atomic ON CONFLICT statement, never a select-then-write', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await upsertSchedulerAttendance('org-1', attendanceRecord());

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).not.toMatch(/^\s*select/i);
    expect(String(sql)).toContain('on conflict (organization_id, class_id, athlete_id) do update');
    expect(params[1]).toEqual(['attendance-1']);
  });
});

describe('listRegisteredAthleteIdsForClass', () => {
  test('returns only live registrations, scoped to org and class', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ATH-1' }, { athlete_id: 'ATH-2' }]);

    const ids = await listRegisteredAthleteIdsForClass('org-1', 'class-1');

    expect(ids).toEqual(['ATH-1', 'ATH-2']);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("status = 'registered'");
    expect(params).toEqual(['org-1', 'class-1']);
  });
});
