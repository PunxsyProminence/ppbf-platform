import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the intervention-execution request-key migration (finding F-135)
// inside one transaction. The operator names the host and database they believe
// they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch
// refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt, each piece looked up ON
// pilot.intervention_executions so a same-named object elsewhere does not pass:
// the column as nullable text; the check, validated, compared IN FULL against
// the text Postgres stores for this migration's own check; and the unique
// index by name, compared by the tail of its stored definition so a same-named
// index over other columns, not unique, or without the partial predicate is
// refused (interventionExecutionRequestKey.pg.test.ts).
const EXPECTED_CHECK = 'CHECK (((request_key IS NULL) OR ((length(btrim(request_key)) > 0) AND (length(request_key) <= 200))))';
const EXPECTED_INDEX_TAIL = 'UNIQUE INDEX pilot_intervention_executions_one_per_request_key ON pilot.intervention_executions USING btree (organization_id, request_key) WHERE (request_key IS NOT NULL)';

const READINESS_QUERY = `
  select
    to_regclass('pilot.intervention_executions') is not null as table_ready,
    exists (
      select 1 from pg_attribute a
       where a.attrelid = to_regclass('pilot.intervention_executions')
         and a.attname = 'request_key' and not a.attisdropped
         and a.atttypid = 'text'::regtype and not a.attnotnull
    ) as column_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.intervention_executions')
         and c.conname = 'pilot_intervention_executions_request_key_check'
         and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) = $1
    ) as check_ready,
    exists (
      select 1 from pg_indexes i
       where i.schemaname = 'pilot' and i.tablename = 'intervention_executions'
         and i.indexname = 'pilot_intervention_executions_one_per_request_key'
         and i.indexdef like '%' || $2
    ) as index_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, [EXPECTED_CHECK, EXPECTED_INDEX_TAIL]);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`INTERVENTION_EXECUTION_REQUEST_KEY_NOT_READY: ${missing.join(', ')}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) throw new Error('MISSING_AZURE_POSTGRES_CONNECTION_STRING');
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const migrationPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../infra/azure/pilot_slice_postgres_intervention_execution_request_key_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied intervention execution request key migration: ${migrationPath}`);
  console.log('PILOT INTERVENTION EXECUTION REQUEST KEY MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT INTERVENTION EXECUTION REQUEST KEY MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
