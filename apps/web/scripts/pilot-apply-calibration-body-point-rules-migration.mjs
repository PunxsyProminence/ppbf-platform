import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the calibration-body-point-rules migration inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Every object below is created by this migration and absent from a database
// it has not reached, so readiness goes false there
// (calibrationBodyPointRules.pg.test.ts, "refuses a database the migration has
// not reached").
// Asserted BY NAME, never by pg_get_constraintdef text: Postgres deparses a
// CHECK rather than echoing its source (issue #488). The three triggers hold
// what the constraints cannot (the stance labels' freeze and 0.2 gate, the
// 0.2 event rules, completeness at submission); a disabled one counts as
// missing.
const CONSTRAINTS = [
  ['pilot.calibration_event_stance_labels', 'pilot_calibration_event_stance_labels_org_fk'],
  ['pilot.calibration_event_stance_labels', 'pilot_calibration_event_stance_labels_pkey'],
  ['pilot.calibration_event_stance_labels', 'pilot_calibration_event_stance_labels_stance_type_vocab'],
  ['pilot.calibration_event_stance_labels', 'pilot_calibration_event_stance_labels_event_fk'],
];
const TRIGGERS = [
  ['pilot.calibration_event_stance_labels', 'pilot_calibration_event_stance_labels_guard'],
  ['pilot.calibration_annotation_events', 'pilot_calibration_events_body_point_rules'],
  ['pilot.calibration_annotation_sets', 'pilot_calibration_sets_body_point_rules'],
];
const INDEXES = ['idx_calibration_event_stance_labels_set'];

const quote = (value) => `'${value}'`;
const READINESS_QUERY = `select ${[
  `to_regclass('pilot.calibration_event_stance_labels') is not null`,
  ...CONSTRAINTS.map(([table, name]) => `exists (select 1 from pg_constraint
      where conrelid = to_regclass(${quote(table)}) and conname = ${quote(name)})`),
  ...TRIGGERS.map(([table, name]) => `exists (select 1 from pg_trigger
      where tgrelid = to_regclass(${quote(table)}) and tgname = ${quote(name)}
        and not tgisinternal and tgenabled <> 'D')`),
  ...INDEXES.map((name) => `exists (select 1 from pg_indexes
      where schemaname = 'pilot' and indexname = ${quote(name)})`),
].map((clause, index) => `${clause} as ready_${index}`).join(', ')}`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('CALIBRATION_BODY_POINT_RULES_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_calibration_body_point_rules_migration.sql',
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
  console.log('PILOT CALIBRATION BODY POINT RULES MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CALIBRATION BODY POINT RULES MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
