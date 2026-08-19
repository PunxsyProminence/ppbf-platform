// Real PostgreSQL-backed test for the durable auth rate limiter (audit #47).
//
// The property under test cannot be demonstrated any other way: the whole
// point of "durable" is that the limit SURVIVES the process. A mocked client
// returns whatever it is told, and the in-memory limiter it replaces would
// pass a same-process test trivially.
//
// What was wrong: /api/pilot/auth/login used ONLY the in-memory limiter, a
// plain Map. That is per-process, so N container replicas meant N independent
// attempt budgets against the same child's 6-digit PIN, and every deploy or
// container recycle reset every lockout to zero. pilot.accounts has no
// failed-attempt column, so nothing else survived. /auth/activate had used
// both limiters all along; login had not.
//
// Spins up the same disposable, local-only embedded Postgres the other
// suites use. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-ratelimit-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_ratelimit';

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-rate-limit-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let rateLimit: typeof import('./rateLimit');
let db: typeof import('./db');

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
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  // pilot.auth_rate_limit_buckets used to arrive here by accident: rateLimit.ts
  // issued `create table if not exists` from inside the request path, so the
  // first call in this suite created it. That DDL is gone -- an unauthenticated
  // login request must not create relations -- and the table is a migration
  // now, applied here the same way every other environment applies it.
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_rate_limit_migration.sql'), 'utf8'),
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  process.env.PPBF_DURABLE_RATE_LIMIT = 'true';

  db = await import('./db');
  rateLimit = await import('./rateLimit');
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

/**
 * Everything the in-memory limiter knows, gone -- exactly what a container
 * recycle, a scale event, or a deploy does to it. The durable row must not
 * care.
 */
function simulateProcessRestart(key: string): void {
  rateLimit.clearRateLimit(key);
}

