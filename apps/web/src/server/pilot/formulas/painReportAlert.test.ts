import { query } from '../db';
import { emitShadowEvent } from '../shadowEvents';
import { flagNearMiss } from '../shadowNearMisses';
import {
  PAIN_REPORT_ALERT_WINDOW_DAYS,
  alertCoachToPainReport,
  classifyPainReporter,
  isPainReport,
  listAthletesWithRecentPainReports,
  listPainReportsForAthletes,
} from './painReportAlert';

jest.mock('../shadowNearMisses', () => ({ flagNearMiss: jest.fn() }));
jest.mock('../shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('../db', () => ({ query: jest.fn() }));

const mockFlagNearMiss = jest.mocked(flagNearMiss);
const mockEmitShadowEvent = jest.mocked(emitShadowEvent);
const mockQuery = jest.mocked(query);

function alertInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    kind: 'pain_report',
    value: 5,
    dimensions: { location: 'Lower back', painType: 'Sharp' },
    actorAccountId: 'account-1',
    actorRole: 'athlete',
    contextId: 'pain_1753900000000',
    observedAt: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFlagNearMiss.mockResolvedValue({
    near_miss_id: 'near-miss-1',
    organization_id: 'org-1',
    athlete_id: 'athlete-1',
    decision_id: null,
    description: 'recorded',
    severity: 'high',
    detected_by: 'system',
    detected_by_account_id: 'account-1',
    metadata: {},
    created_at: '2026-07-31T10:00:00.000Z',
  });
  mockEmitShadowEvent.mockResolvedValue(undefined);
});

describe('isPainReport', () => {
  test('a reported severity is a pain report', () => {
    expect(isPainReport('pain_report', 1)).toBe(true);
  });

  test('no pain and no reading are not pain reports', () => {
    expect(isPainReport('pain_report', 0)).toBe(false);
    expect(isPainReport('pain_report', null)).toBe(false);
  });

  test('another observation kind is not a pain report', () => {
    expect(isPainReport('session_rpe', 9)).toBe(false);
  });
});

describe('alertCoachToPainReport', () => {
  test('writes both coach-visible records for a reported pain', async () => {
    const outcome = await alertCoachToPainReport(alertInput());

    expect(outcome).toEqual({ raised: true, severity: 'high' });
    expect(mockFlagNearMiss).toHaveBeenCalledTimes(1);
    expect(mockEmitShadowEvent).toHaveBeenCalledTimes(1);

    const nearMiss = mockFlagNearMiss.mock.calls[0][0];
    expect(nearMiss.description).toContain('Lower back');
    expect(nearMiss.description).toContain('5/10');
    expect(nearMiss.metadata).toEqual(expect.objectContaining({
      trigger: 'athlete_pain_report',
      severity_1_10: 5,
    }));
    // The review state a coach reads off the feed is derived from this name.
    expect(mockEmitShadowEvent.mock.calls[0][0].eventName).toContain('PENDING');
  });

  // A pain report never sorts below the routine end of the queue.
  test.each([
    [1, 'moderate'],
    [3, 'moderate'],
    [4, 'high'],
    [6, 'high'],
    [7, 'critical'],
    [10, 'critical'],
  ])('severity %i is banded as %s', async (value, severity) => {
    const outcome = await alertCoachToPainReport(alertInput({ value }));
    expect(outcome.severity).toBe(severity);
  });

  test('raises nothing for an observation that is not a pain report', async () => {
    const outcome = await alertCoachToPainReport(alertInput({ kind: 'session_rpe', value: 9 }));

    expect(outcome).toEqual({ raised: false });
    expect(mockFlagNearMiss).not.toHaveBeenCalled();
    expect(mockEmitShadowEvent).not.toHaveBeenCalled();
  });

  test('surfaces a failure to record rather than reporting success', async () => {
    mockFlagNearMiss.mockRejectedValueOnce(new Error('near miss store unavailable'));

    await expect(alertCoachToPainReport(alertInput())).rejects.toThrow('near miss store unavailable');
    expect(mockEmitShadowEvent).not.toHaveBeenCalled();
  });
});

function painReportRow(overrides: Record<string, unknown> = {}) {
  return {
    near_miss_id: 'nm-1',
    athlete_id: 'athlete-1',
    athlete_name: 'Rosa Delgado',
    severity: 'high',
    metadata: {
      trigger: 'athlete_pain_report',
      severity_1_10: 5,
      location: 'Lower back',
      pain_type: 'Sharp',
      observed_at: '2026-07-31T10:00:00.000Z',
    },
    created_at: new Date('2026-07-31T10:00:02.000Z'),
    ...overrides,
  };
}

