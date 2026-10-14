// Real PostgreSQL proof of who reads an athlete's or parent's auto-filed,
// unanswered SHADOW question (F-054; Jason 2026-10-13 "A: Office + asker
// (Recommended)", on OD-2026-10-07-009 ruling 4: a child's words are not for
// the whole coaching staff).
//
// The rows are filed by the REAL fileUnansweredShadowQuestion against the real
// table, and read back through the REAL route handlers with the real access
// gates; only requirePrincipal is stubbed. Rules under test:
//   - the organization admin reads the words;
//   - the asker reads their own;
//   - a coach receives the row (it exists, it is open) with a fixed sentence
//     in place of the words, and no asker id and no key;
//   - another athlete, the asker's guardians, another guardian of the same
//     child, and the other gym read nothing of it.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-asker-question-reads-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_asker_question_reads';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-aq-1';
const OTHER_ORG = 'org-aq-2';
const ATHLETE_A = 'ath-aq-a';
const ATHLETE_B = 'ath-aq-b';

/** Distinctive words, so a leak anywhere in a serialized body is a string match. */
const ATHLETE_WORDS = 'ZEBRA-ATHLETE-7731 my coach hits me and I am scared to go to the gym';
const PARENT_WORDS = 'QUOKKA-PARENT-4419 my son says an adult at the gym touched him';
const ATHLETE_FRAGMENT = 'ZEBRA-ATHLETE-7731';
const PARENT_FRAGMENT = 'QUOKKA-PARENT-4419';
const COACH_SENTENCE = 'A question from an athlete or parent that SHADOW could not answer. The gym administrator can read it.';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let listGet: (request: NextRequest) => Promise<Response>;
let requirementsPost: (request: NextRequest) => Promise<Response>;
let fileQuestion: typeof import('./shadowResearchFiling').fileUnansweredShadowQuestion;
const ids: { athleteRow?: number; parentRow?: number } = {};

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

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
  admin: () => principal({ accountId: 'acct-aq-admin', role: 'organization_admin' }),
  coach: () => principal({ accountId: 'acct-aq-coach', role: 'coach' }),
  athleteA: () => principal({ accountId: 'acct-aq-athlete-a', role: 'athlete', athleteId: ATHLETE_A }),
  athleteB: () => principal({ accountId: 'acct-aq-athlete-b', role: 'athlete', athleteId: ATHLETE_B }),
  guardianOfA: () => principal({ accountId: 'acct-aq-guardian-a', role: 'parent' }),
  guardianB1: () => principal({ accountId: 'acct-aq-guardian-b1', role: 'parent' }),
  guardianB2: () => principal({ accountId: 'acct-aq-guardian-b2', role: 'parent' }),
  otherOrgCoach: () => principal({ accountId: 'acct-aq-coach-org2', role: 'coach', organizationId: OTHER_ORG }),
  otherOrgAdmin: () => principal({ accountId: 'acct-aq-admin-org2', role: 'organization_admin', organizationId: OTHER_ORG }),
} as const;

interface Listed {
  status: number;
  /** The WHOLE response body as the reader receives it. */
  text: string;
  items: Array<Record<string, unknown>>;
}

async function listAs(actor: PilotPrincipal): Promise<Listed> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await listGet(new NextRequest('http://localhost/api/pilot/shadow/research-requirements'));
  const text = await response.text();
  let items: Array<Record<string, unknown>> = [];
  try {
    items = (JSON.parse(text) as { items?: Array<Record<string, unknown>> }).items ?? [];
  } catch {
    items = [];
  }
  return { status: response.status, text, items };
}

const idsOf = (listed: Listed): number[] => listed.items.map((item) => Number(item.research_requirement_id));

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

  const accounts: Array<[string, string, string, string | null]> = [
    ['acct-aq-admin', 'organization_admin', ORG, null],
    ['acct-aq-coach', 'coach', ORG, null],
    ['acct-aq-athlete-a', 'athlete', ORG, ATHLETE_A],
    ['acct-aq-athlete-b', 'athlete', ORG, ATHLETE_B],
    ['acct-aq-guardian-a', 'parent', ORG, null],
    ['acct-aq-guardian-b1', 'parent', ORG, null],
    ['acct-aq-guardian-b2', 'parent', ORG, null],
    ['acct-aq-coach-org2', 'coach', OTHER_ORG, null],
    ['acct-aq-admin-org2', 'organization_admin', OTHER_ORG, null],
  ];
  for (const [accountId, role, organizationId, athleteId] of accounts) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ($1, $2, $3, $4, 'microsoft')`,
      [accountId, role, organizationId, athleteId],
    );
  }

  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, 'acct-aq-coach', now(), now()),
       ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, 'acct-aq-coach', now(), now())`,
    [ORG, ATHLETE_A, ATHLETE_B],
  );
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values
       ($1, 'par-aq-a', 'acct-aq-guardian-a', 'Guardian of A', '555-0100', 'a@example.test'),
       ($1, 'par-aq-b1', 'acct-aq-guardian-b1', 'Guardian B1', '555-0200', 'b1@example.test'),
       ($1, 'par-aq-b2', 'acct-aq-guardian-b2', 'Guardian B2', '555-0300', 'b2@example.test')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-aq-a', $2, 'mother'), ($1, 'par-aq-b1', $3, 'father'), ($1, 'par-aq-b2', $3, 'mother')`,
    [ORG, ATHLETE_A, ATHLETE_B],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  listGet = (await import('@/app/api/pilot/shadow/research-requirements/route')).GET;
  requirementsPost = (await import('@/app/api/pilot/shadow/research-requirements/route')).POST;
  fileQuestion = (await import('./shadowResearchFiling')).fileUnansweredShadowQuestion;

  // Filed by the real function, as the chat route calls it. The athlete is
  // talking about themselves (athleteId passed), the parent about their son.
  expect(await fileQuestion({
    organizationId: ORG, accountId: 'acct-aq-athlete-a', role: 'athlete', question: ATHLETE_WORDS, athleteId: ATHLETE_A,
  })).toBe(true);
  expect(await fileQuestion({
    organizationId: ORG, accountId: 'acct-aq-guardian-b1', role: 'parent', question: PARENT_WORDS, athleteId: ATHLETE_B,
  })).toBe(true);

  const rows = await db.query<{ research_requirement_id: number; created_by_account_id: string }>(
    `select research_requirement_id, created_by_account_id from pilot.shadow_research_requirements
      where organization_id = $1 order by research_requirement_id`,
    [ORG],
  );
  ids.athleteRow = Number(rows.rows.find((row) => row.created_by_account_id === 'acct-aq-athlete-a')?.research_requirement_id);
  ids.parentRow = Number(rows.rows.find((row) => row.created_by_account_id === 'acct-aq-guardian-b1')?.research_requirement_id);
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

