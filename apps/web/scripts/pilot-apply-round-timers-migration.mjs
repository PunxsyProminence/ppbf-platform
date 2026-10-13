import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the round-timers migration inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the table and the guards named below ON IT (looked up by
// conrelid, not by name alone): seven checks and the run foreign key. An
// environment where the table exists without one of those cannot pass. Every
// CHECK is compared IN FULL against the text Postgres stores for it; the
// foreign key by shape (both column lists, target table, ON DELETE action);
// each is refused on its own (roundTimers.pg.test.ts). NOT asserted: the
// primary key, column types and nullability, and the foreign keys to
// pilot.organizations and pilot.accounts.
const EXPECTED_CHECKS = [
  ['pilot_round_timers_round_seconds_check', 'CHECK (((round_seconds >= 1) AND (round_seconds <= 3600)))'],
  ['pilot_round_timers_rest_seconds_check', 'CHECK (((rest_seconds >= 0) AND (rest_seconds <= 3600)))'],
  ['pilot_round_timers_rounds_total_check', 'CHECK (((rounds_total >= 1) AND (rounds_total <= 100)))'],
  ['pilot_round_timers_state_check',
    "CHECK ((state = ANY (ARRAY['ready'::text, 'running'::text, 'paused'::text, 'ended'::text])))"],
  ['pilot_round_timers_paused_seconds_check', 'CHECK ((paused_seconds >= 0))'],
  ['pilot_round_timers_state_times_check',
    "CHECK ((((state = 'ready'::text) AND (started_at IS NULL) AND (paused_at IS NULL) AND (ended_at IS NULL))"
      + " OR ((state = 'running'::text) AND (started_at IS NOT NULL) AND (paused_at IS NULL) AND (ended_at IS NULL))"
      + " OR ((state = 'paused'::text) AND (started_at IS NOT NULL) AND (paused_at IS NOT NULL) AND (ended_at IS NULL))"
      + " OR ((state = 'ended'::text) AND (paused_at IS NULL) AND (ended_at IS NOT NULL))))"],
  ['pilot_round_timers_end_after_start_check',
    'CHECK (((ended_at IS NULL) OR (started_at IS NULL) OR (ended_at >= started_at)))'],
];

const column = (rows, index) => rows.map((row) => row[index]);

const READINESS_QUERY = `
  select
    to_regclass('pilot.round_timers') is not null as round_timers_ready,
    (
      select count(*) = $1 from pg_constraint c
      join unnest($2::text[], $3::text[]) as expected(conname, condef)
        on expected.conname = c.conname and c.conrelid = to_regclass('pilot.round_timers')
      where c.contype = 'c' and c.convalidated and pg_get_constraintdef(c.oid) = expected.condef
    ) as checks_ready,
    exists (
      select 1 from pg_constraint c
      where c.conname = 'pilot_round_timers_run_fk'
        and c.conrelid = to_regclass('pilot.round_timers')
        and c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.session_script_runs')
        and c.confdeltype = 'c'
        and (select string_agg(a.attname::text, ',' order by k.ord)
               from unnest(c.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) = 'organization_id,run_id'
        and (select string_agg(a.attname::text, ',' order by k.ord)
               from unnest(c.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) = 'organization_id,run_id'
    ) as run_fk_ready
`;
const READINESS_PARAMS = [EXPECTED_CHECKS.length, column(EXPECTED_CHECKS, 0), column(EXPECTED_CHECKS, 1)];

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, READINESS_PARAMS);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('ROUND_TIMERS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_round_timers_migration.sql',
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
  console.log(`Applied round timers migration: ${migrationPath}`);
  console.log('PILOT ROUND TIMERS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ROUND TIMERS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
