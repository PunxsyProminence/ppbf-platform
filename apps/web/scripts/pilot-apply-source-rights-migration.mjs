import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the source-rights migration inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Every clause is false on a database this migration has not reached, and
// each is refused on its own (sourceRights.pg.test.ts). Both checks are
// compared in full, so a looser predicate that happens to contain the right
// words fails; each trigger must be enabled, on its table, for its events and
// columns, and call its own function -- one that still refuses (its raise) and,
// where it reads rows, still locks them (FOR SHARE).
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'shadow_library_sources'
        and column_name = 'rights_status' and data_type = 'text' and is_nullable = 'NO'
        and column_default = '''unknown''::text'
    ) as rights_column_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_shadow_library_sources_rights_status_check'
        and conrelid = to_regclass('pilot.shadow_library_sources') and contype = 'c' and convalidated
        and pg_get_constraintdef(oid) = 'CHECK ((rights_status = ANY (ARRAY[''ppbf_owned''::text, ''open_licence''::text, ''licensed_excerpt_only''::text, ''unknown''::text])))'
    ) as rights_check_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'shadow_library_chunks'
        and column_name = 'text_kind' and data_type = 'text' and is_nullable = 'NO'
        and column_default = '''full_text''::text'
    ) as text_kind_column_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'shadow_library_chunks'
        and column_name = 'excerpt_locator' and data_type = 'text' and is_nullable = 'YES'
    ) as locator_column_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_shadow_library_chunks_text_kind_check'
        and conrelid = to_regclass('pilot.shadow_library_chunks') and contype = 'c' and convalidated
        and pg_get_constraintdef(oid) = 'CHECK ((((text_kind = ''full_text''::text) AND (excerpt_locator IS NULL)) OR ((text_kind = ''excerpt''::text) AND (btrim(COALESCE(excerpt_locator, ''''::text)) <> ''''::text))))'
    ) as text_kind_check_ready,
    exists (
      select 1 from pg_trigger t
      where t.tgname = 'shadow_library_chunk_rights_guard' and not t.tgisinternal and t.tgenabled = 'O'
        and t.tgrelid = to_regclass('pilot.shadow_library_chunks')
        and t.tgfoid = to_regprocedure('pilot.shadow_library_chunk_rights_guard()')
        and (select prosrc from pg_proc where oid = t.tgfoid) like '%SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED%'
        and (select prosrc from pg_proc where oid = t.tgfoid) like '%where d.document_id = new.document_id%for share;%where s.source_id = v_source%for share;%'
        and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER shadow_library_chunk_rights_guard BEFORE INSERT OR UPDATE OF document_id, text_kind, text_content ON pilot.shadow_library_chunks FOR EACH ROW EXECUTE FUNCTION pilot.shadow_library_chunk_rights_guard()'
    ) as chunk_guard_ready,
    exists (
      select 1 from pg_trigger t
      where t.tgname = 'shadow_library_source_rights_guard' and not t.tgisinternal and t.tgenabled = 'O'
        and t.tgrelid = to_regclass('pilot.shadow_library_sources')
        and t.tgfoid = to_regprocedure('pilot.shadow_library_source_rights_guard()')
        and (select prosrc from pg_proc where oid = t.tgfoid) like '%SHADOW_LIBRARY_RIGHTS_LOWERED_UNDER_FULL_TEXT%'
        and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER shadow_library_source_rights_guard BEFORE UPDATE OF rights_status ON pilot.shadow_library_sources FOR EACH ROW EXECUTE FUNCTION pilot.shadow_library_source_rights_guard()'
    ) as source_guard_ready,
    exists (
      select 1 from pg_trigger t
      where t.tgname = 'shadow_library_document_rights_guard' and not t.tgisinternal and t.tgenabled = 'O'
        and t.tgrelid = to_regclass('pilot.shadow_library_documents')
        and t.tgfoid = to_regprocedure('pilot.shadow_library_document_rights_guard()')
        and (select prosrc from pg_proc where oid = t.tgfoid) like '%SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED%'
        and (select prosrc from pg_proc where oid = t.tgfoid) like '%for share%'
        and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER shadow_library_document_rights_guard BEFORE UPDATE OF source_id ON pilot.shadow_library_documents FOR EACH ROW EXECUTE FUNCTION pilot.shadow_library_document_rights_guard()'
    ) as document_guard_ready
`;

// Read-only, printed after the commit: what the classification did, and how
// many full-text chunks were already sitting under a source below full-text
// level (the rule checks writes, so these stay until someone acts on them).
const SUMMARY_QUERY = `
  select
    (select coalesce(jsonb_object_agg(rights_status, n), '{}'::jsonb)
       from (select rights_status, count(*)::int as n
               from pilot.shadow_library_sources group by rights_status) r) as sources_by_rights,
    (select coalesce(jsonb_object_agg(text_kind, n), '{}'::jsonb)
       from (select text_kind, count(*)::int as n
               from pilot.shadow_library_chunks group by text_kind) k) as chunks_by_kind,
    (select count(*)::int
       from pilot.shadow_library_chunks c
       join pilot.shadow_library_documents d on d.document_id = c.document_id
       join pilot.shadow_library_sources s on s.source_id = d.source_id
      where c.text_kind = 'full_text'
        and s.rights_status not in ('ppbf_owned', 'open_licence')) as full_text_below_rights
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('SOURCE_RIGHTS_NOT_READY');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function readSummary(client) {
  const result = await client.query(SUMMARY_QUERY);
  return result.rows[0];
}

export async function run() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) throw new Error('MISSING_AZURE_POSTGRES_CONNECTION_STRING');
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const migrationPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../infra/azure/pilot_slice_postgres_source_rights_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  let summary;
  try {
    await applyMigrationTransaction(client, sql);
    summary = await readSummary(client);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`sources_by_rights: ${JSON.stringify(summary.sources_by_rights)}`);
  console.log(`chunks_by_kind: ${JSON.stringify(summary.chunks_by_kind)}`);
  console.log(`full_text_chunks_under_sources_below_full_text_level: ${summary.full_text_below_rights}`);
  console.log('PILOT SOURCE RIGHTS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SOURCE RIGHTS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
