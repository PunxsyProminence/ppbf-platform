// Real PostgreSQL-backed test for getCoachDisplayName's tenancy rule.
//
// './db' is mocked to route into an embedded server, so the function exercised
// below is the actual production function running its actual SQL against
// actual rows. That matters more than usual here: the bug this suite exists
// for was invisible to every mocked test, because it lived entirely in a
// WHERE clause.
//
// WHAT WENT WRONG. The resolver filtered pilot.accounts on
// `organization_id = $1`. That table holds ONE row per account with ONE home
// organization, so the filter answered "is this the account's HOME gym" --
// which is not the question a caller asks. A coach whose home gym is elsewhere
// but who holds an ACTIVE membership here authors perfectly ordinary records:
// hasBlockWriteMembership exists for exactly that case, and
// athleteDevelopmentBlocks.pg.test.ts has a case named for it. For that coach
// the resolver found no row, and every surface fell back to the phrase
// "Your coach" -- silently, and precisely for the multi-gym coaches the
// membership model exists to support.
//
// It reached all five callers: recognitions, behavior standards, the One
// Percent Club, and both development-block surfaces -- including the family
// page, where naming the coach is the entire point of the field.
//
// WHAT MUST NOT CHANGE, asserted here rather than assumed: tenancy. A caller
// may name someone homed here OR actively a member here, and nobody else.
// Holding an account id must never let one gym read a stranger's name.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';

import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
}));

import { getCoachDisplayName } from './achievements';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-name-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const HOME_ORG = 'org-home';
const OTHER_ORG = 'org-other';

/** Homed here. Resolved correctly before this fix and after it. */
const LOCAL_COACH = 'acct-local-coach';
/** Homed ELSEWHERE, actively a member here. The case the fix is for. */
const VISITING_COACH = 'acct-visiting-coach';
/** Homed elsewhere, membership here but INACTIVE. Must stay unnamed. */
const LAPSED_COACH = 'acct-lapsed-coach';
/** Homed elsewhere, no membership here at all. Must stay unnamed. */
const STRANGER = 'acct-stranger';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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

/**
 * The whole schema, then four accounts that differ ONLY in how they are
 * attached to HOME_ORG. Each login_email derives a distinct name, so a wrong
 * row is visible as a wrong name rather than as a passing assertion.
 */
async function seededDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [HOME_ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }

  await client.query(
    `insert into pilot.accounts (account_id, login_email, role, organization_id, auth_provider)
     values ($1, 'j.rivera@ppbf.test',  'coach', $5, 'microsoft'),
            ($2, 'm.okafor@ppbf.test',  'coach', $6, 'microsoft'),
            ($3, 'd.laurent@ppbf.test', 'coach', $6, 'microsoft'),
            ($4, 's.nowak@ppbf.test',   'coach', $6, 'microsoft')`,
    [LOCAL_COACH, VISITING_COACH, LAPSED_COACH, STRANGER, HOME_ORG, OTHER_ORG],
  );

  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $4, 'coach', true),
            ($2, $4, 'coach', true),
            ($3, $4, 'coach', false)`,
    [LOCAL_COACH, VISITING_COACH, LAPSED_COACH, HOME_ORG],
  );

  activeClient = client;
  return client;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
});

afterEach(() => { activeClient = null; });

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

describe('naming a coach in the organization asking', () => {
  let client: Client;

  beforeEach(async () => { client = await seededDatabase('coach_display_name'); });
  afterEach(async () => { await client.end(); });

  test('a coach homed in this organization is named', async () => {
    expect(await getCoachDisplayName(HOME_ORG, LOCAL_COACH)).toBe('Coach J Rivera');
  });

  test('a coach homed ELSEWHERE with an active membership here is named', async () => {
    /* THE REGRESSION THIS SUITE EXISTS FOR. Before the fix this returned the
       phrase "Your coach", because pilot.accounts holds one home org and the
       filter asked about that rather than about presence in the asking gym.
       Silently wrong, and only for multi-gym coaches. */
    expect(await getCoachDisplayName(HOME_ORG, VISITING_COACH)).toBe('Coach M Okafor');
  });

  test('an INACTIVE membership does not name them', async () => {
    // active_flag is load-bearing: a coach who left is not someone this gym
    // may still put a name to.
    expect(await getCoachDisplayName(HOME_ORG, LAPSED_COACH)).toBe('Your coach');
  });

  test('an account with no claim on this organization is never named', async () => {
    /* TENANCY, which the fix must not widen. Holding an account id must not
       let one gym read a stranger's name -- the fallback phrase is the right
       answer here, not a bug. */
    expect(await getCoachDisplayName(HOME_ORG, STRANGER)).toBe('Your coach');
  });

  test('the other organization names its own, and not this one\'s', async () => {
    // The mirror image, so the rule is symmetric rather than accidentally
    // one-directional.
    expect(await getCoachDisplayName(OTHER_ORG, VISITING_COACH)).toBe('Coach M Okafor');
    expect(await getCoachDisplayName(OTHER_ORG, LOCAL_COACH)).toBe('Your coach');
  });
});
