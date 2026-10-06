// Real PostgreSQL-backed test for the source-rights migration: a rights marker
// on every Library source, and full text only for ppbf_owned or open_licence
// sources (OD-2026-10-03-002 section 3; OD-2026-10-02-013 answer 4A).
//
// What needs a real database to prove:
//   * the migration adds the marker from nothing, classifies the seed's PPBF
//     sources (and their copies) as ppbf_owned and nothing else, turns the
//     /evidence intake's existing locator chunks into excerpts, re-applies as a
//     no-op, and the runner refuses a database it never reached or one with any
//     single piece wrong;
//   * the rule holds for every writer, because the triggers enforce it: full
//     text refused under unknown / licensed_excerpt_only, allowed under
//     ppbf_owned / open_licence; excerpts allowed anywhere but only with a
//     locator; rights cannot drop under full text; a document holding full
//     text cannot move under a lower source;
//   * two concurrent writes cannot each pass and together break it;
//   * the research importer loads the whole 2026-08-07 corpus under the rule;
//   * the routes answer a refusal with a 422 and a plain sentence.
//
// Built on the full production schema (scripts/lib/full-schema.mjs).
// Disposable, local-only embedded Postgres. It NEVER connects to production
// or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-source-rights-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_source_rights_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-source-rights-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const IMPORTER_PATH = path.resolve(__dirname, '../../../scripts/import-shadow-research.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-rights-gym';
const ADMIN = 'acct-rights-admin';
const PROGRAMME = 'src_6563c68e39047128';
const ROUTE_DB = 'ppbf_test_source_rights_routes';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const POLICY = 'src_b7041e76b524f743';
// The importer's one copy of a seed source (policyCopyId(PROGRAMME)).
const PROGRAMME_COPY = 'src_ppbfpol_6563c68e39047128';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let readSummary: (client: Client) => Promise<Record<string, unknown>>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let importer: Record<string, unknown>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

/** Removes everything this migration adds, so a test can start before it. */
async function unapply(client: Client): Promise<void> {
  await client.query('drop trigger if exists shadow_library_chunk_rights_guard on pilot.shadow_library_chunks');
  await client.query('drop trigger if exists shadow_library_source_rights_guard on pilot.shadow_library_sources');
  await client.query('drop trigger if exists shadow_library_document_rights_guard on pilot.shadow_library_documents');
  await client.query('drop function if exists pilot.shadow_library_chunk_rights_guard()');
  await client.query('drop function if exists pilot.shadow_library_source_rights_guard()');
  await client.query('drop function if exists pilot.shadow_library_document_rights_guard()');
  await client.query('alter table pilot.shadow_library_chunks drop constraint if exists pilot_shadow_library_chunks_text_kind_check');
  await client.query('alter table pilot.shadow_library_chunks drop column if exists text_kind');
  await client.query('alter table pilot.shadow_library_chunks drop column if exists excerpt_locator');
  await client.query('alter table pilot.shadow_library_sources drop constraint if exists pilot_shadow_library_sources_rights_status_check');
  await client.query('alter table pilot.shadow_library_sources drop column if exists rights_status');
}

async function freshDatabase(name: string, { preMigration = false } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name} encoding 'UTF8' template template0`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, 'organization_admin', $2, 'microsoft', true) on conflict do nothing`,
    [ADMIN, ORG],
  );
  if (preMigration) await unapply(client);
  return client;
}

async function insertSource(client: Client, sourceId: string, extra: { rights?: string; metadata?: object } = {}) {
  await client.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, metadata)
     values ($1, $2, $1, 'peer_reviewed', 2, $3::jsonb)`,
    [sourceId, ORG, JSON.stringify(extra.metadata ?? {})],
  );
  if (extra.rights) {
    await client.query('update pilot.shadow_library_sources set rights_status = $2 where source_id = $1', [sourceId, extra.rights]);
  }
}

async function insertDocument(client: Client, documentId: string, sourceId: string) {
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name)
     values ($1, $2, $3, $1)`,
    [documentId, sourceId, ORG],
  );
}

async function insertChunk(
  client: Client,
  chunkId: string,
  documentId: string,
  sourceId: string,
  options: { ordinal?: number; kind?: 'full_text' | 'excerpt'; locator?: string | null; metadata?: object } = {},
) {
  const withKind = options.kind !== undefined;
  await client.query(
    withKind
      ? `insert into pilot.shadow_library_chunks
           (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata, text_kind, excerpt_locator)
         values ($1, $2, $3, $4, $5, 'text of ' || $1, $6::jsonb, $7, $8)`
      : `insert into pilot.shadow_library_chunks
           (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
         values ($1, $2, $3, $4, $5, 'text of ' || $1, $6::jsonb)`,
    withKind
      ? [chunkId, documentId, sourceId, ORG, options.ordinal ?? 0, JSON.stringify(options.metadata ?? {}), options.kind, options.locator ?? null]
      : [chunkId, documentId, sourceId, ORG, options.ordinal ?? 0, JSON.stringify(options.metadata ?? {})],
  );
}

async function errorOf(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; constraint?: string; message: string };
  }
  throw new Error('expected the statement to be refused');
}

