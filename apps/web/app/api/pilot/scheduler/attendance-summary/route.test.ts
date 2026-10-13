import { NextRequest } from 'next/server';

import { GET } from './route';
import {
  getClassAttendanceReport,
  getClassAttendanceRoster,
  getOrganizationAttendanceSummary,
  getWeeklyAttendanceTrend,
} from '@/src/server/pilot/attendanceReporting';
import { athleteIdsForCoach } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getSchedulerClassById } from '@/src/server/pilot/schedulerDb';

jest.mock('@/src/server/pilot/attendanceReporting', () => ({
  // The CSV writer is pure and stays real, so the file this route sends is the shipped one.
  attendanceByAthleteCsv: jest.requireActual('@/src/server/pilot/attendanceReporting').attendanceByAthleteCsv,
  attendanceByClassCsv: jest.requireActual('@/src/server/pilot/attendanceReporting').attendanceByClassCsv,
  classReportTotals: jest.requireActual('@/src/server/pilot/attendanceReporting').classReportTotals,
  getClassAttendanceReport: jest.fn(),
  getOrganizationAttendanceSummary: jest.fn(),
  getClassAttendanceRoster: jest.fn(),
  getWeeklyAttendanceTrend: jest.fn(),
}));

jest.mock('@/src/server/pilot/schedulerDb', () => ({
  getSchedulerClassById: jest.fn(),
}));

