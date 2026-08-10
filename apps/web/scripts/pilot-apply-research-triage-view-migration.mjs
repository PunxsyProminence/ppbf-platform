import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

const READINESS_QUERY = `
  select
    to_regclass('pilot.v_shadow_research_triage') is not null as view_ready,
    coalesce((
      select reloptions @> array['security_invoker=true']
      from pg_class
      where oid = to_regclass('pilot.v_shadow_research_triage')
    ), false) as security_invoker_ready,
    (
      select count(*) = 16
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'v_shadow_research_triage'
    ) as columns_ready
`;

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

export async function applyMigration(client, sql) {
  await client.query(sql);
  const readiness = await client.query(READINESS_QUERY);
  if (!readiness.rows[0] || Object.values(readiness.rows[0]).some((value) => value !== true)) {
    throw new Error('RESEARCH_TRIAGE_VIEW_NOT_READY');
  }
}

export async function run() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) throw new Error('MISSING_AZURE_POSTGRES_CONNECTION_STRING');
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const migrationPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../infra/azure/pilot_slice_postgres_research_triage_view_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  try {
    await applyMigration(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log('PILOT RESEARCH TRIAGE VIEW MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT RESEARCH TRIAGE VIEW MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
