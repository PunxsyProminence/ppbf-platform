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

import { closePool, resolveSslConfig, sanitizedPoolErrorLog, withTransaction } from './db';

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

describe('resolveSslConfig', () => {
  test('defaults to TLS with no override and no relevant env vars', () => {
    expect(resolveSslConfig({})).toEqual({ rejectUnauthorized: false });
  });

  test('the disable flag alone, outside a test NODE_ENV, is ignored -- TLS stays on', () => {
    // Note: an omitted nodeEnv override falls back to the real
    // process.env.NODE_ENV, which Jest itself always sets to 'test' -- these
    // tests must pass an explicit non-test value to actually exercise "not
    // in a test environment".
    expect(resolveSslConfig({ nodeEnv: 'production', disableSslFlag: 'true' })).toEqual({ rejectUnauthorized: false });
  });

  test('NODE_ENV=test alone (no explicit flag) is ignored -- TLS stays on', () => {
    expect(resolveSslConfig({ nodeEnv: 'test' })).toEqual({ rejectUnauthorized: false });
  });

  test('NODE_ENV=test together with the explicit flag disables TLS', () => {
    expect(resolveSslConfig({ nodeEnv: 'test', disableSslFlag: 'true' })).toBe(false);
  });

  test.each(['production', 'staging'])(
    'NODE_ENV=%s ignores the disable flag even if present -- production/staging can never downgrade TLS',
    (nodeEnv) => {
      expect(resolveSslConfig({ nodeEnv, disableSslFlag: 'true' })).toEqual({ rejectUnauthorized: false });
    },
  );

  test('an unexpected disable flag value (not the exact string "true") is ignored', () => {
    expect(resolveSslConfig({ nodeEnv: 'test', disableSslFlag: 'yes' })).toEqual({ rejectUnauthorized: false });
    expect(resolveSslConfig({ nodeEnv: 'test', disableSslFlag: '1' })).toEqual({ rejectUnauthorized: false });
  });

  test('falls back to real process.env when no override is provided at all', () => {
    // Jest itself always sets NODE_ENV=test for the whole process (it's
    // read-only in this project's types, so it isn't reassigned here) --
    // only the explicit flag needs setting to exercise the real-env path.
    expect(process.env.NODE_ENV).toBe('test');
    const originalFlag = process.env.PPBF_POSTGRES_DISABLE_SSL;
    try {
      process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
      expect(resolveSslConfig()).toBe(false);
    } finally {
      process.env.PPBF_POSTGRES_DISABLE_SSL = originalFlag;
    }
  });
});

describe('sanitizedPoolErrorLog', () => {
  test('includes only the fixed event name, code, and a static message', () => {
    const log = sanitizedPoolErrorLog(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    expect(log).toEqual({
      event: 'pilot-db-pool-error',
      code: '57P01',
      message: expect.any(String),
    });
  });

  test('omits the code field when the error has none', () => {
    const log = sanitizedPoolErrorLog(new Error('plain error'));
    expect(log).toEqual({ event: 'pilot-db-pool-error', message: expect.any(String) });
    expect(log).not.toHaveProperty('code');
  });

  test('never includes the client object, connection string, credentials, query text, or socket internals', () => {
    const sensitiveError = Object.assign(new Error('connection reset'), {
      code: '08006',
      client: {
        connectionParameters: {
          user: 'ppbf_app',
          password: 'super-secret-password',
          host: 'prod-db.internal',
          database: 'pilot',
        },
        connectionString: 'postgres://ppbf_app:super-secret-password@prod-db.internal:5432/pilot',
      },
      query: { text: 'select pin_hash from pilot.accounts where account_id = $1', values: ['admin@example.com'] },
      connection: { stream: { remoteAddress: '10.0.4.12' } },
    });

    const log = sanitizedPoolErrorLog(sensitiveError);
    const serialized = JSON.stringify(log);

    expect(serialized).not.toContain('super-secret-password');
    expect(serialized).not.toContain('prod-db.internal');
    expect(serialized).not.toContain('pin_hash');
    expect(serialized).not.toContain('admin@example.com');
    expect(serialized).not.toContain('10.0.4.12');
    expect(serialized).not.toContain('connectionString');
    expect(serialized).not.toContain('client');
    expect(log).toEqual({ event: 'pilot-db-pool-error', code: '08006', message: expect.any(String) });
  });

  test('handles a non-Error, non-object thrown value without crashing', () => {
    expect(sanitizedPoolErrorLog('a raw string')).toEqual({
      event: 'pilot-db-pool-error',
      message: expect.any(String),
    });
    expect(sanitizedPoolErrorLog(null)).toEqual({ event: 'pilot-db-pool-error', message: expect.any(String) });
  });
});
