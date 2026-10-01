import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the nomination-athlete cascade migration (OD-2026-08-29-007) inside
// one transaction, with the same target-verification discipline as every
// other pilot:apply-* script: the operator must state which host and database
// they believe they are pointing at, and a mismatch refuses before any DDL
// runs.

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function parseConnectionTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('INVALID_POSTGRES_CONNECTION_STRING');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('INVALID_POSTGRES_PROTOCOL');
  }

  const hostname = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!hostname || !database) {
    throw new Error('INCOMPLETE_POSTGRES_TARGET');
  }

  return { hostname, database };
}

function assertExpectedTarget(target, expectedHostname, expectedDatabase) {
  if (
    target.hostname !== expectedHostname.toLowerCase()
    || target.database !== expectedDatabase
  ) {
    throw new Error('POSTGRES_TARGET_MISMATCH');
  }
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Asserts the delete ACTION, not the constraint's name. The name
// pilot_one_percent_nominations_athlete_fk exists before this migration too,
// restricting, so a name check passes on a database that was never migrated.
//
// `athlete_fk_cascades`: the named constraint points at pilot.athletes on
// (organization_id, athlete_id), is validated, and its confdeltype is 'c'.
// The key columns are compared by attribute number, not by matching
// pg_get_constraintdef() text: that text drops the `pilot.` qualifier when
// the connecting role has pilot on its search_path, and a text match would
// then refuse a correctly migrated database.
// `no_restricting_athlete_fk`: no OTHER foreign key from this table onto
// pilot.athletes is left restricting -- one would block the purge just the
// same, under a different name.
// `votes_still_cascade`: asserts what was NOT touched. The decision removes a
// nomination with its athlete; the votes follow only because
// pilot_one_percent_votes_nomination_fk already cascades. If that were ever
// changed, the athlete delete would be refused one table further down.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// row is evaluated when a table is absent, which would report an unmigrated
// database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.one_percent_nominations') is not null as nominations_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_one_percent_nominations_athlete_fk'
         and c.conrelid = to_regclass('pilot.one_percent_nominations')
         and c.confrelid = to_regclass('pilot.athletes')
         and c.contype = 'f'
         and c.confdeltype = 'c'
         and c.convalidated
         and c.conkey = array(
               select a.attnum from pg_attribute a
                where a.attrelid = to_regclass('pilot.one_percent_nominations')
                  and a.attname in ('organization_id', 'athlete_id')
                order by array_position(array['organization_id', 'athlete_id']::name[], a.attname)
             )::int2[]
         and c.confkey = array(
               select a.attnum from pg_attribute a
                where a.attrelid = to_regclass('pilot.athletes')
                  and a.attname in ('organization_id', 'athlete_id')
                order by array_position(array['organization_id', 'athlete_id']::name[], a.attname)
             )::int2[]
    ) as athlete_fk_cascades,
    not exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.one_percent_nominations')
         and c.confrelid = to_regclass('pilot.athletes')
         and c.contype = 'f'
         and c.confdeltype <> 'c'
    ) as no_restricting_athlete_fk,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_one_percent_votes_nomination_fk'
         and c.conrelid = to_regclass('pilot.one_percent_votes')
         and c.confrelid = to_regclass('pilot.one_percent_nominations')
         and c.contype = 'f'
         and c.confdeltype = 'c'
    ) as votes_still_cascade
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ONE_PERCENT_NOMINATION_ATHLETE_CASCADE_NOT_READY');
  }
}

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    assertReadiness(readiness.rows[0]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const expectedHostname = required('PPBF_EXPECTED_POSTGRES_HOSTNAME');
  const expectedDatabase = required('PPBF_EXPECTED_POSTGRES_DATABASE');

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationPath = path.resolve(
    __dirname,
    '../../../infra/azure/pilot_slice_postgres_one_percent_nomination_athlete_cascade_migration.sql',
  );

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

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied 1% Club nomination-athlete cascade migration: ${migrationPath}`);
  console.log('PILOT ONE PERCENT NOMINATION ATHLETE CASCADE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ONE PERCENT NOMINATION ATHLETE CASCADE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
