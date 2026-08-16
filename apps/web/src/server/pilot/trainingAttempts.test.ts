import { query, queryOne } from './db';
import {
  DEFAULT_DIRECTION,
  computeMade,
  listAttempts,
  recordAttempt,
} from './trainingAttempts';

// The failure-first contract, pinned: the verdict is computed from target +
// direction (never caller-supplied), time targets are at_most so a slower
// time is a MISS, a target-less attempt carries no verdict, and every read
// and write is org-scoped with the athlete tenancy check first.

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('computeMade', () => {
  test('at_least: achieving the target or more is made; under is a miss', () => {
    expect(computeMade(10, 10, 'at_least')).toBe(true);
    expect(computeMade(10, 7, 'at_least')).toBe(false);
  });

  test('at_most: a faster time is made; a slower time is a MISS', () => {
    expect(computeMade(90, 88, 'at_most')).toBe(true);
    expect(computeMade(90, 92, 'at_most')).toBe(false);
  });

  test('no target means no verdict -- a measurement, not a make or miss', () => {
    expect(computeMade(null, 12, 'at_least')).toBeNull();
  });

  test('times default at_most; everything else defaults at_least', () => {
    expect(DEFAULT_DIRECTION.time_seconds).toBe('at_most');
    expect(DEFAULT_DIRECTION.reps).toBe('at_least');
    expect(DEFAULT_DIRECTION.load_kg).toBe('at_least');
  });
});

describe('recordAttempt', () => {
  test('an athlete outside the organization is a null, and nothing writes', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await recordAttempt({
      organizationId: 'org-1', athleteId: 'ath-other', metricKind: 'reps',
      targetValue: 10, achievedValue: 7, recordedByAccountId: 'acct-1',
    });

    expect(result).toBeNull();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('the computed verdict and defaulted direction land in the insert', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ attempt_id: 'att-1' })
      .mockResolvedValueOnce({ attempt_id: 'att-1', made: false });

    await recordAttempt({
      organizationId: 'org-1', athleteId: 'ath-1', metricKind: 'time_seconds',
      targetValue: 90, achievedValue: 92, recordedByAccountId: 'acct-1',
    });

    const insertParams = mockQueryOne.mock.calls[1][1] as unknown[];
    // direction defaulted to at_most for a time, so 92 against 90 is a miss.
    expect(insertParams).toContain('at_most');
    expect(insertParams).toContain(false);
  });
});

describe('listAttempts', () => {
  test('org- and athlete-scoped, newest first, limit clamped', async () => {
    mockQuery.mockResolvedValue([]);

    await listAttempts('org-1', 'ath-1', { metricKind: 'reps', limit: 9999 });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('t.organization_id = $1 and t.athlete_id = $2');
    expect(sql).toContain('order by t.attempted_at desc');
    expect(sql).toContain('limit 200');
    expect(params).toEqual(['org-1', 'ath-1', 'reps']);
  });
});
