import { query } from './db';
import { getPerformanceRollup } from './performanceAnalytics';
import {
  ATTENDANCE_WINDOW_DAYS,
  HOLD_EXPIRY_DAYS,
  READINESS_RED_DAYS,
  READINESS_RED_WINDOW_DAYS,
  STALLED_GAP_DAYS,
  UNREVIEWED_SESSION_DAYS,
  getCoachIntelligence,
} from './coachIntelligence';
import { TRAINING_DAYS_MIN_EARLY, TRAINING_DAYS_DROP_RATIO } from './progressionSuggestions';

// The owner-approved definition, pinned: every item is a stored fact plus a
// named threshold; the attendance rule REUSES the gap-suggestion constants
// (imported, not restated); an empty roster never queries; and the fading
// filter applies the exact half-drop rule.

jest.mock('./db', () => ({ query: jest.fn() }));
jest.mock('./performanceAnalytics', () => ({ getPerformanceRollup: jest.fn() }));

const mockQuery = query as jest.Mock;
const mockRollup = getPerformanceRollup as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

test('the thresholds are the approved definition, and attendance reuses the suggestion constants', () => {
  expect(STALLED_GAP_DAYS).toBe(14);
  expect(READINESS_RED_DAYS).toBe(3);
  expect(READINESS_RED_WINDOW_DAYS).toBe(7);
  expect(UNREVIEWED_SESSION_DAYS).toBe(7);
  expect(HOLD_EXPIRY_DAYS).toBe(14);
  expect(ATTENDANCE_WINDOW_DAYS).toBe(28);
  // The reuse is the point: one attendance rule, two consumers, no drift.
  expect(TRAINING_DAYS_MIN_EARLY).toBe(3);
  expect(TRAINING_DAYS_DROP_RATIO).toBe(0.5);
});

test('an empty roster returns an empty digest without touching the database', async () => {
  const digest = await getCoachIntelligence('org-1', []);

  expect(digest).toEqual({
    stalled_gaps: [], readiness_concerns: [], fading_attendance: [], unreviewed_sessions: [], expiring_holds: [],
    open_safety_items: [],
  });
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockRollup).not.toHaveBeenCalled();
});

test('the queries carry the org scope, the thresholds, and the no-assignment/no-review exclusions', async () => {
  mockQuery.mockResolvedValue([]);
  mockRollup.mockResolvedValue([]);

  await getCoachIntelligence('org-1', ['ath-1']);

  const sqls = mockQuery.mock.calls.map((call) => String(call[0]));
  const gapSql = sqls.find((sql) => sql.includes('progression_gaps'));
  expect(gapSql).toContain("g.status = 'identified'");
  expect(gapSql).toContain('not exists');
  const sessionSql = sqls.find((sql) => sql.includes('pilot.sessions'));
  expect(sessionSql).toContain('completed_flag = true');
  expect(sessionSql).toContain('not exists');
  const readinessSql = sqls.find((sql) => sql.includes('pilot.readiness'));
  expect(readinessSql).toContain('distinct on (r.athlete_id, r.measured_at::date)');
  const holdSql = sqls.find((sql) => sql.includes('training_holds'));
  expect(holdSql).toContain("h.status = 'active'");
  const safetySql = sqls.find((sql) => sql.includes('safety_escalations'));
  expect(safetySql).toContain("status in ('open', 'acknowledged')");
  expect(safetySql).toContain('pilot.compliance_violations');
  expect(safetySql).toContain("status not in ('resolved', 'dismissed')");
  for (const call of mockQuery.mock.calls) {
    expect(call[1][0]).toBe('org-1');
  }
  expect(mockRollup).toHaveBeenCalledWith('org-1', ['ath-1'], ATTENDANCE_WINDOW_DAYS);
});

test('open safety escalations and compliance violations are combined and given names', async () => {
  mockQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('safety_escalations')) {
      return [
        {
          athlete_id: 'ath-1', kind: 'escalation', source_id: 'esc-1',
          severity: 'high', reason: 'Repeated near-miss pattern', status: 'open', created_at: '2026-08-10',
        },
        {
          athlete_id: 'ath-1', kind: 'violation', source_id: 'viol-1',
          severity: 'moderate', reason: 'Unsupervised contact drill', status: 'new', created_at: '2026-08-12',
        },
      ];
    }
    if (String(sql).includes('full_name from pilot.athletes')) {
      return [{ athlete_id: 'ath-1', full_name: 'Rosa D.' }];
    }
    return [];
  });
  mockRollup.mockResolvedValue([]);

  const digest = await getCoachIntelligence('org-1', ['ath-1']);

  expect(digest.open_safety_items).toEqual([
    {
      athlete_id: 'ath-1', athlete_name: 'Rosa D.', kind: 'escalation', source_id: 'esc-1',
      severity: 'high', reason: 'Repeated near-miss pattern', status: 'open', created_at: '2026-08-10',
    },
    {
      athlete_id: 'ath-1', athlete_name: 'Rosa D.', kind: 'violation', source_id: 'viol-1',
      severity: 'moderate', reason: 'Unsupervised contact drill', status: 'new', created_at: '2026-08-12',
    },
  ]);
});

test('the fading filter applies the half-drop rule exactly, with names from the roster read', async () => {
  // Name query resolves for everyone; other queries return nothing.
  mockQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('full_name from pilot.athletes')) {
      return [
        { athlete_id: 'ath-fading', full_name: 'Rosa D.' },
        { athlete_id: 'ath-fine', full_name: 'Sam R.' },
        { athlete_id: 'ath-new', full_name: 'Kim L.' },
      ];
    }
    return [];
  });
  mockRollup.mockResolvedValue([
    // 6 -> 2 training days: under half of early -- fading.
    { athlete_id: 'ath-fading', training_days_early: 6, training_days_late: 2 },
    // 6 -> 3: exactly half is NOT under half -- fine.
    { athlete_id: 'ath-fine', training_days_early: 6, training_days_late: 3 },
    // 2 -> 0: early below the minimum floor -- too little signal to flag.
    { athlete_id: 'ath-new', training_days_early: 2, training_days_late: 0 },
  ]);

  const digest = await getCoachIntelligence('org-1', ['ath-fading', 'ath-fine', 'ath-new']);

  expect(digest.fading_attendance).toEqual([
    { athlete_id: 'ath-fading', athlete_name: 'Rosa D.', training_days_early: 6, training_days_late: 2 },
  ]);
});
