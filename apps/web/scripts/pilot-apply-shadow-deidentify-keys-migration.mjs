import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the shadow-deidentify-keys migration inside one transaction. The
// operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// The postcondition, not the statement. A remaining account or athlete key on
// the de-identified tables would make the purge's token update fail (23503)
// for every person; a composite evidence key left non-deferrable would fail
// it at the first statement; a missing column would fail the stamp; a missing,
// disabled, replica-only or wrongly timed trigger would let a delete that has
// not de-identified leave identified rows behind; a missing check would let a
// half-written purge report a row de-identified.
//
// The account keys are matched by their column (conkey = the attnum of
// account_id), never by the text of pg_get_constraintdef: that text drops
// the `pilot.` qualifier when pilot is on the connecting role's search_path,
// and a text match would then count 0 with every cascade still in place --
// a false PASS on an unmigrated database.
export const READINESS_QUERY = `
  select
    (select count(*)::int from pg_constraint c
      where c.contype = 'f'
        and c.conrelid in (
          to_regclass('pilot.shadow_chat_sessions'), to_regclass('pilot.shadow_chat_messages'),
          to_regclass('pilot.shadow_evidence_bundles'), to_regclass('pilot.shadow_learning_events'),
          to_regclass('pilot.shadow_recommendation_effectiveness'), to_regclass('pilot.shadow_human_review_queue'),
          to_regclass('pilot.shadow_data_deletion_requests'))
        and c.confrelid = to_regclass('pilot.accounts')
        and exists (
              select 1 from pg_attribute a
               where a.attrelid = c.conrelid and a.attname = 'account_id'
                 and a.attnum = any(c.conkey))) as account_keys_left,
    (select count(*)::int from pg_constraint c
      where c.contype = 'f'
        and c.conrelid in (
          to_regclass('pilot.shadow_chat_sessions'), to_regclass('pilot.shadow_evidence_bundles'),
          to_regclass('pilot.shadow_decisions'), to_regclass('pilot.shadow_recommendations'),
          to_regclass('pilot.shadow_film_study_proposals'))
        and c.confrelid = to_regclass('pilot.athletes')) as athlete_keys_left,
    (select count(*)::int from pg_constraint c
      where c.contype = 'f' and c.condeferrable and not c.condeferred and c.convalidated
        and c.conrelid in (
          to_regclass('pilot.shadow_evidence_items'), to_regclass('pilot.shadow_evidence_claims'),
          to_regclass('pilot.shadow_message_citations'))
        and c.confrelid in (
          to_regclass('pilot.shadow_evidence_bundles'), to_regclass('pilot.shadow_evidence_items'),
          to_regclass('pilot.shadow_chat_messages'))
        and c.conname in (
          'pilot_shadow_evidence_items_bundle_fk', 'pilot_shadow_evidence_claims_message_fk',
          'pilot_shadow_evidence_claims_bundle_fk', 'pilot_shadow_message_citations_message_fk',
          'pilot_shadow_message_citations_item_fk', 'pilot_shadow_message_citations_bundle_fk')) as deferrable_keys,
    (select count(*)::int from information_schema.columns
      where table_schema = 'pilot' and column_name in ('deidentified_at', 'subject_deleted_at')
        and data_type = 'timestamp with time zone'
        and table_name in ('shadow_chat_sessions', 'shadow_human_review_queue')) as purge_columns,
    (select count(*)::int from pg_constraint c
      where c.contype = 'c' and c.convalidated
        and c.conname in ('pilot_shadow_chat_sessions_deidentified_check', 'pilot_shadow_human_review_queue_deidentified_check')) as stamp_checks,
    (select count(*)::int from pg_trigger t
      where not t.tgisinternal
        and t.tgenabled in ('O', 'A')
        and t.tgtype = 11 /* ROW (1) + BEFORE (2) + DELETE (8) */
        and ((t.tgname = 'pilot_shadow_rows_follow_account' and t.tgrelid = to_regclass('pilot.accounts'))
          or (t.tgname = 'pilot_shadow_rows_follow_athlete' and t.tgrelid = to_regclass('pilot.athletes')))) as cascade_triggers
`;

export const READY = Object.freeze({
  account_keys_left: 0,
  athlete_keys_left: 0,
  deferrable_keys: 6,
  purge_columns: 4,
  stamp_checks: 2,
  cascade_triggers: 2,
});

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // The migration locks every table it touches in one statement first;
    // rather than queue sign-in behind a long reader, give up and let the
    // operator re-run in a quieter moment.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const ready = (await client.query(READINESS_QUERY)).rows[0];
    const unmet = Object.keys(READY).filter((key) => ready?.[key] !== READY[key]);
    if (!ready || unmet.length > 0) {
      throw new Error(
        `SHADOW_DEIDENTIFY_KEYS_NOT_READY: ${Object.keys(READY).map((key) => `${key}=${ready?.[key]}`).join(' ')}`,
      );
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
    '../../../infra/azure/pilot_slice_postgres_shadow_deidentify_keys_migration.sql',
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
  console.log('PILOT SHADOW DEIDENTIFY KEYS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SHADOW DEIDENTIFY KEYS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
