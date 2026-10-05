/*
 * THE COMMITTED REFERENCE CONTENT, LOADED THE WAY THE SEED WORKFLOW LOADS IT,
 * for Postgres suites that need the real disciplines, drill library, templates
 * or scripts in a database.
 *
 * WHY THIS EXISTS. Until IMP-10 those suites imported each seed-*.mjs loader
 * and called its seedAll. The seven loaders were copies of one another, and
 * they are gone: every dataset now loads through the content-import core, and
 * seed-reference-data.yml runs it as `content:apply`, which is runApply
 * (contentImport/cli.ts). These helpers run that SAME runApply -- plan printed,
 * then one transaction -- so a suite's rows are what a real dispatch writes,
 * not what a second copy of the loader would write.
 *
 * WHAT THE CORE NEEDS THAT A LOADER DID NOT. It checks its actor (an active
 * organization_admin or admin with an active membership in the gym,
 * contentImport/actor.ts), it records history and audit rows, and it checks a
 * drill's grounding claims against the research the gym can read. So a suite
 * loads into a FULL-SCHEMA database (scripts/lib/full-schema.mjs) with a gym
 * created by createSeedingGym and, for drills, the loaded research claims in
 * the shared library (loadResearchClaimsIntoPlatformLibrary).
 *
 * COUNTS COME FROM THE FILES (committedRows), never from literals: the library
 * grows with every hand-off, and a pinned 119 would fail on the first one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Client } from 'pg';

import type { DbClient } from '../server/pilot/contentImport/actor';
import { datasetsFor, runApply } from '../server/pilot/contentImport/cli';
import { readCsv } from '../server/pilot/contentImport/csv';
import { claimIdsFromChunksCsv, LOADED_RESEARCH_CHUNKS } from '../server/pilot/contentImport/referenceSets';
import type { DatasetName } from '../server/pilot/contentImport/types';

export const WEB_DIR = path.resolve(__dirname, '../..');
export const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

/**
 * Drops and recreates `database`, connects, and applies the schema production
 * runs (the base file plus every migration, in the workflow's order). The
 * caller supplies its own `pg` Client constructor and connection string for
 * the embedded server it started, and ends the client.
 */
