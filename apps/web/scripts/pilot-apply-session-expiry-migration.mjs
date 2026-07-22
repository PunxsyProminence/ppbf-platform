import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationPath = path.resolve(__dirname, '../../../infra/azure/pilot_slice_postgres_session_expiry_migration.sql');

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    // Every statement in this migration (ALTER TABLE, UPDATE, CREATE INDEX,
    // INSERT ... ON CONFLICT) is valid inside a Postgres transaction, so run
    // the whole file as one: a failure partway through rolls back
    // everything instead of leaving the schema in a half-migrated state.
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }

  console.log(`Applied session expiry migration: ${migrationPath}`);
  console.log('PILOT SESSION EXPIRY MIGRATION PASS');
}

try {
  await run();
} catch (error) {
  console.error('PILOT SESSION EXPIRY MIGRATION FAIL');
  console.error(String(error));
  process.exit(1);
}
