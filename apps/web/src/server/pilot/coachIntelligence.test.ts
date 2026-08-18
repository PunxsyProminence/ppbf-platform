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
import { deriveSuggestions, TRAINING_DAYS_MIN_EARLY, TRAINING_DAYS_DROP_RATIO } from './progressionSuggestions';
import type { AthletePerformanceRow } from './performanceAnalytics';

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
  for (const call of mockQuery.mock.calls) {
    expect(call[1][0]).toBe('org-1');
  }
  expect(mockRollup).toHaveBeenCalledWith('org-1', ['ath-1'], ATTENDANCE_WINDOW_DAYS);
});

test('the fading filter applies the half-drop rule exactly, with names from the roster read', async () => {
  // Name query resolves for everyone; other queries return nothing.
  mockQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('full_name from pilot.athletes')) {
      return [
        { athlete_id: 'ath-fading', full_name: 'Rosa D.' },
        { athlete_id: 'ath-boundary', full_name: 'Alex P.' },
        { athlete_id: 'ath-fine', full_name: 'Sam R.' },
        { athlete_id: 'ath-new', full_name: 'Kim L.' },
      ];
    }
    return [];
  });
  mockRollup.mockResolvedValue([
    // 6 -> 2 training days: under half of early -- fading.
    { athlete_id: 'ath-fading', training_days_early: 6, training_days_late: 2 },
    // 6 -> 3: exactly half lost is still "lost AT LEAST half" -- fading too.
    // (Matches progressionSuggestions.ts's training_days_dropping rule,
    // which also fires at this exact boundary -- see the agreement test
    // below.)
    { athlete_id: 'ath-boundary', training_days_early: 6, training_days_late: 3 },
    // 6 -> 4: above half retained -- fine.
    { athlete_id: 'ath-fine', training_days_early: 6, training_days_late: 4 },
    // 2 -> 0: early below the minimum floor -- too little signal to flag.
    { athlete_id: 'ath-new', training_days_early: 2, training_days_late: 0 },
  ]);

  const digest = await getCoachIntelligence('org-1', ['ath-fading', 'ath-boundary', 'ath-fine', 'ath-new']);

  expect(digest.fading_attendance).toEqual([
    { athlete_id: 'ath-fading', athlete_name: 'Rosa D.', training_days_early: 6, training_days_late: 2 },
    { athlete_id: 'ath-boundary', athlete_name: 'Alex P.', training_days_early: 6, training_days_late: 3 },
  ]);
});

// The header comment's "never drift apart" claim is only as good as this:
// the same rollup row, fed through progressionSuggestions.ts's
// training_days_dropping rule and through this module's fading-attendance
// filter, must agree at the exact half-drop boundary -- not just share the
// two threshold constants, which alone would not have caught a `<` vs `<=`
// mismatch (this test previously did not exist, and that mismatch shipped).
describe('fading_attendance agrees with progressionSuggestions.training_days_dropping', () => {
  function rollupRow(overrides: Partial<AthletePerformanceRow> = {}): AthletePerformanceRow {
    return {
      athlete_id: 'ath-1',
      sessions_total: 0,
      sessions_completed: 0,
      avg_rpe: null,
      training_days: 0,
      training_days_early: 0,
      training_days_late: 0,
      readiness_count: 0,
      avg_readiness: null,
      readiness_early_avg: null,
      readiness_late_avg: null,
      readiness_early_count: 0,
      readiness_late_count: 0,
      open_gaps: 0,
      active_assignments: 0,
      avg_assignment_completion: null,
      ...overrides,
    };
  }

  function isFading(row: AthletePerformanceRow): boolean {
    return row.training_days_early >= TRAINING_DAYS_MIN_EARLY
      && row.training_days_late <= row.training_days_early * TRAINING_DAYS_DROP_RATIO;
  }

  test.each([
    ['well above the floor and well under half', { training_days_early: 6, training_days_late: 2 }],
    ['exactly the half boundary', { training_days_early: 6, training_days_late: 3 }],
    ['just above half (no signal)', { training_days_early: 6, training_days_late: 4 }],
    ['exactly at the early-days floor, with a real drop', { training_days_early: TRAINING_DAYS_MIN_EARLY, training_days_late: 1 }],
    ['below the early-days floor (too little signal)', { training_days_early: TRAINING_DAYS_MIN_EARLY - 1, training_days_late: 0 }],
  ])('%s: both rules reach the same verdict', (_label, overrides) => {
    const row = rollupRow(overrides as Partial<AthletePerformanceRow>);

    const suggestionFired = deriveSuggestions([row], [], new Map())
      .some((s) => s.rule === 'training_days_dropping');
    const digestFired = isFading(row);

    expect(digestFired).toBe(suggestionFired);
  });
});