describe('durable auth rate limiting against real Postgres', () => {
  test('the limit SURVIVES a process restart', async () => {
    const key = 'pin_account:restart-1';
    // Past the free-attempt threshold, into real backoff.
    for (let i = 0; i < 8; i += 1) {
      await rateLimit.recordDurableFailedAttempt(key);
    }

    // In-process, both stores agree.
    expect(rateLimit.checkRateLimit(key).isLimited).toBe(true);

    simulateProcessRestart(key);

    // The volatile limiter has forgotten. This is the exact state a fresh
    // replica starts in, and the state every deploy produced.
    expect(rateLimit.checkRateLimit(key).isLimited).toBe(false);

    // The durable one has not.
    const durable = await rateLimit.checkDurableRateLimit(key);
    expect(durable.isLimited).toBe(true);
    expect(durable.delayMs).toBeGreaterThan(0);
  });

  test('a second replica sees the first replica\'s attempts', async () => {
    // The multi-replica case: the volatile Map is per-process, so without the
    // durable row an attacker got a fresh budget per replica.
    const key = 'pin_account:replica-1';
    for (let i = 0; i < 8; i += 1) {
      await rateLimit.recordDurableFailedAttempt(key);
    }

    simulateProcessRestart(key); // stand in for "a different replica"

    expect((await rateLimit.checkDurableRateLimit(key)).isLimited).toBe(true);
  });

  test('a successful login clears the durable row, not just the in-memory one', async () => {
    const key = 'pin_account:cleared-1';
    for (let i = 0; i < 8; i += 1) {
      await rateLimit.recordDurableFailedAttempt(key);
    }
    expect((await rateLimit.checkDurableRateLimit(key)).isLimited).toBe(true);

    await rateLimit.clearDurableRateLimit(key);

    simulateProcessRestart(key);
    expect((await rateLimit.checkDurableRateLimit(key)).isLimited).toBe(false);

    const row = await db.queryOne<{ n: number }>(
      `select count(*)::int as n from pilot.auth_rate_limit_buckets where bucket_key = $1`,
      [key],
    );
    expect(row?.n).toBe(0);
  });

  test('early attempts sit at the backoff FLOOR, not an escalated delay', async () => {
    // Worth pinning because it is easy to misread MAX_ATTEMPTS_THRESHOLD as
    // "five free attempts". It is not: every failure sets blocked_until, so
    // even the first costs the 1s floor. The threshold governs when the
    // doubling STARTS. A legitimate athlete mistyping their PIN waits a
    // second, not a minute -- that is the property worth protecting.
    const key = 'pin_account:allowance-1';
    const first = await rateLimit.recordDurableFailedAttempt(key);
    const second = await rateLimit.recordDurableFailedAttempt(key);

    expect(first.delayMs).toBe(1000);
    expect(second.delayMs).toBe(1000);

    simulateProcessRestart(key);

    // Still throttled for that second, and the durable row is what says so.
    const durable = await rateLimit.checkDurableRateLimit(key);
    expect(durable.isLimited).toBe(true);
    expect(durable.delayMs).toBeLessThanOrEqual(1000);
  });

  test('backoff grows with attempts rather than staying flat', async () => {
    const key = 'pin_account:backoff-1';
    for (let i = 0; i < 6; i += 1) await rateLimit.recordDurableFailedAttempt(key);
    const early = (await rateLimit.recordDurableFailedAttempt(key)).delayMs;
    for (let i = 0; i < 3; i += 1) await rateLimit.recordDurableFailedAttempt(key);
    const later = (await rateLimit.recordDurableFailedAttempt(key)).delayMs;

    expect(later).toBeGreaterThan(early);
  });

  test('keys are independent: limiting one account does not limit another', async () => {
    const limited = 'pin_account:isolated-a';
    const other = 'pin_account:isolated-b';
    for (let i = 0; i < 8; i += 1) await rateLimit.recordDurableFailedAttempt(limited);

    expect((await rateLimit.checkDurableRateLimit(limited)).isLimited).toBe(true);
    expect((await rateLimit.checkDurableRateLimit(other)).isLimited).toBe(false);
  });

  test('it runs on the shared pool rather than opening its own connections', async () => {
    // The reason this moved off a per-call pg Client: login is a hot path, and
    // a fresh TCP+TLS handshake per attempt is not free. If the limiter were
    // still minting its own clients, the pool would show no activity from it.
    const before = await db.queryOne<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database()`,
    );
    for (let i = 0; i < 5; i += 1) {
      await rateLimit.recordDurableFailedAttempt('pin_account:pooled-1');
      await rateLimit.checkDurableRateLimit('pin_account:pooled-1');
    }
    const after = await db.queryOne<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database()`,
    );

    // Ten durable operations must not have left ten connections behind.
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBeLessThan(5);
  });

  test('a disabled flag turns the durable half off without breaking the volatile half', async () => {
    const key = 'pin_account:disabled-1';
    process.env.PPBF_DURABLE_RATE_LIMIT = 'false';
    try {
      const result = await rateLimit.recordDurableFailedAttempt(key);
      // Still returns the volatile fallback rather than throwing.
      expect(result.delayMs).toBeGreaterThanOrEqual(0);
      expect((await rateLimit.checkDurableRateLimit(key)).isLimited).toBe(false);

      const row = await db.queryOne<{ n: number }>(
        `select count(*)::int as n from pilot.auth_rate_limit_buckets where bucket_key = $1`,
        [key],
      );
      expect(row?.n).toBe(0);
    } finally {
      process.env.PPBF_DURABLE_RATE_LIMIT = 'true';
    }
  });

  // The migration has to produce the shape the runtime DDL used to, or an
  // environment built the sanctioned way gets a table the writes cannot use.
  // Every durable write is `insert ... on conflict (bucket_key) do update`,
  // which needs the primary key -- a table with the right four columns and no
  // key would look migrated and fail every write at runtime.
  test('the migration produces the shape the writes require', async () => {
    const key = await db.queryOne<{ contype: string; def: string }>(
      `select contype, pg_get_constraintdef(oid) as def
       from pg_constraint
       where conrelid = to_regclass('pilot.auth_rate_limit_buckets')
         and contype = 'p'`,
    );
    expect(key?.def).toContain('bucket_key');

    const blockedUntil = await db.queryOne<{ is_nullable: string; data_type: string }>(
      `select is_nullable, data_type
       from information_schema.columns
       where table_schema = 'pilot'
         and table_name = 'auth_rate_limit_buckets'
         and column_name = 'blocked_until'`,
    );
    expect(blockedUntil?.is_nullable).toBe('NO');
    expect(blockedUntil?.data_type).toBe('timestamp with time zone');
  });

  // The property that makes deleting the runtime DDL safe.
  //
  // rateLimit.ts no longer creates the table, so an environment that has not
  // applied the migration will hit a missing relation on every durable call.
  // withDurableClient swallows that and returns null, and every caller reads
  // null as "fall back to the in-memory limiter". If it ever read null as
  // "deny", an unmigrated deploy would lock every athlete out of the platform
  // on a table that is only a guard.
  test('a missing table degrades to the volatile limiter instead of denying', async () => {
    await db.query('alter table pilot.auth_rate_limit_buckets rename to auth_rate_limit_buckets_hidden');
    try {
      const key = 'pin_account:no-table-1';

      // The durable half cannot answer, and the caller is not denied.
      await expect(rateLimit.checkDurableRateLimit(key)).resolves.toMatchObject({ isLimited: false });

      // Recording still returns a usable volatile backoff rather than throwing.
      const result = await rateLimit.recordDurableFailedAttempt(key);
      expect(result.delayMs).toBeGreaterThanOrEqual(0);
    } finally {
      await db.query('alter table pilot.auth_rate_limit_buckets_hidden rename to auth_rate_limit_buckets');
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// The suite above migrates one database in beforeAll with a plain
// `client.query` and then tests the module on top of it. That proves the
// schema and proves nothing about scripts/pilot-apply-rate-limit-migration.mjs's
// READINESS_QUERY -- the assertion that gates the actual dispatch, and the
// only code in this migration whose first real execution is against a live
// environment at the most expensive possible moment.
//
// #488 is what that costs: a readiness check that searched
// pg_get_constraintdef() for the literal `between 1 and 5` could not pass on
// ANY database, because Postgres deparses a CHECK from the parsed tree and
// emits `>= 1 AND <= 5`. The schema was correct the whole time. Only a real
// staging dispatch found it.
//
// The query is never restated here -- `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots. It brings its own disposable
// database so the migrated one the module tests run against is untouched.
describe('durable rate limit runner readiness assertion', () => {
  async function runnerDatabase(name: string): Promise<Client> {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(name) });
    await client.connect();
      await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
    return client;
  }

  async function loadRunner(): Promise<(client: Client, sql: string) => Promise<void>> {
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    return runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
  }

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_ratelimit_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /RATE_LIMIT_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_ratelimit_rdy_ok');
    try {
      const migrationSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_rate_limit_migration.sql'), 'utf8');
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
