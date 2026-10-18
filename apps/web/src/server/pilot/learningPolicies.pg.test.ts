// Real PostgreSQL proof of the bars writer (lane L49, learningPolicies.ts): a
// gym admin's ratification is version 1, the next supersedes it, each kind has
// its own chain and one bar in force, and another gym's admin cannot sign this
// gym's bar. It ratifies the approved v1 bars (learningPolicyApprovedV1.ts),
// the way a gym admin will.
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

import { Client } from 'pg';

import { closePool } from './db';
import {
  APPROVED_ATHLETE_LESSON_V1,
  APPROVED_CITATIONS_V1,
  APPROVED_OBSERVER_CALIBRATION_V1,
  APPROVED_PATTERN_FORMATION_V1,
} from './learningPolicyApprovedV1';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-learning-policies-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_learning_policies';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-lp-1';
const OTHER_ORG = 'org-lp-2';
const OFFICE = 'acct-lp-office';
const COACH = 'acct-lp-coach';
const OTHER_OFFICE = 'acct-lp-other-office';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let writer: typeof import('./learningPolicies');

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
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Other Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  for (const [accountId, role, organizationId] of [
    [OFFICE, 'organization_admin', ORG], [COACH, 'coach', ORG], [OTHER_OFFICE, 'organization_admin', OTHER_ORG],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, organizationId],
    );
    await db.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)`,
      [accountId, organizationId, role],
    );
  }
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  writer = await import('./learningPolicies');
});

afterAll(async () => {
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

describe('ratifying a bar', () => {
  const ratify = (overrides: Partial<Parameters<typeof writer.ratifyLearningPolicy>[0]> = {}) => writer.ratifyLearningPolicy({
    organizationId: ORG, kind: 'pattern_formation', parameters: APPROVED_PATTERN_FORMATION_V1,
    citations: APPROVED_CITATIONS_V1.pattern_formation,
    ratifiedByAccountId: OFFICE, ratifiedByRole: 'organization_admin', ...overrides,
  });

  test('the first is version 1; the next supersedes it; each kind keeps its own chain', async () => {
    const v1 = await ratify();
    expect(v1).toEqual(expect.objectContaining({
      version: 1, status: 'active', supersedes_policy_id: null,
      parameters: APPROVED_PATTERN_FORMATION_V1, citations: APPROVED_CITATIONS_V1.pattern_formation,
    }));
    const v2 = await ratify({ parameters: { ...APPROVED_PATTERN_FORMATION_V1, currentWithinDays: 90 } });
    expect(v2).toEqual(expect.objectContaining({ version: 2, status: 'active', supersedes_policy_id: v1.policy_id }));
    const lesson = await ratify({
      kind: 'athlete_lesson', parameters: APPROVED_ATHLETE_LESSON_V1, citations: APPROVED_CITATIONS_V1.athlete_lesson,
    });
    expect(lesson).toEqual(expect.objectContaining({ version: 1, supersedes_policy_id: null }));
    const calibration = await ratify({
      kind: 'observer_calibration', parameters: APPROVED_OBSERVER_CALIBRATION_V1,
      citations: APPROVED_CITATIONS_V1.observer_calibration,
    });
    expect(calibration).toEqual(expect.objectContaining({ version: 1, supersedes_policy_id: null }));

    const all = await writer.listLearningPolicies(ORG);
    expect(all.map((row) => [row.policy_kind, row.version, row.status])).toEqual([
      ['athlete_lesson', 1, 'active'],
      ['observer_calibration', 1, 'active'],
      ['pattern_formation', 2, 'active'],
      ['pattern_formation', 1, 'superseded'],
    ]);
    expect(await writer.listLearningPolicies(OTHER_ORG)).toEqual([]);
  });

  test("another gym's admin cannot sign this gym's bar; nothing is changed", async () => {
    await expect(ratify({ ratifiedByAccountId: OTHER_OFFICE })).rejects.toThrow('Only an admin of this gym');
    const active = (await writer.listLearningPolicies(ORG)).filter((row) => row.policy_kind === 'pattern_formation' && row.status === 'active');
    expect(active.map((row) => row.version)).toEqual([2]);
  });

  test('a bar with no source, or one out of shape, never reaches the table', async () => {
    await expect(ratify({ citations: [] })).rejects.toThrow('at least one cited source');
    await expect(ratify({ parameters: { currentWithinDays: 84 } })).rejects.toThrow('missing tiers');
    expect((await writer.listLearningPolicies(ORG)).length).toBe(4);
  });
});
