// Real PostgreSQL contract test for pilot_slice_postgres_research_archive_originals_migration.sql
// (issue #345, lane L57 PR A: which PDF a Library source was filed as in the SharePoint Research
// Archive, and which filed PDF an excerpt came from).
//
// What needs a real database to prove: that one PDF is one row per shelf and one SharePoint item
// may stand for it on both shelves; that an original belongs to a source on its own shelf, and an
// excerpt may point only at an original of its own source on its own shelf -- including after a
// move; that only subject folders R01-R19 are accepted and the filed name keeps the writer's
// allowlist; that a later version names an earlier one of the same source; that nothing is removed
// while something points at it, while the purge's document delete still works; that existing
// document writes are untouched; that re-applying is a no-op; that the file holds nothing
// destructive; and that the runner's readiness refuses a result it did not produce. Spins up the
// disposable local embedded Postgres the other migration suites use. It never connects to
// production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-archive-originals-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-research-archive-originals-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_research_archive_originals_migration.sql';
const TEMPLATE_DB = 'arcorig_template';

const ORG = 'org-arcorig';
const PLATFORM = '__platform__';
const SOURCE = 'src_arcorig_paper';
const OTHER_SOURCE = 'src_arcorig_other';
const PLATFORM_SOURCE = 'src_arcorig_platform';
const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyRunner: Apply;
let migrationSql: string;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/** A clone of the fully migrated template (or an empty database), so each test starts clean. */
async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  await adminQuery(`drop database if exists ${name} with (force)`);
  await adminQuery(schema === 'full' ? `create database ${name} template ${TEMPLATE_DB}` : `create database ${name}`);
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

interface OriginalValues {
  id?: string;
  org?: string;
  source?: string;
  itemId?: string;
  sha?: string;
  domain?: string;
  filename?: string;
  channel?: string;
  versionKind?: string;
  supersedes?: string | null;
}

function fileOriginal(client: Client, values: OriginalValues = {}) {
  const sha = values.sha ?? SHA;
  return client.query(
    `insert into pilot.shadow_library_archived_originals
       (archived_original_id, organization_id, source_id, site_id, drive_id, item_id, web_url,
        archive_root_item_id, archive_domain_code, archive_filename, original_filename, content_sha256,
        byte_size, acquisition_provider, acquisition_channel, acquired_at, version_kind,
        supersedes_archived_original_id, created_by_account_id, created_by_role)
     values ($1, $2, $3, 'site-guid', 'b!drive', $4, 'https://example.sharepoint.com/x.pdf',
             'ROOTITEM', $5, $6, 'Paper One.pdf', $7, 1024, 'Penn State University Libraries', $8,
             '2026-10-17T00:00:00Z', $9, $10, 'acct-arcorig-curator', 'organization_admin')`,
    [
      values.id ?? 'arc_one',
      values.org ?? ORG,
      values.source ?? SOURCE,
      values.itemId ?? 'ITEM1',
      values.domain ?? 'R19',
      values.filename ?? `Paper One--${sha.slice(0, 12)}.pdf`,
      sha,
      values.channel ?? 'library_database',
      values.versionKind ?? 'version_of_record',
      values.supersedes ?? null,
    ],
  );
}

