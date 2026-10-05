import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the intake-case-primary-athlete backfill inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// The backfill's postcondition, not its shape: every case whose documents name
// exactly one athlete has that athlete in its column. A migration that updated
// nothing (a wrong owner_entity_type, a dropped join clause) leaves a NULL
// behind, and one that wrote the wrong value leaves a mismatch; both are
// refused (intakeCasePrimaryAthlete.pg.test.ts). This stays true after the
// release: promotion writes the case and its documents together.
const LEFT_BEHIND_QUERY = `
  select count(*)::int as left_behind
  from pilot.intake_cases c
  join (
    select organization_id, intake_case_id, min(owner_entity_id) as athlete_id
    from pilot.intake_documents
    where owner_entity_type = 'athlete'
      and owner_entity_id is not null
    group by organization_id, intake_case_id
    having count(distinct owner_entity_id) = 1
  ) s
    on s.organization_id = c.organization_id
   and s.intake_case_id = c.intake_case_id
  where c.primary_athlete_id is distinct from s.athlete_id
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // A promotion by the code still running mid-deploy writes the documents'
    // owner and not the column. Holding this lock until COMMIT makes it wait,
    // so the check below cannot see it half-done and refuse the run. It
    // conflicts with row writes on intake_cases only; reads are unaffected.
    await client.query('lock table pilot.intake_cases in share row exclusive mode');
    const result = await client.query(sql);
    const leftBehind = (await client.query(LEFT_BEHIND_QUERY)).rows[0]?.left_behind;
    if (leftBehind !== 0) {
      throw new Error(`INTAKE_CASE_PRIMARY_ATHLETE_NOT_READY: ${leftBehind ?? 'unreadable'} case(s) with one athlete owner and no matching primary_athlete_id`);
    }
    await client.query('COMMIT');
    return { casesUpdated: result.rowCount ?? 0 };
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
    '../../../infra/azure/pilot_slice_postgres_intake_case_primary_athlete_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({ connectionString, ssl: sslConfig() });
  let outcome;
  await client.connect();
  try {
    outcome = await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`intake_cases_backfilled: ${outcome.casesUpdated}`);
  console.log('PILOT INTAKE CASE PRIMARY ATHLETE MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT INTAKE CASE PRIMARY ATHLETE MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
