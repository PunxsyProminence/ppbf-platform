import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the calibration-adjudication-revisions migration inside one
// transaction, with the same target-verification discipline as every other
// pilot:apply-* script: the operator must state which host and database they
// believe they are pointing at, and a mismatch refuses before any DDL runs.

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

// Every clause can go false against a database where this migration has not run.
// Asserted BY NAME out of pg_constraint and information_schema rather than by
// deparsing a definition -- Postgres rebuilds a CHECK from the parsed tree
// instead of echoing its source, which blocked a real staging dispatch once
// (issue #488).
//
// THE UNIQUE CONSTRAINT IS THE ONE THAT MATTERS MOST. Without a lock it is the
// only thing standing between two concurrent administrators and two rows both
// claiming to be revision N of the same pair. A table carrying the column and
// the CHECK but not this constraint looks migrated and arbitrates nothing, and
// the route's 409 translation would never fire because no 23505 would be raised.
//
// revision_required_and_undefaulted carries two things at once. With a DEFAULT,
// an insert that omitted the revision would land a plausible row rather than
// failing, and the value it landed would be wrong for every pair that already
// had revisions. And `is_nullable = 'NO'` is ALSO the backfill assertion:
// PostgreSQL refuses `set not null` on a column that still contains a null, so
// the constraint existing is proof the backfill completed. That is strictly
// stronger than scanning the table, because the database enforced it at ALTER
// time rather than at the moment somebody happened to look.
//
// EVERY CLAUSE READS A CATALOG, NEVER THE TABLE'S DATA, and that is load-bearing
// rather than stylistic. A clause like `where revision is null` cannot report
// false on an unmigrated database: PostgreSQL parses the whole statement before
// running any of it, so the reference to a column that does not exist raises
// `column "revision" does not exist` and the gate throws that instead of
// CALIBRATION_ADJUDICATION_REVISIONS_NOT_READY. A readiness gate that errors
// where it should report "not ready" tells the operator the wrong thing about
// the wrong problem. Caught by
// 'REFUSES a database where the revisions migration never ran'.
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'calibration_adjudications'
        and column_name = 'revision'
    ) as revision_column_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'calibration_adjudications'
        and column_name = 'revision'
        and is_nullable = 'NO'
        and column_default is null
    ) as revision_required_and_undefaulted,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudications')
        and conname = 'pilot_calibration_adjudications_revision_positive'
    ) as revision_positive_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudications')
        and conname = 'pilot_calibration_adjudications_pair_revision_uq'
    ) as pair_revision_arbiter_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CALIBRATION_ADJUDICATION_REVISIONS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_calibration_adjudication_revisions_migration.sql',
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
  console.log(`Applied calibration adjudication revisions migration: ${migrationPath}`);
  console.log('PILOT CALIBRATION ADJUDICATION REVISIONS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CALIBRATION ADJUDICATION REVISIONS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
