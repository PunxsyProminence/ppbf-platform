// Real PostgreSQL test for researchArchiveFiling.ts (issue #345; lane L57 PR B): filing a
// research PDF in the SharePoint Research Archive and recording where it went.
//
// The database is real (embedded Postgres, the full schema in the `all` order). Microsoft
// Graph is mocked at fetch, because no test has Graph credentials and no CI run may write to
// the real archive; what Graph does with these requests is the supervised synthetic-PDF proof
// (lane L57 plan section 7). So this proves the ORDER and the DECISIONS: a repeat files nothing
// and calls Graph not at all; an unclassified source is never filed in a guessed folder; a
// filed-but-unrecorded original is recovered by hash, never overwritten or deleted; a different
// file under the same name is refused; a lost race returns the winner; filing approves nothing.
// It never connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import type { ResearchArchiveConfig } from './researchArchiveWrite';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-archive-filing-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEST_DB = 'ppbf_test_research_archive_filing';

const ORG = 'org-arcfile';
const PLATFORM = '__platform__';
const PAPER = 'src_arcfile_paper';
const OTHER_PAPER = 'src_arcfile_other';
const UNCLASSIFIED = 'src_arcfile_unclassified';
const PLATFORM_PAPER = 'src_arcfile_platform';

const ROOT = 'ROOTITEM';
const FOLDER_19 = 'FOLDER19';
const BASE = 'https://graph.microsoft.com/v1.0/sites/site-guid/drives/b!drive';
const LIST_URL = `${BASE}/items/${ROOT}/children?$select=id,name,folder,parentReference&$top=200`;

const PDF = Buffer.from('%PDF-1.4 synthetic archive proof, not research');
const SHA = createHash('sha256').update(PDF).digest('hex');
const FILED_NAME = `Paper One--${SHA.slice(0, 12)}.pdf`;
const ITEM_URL = `${BASE}/items/${FOLDER_19}:/${encodeURIComponent(FILED_NAME)}`;
const PUT_URL = `${ITEM_URL}:/content?@microsoft.graph.conflictBehavior=fail`;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type Filing = typeof import('./researchArchiveFiling');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let filing: Filing;
let fetchMock: jest.Mock;
const getAccessToken = jest.fn(async () => 'test-token');
const CONFIG: ResearchArchiveConfig = { siteId: 'site-guid', driveId: 'b!drive', archiveRootItemId: ROOT, getAccessToken };

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

async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB) });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function bytesResponse(bytes: Buffer): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

const ROOT_CHILDREN = jsonResponse(200, {
  value: [
    { id: 'FOLDER00', name: 'R00 - Unsorted Drop', folder: {}, parentReference: { id: ROOT } },
    { id: FOLDER_19, name: 'R19 - Measurement and Assessment Instruments', folder: {}, parentReference: { id: ROOT } },
    { id: 'FOLDER98', name: 'R98 - Duplicate Hold', folder: {}, parentReference: { id: ROOT } },
  ],
});
const FOLDER_LIST_URL = `${BASE}/items/${FOLDER_19}/children?$select=id,name,folder,parentReference&$top=200`;

/** The R19 folder's listing: the files given, or none. */
function folderWith(...items: Array<{ id: string; name: string }>): Response {
  return jsonResponse(200, { value: items.map((item) => ({ ...item, file: {}, parentReference: { id: FOLDER_19 } })) });
}

function metaUrl(itemId: string): string {
  return `${BASE}/items/${itemId}?$select=id,name,size,webUrl,parentReference`;
}

function metaOf(itemId: string, name: string, webUrl?: string): Response {
  return jsonResponse(200, { id: itemId, name, size: PDF.length, ...(webUrl ? { webUrl } : {}), parentReference: { id: FOLDER_19 } });
}
const CREATED = jsonResponse(201, { id: 'ITEM-NEW', webUrl: 'https://sp/Research%20Archive/R19/x.pdf', parentReference: { id: FOLDER_19 } });

