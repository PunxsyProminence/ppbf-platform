import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the attendance-reconciled-cancelled migration (lane LV,
// OD-2026-10-22-001) inside one transaction: pilot.attendance_reconciled stops
// reading marks on a cancelled class. The operator names the host and database
// they believe they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME /
// _DATABASE); a mismatch refuses before connecting.
//
// The migration replaces one view and its comment. It writes, alters and
// deletes no table, so re-running it is a no-op.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// The view's columns, in order. `create or replace view` refuses a change to
// them, so this is what the readers in attendancePrecedence.ts, passbook.ts and
// performanceAnalytics.ts keep reading.
export const EXPECTED_COLUMNS = [
  'organization_id',
  'athlete_id',
  'attendance_date',
  'status',
  'source',
  'class_marks_that_day',
  'contributing_sources',
];

// Readiness asserts the result, not the attempt, in two steps. First the
// view's shape, read from the catalog so it cannot error on a wrong view:
//   - the view exists, with exactly its seven columns in order;
//   - its definition carries this migration's filter (the text Postgres stores
//     for it, attendanceReconciledCancelled.pg.test.ts), so a database this
//     migration never reached is refused instead of passing.
// Then, only on that shape, its rows:
//   - one row per athlete-day, the property the view exists for;
//   - no day sourced from the register rests only on marks from a cancelled
//     class.
const SHAPE_QUERY = `
  select
    to_regclass('pilot.attendance_reconciled') is not null as view_ready,
    coalesce((
      select array_agg(a.attname::text order by a.attnum)
        from pg_attribute a
       where a.attrelid = to_regclass('pilot.attendance_reconciled')
         and a.attnum > 0 and not a.attisdropped
    ) = $1::text[], false) as columns_ready,
    coalesce(position($2 in pg_get_viewdef(to_regclass('pilot.attendance_reconciled'))) > 0, false)
      as cancelled_filter_ready
`;

const ROWS_QUERY = `
  select
    not exists (
      select 1
        from pilot.attendance_reconciled
       group by organization_id, athlete_id, attendance_date
      having count(*) > 1
    ) as one_row_per_athlete_day,
    not exists (
      select 1
        from pilot.attendance_reconciled r
       where r.source = 'scheduler_attendance'
         and not exists (
           select 1
             from pilot.scheduler_attendance sa
             join pilot.scheduler_classes sc
               on sc.organization_id = sa.organization_id
              and sc.class_id = sa.class_id
            where sa.organization_id = r.organization_id
              and sa.athlete_id = r.athlete_id
              and (sc.start_at at time zone 'America/New_York')::date = r.attendance_date
              and sc.status <> 'cancelled'
         )
    ) as no_day_from_cancelled_marks_only
`;

function refuseUnless(row) {
  const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
  if (missing.length > 0) {
    throw new Error(`ATTENDANCE_RECONCILED_CANCELLED_NOT_READY: ${missing.join(', ')}`);
  }
}

// The filter as Postgres stores it. pg_get_viewdef prints it as
// "WHERE (sc.status <> 'cancelled'::text)", or without the brackets in pretty
// mode; this is the part both forms share (attendanceReconciledCancelled.pg.test.ts
// reads it back from a real database).
export const EXPECTED_FILTER_TEXT = "sc.status <> 'cancelled'::text";

// Runs before the file, so a database without the view or the scheduler tables
// is refused by name instead of failing on a bare "relation does not exist".
const PREREQUISITE_QUERY = `
  select
    to_regclass('pilot.attendance_reconciled') is not null as view_present,
    to_regclass('pilot.scheduler_classes') is not null as classes_present,
    to_regclass('pilot.scheduler_attendance') is not null as register_present
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    const prerequisites = (await client.query(PREREQUISITE_QUERY)).rows[0];
    const absent = prerequisites
      ? Object.entries(prerequisites).filter(([, value]) => value !== true).map(([key]) => key)
      : ['prerequisites'];
    if (absent.length > 0) {
      throw new Error(
        `ATTENDANCE_RECONCILED_CANCELLED_NOT_READY: ${absent.join(', ')} (apply scheduler-tables and attendance-precedence first)`,
      );
    }
    // Replacing the view takes a brief exclusive lock on it, which the coach
    // attendance screens read. Rather than queue behind a long transaction
    // already holding a lock there, give up and let the operator re-run in a
    // quieter moment. Nothing is half-applied: it is one transaction.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    refuseUnless((await client.query(SHAPE_QUERY, [EXPECTED_COLUMNS, EXPECTED_FILTER_TEXT])).rows[0]);
    refuseUnless((await client.query(ROWS_QUERY)).rows[0]);
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
    '../../../infra/azure/pilot_slice_postgres_attendance_reconciled_cancelled_migration.sql',
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
  console.log(`Applied attendance reconciled cancelled migration: ${migrationPath}`);
  console.log('PILOT ATTENDANCE RECONCILED CANCELLED MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATTENDANCE RECONCILED CANCELLED MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
