// Real PostgreSQL proof that intake's promotion and the account cleanup cannot
// leave a live athlete record held by a login marked deleted
// (OD-2026-09-29-002 item 4; the build-list row "Intake can leave a live
// athlete whose login is marked deleted").
//
// WHAT IT PROVES
//
//   1. SEQUENTIAL. The cleanup retired an athlete's never-redeemed login while
//      no athlete row existed. A later promotion of the same athlete_id that
//      names NO account_id is refused, and writes nothing.
//   2. INTAKE FIRST. A promotion is held between its checks and its athlete
//      write. The real cleanup runner (scripts/pilot-cleanup-accounts.mjs,
//      apply mode) is started against the same database and waits; once the
//      promotion commits, the runner leaves that login alone.
//   3. CLEANUP FIRST. The cleanup has retired the login, uncommitted. A
//      promotion started now waits; once the cleanup commits, it is refused.
//
//   4. A LOGIN LINKED MID-RETIRE. A login with no athlete_id gets no lock key.
//      The retire statement waits on that row while intake commits a new
//      athlete and links the login to it; the retire then leaves it alone.
//
// Each fails if its guard is removed: the unconditional check (1), intake's
// lock or the runner's lock (2), intake's lock or the lock SQL (3), the
// retire statement's planned-athlete_id clause (4). Without the locks the two
// sides each check before the other writes.
//
// WHY REAL POSTGRES. The guarantee is about two connections and advisory
// locks; no stub has either. ./db is replaced by a real pg Pool on the
// embedded database, built the way db.ts builds query() and withTransaction(),
// so writePromotedAthleteRecord runs its own SQL on its own connection.
//
// Spins up the same disposable, local-only embedded Postgres the other .pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client, Pool, type PoolClient } from 'pg';

import { writePromotedAthleteRecord } from './intake';

jest.setTimeout(420_000);

// The pool is created in beforeAll, once the embedded server's port is known.
let mockPool: Pool | null = null;
// When armed, the promotion's athlete insert waits for mockGate.release, and
// mockGate.reached resolves as it starts waiting.
let mockGate: { reached: () => void; wait: Promise<void> } | null = null;

