import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the calibration-adjudication-revisions migration inside one
// transaction, with the same target-verification discipline as every other
// pilot:apply-* script: the operator must state which host and database they
// believe they are pointing at, and a mismatch refuses before any DDL runs.

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

// Every clause can go false against a database where this migration has not run.
//
// THE UNIQUE INDEX IS THE ONE THAT MATTERS MOST. Without a lock it is the only
// thing standing between two concurrent administrators and two rows both
// claiming to be revision N of the same disagreement. A table carrying the
// column and the CHECK but not this index looks migrated and arbitrates
// nothing, and the route's 409 translation would never fire because no 23505
// would be raised.
//
// IT IS ASSERTED BY SHAPE, NOT ONLY BY NAME. The migration creates it with
// `if not exists`, which goes by name alone, so an index of that name keyed on
// something else -- the two annotation sets without the source events, which
// numbers unrelated decisions on a clip as corrections of each other, or the
// marks without their nullness, which makes "no mark" the same key as a mark
// whose id is '' -- would be left in place and would pass a name check. The
// clauses below require it to be unique, valid, not partial, nine key parts
// long, and to carry each mark's nullness and value and then the revision, in
// that order. Nothing here matches a CHECK body (issue #488).
//
// THE TRIGGER IS ASSERTED TOO, because it is what keeps the previous image
// writing on this schema: enabled, BEFORE, per ROW, on INSERT (tgtype 7), and
// calling the assign function. Without it the NOT NULL refuses every insert
// that names no revision.
//
// revision_required_and_undefaulted: `is_nullable = 'NO'` is ALSO the backfill
// assertion -- PostgreSQL refuses `set not null` on a column that still
// contains a null, so the constraint existing is proof the backfill completed.
// And no DEFAULT: a constant would be wrong for every disagreement that already
// has an answer.
//
// EVERY CLAUSE READS A CATALOG, NEVER THE TABLE'S DATA, and that is load-bearing
// rather than stylistic. A clause like `where revision is null` cannot report
// false on an unmigrated database: PostgreSQL parses the whole statement before
// running any of it, so the reference to a column that does not exist raises
// `column "revision" does not exist` and the gate throws that instead of
// CALIBRATION_ADJUDICATION_REVISIONS_NOT_READY. to_regclass()/to_regprocedure()
// rather than casts, for the same reason. Caught by
// 'REFUSES a database where the revisions migration never ran'.
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'calibration_adjudications'
        and column_name = 'revision'
        and data_type = 'integer'
    ) as revision_column_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'calibration_adjudications'
        and column_name = 'revision'
        and is_nullable = 'NO'
        and column_default is null
    ) as revision_required_and_undefaulted,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudications')
        and conname = 'pilot_calibration_adjudications_revision_positive'
    ) as revision_positive_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.calibration_adjudications')
        and c.relname = 'pilot_calibration_adjudications_decision_revision_uq'
        and i.indisunique
        and i.indisvalid
        and i.indpred is null
        and i.indnatts = 9
        and pg_get_indexdef(i.indexrelid) like
          '%(organization_id, calibration_clip_id, annotation_set_id_a, annotation_set_id_b, %source_event_id_a IS NULL%, COALESCE(source_event_id_a, %), %source_event_id_b IS NULL%, COALESCE(source_event_id_b, %), revision)'
    ) as decision_revision_arbiter_ready,
    exists (
      select 1 from pg_trigger t
      where t.tgrelid = to_regclass('pilot.calibration_adjudications')
        and t.tgname = 'pilot_calibration_adjudications_assign_revision'
        and not t.tgisinternal
        and t.tgenabled = 'O'
        and t.tgtype = 7
        and t.tgfoid = to_regprocedure('pilot.calibration_adjudications_assign_revision()')
    ) as previous_image_insert_numbered
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CALIBRATION_ADJUDICATION_REVISIONS_NOT_READY');
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

// WHAT THE APPLY WOULD REFUSE, READ WITHOUT APPLYING ANYTHING.
//
// The migration stops when one disagreement holds two existing adjudications
// with the same adjudicated_at, because which of them is current cannot be
// read from the data. On an `all` dispatch that stop also holds back every
// migration listed after this one, so it is worth knowing before dispatching.
//
// Runs inside BEGIN READ ONLY and always rolls back: PostgreSQL itself refuses
// a write in that transaction, so this cannot change a row even by mistake.
//
// The grouping is the migration's own (step 2). On a database where the
// migration is already applied there is nothing left to backfill and the
// answer is 0 by definition; `already_applied` says which case it was. The
// column is looked up first and the count query is chosen from that, because a
// statement naming a column that does not exist fails to parse.
export async function countBackfillTies(client) {
  await client.query('BEGIN READ ONLY');
  try {
    const table = await client.query(
      `select to_regclass('pilot.calibration_adjudications') is not null as present`,
    );
    if (table.rows[0]?.present !== true) {
      throw new Error('CALIBRATION_ADJUDICATIONS_TABLE_MISSING');
    }
    const column = await client.query(
      `select exists (
         select 1 from information_schema.columns
         where table_schema = 'pilot'
           and table_name = 'calibration_adjudications'
           and column_name = 'revision'
       ) as present`,
    );
    const alreadyApplied = column.rows[0]?.present === true;
    const counted = await client.query(
      `select
         (select count(*)::int from pilot.calibration_adjudications) as existing_adjudications,
         (select count(*)::int from (
            select 1
              from pilot.calibration_adjudications
             ${alreadyApplied ? 'where revision is null' : ''}
             group by organization_id, calibration_clip_id,
                      annotation_set_id_a, annotation_set_id_b,
                      source_event_id_a, source_event_id_b,
                      adjudicated_at
            having count(*) > 1
          ) tied) as tied_disagreements`,
    );
    return {
      already_applied: alreadyApplied,
      existing_adjudications: counted.rows[0].existing_adjudications,
      tied_disagreements: counted.rows[0].tied_disagreements,
    };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

export async function run({ preflight = false } = {}) {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const expectedHostname = required('PPBF_EXPECTED_POSTGRES_HOSTNAME');
  const expectedDatabase = required('PPBF_EXPECTED_POSTGRES_DATABASE');

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationPath = path.resolve(
    __dirname,
    '../../../infra/azure/pilot_slice_postgres_calibration_adjudication_revisions_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    if (preflight) {
      const report = await countBackfillTies(client);
      console.log(`target_hostname: ${target.hostname}`);
      console.log(`target_database: ${target.database}`);
      console.log(JSON.stringify({ event: 'calibration_adjudication_revisions.preflight', ...report }));
      console.log(
        report.tied_disagreements === 0
          ? 'PILOT CALIBRATION ADJUDICATION REVISIONS PREFLIGHT PASS (read-only; nothing applied)'
          : 'PILOT CALIBRATION ADJUDICATION REVISIONS PREFLIGHT TIES FOUND (read-only; nothing applied)',
      );
      if (report.tied_disagreements !== 0) process.exitCode = 2;
      return;
    }
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied calibration adjudication revisions migration: ${migrationPath}`);
  console.log('PILOT CALIBRATION ADJUDICATION REVISIONS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run({ preflight: process.argv.includes('--preflight') });
  } catch (error) {
    console.error('PILOT CALIBRATION ADJUDICATION REVISIONS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
