import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Verifies the migration actually took, rather than trusting that the SQL ran.
//
// The vocabulary check asks whether ANY constraint still refuses magic_link,
// not whether one named constraint admits it. That distinction is the whole
// lesson of this file:
//
// A deployed database carried TWO check constraints on auth_provider -- the
// inline one from the base schema's CREATE TABLE, auto-named
// accounts_auth_provider_check, and pilot_accounts_auth_provider_check from
// the multiorg migration. The first version of this query looked up the second
// by name, found magic_link in it, and reported ready. The insert still failed,
// because a row must satisfy both and nobody had widened the one PostgreSQL
// named for itself.
//
// Checking the constraint you thought of is not checking the constraint.
const READINESS_QUERY = `
  select
    to_regclass('pilot.magic_link_tokens') is not null as table_ready,
    (
      select count(*) = 0
      from pg_constraint c
      where c.conrelid = 'pilot.accounts'::regclass
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) ilike '%auth_provider%'
        and pg_get_constraintdef(c.oid) not ilike '%magic_link%'
    ) as vocabulary_ready,
    (
      select count(*) = 2
      from pg_indexes
      where schemaname = 'pilot'
        and tablename = 'magic_link_tokens'
        and indexname in ('idx_magic_link_tokens_account_live', 'idx_magic_link_tokens_expires_at')
    ) as indexes_ready,
    (
      select count(*) = 2
      from pg_constraint
      where conrelid = 'pilot.magic_link_tokens'::regclass
        and conname in (
          'pilot_magic_link_tokens_expiry_after_creation',
          'pilot_magic_link_tokens_single_outcome'
        )
    ) as guards_ready
`;

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

export async function applyMigration(client, sql) {
  await client.query(sql);
  const readiness = await client.query(READINESS_QUERY);
  if (!readiness.rows[0] || Object.values(readiness.rows[0]).some((value) => value !== true)) {
    throw new Error(`MAGIC_LINK_MIGRATION_NOT_READY:${JSON.stringify(readiness.rows[0])}`);
  }
}

export async function run() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) throw new Error('MISSING_AZURE_POSTGRES_CONNECTION_STRING');
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const migrationPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../infra/azure/pilot_slice_postgres_magic_link_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  try {
    await applyMigration(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log('PILOT MAGIC LINK MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT MAGIC LINK MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
