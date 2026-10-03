import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the calibration-body-point-rules migration inside one transaction, with
// the same target-verification discipline as every other pilot:apply-* script: the
// operator must state which host and database they believe they are
// pointing at, and a mismatch refuses before any DDL runs.

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

// Every object below is absent from a database where this migration has not
// run, so readiness can go false there (migrationReadinessGates.pg.test.ts).
//
// Asserted BY NAME out of pg_constraint, pg_trigger and pg_indexes, never by
// pg_get_constraintdef text: Postgres deparses a CHECK rather than echoing
// its source (issue #488).
//
// THE THREE TRIGGERS ARE ASSERTED because they hold what the constraints
// cannot: the freeze and 0.2-only gate on stance labels, the 0.2 rules on the
// event row, and the completeness check at submission. A trigger present but
// disabled counts as missing.
const CONSTRAINTS = [
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

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CALIBRATION_BODY_POINT_RULES_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_calibration_body_point_rules_migration.sql',
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
  console.log(`Applied calibration body point rules migration: ${migrationPath}`);
  console.log('PILOT CALIBRATION BODY POINT RULES MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CALIBRATION BODY POINT RULES MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
