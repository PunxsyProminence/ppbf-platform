import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only audit of two gaps in the Library's records that wait on a person
 * (issue #1468, N6-03 PR 3): text rights, and the indexing time servability
 * needs. It does not count records that are unservable by a person's decision
 * (pending approval, rejected, suppressed, athlete-scoped).
 *
 * The work order asked to backfill "only where deterministically recoverable".
 * This script backfills nothing. text_kind and excerpt_locator were already
 * backfilled by the rights migration, and a source's rights_status is a
 * person's classification (OD-2026-10-03-002 Q3: ppbf_owned / open_licence /
 * licensed_excerpt_only / unknown; unknown refuses full text). Importing a
 * document does not prove the gym may show its text (N6-03-Q1, option A). It
 * counts, per shelf:
 *
 *   - sources by rights_status, how many hold text, and how many hold FULL
 *     text. Only ppbf_owned and open_licence may; the rights guard checks
 *     writes, so rows from before it can still hold full text under another
 *     value, and those are the urgent ones to classify. Text is counted by the
 *     DOCUMENT's source, as the guard and the excerpt budget count it: a chunk
 *     that only cites a source is held under its document's source;
 *   - documents marked 'indexed' whose index_completed_at is null, which
 *     SERVABLE_GYM_WIDE_LIBRARY_DOCUMENT_SQL (libraryServability.ts) refuses,
 *     and how many of those hold text of their own. Those can be completed by
 *     the indexing step the app already runs (it stamps the time when it
 *     finishes); one with no text cannot. Running that step is a curator's or
 *     operator's call, not this script's. None of these documents can be
 *     approved (shadow_library_documents_review_pair_check requires the time
 *     for an approval).
 *
 * Counts and shelf (organization) ids only: no titles, no text, no account
 * ids. SELECT statements only, inside an explicit READ ONLY transaction, so
 * Postgres refuses any write this file could attempt.
 */

async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');

  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // No .env.local (CI, or a container). The env var must be set.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'Set it in apps/web/.env.local, or export it before running this script.',
    );
  }
  return value;
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

export async function checkLibraryRights(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const database = (await client.query('select current_database() as db')).rows[0].db;

    const sources = await client.query(
      `select s.organization_id,
              s.rights_status,
              count(*)::int as sources,
              count(*) filter (where exists (
                select 1
                  from pilot.shadow_library_chunks c
                  join pilot.shadow_library_documents d
                    on d.document_id = c.document_id and d.organization_id = c.organization_id
                 where d.source_id = s.source_id and d.organization_id = s.organization_id
              ))::int as sources_holding_text,
              count(*) filter (where exists (
                select 1
                  from pilot.shadow_library_chunks c
                  join pilot.shadow_library_documents d
                    on d.document_id = c.document_id and d.organization_id = c.organization_id
                 where d.source_id = s.source_id and d.organization_id = s.organization_id
                   and c.text_kind = 'full_text'
              ))::int as sources_holding_full_text
         from pilot.shadow_library_sources s
        group by s.organization_id, s.rights_status
        order by s.organization_id collate "C", s.rights_status collate "C"`,
    );

    const documents = await client.query(
      `select d.organization_id,
              count(*)::int as indexed_without_completion,
              count(*) filter (where exists (
                select 1 from pilot.shadow_library_chunks c
                 where c.document_id = d.document_id and c.organization_id = d.organization_id
              ))::int as with_text
         from pilot.shadow_library_documents d
        where d.ingest_state = 'indexed'
          and d.index_completed_at is null
        group by d.organization_id
        order by d.organization_id collate "C"`,
    );

    await client.query('COMMIT');
    return { database, sources: sources.rows, documents: documents.rows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  let report;
  try {
    report = await checkLibraryRights(client);
  } finally {
    await client.end();
  }

  console.log('Library rights and servability audit (read-only; nothing is changed)');
  console.log('====================================================================');
  console.log(`database: ${report.database}`);
  console.log('');
  console.log('Sources by rights, per shelf (sources / of which hold text / of which hold full text):');
  for (const row of report.sources) {
    console.log(`  ${row.organization_id}  ${row.rights_status}: ${row.sources} / ${row.sources_holding_text} / ${row.sources_holding_full_text}`);
  }
  const unknown = report.sources.filter((row) => row.rights_status === 'unknown');
  const unknownTotal = unknown.reduce((sum, row) => sum + row.sources, 0);
  console.log(`  -> ${unknownTotal} source(s) carry rights 'unknown' and wait for a curator to classify them.`);
  console.log('');
  console.log("Documents marked 'indexed' with no index_completed_at (not servable), per shelf (documents / of which hold text):");
  if (report.documents.length === 0) {
    console.log('  none');
  }
  for (const row of report.documents) {
    console.log(`  ${row.organization_id}: ${row.indexed_without_completion} / ${row.with_text}`);
  }
  console.log('====================================================================');
  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
    // Always zero: this reports a state, it does not gate one.
    process.exit(0);
  } catch (error) {
    console.error('LIBRARY RIGHTS AUDIT FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
