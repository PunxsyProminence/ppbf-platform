import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the clearance-type seeds inside one transaction, with the same
// target-verification discipline as every other pilot:apply-* script: the
// operator must state which host and database they believe they are
// pointing at, and a mismatch refuses before any DDL/DML runs.

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

// Same reasoning as db.ts's resolveSslConfig and every other pilot-apply-*
// script: production/staging always require TLS.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Asserts the OUTCOME -- that no organization is left without any of the
// four defaults -- rather than a row count, matching the compliance-rule-
// seeds runner's own reasoning: a healthy organization's row count is not
// fixed, since a gym may add clearance types of its own.
//
// The disjunction (deterministic id OR name) is what makes this survive a
// gym's edits: a default is accounted for if its id is present (the gym
// renamed it) or its name is present (the gym re-keyed it under an id of its
// own).
const READINESS_QUERY = `
  with defaults(id_prefix, name) as (
    values
      ('ct_safesport_', 'SafeSport Training'),
      ('ct_usaboxing_coach_', 'USA Boxing Coach Certification'),
      ('ct_background_check_', 'Background Check'),
      ('ct_cpr_first_aid_', 'CPR/First Aid')
  ),
  unseeded as (
    select 1
    from pilot.organizations o
    cross join defaults d
    -- The reserved organization owning the platform SHADOW evidence
    -- baseline is a shelf, not a gym: no staff to credential. The seeding
    -- statements skip it, so asserting it is seeded would report this
    -- migration NOT READY forever.
    where o.organization_id <> '__platform__'
      and not exists (
        select 1
        from pilot.clearance_types ct
        where ct.organization_id = o.organization_id
          and (
            ct.clearance_type_id = d.id_prefix || o.organization_id
            or ct.name = d.name
          )
      )
  )
  select
    to_regclass('pilot.clearance_types') is not null as clearance_types_ready,
    not exists (select 1 from unseeded) as default_clearance_types_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CLEARANCE_TYPE_SEEDS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_clearance_type_seeds_migration.sql',
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
  console.log(`Applied clearance type seeds migration: ${migrationPath}`);
  console.log('PILOT CLEARANCE TYPE SEEDS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CLEARANCE TYPE SEEDS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
