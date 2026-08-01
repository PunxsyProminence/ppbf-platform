// Applies the board role migration.
//
// Unreachable until 2026-08-01. This migration widens the role check constraints
// to admit 'board'; without it, inserting a board account fails the constraint,
// so board members cannot exist in a rebuilt environment.
//
// This migration's SQL opens and closes its own transaction, so this runner
// deliberately does NOT wrap it in one. Issuing BEGIN around a self-transacting
// migration nests the transaction: the migration's own COMMIT ends it, a
// trailing COMMIT here warns that none is in progress, and -- the part that
// matters -- a ROLLBACK after a failed readiness check would silently do
// nothing, because the work is already committed. The readiness assertion below
// is therefore a post-commit verification that fails the run loudly, not a gate
// that can undo it.
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

// Asserts the constraints ADMIT 'board', not merely that constraints by these
// names exist -- the migration drops and recreates them, and a recreation that
// omitted the new role would pass a name-only check while board sign-in stayed
// broken. The literal is matched quoted ('%''board''%') so it cannot match the
// substring of another role or of the column name.
const READINESS_QUERY = `
  select
    exists (
      select 1 from pg_constraint
      where conname = 'accounts_role_check'
        and conrelid = to_regclass('pilot.accounts')
        and pg_get_constraintdef(oid) like '%''board''%'
    ) as accounts_admit_board,
    exists (
      select 1 from pg_constraint
      where conname = 'organization_memberships_role_check'
        and conrelid = to_regclass('pilot.organization_memberships')
        and pg_get_constraintdef(oid) like '%''board''%'
    ) as memberships_admit_board
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('BOARD_ROLE_NOT_READY');
  }
}

export async function applyMigration(client, sql) {
  await client.query(sql);
  const readiness = await client.query(READINESS_QUERY);
  assertReadiness(readiness.rows[0]);
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
    '../../../infra/azure/pilot_slice_postgres_board_role_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await applyMigration(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied board role migration: ${migrationPath}`);
  console.log('PILOT BOARD ROLE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT BOARD ROLE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
