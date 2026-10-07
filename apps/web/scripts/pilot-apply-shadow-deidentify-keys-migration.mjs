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
// it at the first statement; a missing deidentified_at would fail the stamp.
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
        and pg_get_constraintdef(c.oid) like 'FOREIGN KEY (account_id) REFERENCES pilot.accounts(account_id)%') as account_keys_left,
    (select count(*)::int from pg_constraint c
      where c.contype = 'f'
        and c.conrelid in (
          to_regclass('pilot.shadow_chat_sessions'), to_regclass('pilot.shadow_evidence_bundles'),
          to_regclass('pilot.shadow_decisions'), to_regclass('pilot.shadow_recommendations'),
          to_regclass('pilot.shadow_film_study_proposals'))
        and c.confrelid = to_regclass('pilot.athletes')) as athlete_keys_left,
    (select count(*)::int from pg_constraint c
      where c.contype = 'f' and c.condeferrable and not c.condeferred
        and c.conname in (
          'pilot_shadow_evidence_items_bundle_fk', 'pilot_shadow_evidence_claims_message_fk',
          'pilot_shadow_evidence_claims_bundle_fk', 'pilot_shadow_message_citations_message_fk',
          'pilot_shadow_message_citations_item_fk', 'pilot_shadow_message_citations_bundle_fk')) as deferrable_keys,
    (select count(*)::int from information_schema.columns
      where table_schema = 'pilot' and column_name = 'deidentified_at'
        and table_name in ('shadow_chat_sessions', 'shadow_human_review_queue')) as stamp_columns
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const ready = (await client.query(READINESS_QUERY)).rows[0];
    if (!ready || ready.account_keys_left !== 0 || ready.athlete_keys_left !== 0
      || ready.deferrable_keys !== 6 || ready.stamp_columns !== 2) {
      throw new Error(
        `SHADOW_DEIDENTIFY_KEYS_NOT_READY: account_keys_left=${ready?.account_keys_left} athlete_keys_left=${ready?.athlete_keys_left} deferrable_keys=${ready?.deferrable_keys} stamp_columns=${ready?.stamp_columns}`,
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
