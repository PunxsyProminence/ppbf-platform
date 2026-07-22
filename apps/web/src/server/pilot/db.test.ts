const mockConnect = jest.fn();
const mockPoolEnd = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    end: mockPoolEnd,
    on: mockOn,
  })),
}));

jest.mock('./env', () => ({
  getAzurePostgresConnectionString: () => 'postgres://test',
}));

import { closePool, withTransaction } from './db';

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
    // getPool() only registers its error listener the first time it
    // constructs the pool (this call, in this file) -- verify it here
    // rather than in a later test, since afterEach clears mock call history.
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
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

  test('closePool ends the pool and clears it so the next call creates a fresh one', async () => {
    const { Pool } = jest.requireMock('pg') as { Pool: jest.Mock };
    const constructedBefore = Pool.mock.calls.length;

    await closePool();
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);

    const client = fakeClient();
    mockConnect.mockResolvedValueOnce(client);
    await withTransaction(async () => 'ok');

    expect(Pool.mock.calls.length).toBe(constructedBefore + 1);
  });

  test('closePool is a no-op when no pool was ever created', async () => {
    await closePool(); // pool is null after the previous test's closePool()
    mockPoolEnd.mockClear();
    await closePool();
    expect(mockPoolEnd).not.toHaveBeenCalled();
  });
});
