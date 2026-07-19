import { createOrUpdateAthleteAccount } from './auth';
import { query } from './db';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('./security', () => ({
  createOpaqueToken: jest.fn(),
  hashPin: jest.fn(async () => 'hashed-pin'),
  hashToken: jest.fn(),
  verifyPin: jest.fn(),
}));

describe('auth account upsert behavior', () => {
  test('createOrUpdateAthleteAccount uses account_id upsert for reruns', async () => {
    await createOrUpdateAthleteAccount('acct_1', 'athlete_1', '123456', 'org_1');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = (query as jest.Mock).mock.calls[0];

    expect(sql).toContain('on conflict (account_id) do update');
    expect(params).toEqual([
      'acct_1',
      'athlete',
      'org_1',
      'athlete_1',
      'hashed-pin',
      true,
      false,
    ]);
  });
});
