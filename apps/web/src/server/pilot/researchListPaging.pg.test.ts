// Real PostgreSQL proof of the paged research list (F-025: the Research
// Inbox put every requirement on one page). Rows are read back through the
// REAL route handler with the real access gates; only requirePrincipal is
// stubbed. Rules under test:
//   - pages walk the whole list once, newest first, ties broken by id, with
//     no repeat and no skip, even across a microsecond inside a millisecond;
//   - a reader's page is filled only from rows they may see, so a guardian
//     reads past a full database batch of another child's rows;
//   - the family projection (#1588) applies on every page;
//   - a malformed limit or cursor is a 400.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
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

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-list-paging-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_research_list_paging';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

const ORG = 'org-rp-1';
const OTHER_ORG = 'org-rp-2';
const ATHLETE_A = 'ath-rp-a';
const ATHLETE_B = 'ath-rp-b';
/** Rows about athlete B, newest of all, so a guardian of A must read past a full batch of them. */
const B_ROWS = 230;

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let listGet: (request: NextRequest) => Promise<Response>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

function principal(overrides: Partial<PilotPrincipal> & Pick<PilotPrincipal, 'accountId' | 'role'>): PilotPrincipal {
  return {
    organizationId: ORG,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const AS = {
  admin: () => principal({ accountId: 'acct-rp-admin', role: 'organization_admin' }),
  guardianOfA: () => principal({ accountId: 'acct-rp-guardian-a', role: 'parent' }),
} as const;

interface Page {
  status: number;
  text: string;
  items: Array<Record<string, unknown>>;
  next: string | null;
}

async function pageAs(actor: PilotPrincipal, query: string): Promise<Page> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await listGet(new NextRequest(`http://localhost/api/pilot/shadow/research-requirements${query}`));
  const text = await response.text();
  const body = JSON.parse(text) as { items?: Array<Record<string, unknown>>; next_cursor?: string | null };
  return { status: response.status, text, items: body.items ?? [], next: body.next_cursor ?? null };
}

/** Every page a reader can walk, following next_cursor until it is null. */
async function walk(actor: PilotPrincipal, limit: number): Promise<{ pages: Page[]; ids: number[] }> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `?limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = await pageAs(actor, query);
    expect(page.status).toBe(200);
    pages.push(page);
    cursor = page.next;
  } while (cursor !== null && pages.length < 1000);
  return { pages, ids: pages.flatMap((page) => page.items.map((item) => Number(item.research_requirement_id))) };
}

/** The order the list promises, read straight from the table. */
async function expectedIds(where: string, params: unknown[]): Promise<number[]> {
  const rows = await db.query<{ id: string }>(
    `select research_requirement_id::text as id from pilot.shadow_research_requirements
      where ${where} order by created_at desc, research_requirement_id desc`,
    params,
  );
  return rows.rows.map((row) => Number(row.id));
}

async function insertRow(organizationId: string, entityId: string, createdAt: string, subjectId: string | null): Promise<void> {
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata, subject_id, created_at)
     values ($1, 'MANUAL_RESEARCH_NOTE', 'manual_note', $2, $3, 'gap', 'missing', 'INSUFFICIENT', 'unknown',
             'acct-rp-admin', 'organization_admin', '{}'::jsonb, $4, $5::timestamptz)`,
    [organizationId, entityId, `requirement ${entityId}`, subjectId, createdAt],
  );
}

beforeAll(async () => {
  PG_PORT = await freePort();

  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Another Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  for (const [accountId, role, organizationId] of [
    ['acct-rp-admin', 'organization_admin', ORG],
    ['acct-rp-coach', 'coach', ORG],
    ['acct-rp-guardian-a', 'parent', ORG],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, organizationId],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, 'acct-rp-coach', now(), now()),
       ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, 'acct-rp-coach', now(), now())`,
    [ORG, ATHLETE_A, ATHLETE_B],
  );
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, 'par-rp-a', 'acct-rp-guardian-a', 'Guardian of A', '555-0100', 'a@example.test')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-rp-a', $2, 'mother')`,
    [ORG, ATHLETE_A],
  );

  // Three rows about A, oldest. Two of them share created_at to the
  // microsecond, so only the id can order them.
  await insertRow(ORG, 'a-1', '2026-01-01 10:00:00.000001+00', ATHLETE_A);
  await insertRow(ORG, 'a-2', '2026-01-02 10:00:00.000001+00', ATHLETE_A);
  await insertRow(ORG, 'a-3', '2026-01-02 10:00:00.000001+00', ATHLETE_A);
  // Two subject-less rows a microsecond apart inside one millisecond: a page
  // key carried as a JS Date would round them together.
  await insertRow(ORG, 'micro-1', '2026-02-01 10:00:00.123456+00', null);
  await insertRow(ORG, 'micro-2', '2026-02-01 10:00:00.123457+00', null);
  // The newest rows are about B, more of them than one database batch.
  for (let index = 0; index < B_ROWS; index += 1) {
    await insertRow(ORG, `b-${index}`, `2026-03-01 10:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(6, '0')}+00`, ATHLETE_B);
  }
  // Another gym's row, newest of all.
  await insertRow(OTHER_ORG, 'other-1', '2026-09-01 10:00:00+00', null);

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  listGet = (await import('@/app/api/pilot/shadow/research-requirements/route')).GET;
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool().catch(() => {});
  await db?.end().catch(() => {});

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

