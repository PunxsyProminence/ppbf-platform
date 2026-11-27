import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the web-push migration (lane W5-WP, WP-1a; each browser a person
// turned push on in, and the push send log with its checkpoints; OW27-17 B,
// OW27-18 A, plan and GO on #2228) inside one transaction. The operator names
// the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// For each of the three tables, the readiness check asserts: an ordinary
// logged table with no user trigger, rule, row security or inheritance (any of
// them could swallow or lose rows without an error); the exact column list,
// each column's type, nullability, default and identity; exactly the CHECKs
// below and no others, each compared IN FULL against the text Postgres stores,
// which says NOT VALID for a CHECK not validated (webPushMigration.pg.test.ts
// drives this runner against a real database); the primary key and every
// unique key by name and columns, none deferrable (ON CONFLICT refuses a
// deferrable key); exactly the foreign keys below, each by name, columns on
// both sides, target, cascade on delete, the default update rule, validated
// and not deferrable; and every index on the table by its full definition.

const USER_TYPES = "CHECK ((user_type = ANY (ARRAY['staff'::text, 'parent'::text, 'adult_athlete'::text])))";
const KIND = "CHECK ((event_kind ~ '^[a-z][a-z_]{0,62}$'::text))";
const PERSON_KEYS = (table, prefix) => [
  [`${table}_organization_id_fkey`, ['organization_id'], 'pilot.organizations', ['organization_id']],
  [`${table}_account_id_fkey`, ['account_id'], 'pilot.accounts', ['account_id']],
  [`${prefix}_membership_fk`, ['account_id', 'organization_id'], 'pilot.organization_memberships', ['account_id', 'organization_id']],
];

export const EXPECTED = {
  push_subscriptions: {
    // name|type|nullable|default|identity, in column order ('a' = generated always).
    columns: [
      'subscription_id|bigint|NO||a',
      'organization_id|text|NO||',
      'account_id|text|NO||',
      'user_type|text|NO||',
      'endpoint|text|NO||',
      'key_p256dh|text|NO||',
      'key_auth|text|NO||',
      'device_key_hash|text|YES||',
      'created_at|timestamp with time zone|NO|clock_timestamp()|',
      'saved_at|timestamp with time zone|NO|clock_timestamp()|',
    ],
    checks: {
      pilot_push_subscription_user_type_check: USER_TYPES,
      pilot_push_subscription_endpoint_check:
        "CHECK (((endpoint ~ '^https://[^[:space:]]+$'::text) AND (length(endpoint) <= 2048)))",
      pilot_push_subscription_p256dh_check: "CHECK ((key_p256dh ~ '^[A-Za-z0-9_-]{87}$'::text))",
      pilot_push_subscription_auth_check: "CHECK ((key_auth ~ '^[A-Za-z0-9_-]{22,128}$'::text))",
      pilot_push_subscription_device_key_check: "CHECK ((device_key_hash ~ '^[0-9a-f]{64}$'::text))",
    },
    primaryKey: ['subscription_id'],
    uniqueKeys: [['pilot_push_subscription_endpoint_key', ['endpoint']]],
    foreignKeys: PERSON_KEYS('push_subscriptions', 'pilot_push_subscription'),
    // Every index on the table, ordered by name.
    indexes: [
      'CREATE INDEX idx_push_subscriptions_person ON pilot.push_subscriptions USING btree (organization_id, account_id)',
      'CREATE UNIQUE INDEX pilot_push_subscription_endpoint_key ON pilot.push_subscriptions USING btree (endpoint)',
      'CREATE UNIQUE INDEX push_subscriptions_pkey ON pilot.push_subscriptions USING btree (subscription_id)',
    ],
  },
  push_alert_sends: {
    columns: [
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
    ],
    checks: {
      pilot_push_alert_send_user_type_check: USER_TYPES,
      pilot_push_alert_send_kind_check: KIND,
      pilot_push_alert_send_event_id_check:
        "CHECK ((event_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))",
      pilot_push_alert_send_status_check:
        "CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'skipped'::text, 'failed'::text])))",
      pilot_push_alert_send_tries_check: 'CHECK (((tries >= 0) AND (tries <= 5)))',
      pilot_push_alert_send_skip_reason_check:
        "CHECK ((skip_reason = ANY (ARRAY['switched_off'::text, 'gym_unticked'::text, 'sign_in_off'::text, 'not_offered'::text, 'no_subscription'::text])))",
      pilot_push_alert_send_status_code_check: 'CHECK (((last_status_code >= 100) AND (last_status_code <= 599)))',
      pilot_push_alert_send_error_code_check: "CHECK ((last_error_code ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'::text))",
      pilot_push_alert_send_lease_check:
        "CHECK ((((status = 'sending'::text) = (lease_token IS NOT NULL)) AND ((lease_token IS NULL) = (lease_expires_at IS NULL))))",
      pilot_push_alert_send_finished_check:
        "CHECK (((status = ANY (ARRAY['sent'::text, 'skipped'::text, 'failed'::text])) = (finished_at IS NOT NULL)))",
      pilot_push_alert_send_skipped_check: "CHECK (((status = 'skipped'::text) = (skip_reason IS NOT NULL)))",
      pilot_push_alert_send_queued_tries_check: "CHECK (((status <> 'queued'::text) OR (tries < 5)))",
    },
    primaryKey: ['send_id'],
    uniqueKeys: [['pilot_push_alert_send_once_key', ['organization_id', 'account_id', 'event_kind', 'event_id']]],
    foreignKeys: PERSON_KEYS('push_alert_sends', 'pilot_push_alert_send'),
    indexes: [
      "CREATE INDEX idx_push_alert_sends_leased ON pilot.push_alert_sends USING btree (lease_expires_at) WHERE (status = 'sending'::text)",
      "CREATE INDEX idx_push_alert_sends_queued ON pilot.push_alert_sends USING btree (next_try_at) WHERE (status = 'queued'::text)",
      'CREATE UNIQUE INDEX pilot_push_alert_send_once_key ON pilot.push_alert_sends USING btree (organization_id, account_id, event_kind, event_id)',
      'CREATE UNIQUE INDEX push_alert_sends_pkey ON pilot.push_alert_sends USING btree (send_id)',
    ],
  },
  push_alert_checkpoints: {
    columns: [
      'event_kind|text|NO||',
      'swept_to|timestamp with time zone|NO||',
      'updated_at|timestamp with time zone|NO|clock_timestamp()|',
    ],
    checks: { pilot_push_alert_checkpoint_kind_check: KIND },
    primaryKey: ['event_kind'],
    uniqueKeys: [],
    foreignKeys: [],
    indexes: ['CREATE UNIQUE INDEX push_alert_checkpoints_pkey ON pilot.push_alert_checkpoints USING btree (event_kind)'],
  },
};

// Columns of a key, in key order: $col = 'conkey' or 'confkey', $rel the side's table.
const keyColumns = (col, rel) => `(select array_agg(a.attname::text order by k.ord)
    from unnest(c.${col}) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = c.${rel} and a.attnum = k.attnum)`;

// $1 table name; $2 columns; $3 check names; $4 check defs; $5 primary key columns;
// $6 unique key names; $7 unique key columns joined by ','; $8 foreign key names;
// $9 local columns joined by ','; $10 targets; $11 referenced columns joined by ','; $12 indexes.
const READINESS_QUERY = `
  with t as (select to_regclass('pilot.' || $1) as rel)
  select
    (select rel is not null from t) as table_ready,
    coalesce((select c.relkind = 'r' and c.relpersistence = 'p' and not c.relrowsecurity
        and not exists (select 1 from pg_trigger g where g.tgrelid = c.oid and not g.tgisinternal)
        and not exists (select 1 from pg_rewrite r where r.ev_class = c.oid)
        and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid or i.inhparent = c.oid)
      from pg_class c, t where c.oid = t.rel), false) as table_plain,
    (select array_agg(a.attname::text || '|' || format_type(a.atttypid, a.atttypmod)
                      || '|' || case when a.attnotnull then 'NO' else 'YES' end
                      || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
                      || '|' || a.attidentity::text order by a.attnum)
       from t join pg_attribute a on a.attrelid = t.rel
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attnum > 0 and not a.attisdropped) = $2::text[] as columns_ready,
    (select count(*) = cardinality($3::text[]) from pg_constraint c, t
       join unnest($3::text[], $4::text[]) as e(conname, condef) on true
      where c.conrelid = t.rel and c.contype = 'c' and c.conname = e.conname
        and pg_get_constraintdef(c.oid) = e.condef)
      and (select count(*) = cardinality($3::text[]) from pg_constraint c, t
            where c.conrelid = t.rel and c.contype = 'c') as checks_ready,
    exists (select 1 from pg_constraint c, t
      where c.conrelid = t.rel and c.contype = 'p' and not c.condeferrable
        and ${keyColumns('conkey', 'conrelid')} = $5::text[]) as primary_key_ready,
    (select count(*) = cardinality($6::text[]) from pg_constraint c, t
       join unnest($6::text[], $7::text[]) as e(conname, cols) on true
      where c.conrelid = t.rel and c.contype = 'u' and c.conname = e.conname and not c.condeferrable
        and ${keyColumns('conkey', 'conrelid')} = string_to_array(e.cols, ','))
      and (select count(*) = cardinality($6::text[]) from pg_constraint c, t
            where c.conrelid = t.rel and c.contype = 'u') as unique_keys_ready,
    (select count(*) = cardinality($8::text[]) from pg_constraint c, t
       join unnest($8::text[], $9::text[], $10::text[], $11::text[]) as e(conname, cols, target, refcols) on true
      where c.conrelid = t.rel and c.contype = 'f' and c.conname = e.conname and c.convalidated
        and not c.condeferrable and c.confrelid = to_regclass(e.target)
        and c.confdeltype = 'c' and c.confupdtype = 'a'
        and ${keyColumns('conkey', 'conrelid')} = string_to_array(e.cols, ',')
        and ${keyColumns('confkey', 'confrelid')} = string_to_array(e.refcols, ','))
      and (select count(*) = cardinality($8::text[]) from pg_constraint c, t
            where c.conrelid = t.rel and c.contype = 'f') as foreign_keys_ready,
    coalesce((select array_agg(indexdef::text order by indexname collate "C") from pg_indexes
       where schemaname = 'pilot' and tablename = $1), '{}') = $12::text[] as indexes_ready
`;

function readinessParams(table, spec) {
  return [
    table,
    spec.columns,
    Object.keys(spec.checks),
    Object.values(spec.checks),
    spec.primaryKey,
    spec.uniqueKeys.map(([name]) => name),
    spec.uniqueKeys.map(([, cols]) => cols.join(',')),
    spec.foreignKeys.map(([name]) => name),
    spec.foreignKeys.map(([, cols]) => cols.join(',')),
    spec.foreignKeys.map(([, , target]) => target),
    spec.foreignKeys.map(([, , , refcols]) => refcols.join(',')),
    spec.indexes,
  ];
}

/** Every readiness flag of every table; all must be true. Exported for the pg test's messages. */
export async function readiness(client) {
  const out = {};
  for (const [table, spec] of Object.entries(EXPECTED)) {
    const { rows } = await client.query(READINESS_QUERY, readinessParams(table, spec));
    for (const [flag, value] of Object.entries(rows[0] ?? {})) out[`${table}.${flag}`] = value;
  }
  return out;
}

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const flags = await readiness(client);
    if (Object.keys(flags).length === 0 || Object.values(flags).some((value) => value !== true)) {
      throw new Error('WEB_PUSH_TABLES_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_web_push_migration.sql',
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
  console.log(`Applied web push migration: ${migrationPath}`);
  console.log('PILOT WEB PUSH MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT WEB PUSH MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