function fileExcerpt(
  client: Client,
  values: { id?: string; source?: string; org?: string; archivedOriginalId?: string | null; subjectId?: string | null } = {},
) {
  return client.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, document_name, archived_original_id, subject_id)
     values ($1, $2, $3, 'Excerpt, page 3', $4, $5)`,
    [values.id ?? 'doc_one', values.source ?? SOURCE, values.org ?? ORG, values.archivedOriginalId ?? null, values.subjectId ?? null],
  );
}

async function count(client: Client, table: string): Promise<number> {
  const result = await client.query(`select count(*)::int as n from pilot.${table}`);
  return result.rows[0].n;
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  // The whole schema once, in the `all` order (which now includes this migration), plus the
  // gym, two sources on its shelf and one on the platform shelf. Every test clones it.
  await adminQuery(`drop database if exists ${TEMPLATE_DB} with (force)`);
  await adminQuery(`create database ${TEMPLATE_DB}`);
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    await template.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')
       on conflict do nothing`,
      [ORG],
    );
    await template.query(
      `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url)
       values ($1, $4, 'A paper', 'peer_reviewed', 1, 'https://example.org/paper'),
              ($2, $4, 'Another paper', 'peer_reviewed', 1, 'https://example.org/other'),
              ($3, $5, 'A platform paper', 'peer_reviewed', 1, 'https://example.org/platform')`,
      [SOURCE, OTHER_SOURCE, PLATFORM_SOURCE, ORG, PLATFORM],
    );
  } finally {
    await template.end();
  }
});

