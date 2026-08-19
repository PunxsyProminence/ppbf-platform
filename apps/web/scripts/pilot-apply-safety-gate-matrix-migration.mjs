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

// Asserts the OUTCOME -- every organization has the contact_medical_clearance
// gate -- rather than a row count, matching compliance-rule-seeds' reasoning:
// a gym may hold gates of its own beyond the one default. The disjunction
// (deterministic gate_id OR gate_key) survives a gym renaming the row.
const READINESS_QUERY = `
  -- Every gate this migration seeds, not just the first one. The tables and
  -- indexes below are all declared by the base schema (pilot_slice_postgres.sql)
  -- too, so the ONLY thing this migration contributes beyond the base schema is
  -- these seed rows -- which makes them the only thing worth asserting. Listing
  -- one of the two let a database seeded by the earlier revision of this
  -- migration (which shipped contact_medical_clearance alone) report READY while
  -- missing the gate that BLOCKS registration for an athlete under a training
  -- hold. src/server/pilot/safetyGateSeeds.ts holds the same two in
  -- DEFAULT_SAFETY_GATES for organizations created after a dispatch, and
  -- safetyGateSeedsOwnership.test.ts fails the build if the two lists diverge.
  --
  -- Keyed on gate_key ONLY -- never on name, enforcement, or active_flag. A gym
  -- may rename a gate or switch it off through the admin surface, and the
  -- migration's own seed guard is a not-exists on gate_key alone, so it
  -- would never repair an edited row. Asserting an editable field would strand
  -- the dispatch on a state no re-apply can reach.
  with expected_gate(gate_key) as (
    values ('contact_medical_clearance'), ('training_hold')
  ),
  unseeded as (
    select 1
    from pilot.organizations o
    cross join expected_gate e
    -- The reserved organization owning the platform SHADOW evidence baseline is
    -- a shelf, not a gym: no accounts, no athletes, nobody to clear for contact.
    -- The seeding statements skip it, so asserting it is seeded would report
    -- this migration NOT READY forever.
    where o.organization_id <> '__platform__'
      and not exists (
      select 1
      from pilot.safety_gates g
      where g.organization_id = o.organization_id
        and (
          g.gate_id = 'gate_' || o.organization_id || '_' || e.gate_key
          or g.gate_key = e.gate_key
        )
    )
  )
  select
    to_regclass('pilot.safety_gates') is not null as safety_gates_ready,
    to_regclass('pilot.safety_gate_evaluations') is not null as safety_gate_evaluations_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.safety_gates')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%''block''%'
        and pg_get_constraintdef(oid) like '%''flag''%'
    ) as enforcement_vocabulary_ready,
    not exists (select 1 from unseeded) as default_gates_seeded
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SAFETY_GATE_MATRIX_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_safety_gate_matrix_migration.sql',
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
  console.log(`Applied safety gate matrix migration: ${migrationPath}`);
  console.log('PILOT SAFETY GATE MATRIX MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SAFETY GATE MATRIX MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