export async function openFullSchemaDatabase(
  ClientClass: new (options: { connectionString: string }) => Client,
  connectionStringFor: (database: string) => string,
  database: string,
): Promise<Client> {
  const admin = new ClientClass({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${database}`);
  await admin.query(`create database ${database}`);
  await admin.end();

  const client = new ClientClass({ connectionString: connectionStringFor(database) });
  await client.connect();
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER).href);
  const applyFullSchema = fullSchema.applyFullSchema as (c: Client, options?: { infraDir?: string }) => Promise<unknown>;
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  return client;
}

/**
 * A gym and the account that seeds it: an organization row, an account with
 * `role` (organization_admin unless the case says otherwise) homed there, and
 * an ACTIVE membership in it -- what the core's seeder rule accepts. Returns
 * the account id.
 */
export async function createSeedingGym(
  client: DbClient,
  organizationId: string,
  options: { accountId?: string; role?: string } = {},
): Promise<string> {
  const accountId = options.accountId ?? `seed-admin@${organizationId}`;
  const role = options.role ?? 'organization_admin';
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict (organization_id) do nothing`,
    [organizationId],
  );
  await client.query('insert into pilot.accounts (account_id, role, organization_id) values ($1, $2, $3)', [
    accountId,
    role,
    organizationId,
  ]);
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)`,
    [accountId, organizationId, role],
  );
  return accountId;
}

/**
 * Every claim id of the LOADED research package, as chunks of the shared
 * __platform__ library -- where referenceSetsDb.ts looks when a drill cites a
 * claim. Idempotent, so a suite may call it once per gym.
 */
export async function loadResearchClaimsIntoPlatformLibrary(client: DbClient): Promise<void> {
  const ids = [...claimIdsFromChunksCsv(fs.readFileSync(path.join(SEED_DATA_DIR, LOADED_RESEARCH_CHUNKS), 'utf8'))];
  await client.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url)
     values ('src_reference_fixture', '__platform__', 'Loaded research claims (test)', 'peer_reviewed', 1, 'https://example.org/reference-fixture')
     on conflict do nothing`,
  );
  // The seed it stands in for is the research program's own synthesis, filed
  // under a ppbf_owned source; full text loads only under one (source-rights
  // migration). Guarded: some suites build a schema without that migration.
  await client.query(
    `do $fixture_rights$ begin
       if exists (select 1 from information_schema.columns
                  where table_schema = 'pilot' and table_name = 'shadow_library_sources'
                    and column_name = 'rights_status') then
         update pilot.shadow_library_sources set rights_status = 'ppbf_owned'
          where source_id = 'src_reference_fixture';
       end if;
     end $fixture_rights$`,
  );
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name, content_sha256)
     values ('doc_reference_fixture', 'src_reference_fixture', '__platform__', 'Loaded research claims (test)', 'reference-fixture')
     on conflict do nothing`,
  );
  await client.query(
    `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
     select 'chunk_fixture_' || claim_id, 'doc_reference_fixture', 'src_reference_fixture', '__platform__', ordinal::int,
            'Claim ' || claim_id, jsonb_build_object('claim_id', claim_id)
       from unnest($1::text[]) with ordinality as claim(claim_id, ordinal)
     on conflict do nothing`,
    [ids],
  );
}

export interface LoadResult {
  /** runApply's exit code: 0 loaded (or nothing to do), 1 refused or blocked. */
  code: number;
  /** Every line the CLI would have printed. */
  lines: string[];
}

interface LoadOptions {
  organizationId: string;
  actorAccountId: string;
  /** A --dataset value ('all', 'drill-library', 'competence-levels,cohort-definitions') or the names. */
  datasets: string | readonly DatasetName[];
  dryRun?: boolean;
  /** Load these files (seed-data-relative path -> text) instead of the committed ones. */
  files?: Readonly<Record<string, string>>;
}

/**
 * runApply -- the function `npm run seed:<dataset>` and the seed workflow run
 * -- over the committed seed-data, or over `files` laid out the same way in a
 * scratch folder. A JavaScript error inside the load is rethrown, as the CLI
 * would; a refusal comes back as code 1 with the CLI's lines.
 */
export async function loadReferenceContent(client: DbClient, options: LoadOptions): Promise<LoadResult> {
  const datasets = typeof options.datasets === 'string' ? datasetsFor(options.datasets) : [...options.datasets];
  let seedDataDir = SEED_DATA_DIR;
  let scratch: string | null = null;
  if (options.files) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-reference-fixture-'));
    for (const [relative, text] of Object.entries(options.files)) {
      fs.mkdirSync(path.dirname(path.join(scratch, relative)), { recursive: true });
      fs.writeFileSync(path.join(scratch, relative), text, 'utf8');
    }
    seedDataDir = scratch;
  }
  const lines: string[] = [];
  try {
    const code = await runApply(
      {
        client,
        organizationId: options.organizationId,
        actorAccountId: options.actorAccountId,
        seedDataDir,
        datasets,
        dryRun: options.dryRun ?? false,
      },
      { log: (line: string) => lines.push(line) },
    );
    return { code, lines };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A committed seed CSV's rows as column -> cell, read with the core's own reader. */
export function committedRows(relative: string): Record<string, string>[] {
  const table = readCsv(fs.readFileSync(path.join(SEED_DATA_DIR, relative), 'utf8'));
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index] ?? ''])));
}

/** A committed seed CSV's raw text, for a case that edits a copy of it. */
export function committedText(relative: string): string {
  return fs.readFileSync(path.join(SEED_DATA_DIR, relative), 'utf8');
}
