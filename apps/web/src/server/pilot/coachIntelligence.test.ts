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

// The owner-approved definition, pinned: every item is a stored fact plus a
// named threshold; the attendance rule REUSES the gap-suggestion constants
// (imported, not restated); an empty roster never queries; and the fading
// filter applies the half-drop rule -- a clean halving included -- with the
// same verdict the suggestion engine reaches on the same rows.

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
  // The reuse is the point, but it only pins the numbers -- the boundary
  // test below is what pins the comparison the two consumers build on them.
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
        { athlete_id: 'ath-halved', full_name: 'Dev P.' },
        { athlete_id: 'ath-fine', full_name: 'Sam R.' },
        { athlete_id: 'ath-new', full_name: 'Kim L.' },
      ];
    }
    return [];
  });
  mockRollup.mockResolvedValue([
    // 6 -> 2 training days: under half of early -- fading.
    { athlete_id: 'ath-fading', training_days_early: 6, training_days_late: 2 },
    // 6 -> 3: exactly half. A clean halving is a drop the coach hears about,
    // the same way rule 2 in progressionSuggestions.ts suggests a gap for it.
    { athlete_id: 'ath-halved', training_days_early: 6, training_days_late: 3 },
    // 6 -> 4: the newer half holds above half -- fine.
    { athlete_id: 'ath-fine', training_days_early: 6, training_days_late: 4 },
    // 2 -> 0: early below the minimum floor -- too little signal to flag.
    { athlete_id: 'ath-new', training_days_early: 2, training_days_late: 0 },
  ]);

  const digest = await getCoachIntelligence('org-1', ['ath-fading', 'ath-halved', 'ath-fine', 'ath-new']);

  expect(digest.fading_attendance).toEqual([
    { athlete_id: 'ath-fading', athlete_name: 'Rosa D.', training_days_early: 6, training_days_late: 2 },
    { athlete_id: 'ath-halved', athlete_name: 'Dev P.', training_days_early: 6, training_days_late: 3 },
  ]);
});

// The header above says the shared constants do not by themselves stop the
// two attendance rules drifting -- this test is what does. It walks the whole
// boundary (below, exactly at, and above the half-drop, plus the early-days
// floor) through BOTH the suggestion engine and this digest and requires the
// same verdict from each. If either comparison moves, this fails.
test('the fading filter agrees with the suggestion engine on every boundary', async () => {
  const rows = [
    { athlete_id: 'ath-b1', training_days_early: 6, training_days_late: 2 },
    { athlete_id: 'ath-b2', training_days_early: 6, training_days_late: 3 },
    { athlete_id: 'ath-b3', training_days_early: 6, training_days_late: 4 },
    { athlete_id: 'ath-b4', training_days_early: 4, training_days_late: 2 },
    { athlete_id: 'ath-b5', training_days_early: 3, training_days_late: 1 },
    { athlete_id: 'ath-b6', training_days_early: 2, training_days_late: 0 },
    { athlete_id: 'ath-b7', training_days_early: 6, training_days_late: 0 },
  ];
  const ids = rows.map((row) => row.athlete_id);

  mockQuery.mockResolvedValue([]);
  mockRollup.mockResolvedValue(rows);
  const digest = await getCoachIntelligence('org-1', ids);
  const flaggedByDigest = digest.fading_attendance.map((row) => row.athlete_id);

  // Same rows through rule 2, with nothing else that could speak: no stalled
  // assignments, no open gaps, and readiness fields that cannot trip rule 1.
  const suggested = deriveSuggestions(
    rows.map((row) => ({
      ...row,
      sessions_total: 0,
      sessions_completed: 0,
      avg_rpe: null,
      training_days: row.training_days_early + row.training_days_late,
      readiness_count: 0,
      avg_readiness: null,
      readiness_early_avg: null,
      readiness_late_avg: null,
      readiness_early_count: 0,
      readiness_late_count: 0,
      open_gaps: 0,
      active_assignments: 0,
      avg_assignment_completion: null,
    })),
    [],
    new Map(),
  );
  const flaggedByRule = suggested
    .filter((s) => s.rule === 'training_days_dropping')
    .map((s) => s.athlete_id);

  expect(flaggedByDigest).toEqual(flaggedByRule);
  // Pinned so the agreement cannot be satisfied by both sides going silent.
  expect(flaggedByDigest).toEqual(['ath-b1', 'ath-b2', 'ath-b4', 'ath-b5', 'ath-b7']);
});
