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

// Asserts the properties the migration exists for, not merely that a
// constraint by that name appeared.
//
// `fk_cascades` pins confdeltype = 'c'. The delete action is the entire point:
// a foreign key here that merely RESTRICTED would turn the missing-cascade
// problem into a blocked-purge problem, which is the defect this schema has
// already been bitten by on pilot.parents. NO ACTION would read as "migrated"
// while making retention worse.
//
// `fk_validated` pins convalidated. A `not valid` constraint enforces the rule
// for new rows while recording that the existing ones were never checked, and
// a readiness query that accepted it would report success on a database still
// holding orphans.
//
// THERE IS DELIBERATELY NO `no_orphans` ASSERTION HERE. An earlier draft had
// one, and it could not fail: a VALIDATED CASCADE foreign key onto
// pilot.accounts guarantees no orphan rows, so the check could only ever agree
// with the two assertions above it. An assertion that cannot fail is not a
// guard, it is decoration that later readers mistake for coverage. The orphan
// count is still MEASURED and logged before the ALTER, where it is real
// diagnostics -- an orphan is the one thing that makes this migration fail,
// and the operator should read the number rather than infer it from a 23503.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// row is evaluated when the table is absent, which would report an unmigrated
// database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.organization_memberships') is not null as table_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_organization_memberships_account_fk'
        and conrelid = to_regclass('pilot.organization_memberships')
        and contype = 'f'
        and confrelid = to_regclass('pilot.accounts')
    ) as fk_present,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_organization_memberships_account_fk'
        and conrelid = to_regclass('pilot.organization_memberships')
        and confdeltype = 'c'
    ) as fk_cascades,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_organization_memberships_account_fk'
        and conrelid = to_regclass('pilot.organization_memberships')
        and convalidated
    ) as fk_validated
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('MEMBERSHIP_ACCOUNT_FK_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_membership_account_fk_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    // Counted and reported before the ALTER, because an orphan is the one
    // thing that makes this migration fail, and the operator should read the
    // number rather than infer it from a 23503.
    const orphans = await client.query(
      `select count(*)::int as orphans
         from pilot.organization_memberships m
         left join pilot.accounts a on a.account_id = m.account_id
        where a.account_id is null`,
    );
    console.log(`orphan_membership_rows: ${orphans.rows[0]?.orphans ?? 'unreadable'}`);
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied membership account foreign-key migration: ${migrationPath}`);
  console.log('PILOT MEMBERSHIP ACCOUNT FK MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT MEMBERSHIP ACCOUNT FK MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
