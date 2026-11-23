import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the pain report review migration (DR-25: the athlete's note on a
// pain report, and the coach's "Mark reviewed") inside one transaction. The
// operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting. Run only by the apply-migrations workflow in a release.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt, each piece looked up ON
// pilot.shadow_near_misses so a same-named object elsewhere does not pass.
// The table first, by itself: it comes from the shadow-decision-loop
// migration, and when it is missing the operator is told that, not that a
// column is missing. Then each column by type, nullability and default (all
// four nullable with no default: the admin-only verdict fails closed); each
// check, validated, compared IN FULL against the text Postgres stores for this
// migration's own check; and the foreign key by shape (column, target table
// and column, ON DELETE SET NULL, ON UPDATE NO ACTION, not deferrable). Each
// is refused on its own (painReportReviewMigration.pg.test.ts).
// A JavaScript string, so the escaped tab, carriage return and line feed below are the
// real characters Postgres prints back.
const EXPECTED_NOTE_CHECK = "CHECK (((athlete_note IS NULL) OR (((char_length(athlete_note) >= 1) AND (char_length(athlete_note) <= 500)) AND (athlete_note = btrim(athlete_note, ' \t\r\n'::text)))))";
const EXPECTED_ADMIN_ONLY_CHECK = 'CHECK (((athlete_note IS NULL) = (athlete_note_admin_only IS NULL)))';
const EXPECTED_REVIEWED_CHECK = 'CHECK (((reviewed_by_account_id IS NULL) OR (reviewed_at IS NOT NULL)))';

const READINESS_QUERY = `
  with t as (select to_regclass('pilot.shadow_near_misses') as oid),
  col as (
    select a.attname, a.atttypid, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as default_text
      from pg_attribute a
      join t on a.attrelid = t.oid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where not a.attisdropped
  )
  select
    exists (select 1 from col where attname = 'athlete_note'
              and atttypid = 'text'::regtype and not attnotnull and default_text is null) as athlete_note_ready,
    exists (select 1 from col where attname = 'athlete_note_admin_only'
              and atttypid = 'boolean'::regtype and not attnotnull and default_text is null) as athlete_note_admin_only_ready,
    exists (select 1 from col where attname = 'reviewed_by_account_id'
              and atttypid = 'text'::regtype and not attnotnull and default_text is null) as reviewed_by_account_id_ready,
    exists (select 1 from col where attname = 'reviewed_at'
              and atttypid = 'timestamptz'::regtype and not attnotnull and default_text is null) as reviewed_at_ready,
    exists (
      select 1 from pg_constraint c, t
       where c.conrelid = t.oid and c.conname = 'pilot_shadow_near_misses_athlete_note_check'
         and c.contype = 'c' and c.convalidated and pg_get_constraintdef(c.oid) = $1
    ) as note_check_ready,
    exists (
      select 1 from pg_constraint c, t
       where c.conrelid = t.oid and c.conname = 'pilot_shadow_near_misses_athlete_note_admin_only_check'
         and c.contype = 'c' and c.convalidated and pg_get_constraintdef(c.oid) = $2
    ) as admin_only_check_ready,
    exists (
      select 1 from pg_constraint c, t
       where c.conrelid = t.oid and c.conname = 'pilot_shadow_near_misses_reviewed_check'
         and c.contype = 'c' and c.convalidated and pg_get_constraintdef(c.oid) = $3
    ) as reviewed_check_ready,
    exists (
      select 1 from pg_constraint c, t
       where c.conrelid = t.oid and c.conname = 'pilot_shadow_near_misses_reviewed_by_fk'
         and c.contype = 'f' and c.convalidated
         and c.confrelid = to_regclass('pilot.accounts')
         and c.confdeltype = 'n' and c.confupdtype = 'a' and not c.condeferrable
         and c.conkey = array[(select attnum from pg_attribute where attrelid = t.oid and attname = 'reviewed_by_account_id')]::int2[]
         and c.confkey = array[(select attnum from pg_attribute where attrelid = to_regclass('pilot.accounts') and attname = 'account_id')]::int2[]
    ) as reviewed_by_fk_ready
`;

// Runs before the file, so a database without pilot.shadow_near_misses is
// refused by name instead of failing on the ALTER with a bare "relation does
// not exist".
const TABLE_QUERY = `select to_regclass('pilot.shadow_near_misses') is not null as table_ready`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    const table = await client.query(TABLE_QUERY);
    if (table.rows[0]?.table_ready !== true) {
      throw new Error('PAIN_REPORT_REVIEW_NOT_READY: table_ready (pilot.shadow_near_misses is missing; apply shadow-decision-loop first)');
    }
    // The columns, the checks and the foreign key take brief locks on
    // pilot.shadow_near_misses (exclusive) and pilot.accounts (share row
    // exclusive: reads go on, writes wait). Rather than queue behind a long
    // transaction already holding one, give up and let the operator re-run in
    // a quieter moment. Nothing is half-applied: it is one transaction.
    //
    // pilot.accounts is locked FIRST, the order the nightly purge's account
    // branch takes them (an account delete cascades into shadow_near_misses
    // through detected_by_account_id). Its athlete branch takes the opposite
    // order (the athlete delete cascades into shadow_near_misses, then it
    // updates pilot.accounts), so no single order avoids every deadlock with a
    // purge running at the same moment. Either way Postgres aborts one side
    // cleanly: this transaction rolls back whole and is re-run, or the purge's
    // savepoint for that athlete rolls back and it is purged on the next run
    // (PR 1 reviewer A).
    await client.query("set local lock_timeout = '10s'");
    await client.query('lock table pilot.accounts in share row exclusive mode');
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, [
      EXPECTED_NOTE_CHECK, EXPECTED_ADMIN_ONLY_CHECK, EXPECTED_REVIEWED_CHECK,
    ]);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`PAIN_REPORT_REVIEW_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_pain_report_review_migration.sql',
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
  console.log(`Applied pain report review migration: ${migrationPath}`);
  console.log('PILOT PAIN REPORT REVIEW MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT PAIN REPORT REVIEW MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
