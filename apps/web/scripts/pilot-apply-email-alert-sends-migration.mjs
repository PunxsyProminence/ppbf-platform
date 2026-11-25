import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the email-alert-sends migration (lane W4-1, EM-3; the send log and
// the sweep's checkpoints for the content-free email alert, OD-2026-11-19-019,
// OW27-03 B, Q1.10) inside one transaction. The operator names the host and
// database they believe they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME
// / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Asserts, for both tables: an ordinary logged table with no user trigger, no
// rule, no row security and no inheritance (any of these could swallow or lose
// rows without an error).
//
// For pilot.email_alert_sends: the exact column list with each column's type,
// nullability, default and identity (so a new row starts queued, with no
// tries, due now); exactly the CHECKs below and no others, each compared IN
// FULL against the text Postgres stores, which says NOT VALID for a CHECK not
// validated (emailAlertSendsMigration.pg.test.ts drives this runner against a
// real database); the primary key, not deferrable; the one-row-per-event key
// by name and column order, not deferrable (ON CONFLICT refuses a deferrable
// key); exactly three foreign keys (gym, account, and the person's membership
// of that gym), each by column, target, cascade and the default update rule,
// none deferrable; and every index on the table by full definition, which also
// refuses any other unique key (each has an index).
//
// For pilot.email_alert_checkpoints: its columns, its one CHECK, its primary
// key (not deferrable: the sweep upserts on it) and its only index.
export const EXPECTED_SEND_CHECKS = {
  pilot_email_alert_send_user_type_check:
    "CHECK ((user_type = ANY (ARRAY['staff'::text, 'parent'::text, 'adult_athlete'::text])))",
  pilot_email_alert_send_kind_check:
    "CHECK ((event_kind ~ '^[a-z][a-z_]{0,62}$'::text))",
  pilot_email_alert_send_event_id_check:
    "CHECK ((event_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))",
  pilot_email_alert_send_status_check:
    "CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'skipped'::text, 'failed'::text])))",
  pilot_email_alert_send_tries_check:
    'CHECK (((tries >= 0) AND (tries <= 5)))',
  pilot_email_alert_send_skip_reason_check:
    "CHECK ((skip_reason = ANY (ARRAY['switched_off'::text, 'gym_unticked'::text, 'sign_in_off'::text, 'not_offered'::text, 'no_address'::text])))",
  pilot_email_alert_send_status_code_check:
    'CHECK (((last_status_code >= 100) AND (last_status_code <= 599)))',
  pilot_email_alert_send_error_code_check:
    "CHECK ((last_error_code ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'::text))",
  pilot_email_alert_send_lease_check:
    "CHECK ((((status = 'sending'::text) = (lease_token IS NOT NULL)) AND ((lease_token IS NULL) = (lease_expires_at IS NULL))))",
  pilot_email_alert_send_finished_check:
    "CHECK (((status = ANY (ARRAY['sent'::text, 'skipped'::text, 'failed'::text])) = (finished_at IS NOT NULL)))",
  pilot_email_alert_send_skipped_check:
    "CHECK (((status = 'skipped'::text) = (skip_reason IS NOT NULL)))",
  pilot_email_alert_send_queued_tries_check:
    "CHECK (((status <> 'queued'::text) OR (tries < 5)))",
};

export const EXPECTED_CHECKPOINT_CHECKS = {
  pilot_email_alert_checkpoint_kind_check:
    "CHECK ((event_kind ~ '^[a-z][a-z_]{0,62}$'::text))",
};

// name|type|nullable|default|identity, in column order ('a' = generated always).
export const EXPECTED_SEND_COLUMNS = [
  'send_id|bigint|NO||a',
  'organization_id|text|NO||',
  'account_id|text|NO||',
  'user_type|text|NO||',
  'event_kind|text|NO||',
  'event_id|text|NO||',
  "status|text|NO|'queued'::text|",
  'tries|integer|NO|0|',
  'next_try_at|timestamp with time zone|NO|clock_timestamp()|',
  'lease_token|uuid|YES||',
  'lease_expires_at|timestamp with time zone|YES||',
  'skip_reason|text|YES||',
  'last_status_code|integer|YES||',
  'last_error_code|text|YES||',
  'created_at|timestamp with time zone|NO|clock_timestamp()|',
  'finished_at|timestamp with time zone|YES||',
];

export const EXPECTED_CHECKPOINT_COLUMNS = [
  'event_kind|text|NO||',
  'swept_to|timestamp with time zone|NO||',
  'updated_at|timestamp with time zone|NO|clock_timestamp()|',
];

// Every index on each table, ordered by name.
export const EXPECTED_SEND_INDEXES = [
  'CREATE UNIQUE INDEX email_alert_sends_pkey ON pilot.email_alert_sends USING btree (send_id)',
  "CREATE INDEX idx_email_alert_sends_leased ON pilot.email_alert_sends USING btree (lease_expires_at) WHERE (status = 'sending'::text)",
  "CREATE INDEX idx_email_alert_sends_queued ON pilot.email_alert_sends USING btree (next_try_at) WHERE (status = 'queued'::text)",
  'CREATE UNIQUE INDEX pilot_email_alert_send_once_key ON pilot.email_alert_sends USING btree (organization_id, account_id, event_kind, event_id)',
];

export const EXPECTED_CHECKPOINT_INDEXES = [
  'CREATE UNIQUE INDEX email_alert_checkpoints_pkey ON pilot.email_alert_checkpoints USING btree (event_kind)',
];

const SENDS = `to_regclass('pilot.email_alert_sends')`;
const CHECKPOINTS = `to_regclass('pilot.email_alert_checkpoints')`;

function columnsOf(rel) {
  return `(
      select array_agg(a.attname::text || '|' || format_type(a.atttypid, a.atttypmod)
                       || '|' || case when a.attnotnull then 'NO' else 'YES' end
                       || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
                       || '|' || a.attidentity::text order by a.attnum)
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = ${rel} and a.attnum > 0 and not a.attisdropped
    )`;
}

function indexesOf(table) {
  return `(
      select array_agg(indexdef::text order by indexname collate "C") from pg_indexes
      where schemaname = 'pilot' and tablename = '${table}'
    )`;
}

function keyColumns(side) {
  const [keys, relid] = side === 'local' ? ['c.conkey', 'c.conrelid'] : ['c.confkey', 'c.confrelid'];
  return `(select array_agg(a.attname::text order by k.ord)
             from unnest(${keys}) with ordinality k(attnum, ord)
             join pg_attribute a on a.attrelid = ${relid} and a.attnum = k.attnum)`;
}

function checksReady(rel, countParam, namesParam, defsParam) {
  return `(
      select count(*) = ${countParam} from pg_constraint c
      join unnest(${namesParam}::text[], ${defsParam}::text[]) as expected(conname, condef) on expected.conname = c.conname
      where c.conrelid = ${rel} and c.contype = 'c'
        and pg_get_constraintdef(c.oid) = expected.condef
    ) and (
      select count(*) = ${countParam} from pg_constraint c where c.conrelid = ${rel} and c.contype = 'c'
    )`;
}

function plainTable(rel) {
  return `coalesce((
      select c.relkind = 'r' and c.relpersistence = 'p' and not c.relrowsecurity
        and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal)
        and not exists (select 1 from pg_rewrite r where r.ev_class = c.oid)
        and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid or i.inhparent = c.oid)
      from pg_class c where c.oid = ${rel}
    ), false)`;
}

function sendKeyReady(name, columns, target) {
  return `exists (
      select 1 from pg_constraint c
      where c.conrelid = ${SENDS} and c.contype = 'f' and c.conname = '${name}' and c.convalidated
        and not c.condeferrable and c.confrelid = to_regclass('${target}') and c.confdeltype = 'c'
        and c.confupdtype = 'a'
        and ${keyColumns('local')} = array[${columns}]
        and ${keyColumns('referenced')} = array[${columns}]
    )`;
}

const READINESS_QUERY = `
  select
    ${SENDS} is not null as sends_table_ready,
    ${plainTable(SENDS)} as sends_table_plain,
    ${columnsOf(SENDS)} = $1::text[] as send_columns_ready,
    ${checksReady(SENDS, '$2', '$3', '$4')} as send_checks_ready,
    exists (
      select 1 from pg_constraint c
      where c.conrelid = ${SENDS} and c.contype = 'p' and not c.condeferrable
        and ${keyColumns('local')} = array['send_id']
    ) as send_primary_key_ready,
    exists (
      select 1 from pg_constraint c
      where c.conrelid = ${SENDS} and c.contype = 'u' and c.conname = 'pilot_email_alert_send_once_key'
        and not c.condeferrable
        and ${keyColumns('local')} = array['organization_id', 'account_id', 'event_kind', 'event_id']
    ) as send_once_key_ready,
    ${sendKeyReady('email_alert_sends_organization_id_fkey', "'organization_id'", 'pilot.organizations')} as send_organization_fk_ready,
    ${sendKeyReady('email_alert_sends_account_id_fkey', "'account_id'", 'pilot.accounts')} as send_account_fk_ready,
    ${sendKeyReady('pilot_email_alert_send_membership_fk', "'account_id', 'organization_id'", 'pilot.organization_memberships')} as send_membership_fk_ready,
    (
      select count(*) = 3 from pg_constraint c where c.conrelid = ${SENDS} and c.contype = 'f'
    ) as send_no_other_keys,
    ${indexesOf('email_alert_sends')} = $5::text[] as send_indexes_ready,
    ${CHECKPOINTS} is not null as checkpoints_table_ready,
    ${plainTable(CHECKPOINTS)} as checkpoints_table_plain,
    ${columnsOf(CHECKPOINTS)} = $6::text[] as checkpoint_columns_ready,
    ${checksReady(CHECKPOINTS, '$7', '$8', '$9')} as checkpoint_checks_ready,
    exists (
      select 1 from pg_constraint c
      where c.conrelid = ${CHECKPOINTS} and c.contype = 'p' and not c.condeferrable
        and ${keyColumns('local')} = array['event_kind']
    ) as checkpoint_primary_key_ready,
    ${indexesOf('email_alert_checkpoints')} = $10::text[] as checkpoint_indexes_ready
`;
const READINESS_PARAMS = [
  EXPECTED_SEND_COLUMNS,
  Object.keys(EXPECTED_SEND_CHECKS).length,
  Object.keys(EXPECTED_SEND_CHECKS),
  Object.values(EXPECTED_SEND_CHECKS),
  EXPECTED_SEND_INDEXES,
  EXPECTED_CHECKPOINT_COLUMNS,
  Object.keys(EXPECTED_CHECKPOINT_CHECKS).length,
  Object.keys(EXPECTED_CHECKPOINT_CHECKS),
  Object.values(EXPECTED_CHECKPOINT_CHECKS),
  EXPECTED_CHECKPOINT_INDEXES,
];

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, READINESS_PARAMS);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('EMAIL_ALERT_SENDS_TABLES_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_email_alert_sends_migration.sql',
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
  console.log(`Applied email alert sends migration: ${migrationPath}`);
  console.log('PILOT EMAIL ALERT SENDS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT EMAIL ALERT SENDS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
