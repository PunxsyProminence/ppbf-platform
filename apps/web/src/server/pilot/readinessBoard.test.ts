import { query } from './db';
import {
  READINESS_FRESHNESS_HOURS,
  getReadinessBoard,
  readinessStatusForScore,
} from './readinessBoard';

// The board's two honesty rules, pinned: the score bands are deterministic
// over the check-in formula's 1-10 range, and the SQL only ever considers
// FRESH readings -- a stale GREEN shown as today's state is the false
// reassurance the UNKNOWN default exists to prevent.

jest.mock('./db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('score bands', () => {
  test('map the 1-10 range to triage colors deterministically', () => {
    expect(readinessStatusForScore(10)).toBe('GREEN');
    expect(readinessStatusForScore(7)).toBe('GREEN');
    expect(readinessStatusForScore(6.9)).toBe('YELLOW');
    expect(readinessStatusForScore(4)).toBe('YELLOW');
    expect(readinessStatusForScore(3.9)).toBe('RED');
    expect(readinessStatusForScore(1)).toBe('RED');
  });
});

describe('getReadinessBoard', () => {
  test('queries only fresh readings, latest per athlete, org-scoped', async () => {
    mockQuery.mockResolvedValue([
      { athlete_id: 'ath-1', score: '8.2', measured_at: '2026-08-15T12:00:00.000Z' },
      { athlete_id: 'ath-2', score: '3.0', measured_at: '2026-08-15T11:00:00.000Z' },
    ]);

    const board = await getReadinessBoard('org-1', ['ath-1', 'ath-2', 'ath-3']);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('distinct on (athlete_id)');
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('make_interval(hours => $3)');
    expect(params).toEqual(['org-1', ['ath-1', 'ath-2', 'ath-3'], READINESS_FRESHNESS_HOURS]);

    // ath-3 had no fresh reading: absent, not UNKNOWN, not defaulted.
    expect(board).toEqual([
      { athlete_id: 'ath-1', status: 'GREEN', score: 8.2, measured_at: '2026-08-15T12:00:00.000Z' },
      { athlete_id: 'ath-2', status: 'RED', score: 3, measured_at: '2026-08-15T11:00:00.000Z' },
    ]);
  });

  test('an empty roster never queries', async () => {
    expect(await getReadinessBoard('org-1', [])).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