describe('listAthletesWithRecentPainReports', () => {
  test('asks only for athlete identifiers, scoped to the organization and the alert window', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'athlete-1' }, { athlete_id: 'athlete-2' }]);

    const athleteIds = await listAthletesWithRecentPainReports('org-1');

    expect(athleteIds).toEqual(['athlete-1', 'athlete-2']);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('select distinct athlete_id');
    expect(params).toEqual(['org-1', 'athlete_pain_report', PAIN_REPORT_ALERT_WINDOW_DAYS]);
  });

  // The write path stamps this marker into metadata; a read that stopped
  // matching it would show the coach every hand-flagged near miss as a pain
  // report, and every real pain report as nothing at all.
  test('matches the same trigger marker the alert writes', async () => {
    await alertCoachToPainReport(alertInput());
    const written = mockFlagNearMiss.mock.calls[0][0].metadata as { trigger: string };

    mockQuery.mockResolvedValueOnce([]);
    await listAthletesWithRecentPainReports('org-1');

    expect(mockQuery.mock.calls[0][1]?.[1]).toBe(written.trigger);
  });
});

describe('listPainReportsForAthletes', () => {
  test('never queries for an empty athlete set', async () => {
    const page = await listPainReportsForAthletes('org-1', [], { limit: 25 });

    expect(page).toEqual({ reports: [], truncated: false });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('names the athlete, the severity, the body location and both timestamps', async () => {
    mockQuery.mockResolvedValueOnce([painReportRow()]);

    const page = await listPainReportsForAthletes('org-1', ['athlete-1'], { limit: 25 });

    expect(page.truncated).toBe(false);
    expect(page.reports).toEqual([{
      nearMissId: 'nm-1',
      athleteId: 'athlete-1',
      athleteName: 'Rosa Delgado',
      severity: 'high',
      painScore: 5,
      location: 'Lower back',
      painType: 'Sharp',
      observedAt: '2026-07-31T10:00:00.000Z',
      recordedAt: '2026-07-31T10:00:02.000Z',
      // This fixture's metadata carries no reporter_role, which is what EVERY
      // pain report written before 2026-08-24 looks like: the near-miss table
      // has detected_by_account_id but no detected_by_role column, so the
      // reporter was never on the row. 'unknown' is the honest read. Silently
      // rewriting these as athlete reports is the thing this whole change
      // exists to stop.
      reporter: 'unknown',
    }]);
  });

  test('a historical row with no reporter_role reads as unknown, never as athlete', async () => {
    mockQuery.mockResolvedValueOnce([painReportRow()]);

    const page = await listPainReportsForAthletes('org-1', ['athlete-1'], { limit: 25 });

    expect(page.reports[0].reporter).toBe('unknown');
  });

  test.each([
    ['athlete', 'athlete'],
    ['coach', 'coach'],
    ['staff_admin', 'staff_admin'],
    ['volunteer', 'unknown'],
    ['', 'unknown'],
  ])('a stored reporter_role of %p reads back as %p', async (stored, expected) => {
    const row = painReportRow();
    mockQuery.mockResolvedValueOnce([{
      ...row,
      metadata: { ...(row.metadata as Record<string, unknown>), reporter_role: stored },
    }]);

    const page = await listPainReportsForAthletes('org-1', ['athlete-1'], { limit: 25 });

    // Read back through the same classifier that wrote it, so a value this
    // build does not recognise cannot reach a coach's screen as a raw string.
    expect(page.reports[0].reporter).toBe(expected);
  });

  // The description column carries the athlete id and the same facts in prose.
  // It is never selected: the coach's screen renders the structured fields, and
  // a minor's health information should not travel for a field nobody reads.
  test('does not carry the free-text description off the server', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listPainReportsForAthletes('org-1', ['athlete-1'], { limit: 25 });

    expect(String(mockQuery.mock.calls[0][0])).not.toContain('description');
  });

  test('bounds the read to the given athletes and orders critical reports first', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listPainReportsForAthletes('org-1', ['athlete-1', 'athlete-2'], { limit: 25 });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("n.athlete_id = any($2::text[])");
    expect(String(sql)).toContain("when 'critical' then 0");
    expect(params?.[1]).toEqual(['athlete-1', 'athlete-2']);
  });

  // A coach reading a capped list as the whole set is the same false
  // reassurance as an empty list after a failed read, so one row beyond the
  // limit is read purely to answer the question.
  test('reports truncation instead of presenting a capped list as complete', async () => {
    mockQuery.mockResolvedValueOnce([
      painReportRow({ near_miss_id: 'nm-1' }),
      painReportRow({ near_miss_id: 'nm-2' }),
      painReportRow({ near_miss_id: 'nm-3' }),
    ]);

    const page = await listPainReportsForAthletes('org-1', ['athlete-1'], { limit: 2 });

    expect(mockQuery.mock.calls[0][1]?.[4]).toBe(3);
    expect(page.reports).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  test('leaves a detail the athlete did not supply null rather than inventing one', async () => {
    mockQuery.mockResolvedValueOnce([painReportRow({
      athlete_name: null,
      metadata: { trigger: 'athlete_pain_report', severity_1_10: 8, location: null, pain_type: '   ' },
    })]);

    const page = await listPainReportsForAthletes('org-1', ['athlete-1'], { limit: 25 });

    expect(page.reports[0]).toEqual(expect.objectContaining({
      athleteName: null,
      location: null,
      painType: null,
      observedAt: null,
      painScore: 8,
    }));
  });
});

describe('reporter provenance', () => {
  /* THE DEFECT. POST /shadow/formulas/observations admits athlete, coach,
     organization_admin and admin for a pain_report, and every downstream
     sentence said the athlete had self-reported it. A coach writing down what
     they observed was rendered to the next coach as the child's own words --
     which changes what that coach does with it, on a medical-adjacent record
     about a minor. */

  test.each([
    ['athlete', 'athlete'],
    ['coach', 'coach'],
    ['organization_admin', 'staff_admin'],
    ['admin', 'staff_admin'],
  ])('%s classifies as %s', (actorRole, expected) => {
    expect(classifyPainReporter(actorRole)).toBe(expected);
  });

  test.each([null, undefined, '', 'volunteer', 'parent', 'platform_owner'])(
    'an unrecognised or missing role (%p) is unknown, never athlete',
    (actorRole) => {
      // The direction matters. An unknown reporter described as the athlete is
      // a fabricated attribution; an athlete report described as unknown is
      // merely less specific.
      expect(classifyPainReporter(actorRole as string)).toBe('unknown');
    },
  );

  test('only the athlete branch claims a self-report', async () => {
    const claims: Record<string, boolean> = {};
    for (const role of ['athlete', 'coach', 'organization_admin', 'admin']) {
      mockFlagNearMiss.mockClear();
      mockEmitShadowEvent.mockClear();
      await alertCoachToPainReport({ ...alertInput(), actorRole: role });
      const description = mockFlagNearMiss.mock.calls[0][0].description as string;
      // The negative lookbehind is load-bearing. A plain
      // /self-reported by the athlete/ also matches inside "NOT self-reported
      // by the athlete" -- the exact sentence the staff branches carry -- so
      // the naive assertion reported every role as claiming a self-report and
      // would have passed just as happily against the unfixed code.
      claims[role] = /(?<!not )self-reported by the athlete/i.test(description);
    }

    expect(claims).toEqual({
      athlete: true,
      coach: false,
      organization_admin: false,
      admin: false,
    });
  });

  test.each(['coach', 'organization_admin', 'admin'])(
    'a %s-entered report says it is not a medical assessment',
    async (role) => {
      await alertCoachToPainReport({ ...alertInput(), actorRole: role });

      const description = mockFlagNearMiss.mock.calls[0][0].description as string;
      expect(description).toMatch(/not self-reported by the athlete/i);
      expect(description).toMatch(/not a medical assessment/i);
    },
  );

  test('reporter_role is persisted on the near miss and on the event', async () => {
    // Without this the classification cannot be read back: the near-miss table
    // has detected_by_account_id but NO detected_by_role column, so the
    // detectedByRole argument reaches only the audit event and the escalation.
    await alertCoachToPainReport({ ...alertInput(), actorRole: 'coach' });

    expect(mockFlagNearMiss.mock.calls[0][0].metadata).toMatchObject({
      trigger: 'athlete_pain_report',
      reporter_role: 'coach',
    });
    expect(mockEmitShadowEvent.mock.calls[0][0].payload).toMatchObject({
      reporter_role: 'coach',
    });
  });

  test('the persisted trigger and event name are unchanged', async () => {
    // Existing rows depend on both. Renaming either for wording orphans every
    // report already in the database from the coach's alert.
    await alertCoachToPainReport({ ...alertInput(), actorRole: 'coach' });

    expect(mockFlagNearMiss.mock.calls[0][0].metadata).toMatchObject({
      trigger: 'athlete_pain_report',
    });
    expect(mockEmitShadowEvent.mock.calls[0][0].eventName)
      .toBe('SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW');
  });

  test('severity banding is untouched by provenance', async () => {
    for (const role of ['athlete', 'coach', 'admin']) {
      mockFlagNearMiss.mockClear();
      mockEmitShadowEvent.mockClear();
      const outcome = await alertCoachToPainReport({
        ...alertInput(), value: 8, actorRole: role,
      });
      expect(outcome).toEqual({ raised: true, severity: 'critical' });
    }
  });

  test('a staff-entered report still raises the coach alert', async () => {
    // The point is not to suppress staff reports. It is to stop describing
    // them as something they are not.
    const outcome = await alertCoachToPainReport({ ...alertInput(), actorRole: 'admin' });

    expect(outcome.raised).toBe(true);
    expect(mockFlagNearMiss).toHaveBeenCalledTimes(1);
    expect(mockEmitShadowEvent).toHaveBeenCalledTimes(1);
  });
});
