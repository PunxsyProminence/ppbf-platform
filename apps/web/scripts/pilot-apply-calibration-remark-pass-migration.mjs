import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the calibration-remark-pass migration inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

const SETS = 'pilot.calibration_annotation_sets';
const quote = (value) => `'${value}'`;
const constraintExists = (name) => `exists (select 1 from pg_constraint
      where conrelid = to_regclass(${quote(SETS)}) and conname = ${quote(name)})`;

// Every clause is false on a database this migration has not reached
// (calibrationRemarkPass.pg.test.ts, "refuses a database the migration has
// not reached"). The three-column key must be GONE, not merely joined by the
// pass key: with both present a second pass is still unstorable and the
// migration has not done its job. A disabled trigger counts as missing.
const TRIGGERS = [
  [SETS, 'pilot_calibration_sets_pass_guard'],
  ['pilot.calibration_adjudications', 'pilot_calibration_adjudications_first_pass_guard'],
];

const READINESS_QUERY = `select ${[
  `exists (select 1 from pg_attribute
      where attrelid = to_regclass(${quote(SETS)}) and attname = 'pass_number'
        and not attisdropped)`,
  constraintExists('pilot_calibration_sets_pass_number_positive'),
  constraintExists('pilot_calibration_sets_one_per_annotator_pass_uq'),
  `not ${constraintExists('pilot_calibration_sets_one_per_annotator_uq')}`,
  ...TRIGGERS.map(([table, name]) => `exists (select 1 from pg_trigger
      where tgrelid = to_regclass(${quote(table)}) and tgname = ${quote(name)}
        and not tgisinternal and tgenabled <> 'D')`),
].map((clause, index) => `${clause} as ready_${index}`).join(', ')}`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('CALIBRATION_REMARK_PASS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_calibration_remark_pass_migration.sql',
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
  console.log('PILOT CALIBRATION REMARK PASS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CALIBRATION REMARK PASS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