async function rightsOf(client: Client, sourceId: string): Promise<string> {
  const result = await client.query('select rights_status from pilot.shadow_library_sources where source_id = $1', [sourceId]);
  return result.rows[0].rights_status;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);
    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as typeof applyMigrationTransaction;
  readSummary = runnerModule.readSummary as typeof readSummary;
  importer = await nativeDynamicImport(pathToFileURL(IMPORTER_PATH).href);
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool().catch(() => {});
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('source rights migration', () => {
  test('adds the marker from nothing, classifies only the PPBF sources, keeps intake excerpts as excerpts; a re-apply changes nothing', async () => {
    const client = await freshDatabase('ppbf_test_rights_from_nothing', { preMigration: true });
    try {
      await insertSource(client, PROGRAMME);
      await insertSource(client, POLICY);
      await insertSource(client, PROGRAMME_COPY, { metadata: { copied_from_source_id: PROGRAMME } });
      await insertSource(client, 'src_paper');
      await insertDocument(client, 'doc_prog', PROGRAMME);
      await insertDocument(client, 'doc_paper', 'src_paper');
      await insertChunk(client, 'chunk_synthesis', 'doc_prog', 'src_paper');
      await insertChunk(client, 'chunk_intake', 'doc_paper', 'src_paper', { metadata: { locator: '  p. 12 ' } });
      await insertChunk(client, 'chunk_legacy', 'doc_paper', 'src_paper', { ordinal: 1, metadata: { locator: '   ' } });

      await applyMigrationTransaction(client, migrationSql);

      expect(await rightsOf(client, PROGRAMME)).toBe('ppbf_owned');
      expect(await rightsOf(client, POLICY)).toBe('ppbf_owned');
      expect(await rightsOf(client, PROGRAMME_COPY)).toBe('ppbf_owned');
      expect(await rightsOf(client, 'src_paper')).toBe('unknown');
      const chunks = await client.query(
        'select chunk_id, text_kind, excerpt_locator from pilot.shadow_library_chunks order by chunk_id',
      );
      expect(chunks.rows).toEqual([
        { chunk_id: 'chunk_intake', text_kind: 'excerpt', excerpt_locator: 'p. 12' },
        { chunk_id: 'chunk_legacy', text_kind: 'full_text', excerpt_locator: null },
        { chunk_id: 'chunk_synthesis', text_kind: 'full_text', excerpt_locator: null },
      ]);
      // The legacy full-text chunk under an unknown source is counted, not refused.
      const summary = await readSummary(client);
      expect(summary.full_text_below_rights).toBe(1);
      expect(summary.sources_by_rights).toEqual({ ppbf_owned: 3, unknown: 1 });

      // A reviewer's later marking survives a re-apply.
      await client.query("update pilot.shadow_library_sources set rights_status = 'open_licence' where source_id = 'src_paper'");
      await applyMigrationTransaction(client, migrationSql);
      expect(await rightsOf(client, 'src_paper')).toBe('open_licence');
      expect((await readSummary(client)).full_text_below_rights).toBe(0);
    } finally {
      await client.end();
    }
  });

  // #1238 review, P1. The backfill used to also raise any unknown source whose
  // metadata.copied_from_source_id named a seed id. Metadata is caller-written
  // through the sources route and the migration re-runs on every
  // apply-migrations dispatch, so a curator's source could claim to be a copy
  // and be made ppbf_owned -- full text permitted -- on the next run.
  test('a source CLAIMING to be a copy of a PPBF source stays unknown, on the first apply and on every re-run; the importer\'s real copy is still classified', async () => {
    const client = await freshDatabase('ppbf_test_rights_copy_spoof', { preMigration: true });
    try {
      await insertSource(client, PROGRAMME);
      // Positive control: the importer's genuine copy, carrying its provenance.
      await insertSource(client, PROGRAMME_COPY, {
        metadata: { copied_from_source_id: PROGRAMME, copied_for_scope: 'ppbf_policy' },
      });
      // Negative controls: route-shaped ids, each claiming a seed id.
      await insertSource(client, 'source_spoof_programme', {
        metadata: { copied_from_source_id: PROGRAMME, copied_for_scope: 'ppbf_policy' },
      });
      await insertSource(client, 'source_spoof_policy', { metadata: { copied_from_source_id: POLICY } });
      await insertDocument(client, 'doc_spoof', 'source_spoof_programme');

      await applyMigrationTransaction(client, migrationSql);

      expect(await rightsOf(client, PROGRAMME)).toBe('ppbf_owned');
      expect(await rightsOf(client, PROGRAMME_COPY)).toBe('ppbf_owned');
      expect(await rightsOf(client, 'source_spoof_programme')).toBe('unknown');
      expect(await rightsOf(client, 'source_spoof_policy')).toBe('unknown');
      // And so the trigger holds it to excerpts.
      const refused = await errorOf(insertChunk(client, 'chunk_spoof_full', 'doc_spoof', 'source_spoof_programme'));
      expect(refused.message).toMatch(/^SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED/);

      // A spoof written AFTER the first apply (as the route allowed until now),
      // then the re-run every apply-migrations dispatch performs.
      await insertSource(client, 'source_spoof_late', { metadata: { copied_from_source_id: PROGRAMME } });
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      expect(await rightsOf(client, 'source_spoof_late')).toBe('unknown');
      expect(await rightsOf(client, 'source_spoof_programme')).toBe('unknown');
      expect(await rightsOf(client, 'source_spoof_policy')).toBe('unknown');
      expect(await rightsOf(client, PROGRAMME_COPY)).toBe('ppbf_owned');
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_rights_never_ran', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('SOURCE_RIGHTS_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test('the real runner refuses each wrong piece on its own, with everything else right', async () => {
    const client = await freshDatabase('ppbf_test_rights_each_piece');
    try {
      const breakers: Array<[string, string, string]> = [
        [
          'looser rights check',
          `alter table pilot.shadow_library_sources drop constraint pilot_shadow_library_sources_rights_status_check;
           alter table pilot.shadow_library_sources add constraint pilot_shadow_library_sources_rights_status_check
             check (rights_status in ('ppbf_owned', 'open_licence', 'licensed_excerpt_only', 'unknown', 'fair_use'))`,
          `alter table pilot.shadow_library_sources drop constraint pilot_shadow_library_sources_rights_status_check;
           alter table pilot.shadow_library_sources add constraint pilot_shadow_library_sources_rights_status_check
             check (rights_status in ('ppbf_owned', 'open_licence', 'licensed_excerpt_only', 'unknown'))`,
        ],
        [
          'rights default not unknown',
          `alter table pilot.shadow_library_sources alter column rights_status set default 'open_licence'`,
          `alter table pilot.shadow_library_sources alter column rights_status set default 'unknown'`,
        ],
        [
          'excerpt allowed without a locator',
          `alter table pilot.shadow_library_chunks drop constraint pilot_shadow_library_chunks_text_kind_check;
           alter table pilot.shadow_library_chunks add constraint pilot_shadow_library_chunks_text_kind_check
             check (text_kind in ('full_text', 'excerpt'))`,
          `alter table pilot.shadow_library_chunks drop constraint pilot_shadow_library_chunks_text_kind_check;
           alter table pilot.shadow_library_chunks add constraint pilot_shadow_library_chunks_text_kind_check
             check (((text_kind = 'full_text' and excerpt_locator is null)
                     or (text_kind = 'excerpt' and btrim(coalesce(excerpt_locator, '')) <> '')))`,
        ],
        [
          'chunk guard disabled',
          'alter table pilot.shadow_library_chunks disable trigger shadow_library_chunk_rights_guard',
          'alter table pilot.shadow_library_chunks enable trigger shadow_library_chunk_rights_guard',
        ],
        [
          'chunk guard blind to text edits',
          `drop trigger shadow_library_chunk_rights_guard on pilot.shadow_library_chunks;
           create trigger shadow_library_chunk_rights_guard before insert or update of document_id, text_kind
             on pilot.shadow_library_chunks for each row execute function pilot.shadow_library_chunk_rights_guard()`,
          `drop trigger shadow_library_chunk_rights_guard on pilot.shadow_library_chunks;
           create trigger shadow_library_chunk_rights_guard before insert or update of document_id, text_kind, text_content, excerpt_locator
             on pilot.shadow_library_chunks for each row execute function pilot.shadow_library_chunk_rights_guard()`,
        ],
        [
          // CL-C1: the trigger before this rule fired on these columns only.
          'chunk guard blind to locator edits',
          `drop trigger shadow_library_chunk_rights_guard on pilot.shadow_library_chunks;
           create trigger shadow_library_chunk_rights_guard before insert or update of document_id, text_kind, text_content
             on pilot.shadow_library_chunks for each row execute function pilot.shadow_library_chunk_rights_guard()`,
          migrationSql,
        ],
        [
          // CL-C1: the body before this rule (btrim locators), still locking and refusing.
          'chunk guard without the locator whitespace rule',
          `create or replace function pilot.shadow_library_chunk_rights_guard() returns trigger language plpgsql as $f$
           declare v_source text; v_rights text;
           begin
             if new.text_kind <> 'full_text' then return new; end if;
             select d.source_id into v_source from pilot.shadow_library_documents d
              where d.document_id = new.document_id
                for share;
             select s.rights_status into v_rights from pilot.shadow_library_sources s
              where s.source_id = v_source
                for share;
             if v_rights in ('ppbf_owned', 'open_licence') then return new; end if;
             raise exception 'SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED';
           end $f$`,
          migrationSql,
        ],
        [
          'chunk guard that no longer locks what it reads',
          `create or replace function pilot.shadow_library_chunk_rights_guard() returns trigger language plpgsql as $f$
           begin
             if new.text_kind = 'full_text' and not exists (
               select 1 from pilot.shadow_library_documents d join pilot.shadow_library_sources s on s.source_id = d.source_id
                where d.document_id = new.document_id and s.rights_status in ('ppbf_owned', 'open_licence'))
             then raise exception 'SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED'; end if;
             return new;
           end $f$`,
          migrationSql,
        ],
        [
          'text_kind default not full_text',
          `alter table pilot.shadow_library_chunks alter column text_kind set default 'excerpt'`,
          `alter table pilot.shadow_library_chunks alter column text_kind set default 'full_text'`,
        ],
        [
          'excerpt_locator not text',
          // The chunk guard fires on excerpt_locator updates (CL-C1), and Postgres
          // will not retype a column a trigger names: it is set aside and back.
          `alter table pilot.shadow_library_chunks drop constraint pilot_shadow_library_chunks_text_kind_check;
           drop trigger shadow_library_chunk_rights_guard on pilot.shadow_library_chunks;
           alter table pilot.shadow_library_chunks alter column excerpt_locator type varchar(200);
           create trigger shadow_library_chunk_rights_guard before insert or update of document_id, text_kind, text_content, excerpt_locator
             on pilot.shadow_library_chunks for each row execute function pilot.shadow_library_chunk_rights_guard()`,
          `drop trigger shadow_library_chunk_rights_guard on pilot.shadow_library_chunks;
           alter table pilot.shadow_library_chunks alter column excerpt_locator type text;
           alter table pilot.shadow_library_chunks add constraint pilot_shadow_library_chunks_text_kind_check
             check (((text_kind = 'full_text' and excerpt_locator is null)
                     or (text_kind = 'excerpt' and btrim(coalesce(excerpt_locator, '')) <> '')));
           create trigger shadow_library_chunk_rights_guard before insert or update of document_id, text_kind, text_content, excerpt_locator
             on pilot.shadow_library_chunks for each row execute function pilot.shadow_library_chunk_rights_guard()`,
        ],
        [
          'source guard that no longer refuses',
          `create or replace function pilot.shadow_library_source_rights_guard() returns trigger language plpgsql as $f$
           begin return new; end $f$`,
          migrationSql,
        ],
        [
          'document guard that no longer locks the source it reads',
          `create or replace function pilot.shadow_library_document_rights_guard() returns trigger language plpgsql as $f$
           begin
             if exists (select 1 from pilot.shadow_library_sources where source_id = new.source_id
                         and rights_status not in ('ppbf_owned', 'open_licence'))
                and exists (select 1 from pilot.shadow_library_chunks where document_id = new.document_id and text_kind = 'full_text')
             then raise exception 'SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED'; end if;
             return new;
           end $f$`,
          migrationSql,
        ],
        [
          'source guard missing',
          'drop trigger shadow_library_source_rights_guard on pilot.shadow_library_sources',
          `create trigger shadow_library_source_rights_guard before update of rights_status
             on pilot.shadow_library_sources for each row execute function pilot.shadow_library_source_rights_guard()`,
        ],
        [
          'document guard missing',
          'drop trigger shadow_library_document_rights_guard on pilot.shadow_library_documents',
          `create trigger shadow_library_document_rights_guard before update of source_id
             on pilot.shadow_library_documents for each row execute function pilot.shadow_library_document_rights_guard()`,
        ],
      ];
      // Everything right: the readiness query passes with no SQL of its own.
      await expect(applyMigrationTransaction(client, 'select 1')).resolves.toBeUndefined();
      for (const [label, breakSql, repairSql] of breakers) {
        await client.query(breakSql);
        const refused = await applyMigrationTransaction(client, 'select 1').then(
          () => `${label}: NOT refused`,
          (error: Error) => `${label}: ${error.message}`,
        );
        expect(refused).toBe(`${label}: SOURCE_RIGHTS_NOT_READY`);
        await client.query(repairSql);
        const repaired = await applyMigrationTransaction(client, 'select 1').then(
          () => `${label}: ready`,
          (error: Error) => `${label}: ${error.message}`,
        );
        expect(repaired).toBe(`${label}: ready`);
      }
    } finally {
      await client.end();
    }
  });
});

describe('the full-text rule, held by the database for every writer', () => {
  let client: Client;
  beforeAll(async () => {
    client = await freshDatabase('ppbf_test_rights_rule');
    for (const rights of ['ppbf_owned', 'open_licence', 'licensed_excerpt_only', 'unknown']) {
      await insertSource(client, `src_${rights}`, { rights });
      await insertDocument(client, `doc_${rights}`, `src_${rights}`);
    }
  });
  afterAll(async () => {
    await client.end();
  });

  test('a new source reads unknown; no other value is accepted', async () => {
    await insertSource(client, 'src_default');
    expect(await rightsOf(client, 'src_default')).toBe('unknown');
    const refused = await errorOf(
      client.query("update pilot.shadow_library_sources set rights_status = 'fair_use' where source_id = 'src_default'"),
    );
    expect(refused.constraint).toBe('pilot_shadow_library_sources_rights_status_check');
  });

  test.each([
    ['ppbf_owned', true],
    ['open_licence', true],
    ['licensed_excerpt_only', false],
    ['unknown', false],
  ])('full text under a %s source: allowed=%s', async (rights, allowed) => {
    const attempt = insertChunk(client, `chunk_full_${rights}`, `doc_${rights}`, `src_${rights}`, { ordinal: 10 });
    if (allowed) {
      await expect(attempt).resolves.toBeUndefined();
    } else {
      const refused = await errorOf(attempt);
      expect(refused.code).toBe('23514');
      expect(refused.message).toMatch(/^SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED: the source is /);
    }
  });

  test.each(['ppbf_owned', 'open_licence', 'licensed_excerpt_only', 'unknown'])(
    'an excerpt with a locator is allowed under a %s source',
    async (rights) => {
      await expect(
        insertChunk(client, `chunk_ex_${rights}`, `doc_${rights}`, `src_${rights}`, { ordinal: 20, kind: 'excerpt', locator: 'p. 4' }),
      ).resolves.toBeUndefined();
    },
  );

  test('a writer that predates text_kind (the live /evidence intake): a metadata locator is stored as an excerpt; none is refused', async () => {
    await insertChunk(client, 'chunk_old_shape_located', 'doc_unknown', 'src_unknown', {
      ordinal: 60,
      metadata: { intake_method: 'manual_text', locator: '  p. 9 ' },
    });
    const stored = await client.query(
      "select text_kind, excerpt_locator from pilot.shadow_library_chunks where chunk_id = 'chunk_old_shape_located'",
    );
    expect(stored.rows[0]).toEqual({ text_kind: 'excerpt', excerpt_locator: 'p. 9' });

    for (const metadata of [{}, { locator: '   ' }, { locator: null }]) {
      const refused = await errorOf(
        insertChunk(client, 'chunk_old_shape_bare', 'doc_unknown', 'src_unknown', { ordinal: 61, metadata }),
      );
      expect(refused.code).toBe('23514');
    }
  });

  test('an excerpt must say where it comes from, and full text must not pretend to', async () => {
    for (const locator of [null, '', '   ']) {
      const refused = await errorOf(
        insertChunk(client, 'chunk_no_locator', 'doc_unknown', 'src_unknown', { ordinal: 30, kind: 'excerpt', locator }),
      );
      expect(refused.constraint).toBe('pilot_shadow_library_chunks_text_kind_check');
    }
    const refused = await errorOf(
      insertChunk(client, 'chunk_full_locator', 'doc_ppbf_owned', 'src_ppbf_owned', { ordinal: 31, kind: 'full_text', locator: 'p. 1' }),
    );
    expect(refused.constraint).toBe('pilot_shadow_library_chunks_text_kind_check');
  });

  // CL-C1 (audit 2026-10-05). The route trimmed with JavaScript (tabs, line
  // breaks, NBSP are blank) and the trigger with btrim (spaces only), so a
  // tab "locator" was full text to the route and an excerpt to the database,
  // and the full-text rule was never asked.
  const BLANKS = ['\t', '\n', '\r\n', '\u00a0', '\u2003', '\ufeff', ' \t\u3000\u2028 '];

  test('a whitespace-only metadata locator is no locator: under an unknown source the full-text rule refuses it', async () => {
    for (const [i, blank] of BLANKS.entries()) {
      const refused = await errorOf(
        insertChunk(client, `chunk_ws_meta_${i}`, 'doc_unknown', 'src_unknown', { ordinal: 700 + i, metadata: { locator: blank } }),
      );
      expect(refused.message).toMatch(/SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED/);
    }
    // Nor is a locator that is not text: ->> would read true as 'true'.
    for (const [i, notText] of [true, 5, {}, ['p. 1']].entries()) {
      const refused = await errorOf(
        insertChunk(client, `chunk_nt_meta_${i}`, 'doc_unknown', 'src_unknown', { ordinal: 730 + i, metadata: { locator: notText } }),
      );
      expect(refused.message).toMatch(/SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED/);
    }
    // A real locator wrapped in any of that whitespace is stored trimmed by the same rule.
    await insertChunk(client, 'chunk_ws_meta_wrapped', 'doc_unknown', 'src_unknown', {
      ordinal: 720,
      metadata: { locator: '\u00a0\tp. 9\n' },
    });
    const stored = await client.query(
      "select text_kind, excerpt_locator from pilot.shadow_library_chunks where chunk_id = 'chunk_ws_meta_wrapped'",
    );
    expect(stored.rows[0]).toEqual({ text_kind: 'excerpt', excerpt_locator: 'p. 9' });
  });

  test('a whitespace-only excerpt_locator is refused on insert, and when an update sets one', async () => {
    for (const [i, blank] of BLANKS.entries()) {
      const refused = await errorOf(
        insertChunk(client, `chunk_ws_ex_${i}`, 'doc_ppbf_owned', 'src_ppbf_owned', { ordinal: 740 + i, kind: 'excerpt', locator: blank }),
      );
      expect(refused.code).toBe('23514');
    }
    await insertChunk(client, 'chunk_ws_ex_ok', 'doc_unknown', 'src_unknown', { ordinal: 760, kind: 'excerpt', locator: 'p. 2' });
    const refused = await errorOf(
      client.query("update pilot.shadow_library_chunks set excerpt_locator = E'\\t' where chunk_id = 'chunk_ws_ex_ok'"),
    );
    expect(refused.code).toBe('23514');
  });

  test('a row already holding a whitespace-only locator is not blocked by an edit that leaves the locator alone', async () => {
    await client.query('alter table pilot.shadow_library_chunks disable trigger shadow_library_chunk_rights_guard');
    try {
      await insertChunk(client, 'chunk_ws_legacy', 'doc_ppbf_owned', 'src_ppbf_owned', { ordinal: 780, kind: 'excerpt', locator: '\t' });
    } finally {
      await client.query('alter table pilot.shadow_library_chunks enable trigger shadow_library_chunk_rights_guard');
    }
    await client.query("update pilot.shadow_library_chunks set text_content = 'edited' where chunk_id = 'chunk_ws_legacy'");
    await client.query("update pilot.shadow_library_chunks set excerpt_locator = 'p. 3' where chunk_id = 'chunk_ws_legacy'");
    const stored = await client.query(
      "select text_content, excerpt_locator from pilot.shadow_library_chunks where chunk_id = 'chunk_ws_legacy'",
    );
    expect(stored.rows[0]).toEqual({ text_content: 'edited', excerpt_locator: 'p. 3' });
  });

  test('a re-apply does not turn full text with a whitespace-only metadata locator into an "excerpt"', async () => {
    await insertChunk(client, 'chunk_ws_reapply', 'doc_ppbf_owned', 'src_ppbf_owned', { ordinal: 790, metadata: { locator: '\t' } });
    await client.query(migrationSql);
    const stored = await client.query(
      "select text_kind, excerpt_locator from pilot.shadow_library_chunks where chunk_id = 'chunk_ws_reapply'",
    );
    expect(stored.rows[0]).toEqual({ text_kind: 'full_text', excerpt_locator: null });
  });

  test('the document\'s source decides, not the source a chunk cites (the seed\'s synthesis pattern)', async () => {
    await expect(
      insertChunk(client, 'chunk_cites_unknown', 'doc_ppbf_owned', 'src_unknown', { ordinal: 40 }),
    ).resolves.toBeUndefined();
    const refused = await errorOf(
      insertChunk(client, 'chunk_cites_owned', 'doc_unknown', 'src_ppbf_owned', { ordinal: 41 }),
    );
    expect(refused.code).toBe('23514');
  });

  test('an excerpt cannot be turned into full text, or moved as full text, under a lower source', async () => {
    const toFull = await errorOf(
      client.query(
        "update pilot.shadow_library_chunks set text_kind = 'full_text', excerpt_locator = null where chunk_id = 'chunk_ex_unknown'",
      ),
    );
    expect(toFull.code).toBe('23514');
    const moved = await errorOf(
      client.query("update pilot.shadow_library_chunks set document_id = 'doc_unknown' where chunk_id = 'chunk_full_ppbf_owned'"),
    );
    expect(moved.code).toBe('23514');
  });

  test('a legacy full-text chunk under an unknown source stays readable and embeddable, but its text cannot be rewritten', async () => {
    await client.query('alter table pilot.shadow_library_chunks disable trigger shadow_library_chunk_rights_guard');
    await insertChunk(client, 'chunk_legacy_unknown', 'doc_unknown', 'src_unknown', { ordinal: 50 });
    await client.query('alter table pilot.shadow_library_chunks enable trigger shadow_library_chunk_rights_guard');

    await expect(
      client.query(
        `update pilot.shadow_library_chunks set metadata = metadata || '{"k":1}', organization_id = organization_id
         where chunk_id = 'chunk_legacy_unknown'`,
      ),
    ).resolves.toBeDefined();
    const rewritten = await errorOf(
      client.query("update pilot.shadow_library_chunks set text_content = 'new words' where chunk_id = 'chunk_legacy_unknown'"),
    );
    expect(rewritten.code).toBe('23514');
    await client.query("delete from pilot.shadow_library_chunks where chunk_id = 'chunk_legacy_unknown'");
  });

  test('a source holding full text cannot drop below full-text level; one holding only excerpts can', async () => {
    const lowered = await errorOf(
      client.query("update pilot.shadow_library_sources set rights_status = 'unknown' where source_id = 'src_open_licence'"),
    );
    expect(lowered.code).toBe('23514');
    expect(lowered.message).toMatch(/^SHADOW_LIBRARY_RIGHTS_LOWERED_UNDER_FULL_TEXT: /);
    // ppbf_owned -> open_licence keeps full text allowed.
    await expect(
      client.query("update pilot.shadow_library_sources set rights_status = 'open_licence' where source_id = 'src_ppbf_owned'"),
    ).resolves.toBeDefined();
    await client.query("update pilot.shadow_library_sources set rights_status = 'ppbf_owned' where source_id = 'src_ppbf_owned'");
    // Only excerpts under it: free to lower.
    await expect(
      client.query("update pilot.shadow_library_sources set rights_status = 'unknown' where source_id = 'src_licensed_excerpt_only'"),
    ).resolves.toBeDefined();
    await client.query("update pilot.shadow_library_sources set rights_status = 'licensed_excerpt_only' where source_id = 'src_licensed_excerpt_only'");
  });

  test('a document holding full text cannot move under a lower source; an excerpt-only document can', async () => {
    const moved = await errorOf(
      client.query("update pilot.shadow_library_documents set source_id = 'src_unknown' where document_id = 'doc_ppbf_owned'"),
    );
    expect(moved.code).toBe('23514');
    await insertDocument(client, 'doc_excerpts_only', 'src_ppbf_owned');
    await insertChunk(client, 'chunk_only_excerpt', 'doc_excerpts_only', 'src_ppbf_owned', { kind: 'excerpt', locator: '00:12:30' });
    await expect(
      client.query("update pilot.shadow_library_documents set source_id = 'src_unknown' where document_id = 'doc_excerpts_only'"),
    ).resolves.toBeDefined();
  });

  // Waits until `pid` is blocked on a lock, read through `observer`. Proves the
  // second writer really waited for the first, rather than happening to run
  // after its commit.
  async function waitUntilLockWaiting(observer: Client, pid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const row = await observer.query('select wait_event_type from pg_stat_activity where pid = $1', [pid]);
      if (row.rows[0]?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`backend ${pid} never waited on a lock`);
  }

  async function pidOf(c: Client): Promise<number> {
    return (await c.query('select pg_backend_pid() as pid')).rows[0].pid;
  }

  test('concurrent: a full-text write and a rights drop cannot both commit, in either order', async () => {
    await insertSource(client, 'src_race', { rights: 'open_licence' });
    await insertDocument(client, 'doc_race', 'src_race');
    const other = new Client({ connectionString: connectionStringFor('ppbf_test_rights_rule') });
    await other.connect();
    try {
      const clientPid = await pidOf(client);
      const otherPid = await pidOf(other);

      // Chunk first: the drop waits for it, then sees it and refuses.
      await client.query('begin');
      await insertChunk(client, 'chunk_race_1', 'doc_race', 'src_race');
      const drop = errorOf(
        other.query("update pilot.shadow_library_sources set rights_status = 'unknown' where source_id = 'src_race'"),
      );
      await waitUntilLockWaiting(client, otherPid);
      await client.query('commit');
      expect((await drop).code).toBe('23514');
      expect(await rightsOf(client, 'src_race')).toBe('open_licence');

      // Drop first (before any full text): the chunk waits for it, then sees unknown and refuses.
      await client.query("delete from pilot.shadow_library_chunks where chunk_id = 'chunk_race_1'");
      await other.query('begin');
      await other.query("update pilot.shadow_library_sources set rights_status = 'unknown' where source_id = 'src_race'");
      const write = errorOf(insertChunk(client, 'chunk_race_2', 'doc_race', 'src_race'));
      await waitUntilLockWaiting(other, clientPid);
      await other.query('commit');
      expect((await write).code).toBe('23514');
      const left = await client.query("select count(*)::int as n from pilot.shadow_library_chunks where document_id = 'doc_race'");
      expect(left.rows[0].n).toBe(0);
    } finally {
      await other.end();
    }
  });

  test('concurrent: a document re-pointed to a lower source while a full-text chunk waits for it -- the chunk is refused', async () => {
    await insertSource(client, 'src_repoint_owned', { rights: 'ppbf_owned' });
    await insertSource(client, 'src_repoint_unknown');
    await insertDocument(client, 'doc_repoint', 'src_repoint_owned');
    const other = new Client({ connectionString: connectionStringFor('ppbf_test_rights_rule') });
    await other.connect();
    try {
      const clientPid = await pidOf(client);
      // The move passes on its own: the document holds no full text yet.
      await other.query('begin');
      await other.query("update pilot.shadow_library_documents set source_id = 'src_repoint_unknown' where document_id = 'doc_repoint'");
      const write = errorOf(insertChunk(client, 'chunk_repoint', 'doc_repoint', 'src_repoint_owned'));
      await waitUntilLockWaiting(other, clientPid);
      await other.query('commit');
      const refused = await write;
      expect(refused.code).toBe('23514');
      expect(refused.message).toMatch(/the source is unknown/);
      const left = await client.query("select count(*)::int as n from pilot.shadow_library_chunks where document_id = 'doc_repoint'");
      expect(left.rows[0].n).toBe(0);
    } finally {
      await other.end();
    }
  });
});

describe('the research importer under the rule', () => {
  test('loads the whole 2026-08-07 corpus: 21 PPBF sources ppbf_owned, 980 unknown, every chunk stored', async () => {
    const client = await freshDatabase('ppbf_test_rights_importer');
    try {
      const loadSeedPackage = importer.loadSeedPackage as (o: Record<string, unknown>) => Promise<unknown>;
      const importSeedPackage = importer.importSeedPackage as (c: Client, s: unknown, org: string) => Promise<void>;
      const seed = await loadSeedPackage({
        seedDir: importer.DEFAULT_SEED_DIR,
        organizationId: ORG,
        accountId: ADMIN,
        createdByRole: 'organization_admin',
      });
      await importSeedPackage(client, seed, ORG);
      const rights = await client.query(
        `select rights_status, count(*)::int as n from pilot.shadow_library_sources
          where organization_id = $1 group by rights_status order by rights_status`,
        [ORG],
      );
      expect(rights.rows).toEqual([
        { rights_status: 'ppbf_owned', n: 21 },
        { rights_status: 'unknown', n: 980 },
      ]);
      const chunks = await client.query(
        'select count(*)::int as n from pilot.shadow_library_chunks where organization_id = $1',
        [ORG],
      );
      expect(chunks.rows[0].n).toBe(1193);

      // A re-run never lowers what a reviewer marked.
      await client.query(
        "update pilot.shadow_library_sources set rights_status = 'open_licence' where source_id = 'src_6a5f99045eae8a7c'",
      );
      await importSeedPackage(client, seed, ORG);
      expect(await rightsOf(client, 'src_6a5f99045eae8a7c')).toBe('open_licence');
    } finally {
      await client.end();
    }
  });
});

describe('the routes answer the rule in plain words', () => {
  let routes: {
    postSource: (r: NextRequest) => Promise<Response>;
    patchSource: (r: NextRequest) => Promise<Response>;
    postDocument: (r: NextRequest) => Promise<Response>;
    postChunk: (r: NextRequest) => Promise<Response>;
  };

  function principal(role: PilotPrincipal['role']): PilotPrincipal {
    return { accountId: ADMIN, role, organizationId: ORG } as PilotPrincipal;
  }

  function request(method: string, url: string, body: unknown): NextRequest {
    return new NextRequest(`http://localhost${url}`, {
      method,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  async function call(handler: (r: NextRequest) => Promise<Response>, method: string, url: string, body: unknown) {
    const response = await handler(request(method, url, body));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    const client = await freshDatabase(ROUTE_DB);
    await client.end();
    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(ROUTE_DB);
    process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
    routes = {
      postSource: (await import('@/app/api/pilot/shadow/library/sources/route')).POST,
      patchSource: (await import('@/app/api/pilot/shadow/library/sources/route')).PATCH,
      postDocument: (await import('@/app/api/pilot/shadow/library/documents/route')).POST,
      postChunk: (await import('@/app/api/pilot/shadow/library/chunks/route')).POST,
    };
  });

  beforeEach(() => {
    mockRequirePrincipal.mockReset();
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
  });

  test('register (unknown by default), refuse full text with a 422, accept an excerpt, mark the source, then full text loads; lowering is refused', async () => {
    const source = await call(routes.postSource, 'POST', '/api/pilot/shadow/library/sources', {
      title: 'Rights Route Paper',
      source_type: 'peer_reviewed',
    });
    expect(source.status).toBe(201);
    const sourceRow = source.body.source as { source_id: string; rights_status: string };
    expect(sourceRow.rights_status).toBe('unknown');

    const bad = await call(routes.postSource, 'POST', '/api/pilot/shadow/library/sources', {
      title: 'Bad Rights', source_type: 'peer_reviewed', rights_status: 'fair_use',
    });
    expect(bad.status).toBe(400);

    const document = await call(routes.postDocument, 'POST', '/api/pilot/shadow/library/documents', {
      source_id: sourceRow.source_id,
      document_name: 'Rights route doc',
    });
    expect(document.status).toBe(201);
    const documentId = (document.body.document as { document_id: string }).document_id;

    const full = await call(routes.postChunk, 'POST', '/api/pilot/shadow/library/chunks', {
      document_id: documentId, ordinal: 0, text_content: 'Whole chapter.',
    });
    expect(full.status).toBe(422);
    expect(full.body.error).toMatch(/may hold only excerpts/);

    const excerpt = await call(routes.postChunk, 'POST', '/api/pilot/shadow/library/chunks', {
      document_id: documentId, ordinal: 0, text_content: 'A chosen passage.', excerpt_locator: 'p. 7',
    });
    expect(excerpt.status).toBe(201);
    expect(excerpt.body.chunk).toMatchObject({ text_kind: 'excerpt', excerpt_locator: 'p. 7' });

    // A page loaded before the field existed: the intake's metadata.locator counts.
    const legacyClient = await call(routes.postChunk, 'POST', '/api/pilot/shadow/library/chunks', {
      document_id: documentId, ordinal: 1, text_content: 'Next passage.', metadata: { locator: 'p. 8' },
    });
    expect(legacyClient.status).toBe(201);
    expect(legacyClient.body.chunk).toMatchObject({ text_kind: 'excerpt', excerpt_locator: 'p. 8' });

    const tooLong = await call(routes.postChunk, 'POST', '/api/pilot/shadow/library/chunks', {
      document_id: documentId, ordinal: 2, text_content: 'x', excerpt_locator: 'p'.repeat(201),
    });
    expect(tooLong.status).toBe(400);
    const longFallback = await call(routes.postChunk, 'POST', '/api/pilot/shadow/library/chunks', {
      document_id: documentId, ordinal: 2, text_content: 'x', metadata: { locator: 'p'.repeat(201) },
    });
    expect(longFallback.status).toBe(400);

    const blank = await call(routes.postChunk, 'POST', '/api/pilot/shadow/library/chunks', {
      document_id: documentId, ordinal: 2, text_content: 'x', excerpt_locator: '   ',
    });
    expect(blank.status).toBe(400);

    const both = await call(routes.patchSource, 'PATCH', '/api/pilot/shadow/library/sources', {
      source_id: sourceRow.source_id, rights_status: 'open_licence', classification_domain: 'R01',
    });
    expect(both.status).toBe(400);

    const marked = await call(routes.patchSource, 'PATCH', '/api/pilot/shadow/library/sources', {
      source_id: sourceRow.source_id, rights_status: 'open_licence',
    });
    expect(marked.status).toBe(200);
    expect((marked.body.source as { rights_status: string }).rights_status).toBe('open_licence');

    const fullNow = await call(routes.postChunk, 'POST', '/api/pilot/shadow/library/chunks', {
      document_id: documentId, ordinal: 3, text_content: 'Open-licence full text.',
    });
    expect(fullNow.status).toBe(201);
    expect(fullNow.body.chunk).toMatchObject({ text_kind: 'full_text', excerpt_locator: null });

    const lowered = await call(routes.patchSource, 'PATCH', '/api/pilot/shadow/library/sources', {
      source_id: sourceRow.source_id, rights_status: 'licensed_excerpt_only',
    });
    expect(lowered.status).toBe(422);
    expect(lowered.body.error).toMatch(/already holds full text/);

    const missing = await call(routes.patchSource, 'PATCH', '/api/pilot/shadow/library/sources', {
      source_id: 'source_nowhere', rights_status: 'open_licence',
    });
    expect(missing.status).toBe(404);
  });

  test('a role outside the reviewer tier cannot set rights', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    const refused = await call(routes.patchSource, 'PATCH', '/api/pilot/shadow/library/sources', {
      source_id: 'source_any', rights_status: 'ppbf_owned',
    });
    expect(refused.status).toBe(403);
  });
});