describe('the research list is paged on the server (F-025)', () => {
  test('without a limit the first page holds 50 rows and says there are more', async () => {
    const page = await pageAs(AS.admin(), '');
    expect(page.status).toBe(200);
    expect(page.items).toHaveLength(50);
    expect(page.next).not.toBeNull();
  });

  test('walking the pages returns every row of the gym once, newest first, ties by id', async () => {
    const expected = await expectedIds('organization_id = $1', [ORG]);
    expect(expected).toHaveLength(B_ROWS + 5);
    const { pages, ids } = await walk(AS.admin(), 7);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages[pages.length - 1].next).toBeNull();
    expect(pages.every((page) => page.items.length > 0)).toBe(true);
  });

  test('page boundaries one microsecond apart, and between two rows of the same instant, neither repeat nor skip', async () => {
    const expected = await expectedIds('organization_id = $1', [ORG]);
    // 0-229 about B, 230 micro-2, 231 micro-1, 232 a-3 and 233 a-2 (same
    // instant, id decides), 234 a-1.
    const ids = (page: Page) => page.items.map((item) => Number(item.research_requirement_id));
    const after = (page: Page) => `&cursor=${encodeURIComponent(page.next ?? '')}`;
    const p1 = await pageAs(AS.admin(), '?limit=200');
    const p2 = await pageAs(AS.admin(), `?limit=31${after(p1)}`);
    expect(ids(p2)).toEqual(expected.slice(200, 231)); // ends on micro-2
    const p3 = await pageAs(AS.admin(), `?limit=2${after(p2)}`);
    expect(ids(p3)).toEqual(expected.slice(231, 233)); // micro-1, then a-3
    const p4 = await pageAs(AS.admin(), `?limit=2${after(p3)}`);
    expect(ids(p4)).toEqual(expected.slice(233)); // a-2 (same instant as a-3), a-1
    expect(p4.next).toBeNull();
  });

  test('a guardian reads past a full batch of rows about another child and gets full pages of their own', async () => {
    const expected = await expectedIds('organization_id = $1 and subject_id = $2', [ORG, ATHLETE_A]);
    expect(expected).toHaveLength(3);
    const first = await pageAs(AS.guardianOfA(), '?limit=2');
    expect(first.items.map((item) => Number(item.research_requirement_id))).toEqual(expected.slice(0, 2));
    expect(first.next).not.toBeNull();
    const second = await pageAs(AS.guardianOfA(), `?limit=2&cursor=${encodeURIComponent(first.next ?? '')}`);
    expect(second.items.map((item) => Number(item.research_requirement_id))).toEqual(expected.slice(2));
    expect(second.next).toBeNull();
    // A full last page with nothing after it still ends the list.
    const exact = await pageAs(AS.guardianOfA(), '?limit=3');
    expect(exact.items).toHaveLength(3);
    expect(exact.next).toBeNull();
  });

  test('every page a guardian walks carries the family fields only, nothing about the other child', async () => {
    const { pages } = await walk(AS.guardianOfA(), 1);
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.text).not.toContain('acct-rp-admin');
      expect(page.text).not.toContain(ATHLETE_B);
      expect(page.text).not.toContain('requirement b-');
      for (const item of page.items) {
        expect(item).not.toHaveProperty('created_by_account_id');
        expect(item).not.toHaveProperty('subject_id');
      }
    }
  });

  test("another gym's rows never appear on any page", async () => {
    const { pages } = await walk(AS.admin(), 200);
    expect(pages.some((page) => page.text.includes('requirement other-1'))).toBe(false);
  });

  test.each([
    ['limit=0'],
    ['limit=201'],
    ['limit=abc'],
    ['limit=1.5'],
    ['cursor='],
    ['cursor=not*base64'],
    [`cursor=${Buffer.from('2026-02-30 10:00:00+00|5').toString('base64url')}`],
    [`cursor=${Buffer.from('yesterday|5').toString('base64url')}`],
    [`cursor=${Buffer.from('2026-02-01 10:00:00+00|0').toString('base64url')}`],
    [`cursor=${Buffer.from('2026-02-01 10:00:00+00').toString('base64url')}`],
  ])('a malformed %s is a 400, not a database error', async (query) => {
    const page = await pageAs(AS.admin(), `?${query}`);
    expect(page.status).toBe(400);
  });
});
