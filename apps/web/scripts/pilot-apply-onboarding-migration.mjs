import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const READINESS_QUERY = `
  select
    to_regclass('pilot.account_activation_tokens') is not null as activation_tokens_ready,
    (
      select count(*) = 4
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'account_activation_tokens'
        and column_name in ('token_hash', 'account_id', 'organization_id', 'expires_at')
        and is_nullable = 'NO'
    ) as activation_token_identity_ready
`;

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
  const migrationPath = path.resolve(__dirname, '../../../infra/azure/pilot_slice_postgres_onboarding_migration.sql');

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: true },
  });

  await client.connect();
  try {
    await client.query(sql);

    // Verify the migration actually produced the table this release depends
    // on, rather than trusting that a `create table if not exists` against an
    // unexpected schema state did the right thing.
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('ONBOARDING_SCHEMA_NOT_READY');
    }
  } finally {
    await client.end();
  }

  console.log(`Applied onboarding migration: ${migrationPath}`);
  console.log('activation_schema_ready: true');
  console.log('PILOT ONBOARDING MIGRATION PASS');
}

try {
  await run();
} catch (error) {
  console.error('PILOT ONBOARDING MIGRATION FAIL');
  console.error(String(error));
  process.exit(1);
}