jest.mock('@/src/server/pilot/access', () => ({
  isOrganizationAdminRole: (role: string) => role === 'organization_admin' || role === 'admin',
  athleteIdsForCoach: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requirePrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith('Unauthorized')
      ? 401
      : message.startsWith('Forbidden')
        ? 403
        : message.startsWith('Missing') || message.startsWith('Unsupported')
          ? 400
          : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockSummary = jest.mocked(getOrganizationAttendanceSummary);
const mockRoster = jest.mocked(getClassAttendanceRoster);
const mockGetClass = jest.mocked(getSchedulerClassById);
const mockTrend = jest.mocked(getWeeklyAttendanceTrend);
const mockReachable = jest.mocked(athleteIdsForCoach);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-caller',
    role,
    organizationId: 'org-a',
    athleteId: null,
    ...overrides,
  } as never;
}

function request(url: string): NextRequest {
  return new NextRequest(`https://ppbf.example${url}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReachable.mockResolvedValue([]);
});

describe('GET /api/pilot/scheduler/attendance-summary', () => {
  test('organization_admin gets an org-wide summary with no coach filter', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSummary.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary'));

    expect(response.status).toBe(200);
    expect(mockSummary).toHaveBeenCalledWith('org-a', { coachAccountId: undefined, sinceIso: undefined });
  });

  test('coach gets a summary scoped to their own account', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockSummary.mockResolvedValueOnce([]);

    await GET(request('/api/pilot/scheduler/attendance-summary'));

    expect(mockSummary).toHaveBeenCalledWith('org-a', { coachAccountId: 'acct-coach-1', sinceIso: undefined });
  });

  test('athlete, parent, and board are refused -- this is an ops surface, not self-service', async () => {
    for (const role of ['athlete', 'parent', 'board']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request('/api/pilot/scheduler/attendance-summary'));
      expect(response.status).toBe(403);
    }
    expect(mockSummary).not.toHaveBeenCalled();
  });

  test('a class_id query returns that class roster instead of the org summary', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetClass.mockResolvedValueOnce({
      class_id: 'class-1',
      coach_account_id: 'acct-coach-1',
      scheduled_by_account_id: 'acct-coach-1',
      covering_coach_account_id: undefined,
    } as never);
    mockRoster.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'));

    expect(response.status).toBe(200);
    expect(mockRoster).toHaveBeenCalledWith('org-a', 'class-1');
    expect(mockSummary).not.toHaveBeenCalled();
  });

  test('a coach who does not own the requested class is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));
    mockGetClass.mockResolvedValueOnce({
      class_id: 'class-1',
      coach_account_id: 'acct-coach-1',
      scheduled_by_account_id: 'acct-coach-1',
      covering_coach_account_id: undefined,
    } as never);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'));

    expect(response.status).toBe(403);
    expect(mockRoster).not.toHaveBeenCalled();
  });

  test('a coach who covers the class is allowed even without owning it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-covering' }));
    mockGetClass.mockResolvedValueOnce({
      class_id: 'class-1',
      coach_account_id: 'acct-coach-1',
      scheduled_by_account_id: 'acct-coach-1',
      covering_coach_account_id: 'acct-covering',
    } as never);
    mockRoster.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'));

    expect(response.status).toBe(200);
  });

  test('a class_id with no matching class is a 400 Missing error, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetClass.mockResolvedValueOnce(null);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=nope'));

    expect(response.status).toBe(400);
    expect(mockRoster).not.toHaveBeenCalled();
  });

  // Passed straight through to a ::timestamptz cast in attendanceReporting.ts;
  // an invalid string must be caught here as a 400, not left to surface as a
  // raw Postgres error that jsonError would report as a generic 500.
  test('an invalid since value is a 400, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?since=not-a-date'));

    expect(response.status).toBe(400);
    expect(mockSummary).not.toHaveBeenCalled();
  });

  test('a valid since value is passed through', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSummary.mockResolvedValueOnce([]);

    await GET(request('/api/pilot/scheduler/attendance-summary?since=2026-07-01T00:00:00.000Z'));

    expect(mockSummary).toHaveBeenCalledWith('org-a', { coachAccountId: undefined, sinceIso: '2026-07-01T00:00:00.000Z' });
  });

  describe('?trend=1 (#173)', () => {
    test('returns the weekly trend instead of the athlete summary', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockTrend.mockResolvedValueOnce([
        { week_start: '2026-07-27', present_count: 5, absent_count: 1, excused_count: 0, total_marked: 6, attendance_rate: 0.833 },
      ]);

      const response = await GET(request('/api/pilot/scheduler/attendance-summary?trend=1'));

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.trend).toHaveLength(1);
      expect(mockSummary).not.toHaveBeenCalled();
      expect(mockTrend).toHaveBeenCalledWith('org-a', { coachAccountId: undefined, weeks: undefined });
    });

    test('a coach gets a trend scoped to their own classes', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
      mockTrend.mockResolvedValueOnce([]);

      await GET(request('/api/pilot/scheduler/attendance-summary?trend=1'));

      expect(mockTrend).toHaveBeenCalledWith('org-a', { coachAccountId: 'acct-coach-1', athleteIds: [], weeks: undefined });
    });

    test('a weeks param is passed through', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockTrend.mockResolvedValueOnce([]);

      await GET(request('/api/pilot/scheduler/attendance-summary?trend=1&weeks=12'));

      expect(mockTrend).toHaveBeenCalledWith('org-a', { coachAccountId: undefined, weeks: 12 });
    });

    test('a non-positive weeks value is a 400, not passed through', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

      const response = await GET(request('/api/pilot/scheduler/attendance-summary?trend=1&weeks=0'));

      expect(response.status).toBe(400);
      expect(mockTrend).not.toHaveBeenCalled();
    });

    test('athlete, parent, and board are refused, same as the summary', async () => {
      for (const role of ['athlete', 'parent', 'board']) {
        mockRequirePrincipal.mockResolvedValueOnce(principal(role));
        const response = await GET(request('/api/pilot/scheduler/attendance-summary?trend=1'));
        expect(response.status).toBe(403);
      }
      expect(mockTrend).not.toHaveBeenCalled();
    });
  });

  // CL-A2. cover_class lets any coach write themselves in as the covering
  // coach with no approval, so class ownership alone is self-granting. These
  // rows name individual athletes (and the roster carries free-text notes), so
  // a coach sees only athletes they reach: assignment of record or a live
  // coverage grant -- the rule the scheduler GET already applies.
  describe('a coach sees only athletes they can reach (CL-A2)', () => {
    const coveredClass = {
      class_id: 'class-1',
      coach_account_id: 'acct-coach-1',
      scheduled_by_account_id: 'acct-coach-1',
      covering_coach_account_id: 'acct-covering',
    };

    test('a self-granted covering coach does not get unreachable athletes or their notes from the roster', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-covering' }));
      mockGetClass.mockResolvedValueOnce(coveredClass as never);
      mockReachable.mockResolvedValueOnce(['ath-mine']);
      mockRoster.mockResolvedValueOnce([
        { athlete_id: 'ath-mine', full_name: 'Mine', status: 'present', method: 'coach', note: null, checked_in_at: null },
        { athlete_id: 'ath-other', full_name: 'Other Child', status: 'absent', method: 'coach', note: 'family matter', checked_in_at: null },
      ] as never);

      const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'));

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.roster.map((row: { athlete_id: string }) => row.athlete_id)).toEqual(['ath-mine']);
      expect(JSON.stringify(payload)).not.toContain('family matter');
      expect(JSON.stringify(payload)).not.toContain('Other Child');
      expect(mockReachable).toHaveBeenCalledWith('org-a', 'acct-covering');
    });

    test('a coach with no reachable athletes gets an empty roster, not the class list', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-covering' }));
      mockGetClass.mockResolvedValueOnce(coveredClass as never);
      mockReachable.mockResolvedValueOnce([]);
      mockRoster.mockResolvedValueOnce([
        { athlete_id: 'ath-other', full_name: 'Other Child', status: 'absent', method: 'coach', note: 'x', checked_in_at: null },
      ] as never);

      const payload = await (await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'))).json();

      expect(payload.roster).toEqual([]);
    });

    test('the coach summary drops athletes the coach cannot reach', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-covering' }));
      mockReachable.mockResolvedValueOnce(['ath-mine']);
      mockSummary.mockResolvedValueOnce([
        { athlete_id: 'ath-mine', full_name: 'Mine' },
        { athlete_id: 'ath-other', full_name: 'Other Child' },
      ] as never);

      const payload = await (await GET(request('/api/pilot/scheduler/attendance-summary'))).json();

      expect(payload.athletes.map((row: { athlete_id: string }) => row.athlete_id)).toEqual(['ath-mine']);
    });

    test('the coach trend counts only reachable athletes', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-covering' }));
      mockReachable.mockResolvedValueOnce(['ath-mine']);
      mockTrend.mockResolvedValueOnce([]);

      await GET(request('/api/pilot/scheduler/attendance-summary?trend=1'));

      expect(mockTrend).toHaveBeenCalledWith('org-a', {
        coachAccountId: 'acct-covering',
        athleteIds: ['ath-mine'],
        weeks: undefined,
      });
    });

    test('a coach refused the class is refused before any reach lookup', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-stranger' }));
      mockGetClass.mockResolvedValueOnce(coveredClass as never);

      const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'));

      expect(response.status).toBe(403);
      expect(mockReachable).not.toHaveBeenCalled();
    });

    test('an organization admin is not narrowed and never consults coach reach', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetClass.mockResolvedValueOnce(coveredClass as never);
      mockRoster.mockResolvedValueOnce([
        { athlete_id: 'ath-mine', full_name: 'Mine' },
        { athlete_id: 'ath-other', full_name: 'Other Child' },
      ] as never);

      const payload = await (await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'))).json();

      expect(payload.roster).toHaveLength(2);
      expect(mockReachable).not.toHaveBeenCalled();
    });
  });
});

/*
 * THE ATTENDANCE-BY-ATHLETE REPORT (RP-01): a dated CSV of the same summary,
 * for a period counted by class date in gym time, under the same roles and the
 * same coach scope as the JSON.
 */
describe('the attendance-by-athlete report (RP-01)', () => {
  const ROW = {
    athlete_id: 'ath-1',
    full_name: 'Ada Rivera',
    present_count: 3,
    absent_count: 1,
    excused_count: 1,
    total_marked: 5,
    last_marked_at: '2026-10-08 23:30:00+00',
    attendance_rate: 0.75,
  };

  test('a CSV for a period: the file, its name, and the period passed down', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSummary.mockResolvedValueOnce([ROW]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?from=2026-09-14&to=2026-10-13&format=csv'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="attendance-by-athlete_2026-09-14_2026-10-13.csv"');
    expect(mockSummary).toHaveBeenCalledWith('org-a', expect.objectContaining({ fromDay: '2026-09-14', toDay: '2026-10-13' }));
    // The raw bytes: Response.text() would strip the byte order mark it is checking for.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = new TextDecoder().decode(bytes);
    expect(body).toContain('"Ada Rivera","3","1","1","5","75%"');
  });

  test("a coach's file holds only the athletes their dashboard holds", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach' }));
    mockReachable.mockResolvedValueOnce(['ath-1']);
    mockSummary.mockResolvedValueOnce([ROW, { ...ROW, athlete_id: 'ath-out', full_name: 'Not Mine' }]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?from=2026-09-14&to=2026-10-13&format=csv'));

    expect(mockSummary).toHaveBeenCalledWith('org-a', expect.objectContaining({ coachAccountId: 'acct-coach' }));
    const body = await response.text();
    expect(body).toContain('Ada Rivera');
    expect(body).not.toContain('Not Mine');
  });

  test.each([
    ['a date that is not a date', '?from=2026-02-30&to=2026-03-01&format=csv', /^Unsupported from/],
    ['a date in another shape', '?from=10/01/2026&to=2026-10-13&format=csv', /^Unsupported from/],
    ['a period that ends before it starts', '?from=2026-10-13&to=2026-10-01&format=csv', /^Unsupported period/],
    ['a CSV with no period', '?format=csv', /^Missing from or to/],
    ['another format', '?from=2026-10-01&to=2026-10-13&format=xlsx', /^Unsupported format/],
    ['a CSV of one class roster', '?class_id=c-1&format=csv', /^Unsupported format/],
    ['a CSV of the weekly trend', '?trend=1&format=csv', /^Unsupported format/],
    ['a CSV also narrowed by since', '?since=2026-10-10&from=2026-09-14&to=2026-10-13&format=csv', /^Unsupported format/],
  ])('%s is refused with a sentence', async (_label, query, message) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSummary.mockResolvedValueOnce([]);

    const response = await GET(request(`/api/pilot/scheduler/attendance-summary${query}`));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(message);
    // Refused before any read.
    expect(mockSummary).not.toHaveBeenCalled();
  });

  test('an athlete or a parent cannot download it', async () => {
    for (const role of ['athlete', 'parent']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request('/api/pilot/scheduler/attendance-summary?from=2026-09-14&to=2026-10-13&format=csv'));
      expect(response.status).toBe(403);
    }
    expect(mockSummary).not.toHaveBeenCalled();
  });
});

/*
 * THE REPORT BY CLASS (RP-02): ?report=classes&from=&to=, JSON or CSV, the
 * same roles and scope as the athlete report, refusals before any read.
 */
describe('the attendance report by class (RP-02)', () => {
  const mockClassReport = jest.mocked(getClassAttendanceReport);
  const ROW = {
    class_id: 'c-1',
    title: 'Sparring',
    start_at: '2026-10-08T22:00:00.000Z',
    status: 'open' as const,
    registered_count: 3,
    present_count: 1,
    absent_count: 1,
    excused_count: 0,
    unmarked_count: 1,
    attendance_rate: 0.5,
  };

  test('an admin gets the whole gym: rows and totals for the period', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    mockClassReport.mockResolvedValue([ROW]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?report=classes&from=2026-10-01&to=2026-10-13'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.classes).toEqual([ROW]);
    expect(body.totals).toEqual({
      classes: 1,
      cancelled: 0,
      registered_count: 3,
      present_count: 1,
      absent_count: 1,
      excused_count: 0,
      unmarked_count: 1,
      attendance_rate: 0.5,
    });
    expect(mockClassReport).toHaveBeenCalledWith('org-a', {
      fromDay: '2026-10-01',
      toDay: '2026-10-13',
      coachAccountId: undefined,
      athleteIds: undefined,
    });
    expect(mockReachable).not.toHaveBeenCalled();
  });

  test("a coach's report is their own classes, counted over the athletes they reach", async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockReachable.mockResolvedValue(['ath-1', 'ath-2']);
    mockClassReport.mockResolvedValue([]);

    await GET(request('/api/pilot/scheduler/attendance-summary?report=classes&from=2026-10-01&to=2026-10-13'));

    expect(mockClassReport).toHaveBeenCalledWith('org-a', {
      fromDay: '2026-10-01',
      toDay: '2026-10-13',
      coachAccountId: 'acct-caller',
      athleteIds: ['ath-1', 'ath-2'],
    });
  });

  test('the CSV: its name, the shipped writer, no names', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('admin'));
    mockClassReport.mockResolvedValue([ROW]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?report=classes&from=2026-10-01&to=2026-10-13&format=csv'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="attendance-by-class_2026-10-01_2026-10-13.csv"');
    const text = new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
    expect(text).toContain('"Sparring"');
    expect(text).toContain('"Total, 1 classes not cancelled"');
    expect(mockSummary).not.toHaveBeenCalled();
  });

  test.each([
    ['another report', '?report=athletes&from=2026-10-01&to=2026-10-13'],
    ['no period', '?report=classes'],
    ['half a period', '?report=classes&from=2026-10-01'],
    ['a date that is not a date', '?report=classes&from=2026-02-30&to=2026-03-01'],
    ['a period that ends before it starts', '?report=classes&from=2026-10-13&to=2026-10-01'],
    ['with a class_id', '?report=classes&from=2026-10-01&to=2026-10-13&class_id=c-1'],
    ['with since', '?report=classes&from=2026-10-01&to=2026-10-13&since=2026-10-01'],
  ])('%s is refused, and nothing is read', async (_label, query) => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));

    const response = await GET(request(`/api/pilot/scheduler/attendance-summary${query}`));

    expect(response.status).toBe(400);
    expect(mockClassReport).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'board'])('%s cannot have it', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?report=classes&from=2026-10-01&to=2026-10-13'));

    expect(response.status).toBe(403);
    expect(mockClassReport).not.toHaveBeenCalled();
  });
});
