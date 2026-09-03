const mockConnect = jest.fn();
const mockPoolEnd = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();

// Captured in a plain Map rather than a jest.fn: setTypeParser runs once when
// the module is imported, and the suite's clearAllMocks would erase the record
// before any test could read it.
const mockRegisteredTypeParsers = new Map<number, (value: string) => string>();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    end: mockPoolEnd,
    on: mockOn,
  })),
  types: {
    setTypeParser: (oid: number, parser: (value: string) => string) => {
      mockRegisteredTypeParsers.set(oid, parser);
    },
  },
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
    expect(resolveSslConfig({})).toEqual({ rejectUnauthorized: true });
  });

  test('the disable flag alone, outside a test NODE_ENV, is ignored -- TLS stays on', () => {
    // Note: an omitted nodeEnv override falls back to the real
    // process.env.NODE_ENV, which Jest itself always sets to 'test' -- these
    // tests must pass an explicit non-test value to actually exercise "not
    // in a test environment".
    expect(resolveSslConfig({ nodeEnv: 'production', disableSslFlag: 'true' })).toEqual({ rejectUnauthorized: true });
  });

  test('NODE_ENV=test alone (no explicit flag) is ignored -- TLS stays on', () => {
    expect(resolveSslConfig({ nodeEnv: 'test' })).toEqual({ rejectUnauthorized: true });
  });

  test('NODE_ENV=test together with the explicit flag disables TLS', () => {
    expect(resolveSslConfig({ nodeEnv: 'test', disableSslFlag: 'true' })).toBe(false);
  });

  test('the offline launcher marker disables TLS only in development', () => {
    expect(resolveSslConfig({ nodeEnv: 'development', offlineRuntimeFlag: 'true', connectionString: 'postgres://offline:offline@127.0.0.1:5432/postgres' })).toBe(false);
  });

  test.each([
    'postgres://offline:offline@127.0.0.1:5432/postgres',
    'postgresql://offline:offline@127.1.2.3:5432/postgres',
    'postgres://offline:offline@localhost:5432/postgres',
    'postgres://offline:offline@[::1]:5432/postgres',
  ])('offline development disables TLS only for loopback Postgres target %s', (connectionString) => {
    expect(resolveSslConfig({
      nodeEnv: 'development',
      offlineRuntimeFlag: 'true',
      connectionString,
    })).toBe(false);
  });

  test.each([
    'postgres://offline:offline@example.com:5432/postgres',
    'postgres://offline:offline@8.8.8.8:5432/postgres',
    'postgres://offline:offline@127.example.com:5432/postgres',
    'https://127.0.0.1/postgres',
    'not-a-postgres-url',
  ])('offline marker cannot disable TLS for non-loopback or invalid target %s', (connectionString) => {
    expect(resolveSslConfig({
      nodeEnv: 'development',
      offlineRuntimeFlag: 'true',
      connectionString,
    })).toEqual({ rejectUnauthorized: true });
  });

  test('offline marker without a database target cannot disable TLS', () => {
    expect(resolveSslConfig({
      nodeEnv: 'development',
      offlineRuntimeFlag: 'true',
      connectionString: undefined,
    })).toEqual({ rejectUnauthorized: true });
  });
  test.each(['production', 'staging', 'test'])(
    'NODE_ENV=%s ignores the offline launcher marker -- TLS stays on',
    (nodeEnv) => {
      expect(resolveSslConfig({ nodeEnv, offlineRuntimeFlag: 'true' })).toEqual({ rejectUnauthorized: true });
    },
  );

  test.each(['production', 'staging'])(
    'NODE_ENV=%s ignores the disable flag even if present -- production/staging can never downgrade TLS',
    (nodeEnv) => {
      expect(resolveSslConfig({ nodeEnv, disableSslFlag: 'true' })).toEqual({ rejectUnauthorized: true });
    },
  );

  test('an unexpected disable flag value (not the exact string "true") is ignored', () => {
    expect(resolveSslConfig({ nodeEnv: 'test', disableSslFlag: 'yes' })).toEqual({ rejectUnauthorized: true });
    expect(resolveSslConfig({ nodeEnv: 'test', disableSslFlag: '1' })).toEqual({ rejectUnauthorized: true });
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

  test('retains a valid 5-character uppercase alphanumeric SQLSTATE', () => {
    expect(sanitizedPoolErrorLog({ code: '57P01' })).toEqual({
      event: 'pilot-db-pool-error',
      code: '57P01',
      message: expect.any(String),
    });
    expect(sanitizedPoolErrorLog({ code: '08006' })).toHaveProperty('code', '08006');
    expect(sanitizedPoolErrorLog({ code: 'ZZZZZ' })).toHaveProperty('code', 'ZZZZZ');
  });

  test('omits an oversized code value', () => {
    const log = sanitizedPoolErrorLog({ code: '57P011' }); // 6 characters
    expect(log).not.toHaveProperty('code');
    const longLog = sanitizedPoolErrorLog({ code: 'A'.repeat(500) });
    expect(longLog).not.toHaveProperty('code');
  });

  test('omits an undersized code value', () => {
    expect(sanitizedPoolErrorLog({ code: '5701' })).not.toHaveProperty('code'); // 4 characters
    expect(sanitizedPoolErrorLog({ code: '' })).not.toHaveProperty('code');
  });

  test('omits a lowercase or mixed-case code value', () => {
    expect(sanitizedPoolErrorLog({ code: '57p01' })).not.toHaveProperty('code');
    expect(sanitizedPoolErrorLog({ code: 'abcde' })).not.toHaveProperty('code');
  });

  test('omits a code value containing a newline or other control character', () => {
    expect(sanitizedPoolErrorLog({ code: '57P0\n' })).not.toHaveProperty('code');
    expect(sanitizedPoolErrorLog({ code: '57P0\t' })).not.toHaveProperty('code');
    expect(sanitizedPoolErrorLog({ code: '\n\n\n\n\n' })).not.toHaveProperty('code');
  });

  test('omits a code value containing whitespace', () => {
    expect(sanitizedPoolErrorLog({ code: '57P0 ' })).not.toHaveProperty('code');
    expect(sanitizedPoolErrorLog({ code: ' 7P01' })).not.toHaveProperty('code');
    expect(sanitizedPoolErrorLog({ code: '5 P01' })).not.toHaveProperty('code');
  });

  test('omits a code value containing punctuation or symbols', () => {
    expect(sanitizedPoolErrorLog({ code: '57P0!' })).not.toHaveProperty('code');
    expect(sanitizedPoolErrorLog({ code: '57-01' })).not.toHaveProperty('code');
  });

  test('omits a non-string code value', () => {
    expect(sanitizedPoolErrorLog({ code: 12345 })).not.toHaveProperty('code');
    expect(sanitizedPoolErrorLog({ code: null })).not.toHaveProperty('code');
    expect(sanitizedPoolErrorLog({ code: { nested: '57P01' } })).not.toHaveProperty('code');
    expect(sanitizedPoolErrorLog({ code: ['5', '7', 'P', '0', '1'] })).not.toHaveProperty('code');
  });

  test('a malformed code never leaks into the message either', () => {
    const log = sanitizedPoolErrorLog({ code: 'malicious-connection-string-fragment' });
    expect(log).not.toHaveProperty('code');
    expect(JSON.stringify(log)).not.toContain('malicious-connection-string-fragment');
  });
});

