function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

jest.mock('./security', () => ({
  createOpaqueToken: jest.fn(),
  hashPin: jest.fn(async () => 'hashed-pin'),
  hashToken: jest.fn(),
  verifyPin: jest.fn(),
}));

import { createOrUpdateAthleteAccount } from './auth';
import { query } from './db';

const mockQuery = query as jest.Mock;

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('createOrUpdateAthleteAccount', () => {
  test('inserts a new account and assigns membership when none exists yet', async () => {
    mockQuery.mockResolvedValueOnce([]); // no existing account

    await createOrUpdateAthleteAccount('acct_1', 'athlete_1', '123456', 'org_1');

    expect(currentClient.query).toHaveBeenCalledTimes(2);

    const [insertSql, insertParams] = currentClient.query.mock.calls[0];
    expect(insertSql).toContain('insert into pilot.accounts');
    expect(insertParams).toEqual(['acct_1', 'athlete', 'org_1', 'athlete_1', 'hashed-pin', true, false]);

    const [membershipSql, membershipParams] = currentClient.query.mock.calls[1];
    expect(membershipSql).toContain('pilot.organization_memberships');
    expect(membershipParams).toEqual(['acct_1', 'org_1', 'athlete']);
  });

  test('updates the existing account, reassigns membership, and revokes sessions on rerun', async () => {
    mockQuery.mockResolvedValueOnce([{ organization_id: 'org_1' }]); // existing account

    await createOrUpdateAthleteAccount('acct_1', 'athlete_1', '123456', 'org_1');

    expect(currentClient.query).toHaveBeenCalledTimes(3);

    const [updateSql, updateParams] = currentClient.query.mock.calls[0];
    expect(updateSql).toContain('update pilot.accounts');
    expect(updateParams).toEqual(['athlete', 'athlete_1', 'hashed-pin', true, 'acct_1', 'org_1']);

    const [membershipSql] = currentClient.query.mock.calls[1];
    expect(membershipSql).toContain('pilot.organization_memberships');

    const [revokeSql, revokeParams] = currentClient.query.mock.calls[2];
    expect(revokeSql).toContain('pilot.session_tokens');
    expect(revokeParams).toEqual(['acct_1']);
  });

  test('rejects reassigning an account that belongs to another organization', async () => {
    mockQuery.mockResolvedValueOnce([{ organization_id: 'org_other' }]);

    await expect(createOrUpdateAthleteAccount('acct_1', 'athlete_1', '123456', 'org_1')).rejects.toThrow(
      'Account already exists in another organization',
    );

    expect(currentClient.query).not.toHaveBeenCalled();
  });
});
