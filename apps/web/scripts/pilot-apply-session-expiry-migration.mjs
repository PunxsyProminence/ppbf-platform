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

// Same reasoning as db.ts's resolveSslConfig: production/staging always
// require TLS. The only opt-out is NODE_ENV === 'test' together with the
// explicit flag, so this script can be pointed at a disposable local test
// database without ever weakening a real run against Azure Postgres.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Applies `sql` against `client` inside a single explicit transaction: every
// statement in this migration (ALTER TABLE, UPDATE, CREATE INDEX, INSERT ...
// ON CONFLICT) is valid inside a Postgres transaction, so a failure partway
// through rolls back everything instead of leaving the schema in a
// half-migrated state. Exported so tests can exercise this exact
// transactional behavior -- including an injected failing statement --
// against a disposable database, without invoking the CLI entry point below.
export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationPath = path.resolve(__dirname, '../../../infra/azure/pilot_slice_postgres_session_expiry_migration.sql');

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`Applied session expiry migration: ${migrationPath}`);
  console.log('PILOT SESSION EXPIRY MIGRATION PASS');
}

// Only run as a CLI side effect when this file is executed directly (e.g.
// `node pilot-apply-session-expiry-migration.mjs`), not when it's imported
// by a test for its exported functions -- importing it must never require
// AZURE_POSTGRES_CONNECTION_STRING or call process.exit.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION EXPIRY MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