jest.mock('./db', () => {
  const pool = () => {
    if (!mockPool) throw new Error('test bug: no embedded pool');
    return mockPool;
  };
  const gated = (client: PoolClient): PoolClient => new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'query') return Reflect.get(target, prop, receiver);
      return async (text: string, values?: unknown[]) => {
        if (mockGate && String(text).trimStart().startsWith('insert into pilot.athletes')) {
          const gate = mockGate;
          mockGate = null;
          gate.reached();
          await gate.wait;
        }
        return target.query(text, values);
      };
    },
  });
  return {
    query: async (text: string, values: unknown[] = []) => (await pool().query(text, values)).rows,
    queryOne: async (text: string, values: unknown[] = []) => (await pool().query(text, values)).rows[0] ?? null,
    withTransaction: async (fn: (client: PoolClient) => Promise<unknown>) => {
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        const result = await fn(gated(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
});

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intake-deleted-login-race-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-cleanup-accounts.mjs');
const PLAN_MODULE_PATH = path.resolve(__dirname, '../../../scripts/lib/account-cleanup-plan.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_intake_deleted_login_race';
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // pilot.accounts.deleted_at and pilot.athletes.deleted_at.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  // pilot.athletes.emergency_contact_note, which upsertAthlete writes.
  'pilot_slice_postgres_emergency_contact_note_migration.sql',
];

const ORG = 'org-idlr';
const COACH = 'idlr-coach';

// ts-jest downlevels a plain dynamic import into require(), which cannot load
// an ESM-only .mjs file. Same trick the other .pg suites use.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let ATHLETE_LOGIN_LOCK_SQL: string;
let RETIRE_ACCOUNTS_SQL: string;

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

function athlete(athleteId: string) {
  const now = new Date().toISOString();
  return {
    athlete_id: athleteId,
    full_name: 'Race Athlete',
    dob: '2012-01-01',
    weight_class: 'open',
    gym_status: 'active',
    emergency_contact: 'n/a',
    active_flag: true,
    coach_id: COACH,
    created_at: now,
    updated_at: now,
  };
}

// The login of a child added to the roster who never redeemed a code: an
// inactive athlete login with an athlete_id and no athlete row behind it --
// exactly what the cleanup's residue rule retires.
async function seedNeverActivatedLogin(accountId: string, athleteId: string, deleted = false): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, active_flag, deleted_at)
     values ($1, 'athlete', $2, 'ppbf_local', $3, false, case when $4::boolean then now() else null end)`,
    [accountId, ORG, athleteId, deleted],
  );
}

async function loginDeleted(accountId: string): Promise<boolean> {
  const row = await client.query<{ deleted: boolean }>(
    'select deleted_at is not null as deleted from pilot.accounts where account_id = $1',
    [accountId],
  );
  return row.rows[0].deleted;
}

async function athleteRow(athleteId: string): Promise<{ deleted: boolean } | null> {
  const row = await client.query<{ deleted: boolean }>(
    'select deleted_at is not null as deleted from pilot.athletes where organization_id = $1 and athlete_id = $2',
    [ORG, athleteId],
  );
  return row.rows[0] ?? null;
}

// The defect itself, over the whole table: a live athlete record whose login
// is marked deleted.
async function liveRecordsHeldByDeletedLogins(): Promise<string[]> {
  const rows = await client.query<{ athlete_id: string }>(
    `select t.athlete_id
       from pilot.athletes t
       join pilot.accounts a on a.organization_id = t.organization_id and a.athlete_id = t.athlete_id
      where t.deleted_at is null and a.deleted_at is not null`,
  );
  return rows.rows.map((row) => row.athlete_id);
}

// Resolves true once some session waits on a lock of the given kind
// (advisory, or a row lock for 'transactionid'), false after `ms` -- a removed
// lock shows up as false here and as a wrong end state below. Each caller
// races this against the other side finishing, so the cap only bounds a
// broken run.
async function waitForLockWaiter(locktype: 'advisory' | 'transactionid', ms = 180_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const row = await client.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_locks where locktype = $1 and not granted`,
      [locktype],
    );
    if (row.rows[0].waiting > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function runCleanupRunner(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Only what the runner needs: never the parent's environment, which on a
    // developer machine may hold another connection string.
    const child = spawn(process.execPath, [RUNNER_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
        PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
        PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
        PPBF_ACCOUNT_CLEANUP_APPLY: 'true',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
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
      // Longer than the other suites' 120 s: a loaded Windows machine was
      // observed taking 144 s to start the server.
    }, 300_000);

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

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  for (const file of MIGRATIONS) {
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }

  const planModule = await nativeDynamicImport(pathToFileURL(PLAN_MODULE_PATH).href);
  ATHLETE_LOGIN_LOCK_SQL = planModule.ATHLETE_LOGIN_LOCK_SQL as string;
  RETIRE_ACCOUNTS_SQL = planModule.RETIRE_ACCOUNTS_SQL as string;

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
  // pilot.athletes.coach_id references an account. Active, so the cleanup
  // holds it.
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, 'coach', $2, 'ppbf_local', true)`,
    [COACH, ORG],
  );

  mockPool = new Pool({ connectionString: connectionStringFor(TEST_DB_NAME), max: 4 });
});

afterAll(async () => {
  await mockPool?.end();
  await client?.end();
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
  // Swallowed as most .pg suites do: on Windows the killed server can still
  // hold the folder (EBUSY), and test-embedded-pg-server.mjs sweeps leftovers.
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  mockGate = null;
});

// Each case starts from the organization and its coach alone, so a guard
// removed for one case cannot fail the cases after it.
beforeEach(async () => {
  await client.query('delete from pilot.athletes');
  await client.query('delete from pilot.session_tokens');
  await client.query('delete from pilot.organization_memberships');
  await client.query('delete from pilot.accounts where account_id <> $1', [COACH]);
});

test('sequential: a promotion naming no account_id is refused when a deleted login holds the athlete id', async () => {
  await seedNeverActivatedLogin('idlr-kid-seq', 'ATH-SEQ', true);

  await expect(writePromotedAthleteRecord({ organizationId: ORG, athlete: athlete('ATH-SEQ') }))
    .rejects.toMatchObject({ code: 'ATHLETE_RECORD_HELD_BY_DELETED_LOGIN' });

  expect(await athleteRow('ATH-SEQ')).toBeNull();
});

test('intake first: the real cleanup runner waits for the promotion, then leaves the login alone', async () => {
  await seedNeverActivatedLogin('idlr-kid-a', 'ATH-A');

  let reached!: () => void;
  const gateReached = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  mockGate = { reached, wait: new Promise<void>((resolve) => { release = resolve; }) };

  // Held after its checks, before its athlete insert: the widest window.
  const promotion = writePromotedAthleteRecord({ organizationId: ORG, athlete: athlete('ATH-A') });
  await gateReached;

  const runner = runCleanupRunner();
  // With both locks in place the runner blocks on the promotion's lock. Without
  // either, it retires the login now, while the athlete row is uncommitted.
  const runnerWaited = await Promise.race([
    waitForLockWaiter('advisory'),
    runner.then(() => false),
  ]);

  release();
  await promotion;
  const result = await runner;

  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  expect(await loginDeleted('idlr-kid-a')).toBe(false);
  expect(await athleteRow('ATH-A')).toEqual({ deleted: false });
  expect(await liveRecordsHeldByDeletedLogins()).toEqual([]);
  expect(runnerWaited).toBe(true);
});

test('cleanup first: a promotion waits for the cleanup to commit, then is refused', async () => {
  await seedNeverActivatedLogin('idlr-kid-b', 'ATH-B');

  // The runner's own sequence from here (pilot-cleanup-accounts.mjs): the
  // lock, then the retire, in one transaction it has not committed yet.
  const cleanup = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await cleanup.connect();
  let promotion: Promise<void> | null = null;
  try {
    await cleanup.query('begin');
    await cleanup.query(ATHLETE_LOGIN_LOCK_SQL, [['idlr-kid-b']]);
    const retired = await cleanup.query(RETIRE_ACCOUNTS_SQL, [['idlr-kid-b'], ['ATH-B']]);
    expect(retired.rows).toEqual([{ account_id: 'idlr-kid-b' }]);

    promotion = writePromotedAthleteRecord({ organizationId: ORG, athlete: athlete('ATH-B') });
    // Settled-state probe so a promotion that finishes early is not an
    // unhandled rejection while the cleanup is still open.
    const outcome = promotion.then(() => 'written', (error: { code?: string }) => error.code ?? 'error');
    const promotionWaited = await Promise.race([
      waitForLockWaiter('advisory'),
      outcome.then(() => false),
    ]);

    await cleanup.query('commit');

    expect(await outcome).toBe('ATHLETE_RECORD_HELD_BY_DELETED_LOGIN');
    expect(promotionWaited).toBe(true);
  } finally {
    await cleanup.query('rollback').catch(() => {});
    await cleanup.end();
    await promotion?.catch(() => {});
  }

  expect(await loginDeleted('idlr-kid-b')).toBe(true);
  expect(await athleteRow('ATH-B')).toBeNull();
  expect(await liveRecordsHeldByDeletedLogins()).toEqual([]);
});

test('a login linked to a new athlete while the retire waits on it is left alone', async () => {
  // Never linked: the lock step takes no key for it.
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ('idlr-kid-c', 'athlete', $1, 'ppbf_local', false)`,
    [ORG],
  );

  // Stands in for createOrUpdateAthleteAccount, which links the login after
  // the promotion commits. It holds the row first so the retire waits on it.
  const linker = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  const cleanup = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await linker.connect();
  await cleanup.connect();
  try {
    await linker.query('begin');
    await linker.query(`update pilot.accounts set updated_at = now() where account_id = 'idlr-kid-c'`);

    await cleanup.query('begin');
    await cleanup.query(ATHLETE_LOGIN_LOCK_SQL, [['idlr-kid-c']]);
    const retire = cleanup.query<{ account_id: string }>(RETIRE_ACCOUNTS_SQL, [['idlr-kid-c'], [null]]);
    const settled = retire.then(() => false, () => false);
    expect(await Promise.race([waitForLockWaiter('transactionid'), settled])).toBe(true);

    // After the retire's snapshot: the record commits, then the login is linked.
    await writePromotedAthleteRecord({ organizationId: ORG, athlete: athlete('ATH-C') });
    await linker.query(`update pilot.accounts set athlete_id = 'ATH-C' where account_id = 'idlr-kid-c'`);
    await linker.query('commit');

    expect((await retire).rows).toEqual([]);
    await cleanup.query('commit');
  } finally {
    await linker.query('rollback').catch(() => {});
    await cleanup.query('rollback').catch(() => {});
    await linker.end();
    await cleanup.end();
  }

  expect(await loginDeleted('idlr-kid-c')).toBe(false);
  expect(await athleteRow('ATH-C')).toEqual({ deleted: false });
  expect(await liveRecordsHeldByDeletedLogins()).toEqual([]);
});
