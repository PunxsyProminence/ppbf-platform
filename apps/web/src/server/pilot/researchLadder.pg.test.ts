// Real PostgreSQL proof that the research answer-state ladder /research shows
// (issue #345: needs evidence -> sources submitted -> evidence under review ->
// partially answered -> resolved) reads the submissions actually stored, through
// the REAL research-submissions GET; only requirePrincipal is stubbed.
//
// Why this exists: the ladder rule (deriveAnswerState) was unit-tested, and the
// batch read /research uses was tested only with mocks or with no submissions at
// all. research_requirement_id is a bigint, which node-postgres hands back as a
// string, so a batch keyed by the raw column and looked up by number found
// nothing and every open requirement read "needs evidence" whatever had been
// submitted or reviewed.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-ladder-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_research_ladder';

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

const ORG = 'org-rl-1';
const ADMIN_ACCOUNT = 'acct-rl-admin';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let submissionsGet: (request: NextRequest) => Promise<Response>;

// One requirement per rung, each with the submissions that put it there.
type Rung = 'needs_evidence' | 'sources_submitted' | 'evidence_under_review' | 'partially_answered' | 'resolved';
const CASES: Array<{ key: string; status: 'open' | 'resolved'; verdicts: string[]; expected: Rung }> = [
  { key: 'nothing-submitted', status: 'open', verdicts: [], expected: 'needs_evidence' },
  { key: 'one-unreviewed', status: 'open', verdicts: ['unreviewed'], expected: 'sources_submitted' },
  { key: 'refused-and-waiting', status: 'open', verdicts: ['not_responsive', 'unreviewed'], expected: 'evidence_under_review' },
  { key: 'responsive', status: 'open', verdicts: ['responsive'], expected: 'partially_answered' },
  { key: 'partly-responsive', status: 'open', verdicts: ['partially_responsive', 'unreviewed'], expected: 'partially_answered' },
  { key: 'all-refused', status: 'open', verdicts: ['not_responsive', 'duplicate'], expected: 'needs_evidence' },
  { key: 'closed', status: 'resolved', verdicts: ['unreviewed'], expected: 'resolved' },
];
const idByKey = new Map<string, number>();

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

function admin(): PilotPrincipal {
  return {
    accountId: ADMIN_ACCOUNT,
    role: 'organization_admin',
    organizationId: ORG,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
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

  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  await adminClient.query(`drop database if exists ${TEST_DB_NAME}`);
  await adminClient.query(`create database ${TEST_DB_NAME}`);
  await adminClient.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Punxsy Prominence', 'active')`, [ORG]);
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'organization_admin', $2, 'microsoft')`,
    [ADMIN_ACCOUNT, ORG],
  );

  // Pad the id sequence first, so no requirement id coincides with a small
  // array index or count that a wrong lookup could match by accident.
  await db.query(`select setval(pg_get_serial_sequence('pilot.shadow_research_requirements', 'research_requirement_id'), 4100)`);

  let sourceIndex = 0;
  for (const testCase of CASES) {
    const inserted = await db.query<{ id: string }>(
      `insert into pilot.shadow_research_requirements
         (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
          knowledge_gap, source_status, source_confidence_tier, source_verification_state,
          created_by_account_id, created_by_role, status, resolved_at)
       values ($1, 'MANUAL_RESEARCH_NOTE', 'manual_note', $2, $3, 'gap', 'missing', 'INSUFFICIENT', 'unknown',
               $4, 'organization_admin', $5, case when $5 = 'resolved' then now() end)
       returning research_requirement_id::text as id`,
      [ORG, testCase.key, `requirement ${testCase.key}`, ADMIN_ACCOUNT, testCase.status],
    );
    const requirementId = Number(inserted.rows[0].id);
    idByKey.set(testCase.key, requirementId);

    for (const verdict of testCase.verdicts) {
      sourceIndex += 1;
      const sourceId = `src-rl-${sourceIndex}`;
      await db.query(
        `insert into pilot.shadow_library_sources
           (source_id, organization_id, title, source_type, authority_tier, status, created_by_account_id, created_by_role)
         values ($1, $2, $3, 'peer_reviewed', 2, 'active', $4, 'organization_admin')`,
        [sourceId, ORG, `Source ${sourceIndex}`, ADMIN_ACCOUNT],
      );
      const reviewed = verdict !== 'unreviewed';
      await db.query(
        `insert into pilot.shadow_research_submissions
           (organization_id, submission_id, research_requirement_id, source_id, applicability_state,
            reviewed_by_account_id, reviewed_at, submitted_by_account_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ORG, `sub-rl-${sourceIndex}`, requirementId, sourceId, verdict,
          reviewed ? ADMIN_ACCOUNT : null, reviewed ? new Date() : null, ADMIN_ACCOUNT,
        ],
      );
    }
  }

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  const submissions = await import('@/app/api/pilot/shadow/research-submissions/route');
  submissionsGet = submissions.GET;
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

describe('the research answer-state ladder reads the stored submissions (#345)', () => {
  test('the batch read /research uses puts every requirement on its rung', async () => {
    mockRequirePrincipal.mockResolvedValue(admin());
    const ids = CASES.map((testCase) => idByKey.get(testCase.key)!);
    const response = await submissionsGet(new NextRequest(
      `http://localhost/api/pilot/shadow/research-submissions?research_requirement_ids=${ids.join(',')}`,
    ));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { answer_states: Record<string, Rung> };
    expect(body.answer_states).toEqual(Object.fromEntries(
      CASES.map((testCase) => [String(idByKey.get(testCase.key)), testCase.expected]),
    ));
  });

  test.each(CASES.map((testCase) => [testCase.key, testCase.expected] as const))(
    'the single read agrees with the batch for %s (%s)',
    async (key, expected) => {
      mockRequirePrincipal.mockResolvedValue(admin());
      const response = await submissionsGet(new NextRequest(
        `http://localhost/api/pilot/shadow/research-submissions?research_requirement_id=${idByKey.get(key)}`,
      ));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { answer_state: Rung };
      expect(body.answer_state).toBe(expected);
    },
  );
});
