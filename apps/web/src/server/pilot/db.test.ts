const mockConnect = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
  })),
}));

jest.mock('./env', () => ({
  getAzurePostgresConnectionString: () => 'postgres://test',
}));

import { withTransaction } from './db';

function fakeClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('withTransaction', () => {
  test('commits when the callback succeeds', async () => {
    const client = fakeClient();
    mockConnect.mockResolvedValueOnce(client);

    const result = await withTransaction(async (c) => {
      await c.query('update pilot.accounts set pin_hash = $1', ['hash']);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[1][0]).toBe('update pilot.accounts set pin_hash = $1');
    expect(client.query.mock.calls[2][0]).toBe('COMMIT');
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('rolls back and rethrows when the callback throws', async () => {
    const client = fakeClient();
    mockConnect.mockResolvedValueOnce(client);
    const failure = new Error('revoke failed');

    await expect(
      withTransaction(async (c) => {
        await c.query('update pilot.accounts set pin_hash = $1', ['hash']);
        throw failure;
      }),
    ).rejects.toThrow('revoke failed');

    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('always releases the client even if rollback itself fails', async () => {
    const client = fakeClient();
    client.query.mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') {
        return Promise.reject(new Error('connection already closed'));
      }
      return Promise.resolve({ rows: [] });
    });
    mockConnect.mockResolvedValueOnce(client);

    await expect(
      withTransaction(async () => {
        throw new Error('original failure');
      }),
    ).rejects.toThrow('original failure');

    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
