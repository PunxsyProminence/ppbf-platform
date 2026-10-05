import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the video-clip-tags-sparring-link migration inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Every clause is false on a database this migration has not reached, and
// each is refused on its own (videoClipTagsSparringLink.pg.test.ts). The
// foreign key is checked by shape, not name: both column lists, its target,
// MATCH SIMPLE, and that its delete action is SET NULL of exposure_id ALONE --
// a whole-key SET NULL would fail on every delete. The check is compared in
// full, so a looser predicate that happens to contain the right words fails.
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'video_clip_tags'
        and column_name = 'exposure_id' and data_type = 'text' and is_nullable = 'YES'
    ) as exposure_column_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_video_clip_tags_exposure_sparring_check'
        and conrelid = to_regclass('pilot.video_clip_tags') and contype = 'c' and convalidated
        and pg_get_constraintdef(oid) = 'CHECK (((exposure_id IS NULL) OR (event_kind = ''sparring''::text)))'
    ) as sparring_only_ready,
    exists (
      select 1 from pg_constraint c
      where c.conname = 'pilot_video_clip_tags_exposure_fk'
        and c.conrelid = to_regclass('pilot.video_clip_tags') and c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.sparring_exposure')
        and c.confdeltype = 'n' and c.confmatchtype = 's'
        and (select array_agg(a.attname::text order by k.ord)
               from unnest(c.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
            = array['organization_id', 'exposure_id', 'athlete_id']
        and (select array_agg(a.attname::text order by k.ord)
               from unnest(c.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum)
            = array['organization_id', 'exposure_id', 'athlete_id']
        and (select array_agg(a.attname::text)
               from unnest(c.confdelsetcols) k(attnum)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
            = array['exposure_id']
    ) as same_athlete_fk_ready,
    exists (
      select 1 from pg_index i
      where i.indexrelid = to_regclass('pilot.idx_sparring_exposure_org_exposure_athlete')
        and i.indrelid = to_regclass('pilot.sparring_exposure') and i.indisunique and i.indpred is null
        and pg_get_indexdef(i.indexrelid) like '%(organization_id, exposure_id, athlete_id)'
    ) as target_index_ready,
    exists (
      select 1 from pg_index i
      where i.indexrelid = to_regclass('pilot.idx_video_clip_tags_exposure')
        and i.indrelid = to_regclass('pilot.video_clip_tags')
        and pg_get_indexdef(i.indexrelid) like '%(organization_id, exposure_id) WHERE (exposure_id IS NOT NULL)'
    ) as link_index_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('VIDEO_CLIP_TAGS_SPARRING_LINK_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_video_clip_tags_sparring_link_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  try {
    const version = await client.query('show server_version_num');
    console.log(`server_version_num: ${version.rows[0]?.server_version_num ?? 'unreadable'}`);
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log('PILOT VIDEO CLIP TAGS SPARRING LINK MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT VIDEO CLIP TAGS SPARRING LINK MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
