import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the learning-loop migration (lane L49) inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// A trigger by name ON its table: BEFORE (2), ROW (1), firing in ordinary sessions, calling the
// named function, on every event in `events` (INSERT 4, DELETE 8, UPDATE 16).
const triggerReady = (table, trigger, fn, events) => `exists (
      select 1 from pg_trigger t
       where t.tgrelid = to_regclass('${table}') and t.tgname = '${trigger}' and not t.tgisinternal
         and t.tgenabled in ('O', 'A') and (t.tgtype & 3) = 3 and (t.tgtype & ${events}) = ${events}
         and t.tgfoid = to_regprocedure('${fn}')
    )`;

const constraintReady = (table, name, type) => `exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('${table}') and c.conname = '${name}' and c.contype = '${type}'
         and c.convalidated
    )`;

// Readiness asserts the result, not the attempt: each table, the append-only guards, the
// athlete follow trigger, the one-bar-in-force index, the citation check, and both new
// intervention columns with their key and check.
const READINESS_QUERY = `
  select
    to_regclass('pilot.behaviour_keys') is not null as keys_table_ready,
    to_regclass('pilot.behaviour_observations') is not null as observations_table_ready,
    to_regclass('pilot.learning_policies') is not null as policies_table_ready,
    ${constraintReady('pilot.behaviour_observations', 'pilot_behaviour_observations_key_fk', 'f')} as observation_key_fk_ready,
    ${constraintReady('pilot.behaviour_observations', 'pilot_behaviour_observations_episode_check', 'c')} as episode_check_ready,
    ${constraintReady('pilot.behaviour_observations', 'pilot_behaviour_observations_deidentified_check', 'c')} as deidentified_check_ready,
    ${constraintReady('pilot.learning_policies', 'pilot_learning_policies_citations_check', 'c')} as citations_check_ready,
    ${triggerReady('pilot.behaviour_observations', 'trg_behaviour_observations_guard', 'pilot.behaviour_observations_guard()', 28)} as observations_guard_ready,
    ${triggerReady('pilot.learning_policies', 'trg_learning_policies_guard', 'pilot.learning_policies_guard()', 28)} as policies_guard_ready,
    ${triggerReady('pilot.athletes', 'pilot_behaviour_observations_follow_athlete', 'pilot.behaviour_observations_follow_athlete()', 8)} as follow_athlete_ready,
    exists (
      select 1 from pg_index i
       where i.indexrelid = to_regclass('pilot.idx_learning_policies_one_active')
         and i.indrelid = to_regclass('pilot.learning_policies') and i.indisunique and i.indpred is not null
    ) as one_active_policy_ready,
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'intervention_protocols' and column_name = 'behaviour_key'
    ) as protocol_behaviour_key_ready,
    ${constraintReady('pilot.intervention_protocols', 'pilot_intervention_protocols_behaviour_key_fk', 'f')} as protocol_behaviour_key_fk_ready,
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'intervention_executions' and column_name = 'trained_task_context_key'
    ) as execution_context_key_ready,
    ${constraintReady('pilot.intervention_executions', 'pilot_intervention_executions_trained_context_key_check', 'c')} as execution_context_check_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`LEARNING_LOOP_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_learning_loop_migration.sql',
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
  console.log(`Applied learning loop migration: ${migrationPath}`);
  console.log('PILOT LEARNING LOOP MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT LEARNING LOOP MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
