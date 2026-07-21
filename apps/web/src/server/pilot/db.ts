import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { getAzurePostgresConnectionString } from './env';

let pool: Pool | null = null;

function getPool(): Pool {
  pool ??= new Pool({
    connectionString: getAzurePostgresConnectionString(),
    ssl: { rejectUnauthorized: false },
    max: 10,
  });

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