function calls(): string[] {
  return fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`);
}

function file(overrides: Partial<Parameters<Filing['fileResearchOriginal']>[0]> = {}) {
  return filing.fileResearchOriginal({
    config: CONFIG,
    filingOrganizationIds: [ORG, PLATFORM],
    organizationId: ORG,
    actorAccountId: 'acct-arcfile-curator',
    actorRole: 'organization_admin',
    sourceId: PAPER,
    originalFilename: 'Paper One.pdf',
    fileBytes: new Uint8Array(PDF),
    acquisitionProvider: 'Penn State University Libraries',
    acquisitionChannel: 'library_database',
    acquiredAt: '2026-10-01',
    versionKind: 'version_of_record',
    ...overrides,
  });
}

async function originals() {
  return sql<{ source_id: string; organization_id: string; item_id: string; archive_filename: string }>(
    'select source_id, organization_id, item_id, archive_filename from pilot.shadow_library_archived_originals order by created_at',
  );
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  const client = new Client({ connectionString: connectionStringFor(TEST_DB) });
  await client.connect();
  try {
    await applyFullSchema(client, { infraDir: INFRA_DIR });
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active') on conflict do nothing`,
      [ORG],
    );
    await client.query(
      `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url, metadata)
       values ($1, $5, 'A paper', 'peer_reviewed', 1, 'https://example.org/paper', '{"classification_domain":"measurement_assessment_instruments"}'),
              ($2, $5, 'Another paper', 'peer_reviewed', 1, 'https://example.org/other', '{"classification_domain":"measurement_assessment_instruments"}'),
              ($3, $5, 'Not yet classified', 'peer_reviewed', 1, 'https://example.org/unclassified', '{}'),
              ($4, $6, 'A platform paper', 'peer_reviewed', 1, 'https://example.org/platform', '{"classification_domain":"measurement_assessment_instruments"}')`,
      [PAPER, OTHER_PAPER, UNCLASSIFIED, PLATFORM_PAPER, ORG, PLATFORM],
    );
  } finally {
    await client.end();
  }

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  filing = await import('./researchArchiveFiling');
});

