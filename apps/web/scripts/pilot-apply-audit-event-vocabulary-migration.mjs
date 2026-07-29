import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Load apps/web/.env.local into process.env, without adding a dotenv
 * dependency for one file.
 *
 * The Next dev server already reads this file, so the connection string is
 * sitting right there -- but a plain node script does not, which meant every
 * run of this migration started with the operator exporting the variable by
 * hand. That is a needless step, and getting the quoting wrong in a shell
 * produces a mangled host rather than an obvious error.
 *
 * A real environment variable always wins, so CI and any deliberate one-off
 * override still behave exactly as before.
 */
async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');

  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // No .env.local (CI, or a container). The env var must be set.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    // Strip one matched pair of surrounding quotes; a bare value keeps any
    // quote characters it legitimately contains.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'Set it in apps/web/.env.local, or export it before running this script.',
    );
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
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationPath = path.resolve(__dirname, '../../../infra/azure/pilot_slice_postgres_audit_event_vocabulary_migration.sql');

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

  console.log(`Applied audit event vocabulary migration: ${migrationPath}`);
  console.log('PILOT AUDIT EVENT VOCABULARY MIGRATION PASS');
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
    console.error('PILOT AUDIT EVENT VOCABULARY MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
