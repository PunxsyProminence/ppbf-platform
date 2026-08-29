import { query, queryOne } from './db';
import { ACTIVITY_LEDGER_LIMIT, listPersonActivities } from './floorHours';

/**
 * The read that makes the correction ledger usable.
 *
 * recordActivityAdjustment takes an `activity_id`. Every read this module
 * offered returned per-person-per-domain-per-quarter AGGREGATES with no
 * activity identifier anywhere in them — so an operator looking at "340 hours,
 * boxing, Q3" could not discover which session was wrong or what to name in
 * the correction. The append-only ledger was reachable in principle and
 * undriveable in practice, while the numbers it corrects were already being
 * published on an unauthenticated page.
 *
 * These cases are about the ways that read goes wrong: reaching past one
 * person, computing a second definition of a figure the public clock already
 * publishes, or hiding half of somebody's sessions behind a silent cap.
 */

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-a',
    activity_id: 'act-1',
    person_account_id: 'coach-1',
    athlete_id: null,
    activity_domain: 'boxing',
    activity_type: 'session',
    occurred_on: '2026-08-01',
    recorded_minutes: 60,
    adjustment_minutes: 0,
    effective_minutes: 60,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([] as never);
  mockQueryOne.mockResolvedValue({ total: 0 } as never);
});

describe('the ledger read is scoped to one person, always', () => {
  it('refuses an empty account id before querying anything', async () => {
    // There is no call shape that returns the whole gym's per-person ledger.
    // This module's header warns against a per-person query a public page
    // could accidentally call; a required parameter is what makes that
    // structural rather than a matter of remembering.
    await expect(listPersonActivities('org-a', '   ')).rejects.toThrow('Missing person_account_id');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('scopes both the rows and the count by organization AND account', async () => {
    await listPersonActivities('org-a', 'coach-1');

    for (const call of [mockQuery.mock.calls[0], mockQueryOne.mock.calls[0]]) {
      expect(String(call[0])).toContain('organization_id = $1');
      expect(String(call[0])).toContain('person_account_id = $2');
      expect((call[1] as unknown[]).slice(0, 2)).toEqual(['org-a', 'coach-1']);
    }
  });

  it('passes a domain filter as a parameter rather than into the SQL', async () => {
    await listPersonActivities('org-a', 'coach-1', { activityDomain: 'boxing' });

    expect(mockQuery.mock.calls[0][1]).toEqual(['org-a', 'coach-1', 'boxing', ACTIVITY_LEDGER_LIMIT]);
    expect(String(mockQuery.mock.calls[0][0])).not.toContain("= 'boxing'");
  });
});

describe('it reads the view the public clock is computed from', () => {
  it('reads v_activity_effective_minutes rather than recomputing minutes', async () => {
    // THE CASE THIS FILE EXISTS FOR, after the scoping. Both aggregate views
    // are built from this one, so reading it means the operator sees the same
    // arithmetic the public page publishes. Summing activity_log and
    // adjustments here instead would be a second definition of the number,
    // and the two would diverge the first time either view changed.
    await listPersonActivities('org-a', 'coach-1');

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('from pilot.v_activity_effective_minutes');
    expect(sql).not.toMatch(/from\s+pilot\.activity_log\b/);
    expect(sql).not.toContain('sum(');
  });

  it('returns the recorded, adjusted and effective figures as three fields', async () => {
    // Not one netted number. "60 minutes" and "90 recorded, 30 corrected away"
    // are different facts about a gym's record, and only one survives being
    // collapsed into a total.
    mockQuery.mockResolvedValue([
      ledgerRow({ recorded_minutes: 90, adjustment_minutes: -30, effective_minutes: 60 }),
    ] as never);
    mockQueryOne.mockResolvedValue({ total: 1 } as never);

    const { rows } = await listPersonActivities('org-a', 'coach-1');

    expect(rows[0].recorded_minutes).toBe(90);
    expect(rows[0].adjustment_minutes).toBe(-30);
    expect(rows[0].effective_minutes).toBe(60);
  });

  it('carries the activity_id a correction has to name', async () => {
    mockQuery.mockResolvedValue([ledgerRow({ activity_id: 'act-77' })] as never);
    mockQueryOne.mockResolvedValue({ total: 1 } as never);

    const { rows } = await listPersonActivities('org-a', 'coach-1');

    expect(rows[0].activity_id).toBe('act-77');
  });
});

describe('the cap is stated, not silent', () => {
  it('counts what the person has instead of inferring it from the rows returned', async () => {
    // `rows.length === limit` is the tempting signal and it is a proxy: it
    // reports a truncation for somebody with exactly 200 sessions and nothing
    // missing. The same mistake the SHADOW export carried until it was made
    // to count.
    mockQuery.mockResolvedValue(
      Array.from({ length: ACTIVITY_LEDGER_LIMIT }, (_v, i) => ledgerRow({ activity_id: `act-${i}` })) as never,
    );
    mockQueryOne.mockResolvedValue({ total: ACTIVITY_LEDGER_LIMIT } as never);

    const result = await listPersonActivities('org-a', 'coach-1');

    expect(result.total).toBe(ACTIVITY_LEDGER_LIMIT);
    expect(result.rows.length).toBe(ACTIVITY_LEDGER_LIMIT);
    expect(result.total > result.rows.length).toBe(false);
  });

  it('reports the shortfall when somebody has more sessions than one read carries', async () => {
    mockQuery.mockResolvedValue(
      Array.from({ length: ACTIVITY_LEDGER_LIMIT }, (_v, i) => ledgerRow({ activity_id: `act-${i}` })) as never,
    );
    mockQueryOne.mockResolvedValue({ total: 400 } as never);

    const result = await listPersonActivities('org-a', 'coach-1');

    expect(result.total).toBe(400);
    expect(result.limit).toBe(ACTIVITY_LEDGER_LIMIT);
    expect(result.total - result.rows.length).toBe(200);
  });

  it('counts as a number, not the string Postgres sends for count(*)', async () => {
    await listPersonActivities('org-a', 'coach-1');

    expect(String(mockQueryOne.mock.calls[0][0])).toContain('count(*)::int');
  });

  it('falls back to the rows it has rather than reporting a phantom shortfall', async () => {
    mockQuery.mockResolvedValue([ledgerRow()] as never);
    mockQueryOne.mockResolvedValue(null as never);

    const result = await listPersonActivities('org-a', 'coach-1');

    expect(result.total).toBe(1);
  });

  it('shows the newest first, so the cap drops the oldest and says so', async () => {
    await listPersonActivities('org-a', 'coach-1');

    expect(String(mockQuery.mock.calls[0][0])).toContain('order by occurred_on desc');
    expect(String(mockQuery.mock.calls[0][0])).toContain('limit $4');
  });
});