beforeEach(async () => {
  jest.clearAllMocks();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  await sql('drop trigger if exists arcfile_refuse_insert on pilot.shadow_library_archived_originals');
  await sql('delete from pilot.shadow_library_archived_originals');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();
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

describe('filing a research PDF (real database, Graph mocked)', () => {
  test('a new PDF is filed under its subject folder and recorded, and its source stays unreviewed', async () => {
    fetchMock.mockResolvedValueOnce(ROOT_CHILDREN).mockResolvedValueOnce(folderWith()).mockResolvedValueOnce(CREATED);

    const result = await file();

    expect(result.status).toBe('filed');
    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`, `PUT ${PUT_URL}`]);
    expect(result.original).toMatchObject({
      organization_id: ORG,
      source_id: PAPER,
      item_id: 'ITEM-NEW',
      web_url: 'https://sp/Research%20Archive/R19/x.pdf',
      archive_root_item_id: ROOT,
      archive_domain_code: 'R19',
      archive_filename: FILED_NAME,
      original_filename: 'Paper One.pdf',
      content_sha256: SHA,
      acquisition_provider: 'Penn State University Libraries',
      acquisition_channel: 'library_database',
      version_kind: 'version_of_record',
      created_by_account_id: 'acct-arcfile-curator',
      created_by_role: 'organization_admin',
    });
    expect(Number(result.original.byte_size)).toBe(PDF.length);
    // A date-only acquisition date is that calendar day, not a parse of the local clock.
    expect(new Date(result.original.acquired_at).toISOString()).toBe('2026-10-01T00:00:00.000Z');

    // Custody is not approval: the source is exactly as unreviewed as before.
    const [source] = await sql<{ approval_state: string; verification_state: string }>(
      'select approval_state, verification_state from pilot.shadow_library_sources where source_id = $1',
      [PAPER],
    );
    expect(source).toEqual({ approval_state: 'pending_review', verification_state: 'unverified' });
  });

  test('the same PDF again is "already filed" and Graph is not called at all', async () => {
    fetchMock.mockResolvedValueOnce(ROOT_CHILDREN).mockResolvedValueOnce(folderWith()).mockResolvedValueOnce(CREATED);
    const first = await file();
    fetchMock.mockClear();

    const again = await file({ originalFilename: 'renamed copy.pdf' });

    expect(again).toEqual({ status: 'already_filed', original: first.original });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await originals()).toHaveLength(1);
  });

  test('the same PDF for another source on the shelf is refused, with no Graph call', async () => {
    fetchMock.mockResolvedValueOnce(ROOT_CHILDREN).mockResolvedValueOnce(folderWith()).mockResolvedValueOnce(CREATED);
    await file();
    fetchMock.mockClear();

    await expect(file({ sourceId: OTHER_PAPER })).rejects.toMatchObject({ status: 409, code: 'ARCHIVE_ORIGINAL_OTHER_SOURCE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a shelf the archive does not take is refused before anything is read or called', async () => {
    await expect(file({ filingOrganizationIds: [PLATFORM] })).rejects.toMatchObject({
      status: 403,
      code: 'ARCHIVE_ORGANIZATION_NOT_ALLOWED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(await originals()).toEqual([]);
  });

  test('an unclassified source is not filed in a guessed folder', async () => {
    await expect(file({ sourceId: UNCLASSIFIED })).rejects.toMatchObject({ status: 409, code: 'SOURCE_NOT_CLASSIFIED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  test.each([
    ['an unknown source', 'src_missing'],
    ["another shelf's source", PLATFORM_PAPER],
  ])('%s is not found, with no Graph call', async (_label, sourceId) => {
    await expect(file({ sourceId })).rejects.toMatchObject({ status: 404, code: 'SOURCE_NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the same PDF on the gym and the platform shelf is one SharePoint item and two rows', async () => {
    fetchMock.mockResolvedValueOnce(ROOT_CHILDREN).mockResolvedValueOnce(folderWith()).mockResolvedValueOnce(CREATED);
    await file();
    fetchMock.mockClear();
    // The platform shelf finds the gym's copy in the folder and reads it back; it writes nothing.
    fetchMock
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(folderWith({ id: 'ITEM-NEW', name: FILED_NAME }))
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(metaOf('ITEM-NEW', FILED_NAME))
      .mockResolvedValueOnce(bytesResponse(PDF));

    const platform = await file({ organizationId: PLATFORM, sourceId: PLATFORM_PAPER });

    expect(platform.original).toMatchObject({ organization_id: PLATFORM, source_id: PLATFORM_PAPER, item_id: 'ITEM-NEW' });
    expect(calls().filter((c) => !c.startsWith('GET '))).toEqual([]);
    expect(await originals()).toEqual([
      expect.objectContaining({ organization_id: ORG, item_id: 'ITEM-NEW' }),
      expect.objectContaining({ organization_id: PLATFORM, item_id: 'ITEM-NEW' }),
    ]);
  });

  test('an original filed earlier but never recorded is read back, matched by hash and recorded -- not rewritten', async () => {
    fetchMock
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(folderWith({ id: 'ITEM-EARLIER', name: FILED_NAME }))
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(metaOf('ITEM-EARLIER', FILED_NAME, 'https://sp/earlier.pdf'))
      .mockResolvedValueOnce(bytesResponse(PDF));

    const result = await file();

    expect(result).toMatchObject({ status: 'filed', original: { item_id: 'ITEM-EARLIER', web_url: 'https://sp/earlier.pdf', content_sha256: SHA } });
    expect(calls()).toEqual([
      `GET ${LIST_URL}`,
      `GET ${FOLDER_LIST_URL}`,
      `GET ${LIST_URL}`,
      `GET ${metaUrl('ITEM-EARLIER')}`,
      `GET ${BASE}/items/ITEM-EARLIER/content`,
    ]);
  });

  test('a retry under another file name finds the copy filed the first time, and files no second one', async () => {
    const firstName = `First name--${SHA.slice(0, 12)}.pdf`;
    fetchMock
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(folderWith({ id: 'ITEM-FIRST', name: firstName }))
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(metaOf('ITEM-FIRST', firstName))
      .mockResolvedValueOnce(bytesResponse(PDF));

    const result = await file({ originalFilename: 'A different name.pdf' });

    expect(result.original).toMatchObject({ item_id: 'ITEM-FIRST', archive_filename: firstName, original_filename: 'A different name.pdf' });
    expect(calls().filter((c) => !c.startsWith('GET '))).toEqual([]);
  });

  test('a different file under the filed name is refused and nothing is recorded or written', async () => {
    fetchMock
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(folderWith({ id: 'ITEM-OTHER', name: FILED_NAME }))
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ITEM-OTHER', name: FILED_NAME, size: 5, parentReference: { id: FOLDER_19 } }))
      .mockResolvedValueOnce(bytesResponse(Buffer.from('%PDF-')));

    await expect(file()).rejects.toMatchObject({ status: 409, code: 'ARCHIVE_NAME_TAKEN' });
    expect(calls().filter((c) => !c.startsWith('GET '))).toEqual([]);
    expect(await originals()).toEqual([]);
  });

  test('an unreachable archive is a 502 that does not claim nothing was filed, and nothing is recorded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: { code: 'serviceNotAvailable' } }));

    await expect(file()).rejects.toMatchObject({
      status: 502,
      code: 'ARCHIVE_UNAVAILABLE',
      message: 'The Research Archive did not confirm the filing. Try again with the same file.',
    });
    expect(await originals()).toEqual([]);
  });

  test('a database failure after filing never deletes the filed original, and the retry records it', async () => {
    await sql(`
      create or replace function arcfile_refuse_insert_fn() returns trigger language plpgsql as $$
      begin raise exception 'synthetic database failure'; end $$`);
    await sql(`create trigger arcfile_refuse_insert before insert on pilot.shadow_library_archived_originals
               for each row execute function arcfile_refuse_insert_fn()`);
    fetchMock.mockResolvedValueOnce(ROOT_CHILDREN).mockResolvedValueOnce(folderWith()).mockResolvedValueOnce(CREATED);

    await expect(file()).rejects.toThrow(/synthetic database failure/);
    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`, `PUT ${PUT_URL}`]);

    await sql('drop trigger arcfile_refuse_insert on pilot.shadow_library_archived_originals');
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(folderWith({ id: 'ITEM-NEW', name: FILED_NAME }))
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(metaOf('ITEM-NEW', FILED_NAME))
      .mockResolvedValueOnce(bytesResponse(PDF));

    const retried = await file();

    expect(retried).toMatchObject({ status: 'filed', original: { item_id: 'ITEM-NEW' } });
    expect(calls().filter((c) => c.startsWith('PUT ') || c.startsWith('DELETE '))).toEqual([]);
  });

  test('two uploads of the same PDF at once: the loser reads the winner back and returns its row', async () => {
    // The other request wins the create-only PUT and records its row while this
    // one is writing: this PUT is refused nameAlreadyExists, the read-back finds
    // the same item, and the insert collides on both unique keys.
    fetchMock
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(folderWith())
      .mockImplementationOnce(async () => {
        await sql(
          `insert into pilot.shadow_library_archived_originals
             (archived_original_id, organization_id, source_id, site_id, drive_id, item_id, archive_root_item_id,
              archive_domain_code, archive_filename, original_filename, content_sha256, byte_size,
              acquisition_provider, acquisition_channel, acquired_at, created_by_account_id, created_by_role)
           values ('arc_winner', $1, $2, 'site-guid', 'b!drive', 'ITEM-NEW', $3, 'R19', $4, 'Paper One.pdf', $5, $6,
                   'Penn State University Libraries', 'library_database', now(), 'acct-other', 'organization_admin')`,
          [ORG, PAPER, ROOT, FILED_NAME, SHA, PDF.length],
        );
        return jsonResponse(409, { error: { code: 'nameAlreadyExists', message: 'synthetic' } });
      })
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ITEM-NEW' }))
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(metaOf('ITEM-NEW', FILED_NAME))
      .mockResolvedValueOnce(bytesResponse(PDF));

    const result = await file();

    expect(result).toMatchObject({ status: 'already_filed', original: { archived_original_id: 'arc_winner' } });
    expect(await originals()).toHaveLength(1);
  });

  test('a lost race to the same bytes for another source is refused, not recorded twice', async () => {
    fetchMock
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(folderWith())
      .mockImplementationOnce(async () => {
        await sql(
          `insert into pilot.shadow_library_archived_originals
             (archived_original_id, organization_id, source_id, site_id, drive_id, item_id, archive_root_item_id,
              archive_domain_code, archive_filename, original_filename, content_sha256, byte_size,
              acquisition_provider, acquisition_channel, acquired_at, created_by_account_id, created_by_role)
           values ('arc_other_source', $1, $2, 'site-guid', 'b!drive', 'ITEM-ELSEWHERE', $3, 'R19', 'x.pdf', 'x.pdf', $4, $5,
                   'Penn State University Libraries', 'library_database', now(), 'acct-other', 'organization_admin')`,
          [ORG, OTHER_PAPER, ROOT, SHA, PDF.length],
        );
        return CREATED;
      });

    await expect(file()).rejects.toMatchObject({ status: 409, code: 'ARCHIVE_ORIGINAL_OTHER_SOURCE' });
    expect(await originals()).toEqual([expect.objectContaining({ source_id: OTHER_PAPER })]);
  });

  test('a later version names the earlier one of the same source; anything else is refused before Graph', async () => {
    fetchMock.mockResolvedValueOnce(ROOT_CHILDREN).mockResolvedValueOnce(folderWith()).mockResolvedValueOnce(CREATED);
    const earlier = await file({ versionKind: 'accepted_manuscript' });
    fetchMock.mockClear();

    const vor = Buffer.from('%PDF-1.4 version of record');
    for (const supersedes of ['arc_missing', 'arc_other_paper']) {
      if (supersedes === 'arc_other_paper') {
        await sql(
          `insert into pilot.shadow_library_archived_originals
             (archived_original_id, organization_id, source_id, site_id, drive_id, item_id, archive_root_item_id,
              archive_domain_code, archive_filename, original_filename, content_sha256, byte_size,
              acquisition_provider, acquisition_channel, acquired_at, created_by_account_id, created_by_role)
           values ('arc_other_paper', $1, $2, 'site-guid', 'b!drive', 'ITEM-O', $3, 'R19', 'o.pdf', 'o.pdf', $4, 5,
                   'PPBF', 'ppbf_created', now(), 'acct', 'organization_admin')`,
          [ORG, OTHER_PAPER, ROOT, 'c'.repeat(64)],
        );
      }
      await expect(file({ fileBytes: new Uint8Array(vor), supersedesArchivedOriginalId: supersedes })).rejects.toMatchObject({
        status: 400,
        code: 'ARCHIVE_SUPERSEDES_INVALID',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const vorName = `Paper One--${createHash('sha256').update(vor).digest('hex').slice(0, 12)}.pdf`;
    fetchMock
      .mockResolvedValueOnce(ROOT_CHILDREN)
      .mockResolvedValueOnce(folderWith())
      .mockResolvedValueOnce(jsonResponse(201, { id: 'ITEM-VOR', parentReference: { id: FOLDER_19 } }));

    const later = await file({ fileBytes: new Uint8Array(vor), supersedesArchivedOriginalId: earlier.original.archived_original_id });

    expect(later.original).toMatchObject({
      archive_filename: vorName,
      supersedes_archived_original_id: earlier.original.archived_original_id,
    });
  });

  test.each([
    ['not a PDF', { fileBytes: new Uint8Array(Buffer.from('hello')) }, 400, 'NOT_A_PDF'],
    ['an unknown channel', { acquisitionChannel: 'email' }, 400, 'ARCHIVE_CHANNEL_INVALID'],
    ['an unknown version', { versionKind: 'preprint' }, 400, 'ARCHIVE_VERSION_INVALID'],
    ['a future acquisition date', { acquiredAt: '2999-01-01' }, 400, 'ARCHIVE_ACQUIRED_AT_INVALID'],
    ['an acquisition date of "1"', { acquiredAt: '1' }, 400, 'ARCHIVE_ACQUIRED_AT_INVALID'],
    ['a date that is not on the calendar', { acquiredAt: '2026-02-30' }, 400, 'ARCHIVE_ACQUIRED_AT_INVALID'],
    ['a year Postgres cannot store', { acquiredAt: '0000-01-01' }, 400, 'ARCHIVE_ACQUIRED_AT_INVALID'],
    ['a word for a date', { acquiredAt: 'October 1' }, 400, 'ARCHIVE_ACQUIRED_AT_INVALID'],
    ['no provider', { acquisitionProvider: '   ' }, 400, 'ARCHIVE_PROVIDER_INVALID'],
    ['a control character in the provider', { acquisitionProvider: `Penn State${String.fromCharCode(0)}` }, 400, 'ARCHIVE_PROVIDER_INVALID'],
    ['a control character in the file name', { originalFilename: `Paper${String.fromCharCode(0)}.pdf` }, 400, 'ARCHIVE_FILENAME_INVALID'],
  ] as const)('%s is refused before anything is called', async (_label, overrides, status, code) => {
    await expect(file(overrides as never)).rejects.toMatchObject({ status, code });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await originals()).toEqual([]);
  });
});
