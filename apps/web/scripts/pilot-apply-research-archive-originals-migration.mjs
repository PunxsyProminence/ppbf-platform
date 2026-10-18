import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the research-archive-originals migration (issue #345, lane L57) inside one
// transaction. The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

const TABLE = "to_regclass('pilot.shadow_library_archived_originals')";

/** A constraint of that name, on that table, of that kind, validated, saying exactly `def`. */
function constraintIs(name, contype, def, table = TABLE) {
  return `exists (
      select 1 from pg_constraint
       where conrelid = ${table} and conname = '${name}' and contype = '${contype}' and convalidated
         and pg_get_constraintdef(oid) = '${def.replaceAll("'", "''")}'
    )`;
}

// Every column of the new table, in name order: type, NOT NULL and default. The file's
// create-if-not-exists keeps a same-named table built earlier, so this is what refuses one whose
// sha or item id is nullable (a unique key over nullable columns no longer means "one row").
const EXPECTED_COLUMNS =
  "acquired_at timestamp with time zone not null, acquisition_channel text not null, acquisition_provider text not null, archive_domain_code text not null, archive_filename text not null, archive_root_item_id text not null, archived_original_id text not null, byte_size bigint not null, content_sha256 text not null, created_at timestamp with time zone not null default now(), created_by_account_id text not null, created_by_role text not null, drive_id text not null, item_id text not null, organization_id text not null, original_filename text not null, provider text not null default 'sharepoint'::text, site_id text not null, source_id text not null, supersedes_archived_original_id text, version_kind text not null default 'unknown'::text, web_url text";

function indexIs(name, def) {
  return `exists (
      select 1 from pg_indexes
       where schemaname = 'pilot' and indexname = '${name}' and indexdef = '${def.replaceAll("'", "''")}'
    )`;
}

// Readiness asserts the result, not the attempt. The table's columns, every constraint the file
// declares and both indexes are compared in full, by name ON their own table, so a same-named
// object elsewhere, or a looser rule that keeps the name (the file's if-not-exists would keep it),
// does not pass. researchArchiveOriginals.pg.test.ts holds every constraint and index in the file to a check
// here, and refuses a loosened sample of them.
const CHECKS = {
  table_ready: `${TABLE} is not null`,
  columns_ready: `(
      select string_agg(
               a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                 || case when a.attnotnull then ' not null' else '' end
                 || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''),
               ', ' order by a.attname)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = ${TABLE} and a.attnum > 0 and not a.attisdropped
    ) = '${EXPECTED_COLUMNS.replaceAll("'", "''")}'`,
  pkey_ready: constraintIs('pilot_shadow_library_archived_originals_pkey', 'p', 'PRIMARY KEY (archived_original_id)'),
  source_fk_ready: constraintIs(
    'pilot_shadow_library_archived_originals_source_fk',
    'f',
    'FOREIGN KEY (source_id, organization_id) REFERENCES pilot.shadow_library_sources(source_id, organization_id) ON DELETE RESTRICT',
  ),
  org_sha_key_ready: constraintIs(
    'pilot_shadow_library_archived_originals_org_sha_key',
    'u',
    'UNIQUE (organization_id, content_sha256)',
  ),
  org_item_key_ready: constraintIs(
    'pilot_shadow_library_archived_originals_org_item_key',
    'u',
    'UNIQUE (organization_id, drive_id, item_id)',
  ),
  link_key_ready: constraintIs(
    'pilot_shadow_library_archived_originals_link_key',
    'u',
    'UNIQUE (archived_original_id, source_id, organization_id)',
  ),
  supersedes_fk_ready: constraintIs(
    'pilot_shadow_library_archived_originals_supersedes_fk',
    'f',
    'FOREIGN KEY (supersedes_archived_original_id, source_id, organization_id) REFERENCES pilot.shadow_library_archived_originals(archived_original_id, source_id, organization_id) ON DELETE RESTRICT',
  ),
  domain_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_domain_check',
    'c',
    "CHECK ((archive_domain_code ~ '^R(0[1-9]|1[0-9])$'::text))",
  ),
  filename_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_filename_check',
    'c',
    "CHECK ((archive_filename ~* '^[a-z0-9][a-z0-9._ -]{0,200}[.]pdf$'::text))",
  ),
  sha256_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_sha256_check',
    'c',
    "CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text))",
  ),
  provider_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_provider_check',
    'c',
    "CHECK ((provider = 'sharepoint'::text))",
  ),
  channel_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_channel_check',
    'c',
    "CHECK ((acquisition_channel = ANY (ARRAY['library_database'::text, 'publisher_site'::text, 'open_access_repository'::text, 'author_copy'::text, 'ppbf_created'::text, 'other'::text])))",
  ),
  version_kind_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_version_kind_check',
    'c',
    "CHECK ((version_kind = ANY (ARRAY['author_original'::text, 'accepted_manuscript'::text, 'version_of_record'::text, 'corrected_version_of_record'::text, 'other'::text, 'unknown'::text])))",
  ),
  not_self_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_not_self_check',
    'c',
    'CHECK (((supersedes_archived_original_id IS NULL) OR (supersedes_archived_original_id <> archived_original_id)))',
  ),
  ids_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_ids_check',
    'c',
    "CHECK (((btrim(site_id) <> ''::text) AND (btrim(drive_id) <> ''::text) AND (btrim(item_id) <> ''::text) AND (btrim(archive_root_item_id) <> ''::text)))",
  ),
  url_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_url_check',
    'c',
    "CHECK (((web_url IS NULL) OR (web_url ~ '^https://'::text)))",
  ),
  original_name_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_original_name_check',
    'c',
    'CHECK (((length(btrim(original_filename)) >= 1) AND (length(btrim(original_filename)) <= 255)))',
  ),
  byte_size_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_byte_size_check',
    'c',
    'CHECK ((byte_size > 0))',
  ),
  acq_provider_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_acq_provider_check',
    'c',
    'CHECK (((length(btrim(acquisition_provider)) >= 1) AND (length(btrim(acquisition_provider)) <= 200)))',
  ),
  created_by_check_ready: constraintIs(
    'pilot_shadow_library_archived_originals_created_by_check',
    'c',
    "CHECK (((btrim(created_by_account_id) <> ''::text) AND (btrim(created_by_role) <> ''::text)))",
  ),
  documents_column_ready: `exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'shadow_library_documents'
         and column_name = 'archived_original_id' and data_type = 'text' and is_nullable = 'YES'
    )`,
  documents_fk_ready: constraintIs(
    'pilot_shadow_library_documents_archived_original_fk',
    'f',
    'FOREIGN KEY (archived_original_id, source_id, organization_id) REFERENCES pilot.shadow_library_archived_originals(archived_original_id, source_id, organization_id) ON DELETE RESTRICT',
    "to_regclass('pilot.shadow_library_documents')",
  ),
  documents_subject_check_ready: constraintIs(
    'pilot_shadow_library_documents_archived_original_subject_check',
    'c',
    'CHECK (((archived_original_id IS NULL) OR (subject_id IS NULL)))',
    "to_regclass('pilot.shadow_library_documents')",
  ),
  source_index_ready: indexIs(
    'idx_shadow_library_archived_originals_source',
    'CREATE INDEX idx_shadow_library_archived_originals_source ON pilot.shadow_library_archived_originals USING btree (organization_id, source_id)',
  ),
  documents_index_ready: indexIs(
    'idx_shadow_library_documents_archived_original',
    'CREATE INDEX idx_shadow_library_documents_archived_original ON pilot.shadow_library_documents USING btree (archived_original_id) WHERE (archived_original_id IS NOT NULL)',
  ),
};

const READINESS_QUERY = `select ${Object.entries(CHECKS)
  .map(([key, predicate]) => `${predicate} as ${key}`)
  .join(',\n  ')}`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // The file alters shadow_library_documents, which every Library read touches: wait for its
    // lock briefly, then fail and retry later rather than queue those reads behind this.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`RESEARCH_ARCHIVE_ORIGINALS_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_research_archive_originals_migration.sql',
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
  console.log(`Applied research archive originals migration: ${migrationPath}`);
  console.log('PILOT RESEARCH ARCHIVE ORIGINALS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT RESEARCH ARCHIVE ORIGINALS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
