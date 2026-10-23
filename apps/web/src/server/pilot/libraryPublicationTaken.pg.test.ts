// Real PostgreSQL-backed test for #345 D2: registering a paper already on the
// shelf is refused, naming the source that holds it.
//
// RULINGS. Q2 (applied by Overwatch under Jason's standing "go with your
// recommendation"): a paper whose DOI or PMID already exists on the shelf is
// REFUSED, naming the source already there, as a duplicate URL is.
// OD-2026-10-18-005 (F-136): a duplicate is not corroboration. Any SHARED DOI
// or PMID counts, not only the publication key: a General Research source
// with a PubMed URL and a DOI in its box keys by the DOI, beside a seeded
// record that has only the PMID (lane LR1's report on #1850).
//
// Driven through the real POST handler against the real schema. Spins up the
// same disposable, local-only embedded Postgres instance the other library
// suites use (scripts/test-embedded-pg-server.mjs). It NEVER connects to
// production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';
import { PLATFORM_LIBRARY_ORGANIZATION_ID } from './platformLibraryScope';
import { emitShadowEvent } from './shadowEvents';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// Real by default; one test holds the first transaction open inside it.
jest.mock('./shadowEvents', () => {
  const actual = jest.requireActual('./shadowEvents');
  return { ...actual, emitShadowEvent: jest.fn((...args: unknown[]) => actual.emitShadowEvent(...args)) };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-publication-taken-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_publication_taken';

const GYM_ID = 'org-taken-gym';
const OTHER_GYM_ID = 'org-taken-other-gym';
const CURATOR = 'acct-taken-curator';
const OTHER_CURATOR = 'acct-taken-other-curator';
const OWNER = 'acct-taken-owner';

// Same set as libraryIntakeRecovery.pg.test.ts.
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
  'pilot_slice_postgres_retraction_surveillance_migration.sql',
  'pilot_slice_postgres_platform_library_scope_migration.sql',
  'pilot_slice_postgres_source_rights_migration.sql',
];

const TAKEN = 'SHADOW_LIBRARY_PUBLICATION_TAKEN';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let POST: (request: NextRequest) => Promise<Response>;

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockEmit = jest.mocked(emitShadowEvent);

function principal(
  accountId: string,
  organizationId: string,
  role: PilotPrincipal['role'] = 'organization_admin',
): PilotPrincipal {
  return { accountId, role, organizationId, athleteId: null, sessionToken: 'token', authProvider: 'microsoft' };
}

const CURATOR_PRINCIPAL = principal(CURATOR, GYM_ID);
const OTHER_GYM_PRINCIPAL = principal(OTHER_CURATOR, OTHER_GYM_ID);
const OWNER_PRINCIPAL = principal(OWNER, GYM_ID, 'platform_owner');

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

async function rawQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** One registration through the real route, as the given principal. */
async function register(
  body: Record<string, unknown>,
  as: PilotPrincipal = CURATOR_PRINCIPAL,
): Promise<{ status: number; json: Record<string, unknown> }> {
  mockRequirePrincipal.mockResolvedValueOnce(as);
  const response = await POST(new NextRequest('http://localhost/api/pilot/shadow/library/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** The General Research form's body: its one "DOI or PMID" box, and an optional URL. */
function generalResearch(title: string, doiOrPmid: string | null, url: string | null = null): Record<string, unknown> {
  return {
    title,
    source_type: 'peer_reviewed',
    url,
    metadata: { general_research: true, provenance: doiOrPmid === null ? {} : { doi_or_pmid: doiOrPmid } },
  };
}

async function registered(title: string, doiOrPmid: string | null, url: string | null = null): Promise<string> {
  const answer = await register(generalResearch(title, doiOrPmid, url));
  expect(answer.status).toBe(201);
  return (answer.json.source as { source_id: string }).source_id;
}

async function sourcesTitled(organizationId: string, title: string): Promise<number> {
  const [row] = await rawQuery<{ count: string }>(
    'select count(*)::text as count from pilot.shadow_library_sources where organization_id = $1 and title = $2',
    [organizationId, title],
  );
  return Number(row.count);
}

beforeAll(async () => {
  delete process.env.AZURE_AI_ENDPOINT;
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
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  for (const file of SCHEMA_FILES) {
    await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  for (const organizationId of [GYM_ID, OTHER_GYM_ID]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  for (const [accountId, role, organizationId] of [
    [CURATOR, 'organization_admin', GYM_ID],
    [OTHER_CURATOR, 'organization_admin', OTHER_GYM_ID],
    [OWNER, 'platform_owner', GYM_ID],
  ]) {
    await migrateClient.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, organizationId],
    );
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  POST = (await import('@/app/api/pilot/shadow/library/sources/route')).POST;
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
});

beforeEach(() => {
  mockRequirePrincipal.mockReset();
});

describe('registering a paper already on the shelf is refused (#345 D2, real database)', () => {
  test('a DOI already on the shelf, in another form, is refused with a message that names the held source', async () => {
    const heldId = await registered('Held DOI paper', '10.1000/held.1');

    const second = await register(generalResearch('Held DOI paper, again', 'https://doi.org/10.1000/HELD.1'));

    expect(second.status).toBe(409);
    expect(second.json).toEqual(expect.objectContaining({
      ok: false,
      code: TAKEN,
      existing_source: { source_id: heldId, title: 'Held DOI paper' },
    }));
    expect(second.json.error).toEqual(expect.stringContaining(`"Held DOI paper" (${heldId})`));
    expect(await sourcesTitled(GYM_ID, 'Held DOI paper, again')).toBe(0);
  });

  test('a PMID already on the shelf is refused, the URL and the box being the same PMID', async () => {
    const heldId = await registered('Held PMID paper', null, 'https://pubmed.ncbi.nlm.nih.gov/31452104/');

    const second = await register(generalResearch('Held PMID paper, again', 'PMID: 31452104'));

    expect(second.status).toBe(409);
    expect(second.json).toEqual(expect.objectContaining({
      code: TAKEN,
      existing_source: { source_id: heldId, title: 'Held PMID paper' },
    }));
    expect(await sourcesTitled(GYM_ID, 'Held PMID paper, again')).toBe(0);
  });

  test('LR1 edge pair: a PubMed URL plus a DOI is refused beside a seeded record that has only the PMID', async () => {
    // A seeded research record: identifier_kind/identifier, no URL, as the importer writes it.
    await rawQuery(
      `insert into pilot.shadow_library_sources
         (source_id, organization_id, title, source_type, authority_tier, url, status, metadata)
       values ('src_seed_27217246', $1, 'Seeded PMID-only record', 'peer_reviewed', 2, null, 'active', $2::jsonb)`,
      [GYM_ID, JSON.stringify({ identifier_kind: 'pmid', identifier: '27217246' })],
    );

    const generalResearchPair = await register(
      generalResearch('General Research copy', '10.1177/1745691616635591', 'https://pubmed.ncbi.nlm.nih.gov/27217246/'),
    );

    expect(generalResearchPair.status).toBe(409);
    expect(generalResearchPair.json).toEqual(expect.objectContaining({
      code: TAKEN,
      existing_source: { source_id: 'src_seed_27217246', title: 'Seeded PMID-only record' },
    }));
    expect(await sourcesTitled(GYM_ID, 'General Research copy')).toBe(0);
  });

  test('the same pair the other way round: the PMID alone is refused beside the URL-plus-DOI source', async () => {
    const heldId = await registered('URL plus DOI first', '10.1177/9999999999', 'https://pubmed.ncbi.nlm.nih.gov/88888888/');

    const pmidOnly = await register(generalResearch('PMID only second', '88888888'));
    const doiOnly = await register(generalResearch('DOI only third', 'doi:10.1177/9999999999'));

    expect(pmidOnly.status).toBe(409);
    expect(pmidOnly.json.existing_source).toEqual({ source_id: heldId, title: 'URL plus DOI first' });
    expect(doiOnly.status).toBe(409);
    expect(doiOnly.json.existing_source).toEqual({ source_id: heldId, title: 'URL plus DOI first' });
  });

  test.each([
    ['archived', `status = 'archived'`],
    ['rejected', `status = 'rejected'`],
    ['quarantined', `status = 'quarantined'`],
    [
      'suppressed for retraction',
      `retrieval_suppressed = true, suppression_reason = 'Retracted by the journal', suppressed_at = now(),
       suppressed_by_account_id = '${CURATOR}'`,
    ],
  ])('a held source counts when it is %s, as a held URL does', async (label, assignment) => {
    const doi = `10.1000/held-${label.replace(/\W+/g, '-')}`;
    const heldId = await registered(`Held ${label} paper`, doi);
    await rawQuery(`update pilot.shadow_library_sources set ${assignment} where source_id = $1`, [heldId]);

    const second = await register(generalResearch(`Held ${label} paper, again`, doi));

    expect(second.status).toBe(409);
    expect(second.json.existing_source).toEqual({ source_id: heldId, title: `Held ${label} paper` });
  });
});

describe('what the check must not refuse (real database)', () => {
  test('another shelf is not this shelf: another gym, and the platform shelf, may each hold the paper', async () => {
    await registered('Gym copy of a shared paper', '10.1000/shared.1');

    const otherGym = await register(generalResearch('Other gym copy', '10.1000/shared.1'), OTHER_GYM_PRINCIPAL);
    const platform = await register({ ...generalResearch('Platform copy', '10.1000/shared.1'), shelf: 'platform' }, OWNER_PRINCIPAL);

    expect(otherGym.status).toBe(201);
    expect(platform.status).toBe(201);
    expect(await sourcesTitled(OTHER_GYM_ID, 'Other gym copy')).toBe(1);
    expect(await sourcesTitled(PLATFORM_LIBRARY_ORGANIZATION_ID, 'Platform copy')).toBe(1);
  });

  test('a paper the platform shelf holds first, which every gym reads, is still not on the gym shelf', async () => {
    const platformFirst = await register(
      { ...generalResearch('Platform holds it first', 'PMID: 55555555'), shelf: 'platform' },
      OWNER_PRINCIPAL,
    );
    const gymSecond = await register(generalResearch('Gym registers it second', null, 'https://pubmed.ncbi.nlm.nih.gov/55555555/'));

    expect(platformFirst.status).toBe(201);
    expect(gymSecond.status).toBe(201);
  });

  test('a deleted source is not counted', async () => {
    const goneId = await registered('Deleted paper', '10.1000/deleted.1');
    await rawQuery('delete from pilot.shadow_library_sources where source_id = $1', [goneId]);

    const again = await register(generalResearch('Deleted paper, registered again', '10.1000/deleted.1'));

    expect(again.status).toBe(201);
  });

  test('a source with no DOI or PMID never matches, beside others without one or beside a DOI source', async () => {
    await registered('Plain one', null, 'https://example.com/plain/1');
    await registered('Identified one', '10.1000/identified.1');

    const plainTwo = await register(generalResearch('Plain two', null, 'https://example.com/plain/2'));
    const noUrl = await register(generalResearch('Plain, no URL', null));
    const notAnId = await register(generalResearch('Box that names no paper', 'PMC1234567'));

    expect([plainTwo.status, noUrl.status, notAnId.status]).toEqual([201, 201, 201]);
  });

  test('a retry of a saved registration is answered as recovered, not as taken by itself', async () => {
    const body = { ...generalResearch('Retried paper', '10.1000/retried.1'), request_id: 'req-taken-retry-0001' };
    const first = await register(body);
    const retry = await register(body);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.json.recovered).toBe(true);
    expect((retry.json.source as { source_id: string }).source_id).toBe((first.json.source as { source_id: string }).source_id);
    expect(await sourcesTitled(GYM_ID, 'Retried paper')).toBe(1);
  });
});

describe('two registrations of one paper at once (real database)', () => {
  test('one is saved and the other refused: the second waits for the first and then sees it', async () => {
    // Holds the first transaction open after its insert and before its commit,
    // and starts the second only once the first is there, so the second must
    // overlap it. Without the per-identifier lock the second cannot see the
    // uncommitted row and saves its own.
    const actualEmit = jest.requireActual('./shadowEvents').emitShadowEvent as typeof emitShadowEvent;
    let firstIsInside!: () => void;
    const firstInside = new Promise<void>((resolve) => {
      firstIsInside = resolve;
    });
    mockEmit.mockImplementationOnce(async (...args: Parameters<typeof emitShadowEvent>) => {
      firstIsInside();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return actualEmit(...args);
    });

    const firstAnswer = register(generalResearch('Race paper A', '10.1000/race.1'));
    await firstInside;
    const second = await register(generalResearch('Race paper B', 'PMID: 7', 'https://doi.org/10.1000/race.1'));
    const first = await firstAnswer;

    expect([first.status, second.status]).toEqual([201, 409]);
    expect(second.json.existing_source).toEqual({ source_id: (first.json.source as { source_id: string }).source_id, title: 'Race paper A' });
    const [row] = await rawQuery<{ count: string }>(
      `select count(*)::text as count from pilot.shadow_library_sources where organization_id = $1 and title like 'Race paper%'`,
      [GYM_ID],
    );
    expect(Number(row.count)).toBe(1);
  });
});
