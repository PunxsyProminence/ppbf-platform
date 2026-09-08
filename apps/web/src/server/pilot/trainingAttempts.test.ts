import { query, queryOne } from './db';
import {
  DEFAULT_DIRECTION,
  computeMade,
  listAttempts,
  recordAttempt,
  recordReview,
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
  test('org- and athlete-scoped, newest first, limit clamped, read from the effective view', async () => {
    mockQuery.mockResolvedValue([]);

    await listAttempts('org-1', 'ath-1', { metricKind: 'reps', limit: 9999 });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // BASE-06: reads the effective projection so a coach correction/dispute
    // shows through, but the scoping, ordering and clamp are unchanged.
    expect(sql).toContain('from pilot.v_training_attempts_effective');
    expect(sql).toContain('v.organization_id = $1 and v.athlete_id = $2');
    expect(sql).toContain('order by v.attempted_at desc');
    expect(sql).toContain('limit 200');
    expect(params).toEqual(['org-1', 'ath-1', 'reps']);
  });
});

describe('recordReview', () => {
  test('a missing attempt is a hidden null and nothing is written', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // getAttemptForReview

    const result = await recordReview({
      organizationId: 'org-1', attemptId: 'att-x', reviewState: 'confirmed', reviewedByAccountId: 'acct-coach',
    });

    expect(result).toBeNull();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('the corrected verdict is computed server-side from the attempt\'s own direction', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1', direction: 'at_most' }) // getAttemptForReview: a time
      .mockResolvedValueOnce({ review_id: 'rev-1' }) // insert
      .mockResolvedValueOnce({ review_id: 'rev-1', review_state: 'corrected' }); // final select

    await recordReview({
      organizationId: 'org-1', attemptId: 'att-1', reviewState: 'corrected',
      correctedTargetValue: 90, correctedAchievedValue: 88, // faster than target under at_most => made
      reason: 'timing gate glitched; hand time was 88 seconds', reviewedByAccountId: 'acct-coach',
    });

    const insertParams = mockQueryOne.mock.calls[1][1] as unknown[];
    // corrected_made is the 7th value ($7): a made, computed by the module.
    expect(insertParams[6]).toBe(true);
  });

  test('a corrected review with no achieved value is refused before any write', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1', direction: 'at_least' });

    await expect(recordReview({
      organizationId: 'org-1', attemptId: 'att-1', reviewState: 'corrected',
      reason: 'a reason long enough to pass the length gate', reviewedByAccountId: 'acct-coach',
    })).rejects.toThrow(/achieved value/i);
    expect(mockQueryOne).toHaveBeenCalledTimes(1); // only the load, no insert
  });

  test('a dispute with a too-short reason is refused before any write', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1', direction: 'at_least' });

    await expect(recordReview({
      organizationId: 'org-1', attemptId: 'att-1', reviewState: 'disputed',
      reason: 'nope', reviewedByAccountId: 'acct-coach',
    })).rejects.toThrow(/reason/i);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });
});