describe('the fixture', () => {
  test('two subject-less rows exist, filed by the asking accounts, carrying the words', async () => {
    const rows = await db.query<{ subject_id: string | null; research_requirement: string; created_by_role: string }>(
      `select subject_id, research_requirement, created_by_role from pilot.shadow_research_requirements
        where organization_id = $1 and source_event_name = 'shadow_unanswered_question' order by research_requirement_id`,
      [ORG],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.subject_id === null)).toBe(true);
    expect(rows.rows.map((row) => row.created_by_role).sort()).toEqual(['athlete', 'parent']);
    expect(rows.rows.map((row) => row.research_requirement).join(' ')).toContain(ATHLETE_FRAGMENT);
    expect(ids.athleteRow).toBeGreaterThan(0);
    expect(ids.parentRow).toBeGreaterThan(0);
  });
});

describe('who reads an athlete\'s or parent\'s unanswered question', () => {
  test('the organization admin reads both, words and all', async () => {
    const listed = await listAs(AS.admin());
    expect(listed.status).toBe(200);
    expect(idsOf(listed)).toEqual(expect.arrayContaining([ids.athleteRow, ids.parentRow]));
    expect(listed.text).toContain(ATHLETE_FRAGMENT);
    expect(listed.text).toContain(PARENT_FRAGMENT);
  });

  test('a coach sees that both exist and are open, and none of the words, keys or asker ids', async () => {
    const listed = await listAs(AS.coach());
    expect(listed.status).toBe(200);
    expect(idsOf(listed)).toEqual(expect.arrayContaining([ids.athleteRow, ids.parentRow]));
    for (const item of listed.items) {
      if (item.source_event_name !== 'shadow_unanswered_question') continue;
      expect(item.status).toBe('open');
      expect(item.research_requirement).toBe(COACH_SENTENCE);
      expect(item.knowledge_gap).toBe(COACH_SENTENCE);
    }
    for (const leak of [ATHLETE_FRAGMENT, PARENT_FRAGMENT, 'scared', 'touched him', 'acct-aq-athlete-a', 'acct-aq-guardian-b1', 'acct:']) {
      expect(listed.text).not.toContain(leak);
    }
  });

  test('a coach closing one gets no row back, so no words', async () => {
    mockRequirePrincipal.mockResolvedValue(AS.coach());
    const response = await requirementsPost(new NextRequest('http://localhost/api/pilot/shadow/research-requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'resolve',
        research_requirement_id: ids.athleteRow,
        closing_note: 'Answered with the family.',
      }),
    }));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, resolved: true });
    for (const leak of [ATHLETE_FRAGMENT, 'scared', 'acct-aq-athlete-a', 'acct:']) {
      expect(text).not.toContain(leak);
    }
  });

  test('the asker reads their own words and not the other asker\'s', async () => {
    const athlete = await listAs(AS.athleteA());
    expect(athlete.status).toBe(200);
    expect(idsOf(athlete)).toEqual([ids.athleteRow]);
    expect(athlete.text).toContain(ATHLETE_FRAGMENT);
    expect(athlete.text).not.toContain(PARENT_FRAGMENT);

    const parent = await listAs(AS.guardianB1());
    expect(parent.status).toBe(200);
    expect(idsOf(parent)).toEqual([ids.parentRow]);
    expect(parent.text).toContain(PARENT_FRAGMENT);
    expect(parent.text).not.toContain(ATHLETE_FRAGMENT);
  });

  test.each([
    ['another athlete', AS.athleteB],
    ['the asking athlete\'s guardian', AS.guardianOfA],
    ['the other guardian of the asking parent\'s child', AS.guardianB2],
  ])('%s reads neither row nor any of the words', async (_label, actor) => {
    const listed = await listAs(actor());
    expect(listed.status).toBe(200);
    expect(idsOf(listed)).toEqual([]);
    for (const leak of [ATHLETE_FRAGMENT, PARENT_FRAGMENT, 'scared', 'touched him']) {
      expect(listed.text).not.toContain(leak);
    }
  });

  test('the other gym\'s coach and organization admin read neither row', async () => {
    for (const actor of [AS.otherOrgCoach(), AS.otherOrgAdmin()]) {
      const listed = await listAs(actor);
      expect(idsOf(listed)).toEqual([]);
      expect(listed.text).not.toContain(ATHLETE_FRAGMENT);
      expect(listed.text).not.toContain(PARENT_FRAGMENT);
    }
  });
});