afterAll(async () => {
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

describe('research archive originals migration (issue #345)', () => {
  test('an original is stored with its defaults, and re-applying through the runner is a no-op', async () => {
    const client = await freshDatabase('arcorig_store');
    try {
      await fileOriginal(client);
      await fileExcerpt(client, { archivedOriginalId: 'arc_one' });

      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const row = await client.query(
        `select provider, version_kind, archive_domain_code, content_sha256
           from pilot.shadow_library_archived_originals`,
      );
      expect(row.rows).toEqual([
        { provider: 'sharepoint', version_kind: 'version_of_record', archive_domain_code: 'R19', content_sha256: SHA },
      ]);
      const doc = await client.query('select archived_original_id from pilot.shadow_library_documents');
      expect(doc.rows).toEqual([{ archived_original_id: 'arc_one' }]);

      await client.query(
        `insert into pilot.shadow_library_archived_originals
           (archived_original_id, organization_id, source_id, site_id, drive_id, item_id, archive_root_item_id,
            archive_domain_code, archive_filename, original_filename, content_sha256, byte_size,
            acquisition_provider, acquisition_channel, acquired_at, created_by_account_id, created_by_role)
         values ('arc_defaults', $1, $2, 's', 'd', 'ITEM9', 'ROOT', 'R01', 'x.pdf', 'x.pdf', $3, 1,
                 'PPBF', 'ppbf_created', now(), 'acct', 'coach')`,
        [ORG, SOURCE, OTHER_SHA],
      );
      const defaults = await client.query(
        `select provider, version_kind from pilot.shadow_library_archived_originals where archived_original_id = 'arc_defaults'`,
      );
      expect(defaults.rows).toEqual([{ provider: 'sharepoint', version_kind: 'unknown' }]);
    } finally {
      await client.end();
    }
  });

  test('one PDF is one row per shelf; one SharePoint item may stand for it on both shelves', async () => {
    const client = await freshDatabase('arcorig_dupes');
    try {
      await fileOriginal(client);
      await expect(fileOriginal(client, { id: 'arc_again', itemId: 'ITEM2' })).rejects.toMatchObject({
        code: '23505',
        constraint: 'pilot_shadow_library_archived_originals_org_sha_key',
      });
      await expect(fileOriginal(client, { id: 'arc_same_item', sha: OTHER_SHA })).rejects.toMatchObject({
        code: '23505',
        constraint: 'pilot_shadow_library_archived_originals_org_item_key',
      });

      // The platform shelf files the same bytes: the same SharePoint item, its own row.
      await fileOriginal(client, { id: 'arc_platform', org: PLATFORM, source: PLATFORM_SOURCE });
      expect(await count(client, 'shadow_library_archived_originals')).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('an original belongs to a source on its own shelf', async () => {
    const client = await freshDatabase('arcorig_source_shelf');
    try {
      await expect(fileOriginal(client, { source: PLATFORM_SOURCE })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_shadow_library_archived_originals_source_fk',
      });
      await expect(fileOriginal(client, { source: 'src_missing' })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_shadow_library_archived_originals_source_fk',
      });
      expect(await count(client, 'shadow_library_archived_originals')).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('only subject folders R01-R19 are accepted: never Unsorted Drop, Duplicate Hold or a made-up code', async () => {
    const client = await freshDatabase('arcorig_domain');
    try {
      for (const domain of ['R00', 'R98', 'R20', 'R1', 'r19', 'R19 - Measurement and Assessment Instruments', '']) {
        await expect(fileOriginal(client, { domain })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_shadow_library_archived_originals_domain_check',
        });
      }
      await fileOriginal(client, { id: 'arc_r01', domain: 'R01' });
      await fileOriginal(client, { id: 'arc_r19', domain: 'R19', sha: OTHER_SHA, itemId: 'ITEM2' });
      expect(await count(client, 'shadow_library_archived_originals')).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('the filed name keeps the archive writer allowlist, and the hash is a lowercase sha-256', async () => {
    const client = await freshDatabase('arcorig_names');
    try {
      for (const filename of ['../evil.pdf', 'a/b.pdf', 'a\\b.pdf', '.hidden.pdf', 'paper.txt', 'paper.pdf.exe', '']) {
        await expect(fileOriginal(client, { filename })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_shadow_library_archived_originals_filename_check',
        });
      }
      for (const sha of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`]) {
        await expect(fileOriginal(client, { sha, filename: 'paper.pdf' })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_shadow_library_archived_originals_sha256_check',
        });
      }
      await fileOriginal(client, { filename: 'Paper One--aaaaaaaaaaaa.PDF' });
      expect(await count(client, 'shadow_library_archived_originals')).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('acquisition channel and version are the fixed values', async () => {
    const client = await freshDatabase('arcorig_values');
    try {
      await expect(fileOriginal(client, { channel: 'email' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_shadow_library_archived_originals_channel_check',
      });
      await expect(fileOriginal(client, { versionKind: 'preprint' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_shadow_library_archived_originals_version_kind_check',
      });
      expect(await count(client, 'shadow_library_archived_originals')).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('an excerpt may point only at an original of its own source on its own shelf, even after a move', async () => {
    const client = await freshDatabase('arcorig_link');
    try {
      await fileOriginal(client);
      await fileOriginal(client, { id: 'arc_platform', org: PLATFORM, source: PLATFORM_SOURCE });

      // Today's writes, unlinked, are untouched.
      await fileExcerpt(client, { id: 'doc_typed' });
      await fileExcerpt(client, { id: 'doc_linked', archivedOriginalId: 'arc_one' });

      await expect(
        fileExcerpt(client, { id: 'doc_wrong_source', source: OTHER_SOURCE, archivedOriginalId: 'arc_one' }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'pilot_shadow_library_documents_archived_original_fk' });
      await expect(
        fileExcerpt(client, { id: 'doc_wrong_shelf', archivedOriginalId: 'arc_platform' }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'pilot_shadow_library_documents_archived_original_fk' });
      await expect(fileExcerpt(client, { id: 'doc_missing', archivedOriginalId: 'arc_missing' })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_shadow_library_documents_archived_original_fk',
      });

      // A linked excerpt cannot be moved to another source; an unlinked one still can.
      await expect(
        client.query(`update pilot.shadow_library_documents set source_id = $1 where document_id = 'doc_linked'`, [OTHER_SOURCE]),
      ).rejects.toMatchObject({ code: '23503', constraint: 'pilot_shadow_library_documents_archived_original_fk' });
      await client.query(`update pilot.shadow_library_documents set source_id = $1 where document_id = 'doc_typed'`, [
        OTHER_SOURCE,
      ]);
      expect(await count(client, 'shadow_library_documents')).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('a document about an athlete is never linked to an archive original', async () => {
    const client = await freshDatabase('arcorig_subject');
    try {
      await fileOriginal(client);
      await expect(
        fileExcerpt(client, { id: 'doc_athlete', archivedOriginalId: 'arc_one', subjectId: 'ATH-1' }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_shadow_library_documents_archived_original_subject_check' });

      // Athlete documents themselves are untouched, and a linked excerpt cannot be given a subject later.
      await fileExcerpt(client, { id: 'doc_athlete_unlinked', subjectId: 'ATH-1' });
      await fileExcerpt(client, { id: 'doc_linked', archivedOriginalId: 'arc_one' });
      await expect(
        client.query(`update pilot.shadow_library_documents set subject_id = 'ATH-1' where document_id = 'doc_linked'`),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_shadow_library_documents_archived_original_subject_check' });
      expect(await count(client, 'shadow_library_documents')).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('a later version names an earlier one of the same source on the same shelf, never itself', async () => {
    const client = await freshDatabase('arcorig_supersedes');
    try {
      await fileOriginal(client, { versionKind: 'accepted_manuscript' });
      await fileOriginal(client, {
        id: 'arc_vor',
        sha: OTHER_SHA,
        itemId: 'ITEM2',
        versionKind: 'version_of_record',
        supersedes: 'arc_one',
      });
      await expect(
        fileOriginal(client, { id: 'arc_self', sha: 'c'.repeat(64), itemId: 'ITEM3', supersedes: 'arc_self' }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_shadow_library_archived_originals_not_self_check' });

      await client.query(
        `insert into pilot.shadow_library_archived_originals
           (archived_original_id, organization_id, source_id, site_id, drive_id, item_id, archive_root_item_id,
            archive_domain_code, archive_filename, original_filename, content_sha256, byte_size,
            acquisition_provider, acquisition_channel, acquired_at, created_by_account_id, created_by_role)
         values ('arc_other', $1, $2, 's', 'd', 'ITEM4', 'ROOT', 'R01', 'y.pdf', 'y.pdf', $3, 1,
                 'PPBF', 'ppbf_created', now(), 'acct', 'coach')`,
        [ORG, OTHER_SOURCE, 'd'.repeat(64)],
      );
      await expect(
        fileOriginal(client, { id: 'arc_cross', sha: 'e'.repeat(64), itemId: 'ITEM5', supersedes: 'arc_other' }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'pilot_shadow_library_archived_originals_supersedes_fk' });
      expect(await count(client, 'shadow_library_archived_originals')).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('nothing is removed while something points at it, and the purge document delete still works', async () => {
    const client = await freshDatabase('arcorig_restrict');
    try {
      await fileOriginal(client);
      await fileExcerpt(client, { archivedOriginalId: 'arc_one' });

      // 23001 restrict_violation: ON DELETE RESTRICT refuses at once, before any cascade could act.
      await expect(client.query('delete from pilot.shadow_library_sources where source_id = $1', [SOURCE])).rejects.toMatchObject(
        { code: '23001', constraint: 'pilot_shadow_library_archived_originals_source_fk' },
      );
      await expect(
        client.query(`delete from pilot.shadow_library_archived_originals where archived_original_id = 'arc_one'`),
      ).rejects.toMatchObject({ code: '23001', constraint: 'pilot_shadow_library_documents_archived_original_fk' });

      // The child side, which pilot-cleanup-deleted-data.mjs deletes, is not held up.
      await client.query(`delete from pilot.shadow_library_documents where document_id = 'doc_one'`);
      expect(await count(client, 'shadow_library_documents')).toBe(0);
      expect(await count(client, 'shadow_library_archived_originals')).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive and changes no existing row', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|schema|function|constraint|trigger)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\bupdate\s+pilot\./);
    expect(sql).not.toMatch(/\bbegin\s*;|\bcommit\s*;/);
    // The one existing table it alters gains a nullable column and a key; nothing else.
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat.match(/alter table pilot\.\w+ add (column|constraint)/g)).toEqual([
      'alter table pilot.shadow_library_documents add column',
      'alter table pilot.shadow_library_documents add constraint',
      'alter table pilot.shadow_library_documents add constraint',
    ]);
    expect(flat.match(/alter table/g)).toHaveLength(3);
  });

  test('every constraint and index the file declares has a readiness check in the runner', async () => {
    const runnerSource = await fs.readFile(RUNNER_PATH, 'utf8');
    const declared = [
      ...migrationSql.matchAll(/\b(?:add\s+)?constraint\s+(pilot_\w+)/gi),
      ...migrationSql.matchAll(/create\s+index\s+if\s+not\s+exists\s+(\w+)/gi),
    ].map((match) => match[1]);
    expect(new Set(declared).size).toBe(23);
    for (const name of declared) {
      expect(runnerSource).toContain(`'${name}'`);
    }
  });

  test('the runner refuses a looser rule kept under the right name', async () => {
    const swaps: Array<[string, string, string, string]> = [
      [
        'shadow_library_archived_originals',
        'pilot_shadow_library_archived_originals_domain_check',
        "check (archive_domain_code ~ '^R[0-9]{2}$')",
        'domain_check_ready',
      ],
      [
        'shadow_library_archived_originals',
        'pilot_shadow_library_archived_originals_filename_check',
        "check (archive_filename ~* '\\.pdf$')",
        'filename_check_ready',
      ],
      [
        'shadow_library_archived_originals',
        'pilot_shadow_library_archived_originals_source_fk',
        'foreign key (source_id, organization_id) references pilot.shadow_library_sources(source_id, organization_id) on delete cascade',
        'source_fk_ready',
      ],
      [
        'shadow_library_documents',
        'pilot_shadow_library_documents_archived_original_fk',
        'foreign key (archived_original_id) references pilot.shadow_library_archived_originals(archived_original_id) on delete restrict',
        'documents_fk_ready',
      ],
      [
        'shadow_library_documents',
        'pilot_shadow_library_documents_archived_original_fk',
        'foreign key (archived_original_id, source_id, organization_id) references pilot.shadow_library_archived_originals(archived_original_id, source_id, organization_id) on delete cascade',
        'documents_fk_ready',
      ],
    ];
    for (const [index, [table, name, looser, flag]] of swaps.entries()) {
      const client = await freshDatabase(`arcorig_loose_${index}`);
      try {
        await client.query(`alter table pilot.${table} drop constraint ${name}`);
        await client.query(`alter table pilot.${table} add constraint ${name} ${looser}`);
        await expect(applyRunner(client, migrationSql)).rejects.toThrow(`RESEARCH_ARCHIVE_ORIGINALS_NOT_READY: ${flag}`);
      } finally {
        await client.end();
      }
    }
  });

  test('the runner refuses a same-named table or index of a looser shape', async () => {
    const changes: Array<[string, string]> = [
      // A nullable hash: the unique key would no longer mean one row per PDF.
      ['alter table pilot.shadow_library_archived_originals alter column content_sha256 drop not null', 'columns_ready'],
      ['alter table pilot.shadow_library_archived_originals alter column version_kind drop default', 'columns_ready'],
      [
        `drop index pilot.idx_shadow_library_documents_archived_original;
         create index idx_shadow_library_documents_archived_original on pilot.shadow_library_documents(source_id)`,
        'documents_index_ready',
      ],
    ];
    for (const [index, [change, flag]] of changes.entries()) {
      const client = await freshDatabase(`arcorig_shape_${index}`);
      try {
        await client.query(change);
        await expect(applyRunner(client, migrationSql)).rejects.toThrow(`RESEARCH_ARCHIVE_ORIGINALS_NOT_READY: ${flag}`);
      } finally {
        await client.end();
      }
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    const client = await freshDatabase('arcorig_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('RESEARCH_ARCHIVE_ORIGINALS_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
