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

// Asserts the OUTCOME -- that no organization is left without any of the five
// defaults -- rather than a row count, because the row count a healthy
// organization carries is not fixed: a gym may add rules of its own.
//
// The disjunction is what makes this survive a gym's edits. A default is
// accounted for if its deterministic rule_id is present (the gym renamed the
// rule) OR its rule_name is present (the gym rewrote it under a rule_id of its
// own). Requiring both would fail an organization that legitimately edited a
// rule, and requiring only rule_name would fail one that renamed it.
const READINESS_QUERY = `
  with defaults(rule_id_prefix, rule_id_suffix, rule_name) as (
    values
      ('rule_safety_', '_physical_injury', 'Physical Injury Prevention'),
      ('rule_technique_', '_form_standards', 'Proper Technique & Form'),
      ('rule_protocol_', '_attendance', 'Training Protocol Compliance'),
      ('rule_medical_', '_clearance', 'Medical Clearance Status'),
      ('rule_behavioral_', '_conduct', 'Code of Conduct')
  ),
  unseeded as (
    select 1
    from pilot.organizations o
    cross join defaults d
    -- The reserved organization owning the platform SHADOW evidence baseline is
    -- a shelf, not a gym: no accounts, no athletes, no conduct to police. The
    -- seeding statements skip it, so asserting it is seeded would report this
    -- migration NOT READY forever.
    where o.organization_id <> '__platform__'
      and not exists (
      select 1
      from pilot.compliance_rules r
      where r.organization_id = o.organization_id
        and (
          r.rule_id = d.rule_id_prefix || o.organization_id || d.rule_id_suffix
          or r.rule_name = d.rule_name
        )
    )
  )
  select
    to_regclass('pilot.compliance_rules') is not null as compliance_rules_ready,
    not exists (select 1 from unseeded) as default_rules_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('COMPLIANCE_RULE_SEEDS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_compliance_rule_seeds_migration.sql',
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
  console.log(`Applied compliance rule seeds migration: ${migrationPath}`);
  console.log('PILOT COMPLIANCE RULE SEEDS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT COMPLIANCE RULE SEEDS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
