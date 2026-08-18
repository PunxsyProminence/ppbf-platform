import { query, queryOne } from './db';
import { listMembershipFlagsForAthlete } from './programMemberships';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

const SAVEPOINT_LITERAL = /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/;

afterEach(() => {
  jest.clearAllMocks();
});

describe('listMembershipFlagsForAthlete', () => {
  test('reads non-active memberships, scoped to org and athlete, via the pool', async () => {
    mockQuery.mockResolvedValueOnce([
      { membership_id: 'mem-1', program_name: 'Youth Boxing', status: 'lapsed' },
    ]);

    const flags = await listMembershipFlagsForAthlete('org-1', 'ATH-1');

    expect(flags).toEqual([{ membership_id: 'mem-1', program_name: 'Youth Boxing', status: 'lapsed' }]);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("status <> 'active'");
    expect(params).toEqual(['org-1', 'ATH-1']);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('an active-only athlete reads as no flags', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(listMembershipFlagsForAthlete('org-1', 'ATH-1')).resolves.toEqual([]);
  });

  // Same degrade-gracefully idiom as trainingHolds.ts's findRegistrationBlockingHold:
  // the pre-migration window (no pilot.program_memberships table yet) must
  // never turn a class registration into a 500.
  test('a missing table (pre-migration window) reads as no flags, never a throw', async () => {
    mockQuery.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.program_memberships" does not exist'), { code: '42P01' }),
    );

    await expect(listMembershipFlagsForAthlete('org-1', 'ATH-1')).resolves.toEqual([]);
  });

  test('any other database error still propagates', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: '08006' }));

    await expect(listMembershipFlagsForAthlete('org-1', 'ATH-1')).rejects.toThrow('connection refused');
  });

  test('inside a transaction it uses the provided client, not the pool', async () => {
    const client = {
      query: jest.fn((sql: unknown) => {
        if (SAVEPOINT_LITERAL.test(String(sql).trim())) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ membership_id: 'mem-1', program_name: 'Wrestling', status: 'ended' }] });
      }),
    };

    const flags = await listMembershipFlagsForAthlete('org-1', 'ATH-1', client as never);

    expect(flags).toEqual([{ membership_id: 'mem-1', program_name: 'Wrestling', status: 'ended' }]);
    expect(mockQuery).not.toHaveBeenCalled();
    // SAVEPOINT, the probe SELECT, RELEASE SAVEPOINT.
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      'SAVEPOINT',
      'select',
      'RELEASE',
    ]);
  });

  // A bare 42P01 mid-transaction leaves the enclosing BEGIN block ABORTED
  // (Postgres 25P02) for every statement after it, exactly the failure mode
  // findRegistrationBlockingHold's SAVEPOINT guard exists to survive --
  // registerForClassTransactionally calls this function on the very same
  // client, right after that hold probe, in the same transaction.
  test('a 42P01 mid-transaction rolls back to the savepoint instead of leaving the transaction aborted', async () => {
    const client = {
      query: jest.fn((sql: unknown) => {
        const text = String(sql).trim();
        if (text.startsWith('SAVEPOINT')) return Promise.resolve({ rows: [] });
        if (text.startsWith('ROLLBACK TO SAVEPOINT')) return Promise.resolve({ rows: [] });
        return Promise.reject(
          Object.assign(new Error('relation "pilot.program_memberships" does not exist'), { code: '42P01' }),
        );
      }),
    };

    const flags = await listMembershipFlagsForAthlete('org-1', 'ATH-1', client as never);

    expect(flags).toEqual([]);
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SAVEPOINT membership_flag_probe',
      'select membership_id,',
      'ROLLBACK TO',
    ]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).trim().startsWith('RELEASE'))).toBe(false);
  });
});
