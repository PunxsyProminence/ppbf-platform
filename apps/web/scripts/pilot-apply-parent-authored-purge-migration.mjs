import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

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

// Same reasoning as db.ts's resolveSslConfig and the other pilot-apply-*
// scripts: production/staging always require TLS.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Asserts the properties the migration exists for, and just as deliberately
// asserts the two it must NOT have changed.
//
// `observation_author_nullable` and `observation_author_set_null` are the
// decision itself: a barrier report filed by a guardian survives that
// guardian's purge, detached from them. Both halves are needed -- SET NULL on a
// NOT NULL column raises the moment it fires, so a database with one and not
// the other reads as migrated and breaks on the first purge.
//
// `author_role_column_intact` because author_role is what makes a detached
// record different from an anonymous one. If it were ever dropped, this
// migration's justification would go with it.
//
// `task_state_cascades` is the second decision. SET NULL is impossible on that
// table -- see the migration's comment and the paired CHECK below -- so the row
// goes with the guardian.
//
// THE LAST TWO ASSERT WHAT WAS NOT TOUCHED, and they are the fail-closed half.
// `completion_pairing_intact` refuses a database where someone removed
// pilot_parent_task_state_completion_paired to make SET NULL work after all;
// that was offered to the owner and declined, and a runner that did not check
// would let it back in quietly. `task_creator_still_restricts` refuses a
// database where created_by_account_id was widened along with the completer --
// a guardian can never be a task's creator, so nothing should have changed
// there, and a migration that quietly did is one that reached past its brief.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// row is evaluated when a table is absent, which would report an unmigrated
// database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.coach_observations') is not null as observations_table_ready,
    to_regclass('pilot.parent_task_state') is not null as task_state_table_ready,
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'coach_observations'
         and column_name = 'coach_account_id' and is_nullable = 'YES'
    ) as observation_author_nullable,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.coach_observations')
         and c.confrelid = to_regclass('pilot.accounts')
         and c.contype = 'f'
         and c.confdeltype = 'n'
         and c.conkey = array[(
               select a.attnum from pg_attribute a
                where a.attrelid = to_regclass('pilot.coach_observations')
                  and a.attname = 'coach_account_id'
             )]::int2[]
    ) as observation_author_set_null,
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'coach_observations'
         and column_name = 'author_role'
    ) as author_role_column_intact,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.parent_task_state')
         and c.confrelid = to_regclass('pilot.accounts')
         and c.contype = 'f'
         and c.confdeltype = 'c'
         and c.conkey = array[(
               select a.attnum from pg_attribute a
                where a.attrelid = to_regclass('pilot.parent_task_state')
                  and a.attname = 'completed_by_account_id'
             )]::int2[]
    ) as task_state_cascades,
    exists (
      select 1 from pg_constraint
       where conname = 'pilot_parent_task_state_completion_paired'
         and conrelid = to_regclass('pilot.parent_task_state')
         and contype = 'c'
    ) as completion_pairing_intact,
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'parent_task_state'
         and column_name = 'created_by_account_id' and is_nullable = 'NO'
    ) as task_creator_still_required
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('PARENT_AUTHORED_PURGE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_parent_authored_purge_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });

  await client.connect();
  try {
    // Reported before the change, because it is the number that says how much
    // this decision actually costs on this database: observations whose author
    // is a parent account already soft-deleted, and which will therefore lose
    // that author at the next purge.
    const exposure = await client.query(
      `select count(*)::int as detachable
         from pilot.coach_observations o
         join pilot.accounts a on a.account_id = o.coach_account_id
        where a.role = 'parent' and a.deleted_at is not null`,
    );
    console.log(`observations_that_will_detach: ${exposure.rows[0]?.detachable ?? 'unreadable'}`);
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied parent-authored purge migration: ${migrationPath}`);
  console.log('PILOT PARENT AUTHORED PURGE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT PARENT AUTHORED PURGE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
