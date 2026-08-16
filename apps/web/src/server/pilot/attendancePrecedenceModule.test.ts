// Unit tests for the CT-13 read module. The pg contract test proves the VIEW
// de-duplicates; these prove the module asks the view the right questions and
// never reaches around it.
//
// The property that matters most here is the one in the last describe block:
// every query this module issues names pilot.attendance_reconciled and nothing
// else. A single raw-table read added later would reintroduce the exact
// double-count the view exists to prevent, and it would look perfectly
// reasonable in review.

import {
  getAthleteAttendanceTotals,
  getOrganizationParticipationTotals,
  listAthleteAttendanceDays,
  listOverlappingSourceDays,
} from './attendancePrecedence';
import { query } from './db';

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

/** Every SQL string the module passed to the db layer during a test. */
function issuedSql(): string[] {
  return mockQuery.mock.calls.map((call) => String(call[0]));
}

describe('listAthleteAttendanceDays', () => {
  test('reads the view, scoped to one organization and one athlete', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listAthleteAttendanceDays('org-1', 'ath-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('pilot.attendance_reconciled');
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('athlete_id = $2');
    expect(params).toEqual(['org-1', 'ath-1', null, null]);
  });

  test('passes a date window through when given, and nulls when not', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listAthleteAttendanceDays('org-1', 'ath-1', { from: '2026-01-01', to: '2026-03-31' });
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'ath-1', '2026-01-01', '2026-03-31']);
  });
});

describe('getAthleteAttendanceTotals', () => {
  test('counts days by status and returns the recorded span', async () => {
    mockQuery.mockResolvedValueOnce([{
      days_present: '12', days_absent: '3', days_excused: '1', days_recorded: '16',
      first_day: '2026-01-05', last_day: '2026-03-20',
    }]);

    expect(await getAthleteAttendanceTotals('org-1', 'ath-1')).toEqual({
      athlete_id: 'ath-1',
      days_present: 12,
      days_absent: 3,
      days_excused: 1,
      days_recorded: 16,
      first_day: '2026-01-05',
      last_day: '2026-03-20',
    });
  });

  test('an athlete with no record reads as zero days RECORDED, not zero days present', async () => {
    // These are different claims. days_recorded is what distinguishes "never
    // marked" from "marked absent every time", and a caller needs both.
    mockQuery.mockResolvedValueOnce([{
      days_present: '0', days_absent: '0', days_excused: '0', days_recorded: '0',
      first_day: null, last_day: null,
    }]);

    const totals = await getAthleteAttendanceTotals('org-1', 'ath-new');
    expect(totals.days_recorded).toBe(0);
    expect(totals.days_present).toBe(0);
    expect(totals.first_day).toBeNull();
  });

  test('an empty result set does not throw', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const totals = await getAthleteAttendanceTotals('org-1', 'ath-1');
    expect(totals.days_recorded).toBe(0);
  });
});

describe('getOrganizationParticipationTotals', () => {
  test('returns unduplicated participants AND athlete-days as separate figures', async () => {
    // The distinction this whole ticket is about: "how many young people did
    // you serve" and "how many sessions did you deliver" are different
    // numbers, and neither is derivable from the other.
    mockQuery.mockResolvedValueOnce([{
      athletes_present: '18',
      athlete_days_present: '204',
      athlete_days_from_legacy: '31',
    }]);

    expect(await getOrganizationParticipationTotals('org-1', { from: '2026-01-01', to: '2026-03-31' }))
      .toEqual({
        athletes_present: 18,
        athlete_days_present: 204,
        athlete_days_from_legacy: 31,
        window_from: '2026-01-01',
        window_to: '2026-03-31',
      });
  });

  test('counts distinct athletes for the participant figure, not rows', async () => {
    mockQuery.mockResolvedValueOnce([{
      athletes_present: '0', athlete_days_present: '0', athlete_days_from_legacy: '0',
    }]);
    await getOrganizationParticipationTotals('org-1');

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('count(distinct athlete_id)');
  });

  test('surfaces how much of the figure rests on legacy records', async () => {
    mockQuery.mockResolvedValueOnce([{
      athletes_present: '5', athlete_days_present: '40', athlete_days_from_legacy: '40',
    }]);
    const totals = await getOrganizationParticipationTotals('org-1');
    // All 40 days came from the frozen legacy table -- a caller can say so
    // rather than presenting one undifferentiated confidence.
    expect(totals.athlete_days_from_legacy).toBe(totals.athlete_days_present);
  });
});

describe('listOverlappingSourceDays', () => {
  test('asks only for days where more than one source spoke', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listOverlappingSourceDays('org-1', 25);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('contributing_sources > 1');
    expect(params).toEqual(['org-1', 25]);
  });
});

describe('CT-13: the module never reaches around the view', () => {
  test('every query names the view and no raw attendance table', async () => {
    mockQuery.mockResolvedValue([{
      days_present: '0', days_absent: '0', days_excused: '0', days_recorded: '0',
      first_day: null, last_day: null,
      athletes_present: '0', athlete_days_present: '0', athlete_days_from_legacy: '0',
    }]);

    await listAthleteAttendanceDays('org-1', 'ath-1');
    await getAthleteAttendanceTotals('org-1', 'ath-1');
    await getOrganizationParticipationTotals('org-1');
    await listOverlappingSourceDays('org-1');

    const statements = issuedSql();
    expect(statements).toHaveLength(4);

    for (const sql of statements) {
      expect(sql).toContain('pilot.attendance_reconciled');
      // Anchored so the view's own name does not count as a legacy read.
      expect(sql).not.toMatch(/pilot\.attendance(?![\w_])/);
      expect(sql).not.toMatch(/pilot\.scheduler_attendance(?![\w_])/);
      expect(sql).not.toMatch(/pilot\.activity_log(?![\w_])/);
    }
  });

  test('no query unions or joins a second relation into the view', async () => {
    mockQuery.mockResolvedValue([]);
    await listAthleteAttendanceDays('org-1', 'ath-1');
    await listOverlappingSourceDays('org-1');

    for (const sql of issuedSql()) {
      expect(sql).not.toMatch(/\bunion\b/i);
      expect(sql).not.toMatch(/\bjoin\b/i);
    }
  });

  test('every read is scoped to one organization', async () => {
    mockQuery.mockResolvedValue([]);
    await listAthleteAttendanceDays('org-1', 'ath-1');
    await listOverlappingSourceDays('org-1');

    for (const sql of issuedSql()) {
      expect(sql).toContain('organization_id = $1');
    }
  });
});
