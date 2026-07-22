import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { getAzurePostgresConnectionString } from './env';

let pool: Pool | null = null;

// Azure Postgres always requires SSL in production. The only opt-out is this
// exact, explicit flag, which real deploy environments never set -- it
// exists solely so local/CI tests can point at a disposable, non-SSL local
// Postgres instance (e.g. the embedded-postgres-backed migration tests).
function sslConfig(): { rejectUnauthorized: boolean } | false {
  if (process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: false };
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getAzurePostgresConnectionString(),
      ssl: sslConfig(),
      max: 10,
    });
    // pg's Pool re-emits errors from idle clients (e.g. the server closing a
    // connection, a network blip). Without a listener here, that becomes an
    // unhandled 'error' event and crashes the entire process -- registering
    // one just logs it, since query()/withTransaction() already surface the
    // failure to whichever caller was using that connection.
    pool.on('error', (error) => {
      console.error('pilot-db-pool-error', error);
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
