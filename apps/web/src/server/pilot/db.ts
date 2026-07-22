import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { getAzurePostgresConnectionString } from './env';

let pool: Pool | null = null;

export interface SslOverride {
  nodeEnv?: string;
  disableSslFlag?: string;
}

// Azure Postgres always requires TLS in production and staging. The only
// opt-out is this exact combination -- NODE_ENV must be the unmistakable
// 'test' value, AND the explicit disable flag must be set -- so a stray or
// accidental PPBF_POSTGRES_DISABLE_SSL=true can never downgrade a real
// deploy environment, which never runs with NODE_ENV=test. Accepts an
// injected override so this is directly unit-testable without mutating
// global process.env.
export function resolveSslConfig(override: SslOverride = {}): { rejectUnauthorized: boolean } | false {
  const nodeEnv = override.nodeEnv ?? process.env.NODE_ENV;
  const disableSslFlag = override.disableSslFlag ?? process.env.PPBF_POSTGRES_DISABLE_SSL;

  if (nodeEnv === 'test' && disableSslFlag === 'true') {
    return false;
  }

  return { rejectUnauthorized: false };
}

// Bounded, sanitized log payload for an idle-connection pool error. Never
// includes the client object, connection parameters/string, credentials,
// query text/parameters, or socket internals -- only a fixed event name,
// the Postgres error code (if the driver supplied one), and a static,
// non-derived message.
export function sanitizedPoolErrorLog(error: unknown): { event: string; code?: string; message: string } {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;

  return {
    event: 'pilot-db-pool-error',
    ...(code ? { code } : {}),
    message: 'Idle database connection encountered an error and was discarded from the pool.',
  };
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getAzurePostgresConnectionString(),
      ssl: resolveSslConfig(),
      max: 10,
    });
    // pg's Pool re-emits errors from idle clients (e.g. the server closing a
    // connection, a network blip). Without a listener here, that becomes an
    // unhandled 'error' event and crashes the entire process -- registering
    // one just logs a sanitized summary, since query()/withTransaction()
    // already surface the failure to whichever caller was using that
    // connection.
    pool.on('error', (error) => {
      console.error(sanitizedPoolErrorLog(error));
    });
  }

  return pool;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = await getPool().connect();
  try {
    const result = await client.query<T>(text, params);
    return result.rows;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

// Closes the connection pool, if one was ever created. Not used by the
// running application (the pool lives for the process lifetime), but lets
// tests that stand up a disposable database shut it down cleanly instead of
// leaving an idle connection open when the test database itself goes away.
export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

// Runs `fn` inside a single BEGIN/COMMIT transaction on one connection.
// Any thrown error rolls the transaction back before rethrowing, so callers
// that pair a sensitive mutation with a dependent side effect (e.g. changing
// a credential and revoking sessions) can never commit only one half.
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failures (e.g. connection already broken) -- the
      // original error is what the caller needs to see.
    }
    throw error;
  } finally {
    client.release();
  }
}