describe('the registered pool error listener logs a sanitized payload', () => {
  test('the actual callback passed to pool.on(\'error\', ...) invokes console.error with only sanitized fields', async () => {
    // Force a fresh pool (and therefore a fresh pool.on('error', ...)
    // registration) within this test, rather than relying on registration
    // order from earlier tests in this file.
    await closePool();

    const client = fakeClient();
    mockConnect.mockResolvedValueOnce(client);
    await withTransaction(async () => 'ok');

    const errorRegistration = mockOn.mock.calls.find(([eventName]) => eventName === 'error');
    expect(errorRegistration).toBeDefined();
    const registeredListener = errorRegistration?.[1] as (err: unknown) => void;

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const sensitiveError = Object.assign(new Error('do not log this raw message'), {
        code: '57P01',
        client: {
          connectionParameters: { user: 'ppbf_app', password: 'super-secret-password', host: 'prod-db.internal' },
        },
        connectionString: 'postgres://ppbf_app:super-secret-password@prod-db.internal:5432/pilot',
        query: { text: 'select pin_hash from pilot.accounts', values: ['acct-1'] },
      });

      registeredListener(sensitiveError);

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith({
        event: 'pilot-db-pool-error',
        code: '57P01',
        message: expect.any(String),
      });

      const loggedSerialized = JSON.stringify(consoleErrorSpy.mock.calls[0]);
      expect(loggedSerialized).not.toContain('super-secret-password');
      expect(loggedSerialized).not.toContain('prod-db.internal');
      expect(loggedSerialized).not.toContain('do not log this raw message');
      expect(loggedSerialized).not.toContain('pin_hash');
      expect(loggedSerialized).not.toContain('connectionString');
      expect(loggedSerialized).not.toContain('client');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

// A `date` column is a calendar day. Parsed into a JS Date it becomes an
// instant at the server's local midnight, and serializing that to JSON moves
// the day backwards for any server east of UTC -- so a date of birth read on
// one host and written back from another would silently walk.
test('DATE columns are handed through as calendar days, not parsed into instants', () => {
  const dateOid = 1082;
  const parser = mockRegisteredTypeParsers.get(dateOid);

  expect(parser).toBeDefined();
  expect(parser?.('2008-03-15')).toBe('2008-03-15');
  // Timestamps keep their own parsing.
  expect(mockRegisteredTypeParsers.has(1114)).toBe(false);
});
