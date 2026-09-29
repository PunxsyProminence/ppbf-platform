import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// The census script's copy of waiverCompliance.ts's WAIVER_STATUSES, which
// waiverStatusCensus.pg.test.ts pins equal to the TypeScript list. Imported
// rather than copied a third time: this is a .mjs script and cannot import the
// TypeScript module, and that file is already the pinned .mjs copy.
import { WAIVER_STATUSES } from './pilot-check-waiver-statuses.mjs';

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
// `check_validated` pins convalidated, for the reason the membership-account-fk
// runner gives: a `not valid` constraint enforces new rows while recording that
// the existing ones were never checked, and accepting it would report success
// on a database that may still hold the rows this exists to rule out.
//
// `check_on_status_only` pins the constraint to the status column alone, so a
// same-named CHECK over some other column cannot read as this one.
//
// The vocabulary is checked in assertReadiness below, against the definition
// Postgres reports back. The add is guarded by `if not exists (conname ...)`,
// so a database already carrying a differently-worded constraint by this name
// would keep it and the SQL would report success. This is what refuses that
// database instead.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when the table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.waivers') is not null as table_ready,
    exists (
      select 1
      from pg_constraint c
      where c.conname = 'pilot_waivers_status_check'
        and c.conrelid = to_regclass('pilot.waivers')
        and c.contype = 'c'
    ) as check_present,
    exists (
      select 1
      from pg_constraint c
      where c.conname = 'pilot_waivers_status_check'
        and c.conrelid = to_regclass('pilot.waivers')
        and c.convalidated
    ) as check_validated,
    exists (
      select 1
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attname = 'status'
      where c.conname = 'pilot_waivers_status_check'
        and c.conrelid = to_regclass('pilot.waivers')
        and c.conkey = array[a.attnum]
    ) as check_on_status_only,
    (
      select pg_get_constraintdef(c.oid)
      from pg_constraint c
      where c.conname = 'pilot_waivers_status_check'
        and c.conrelid = to_regclass('pilot.waivers')
    ) as definition
`;

/** Every single-quoted literal in a constraint definition, unescaped. */
export function literalsIn(definition) {
  return [...String(definition ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((match) =>
    match[1].replace(/''/g, "'"),
  );
}

function sameSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertReadiness(row) {
  const { definition, ...flags } = row ?? {};
  if (!row || Object.values(flags).some((value) => value !== true)) {
    throw new Error('WAIVER_STATUS_CHECK_NOT_READY');
  }
  if (!sameSet(literalsIn(definition), WAIVER_STATUSES)) {
    throw new Error(
      `WAIVER_STATUS_CHECK_NOT_READY: pilot_waivers_status_check admits `
      + `[${literalsIn(definition).join(', ')}], expected exactly [${WAIVER_STATUSES.join(', ')}]`,
    );
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
    '../../../infra/azure/pilot_slice_postgres_waiver_status_check_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    // Counted and reported before the ALTER, because a non-exact row is the
    // one thing that makes this migration fail, and the operator should read
    // the number rather than infer it from a 23514 that names no row.
    const nonExact = await client.query(
      `select count(*)::int as non_exact
         from pilot.waivers
        where status <> all($1::text[])`,
      [WAIVER_STATUSES],
    );
    console.log(`non_exact_status_rows: ${nonExact.rows[0]?.non_exact ?? 'unreadable'}`);
    if ((nonExact.rows[0]?.non_exact ?? 0) > 0) {
      console.log(
        'Rows outside the vocabulary will make the ALTER refuse. '
        + 'npm run pilot:check-waiver-statuses lists every one.',
      );
    }
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied waiver status check migration: ${migrationPath}`);
  console.log('PILOT WAIVER STATUS CHECK MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT WAIVER STATUS CHECK MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
