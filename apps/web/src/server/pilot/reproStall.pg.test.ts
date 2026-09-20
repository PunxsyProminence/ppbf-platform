// BASE-02 bounded diagnostic (round 4, owner-authorized single-variable
// isolation "Run C"): identical to Run A (round 2: real 42-file sorted
// prefix through drills, no client.query wrapper, no extra worker GUC
// queries, applyFullSchema called directly on the unwrapped client) except
// for exactly one intentional difference -- the embedded-postgres server's
// stdout/readline stream is drained continuously for the life of the test
// instead of being closed at the EMBEDDED_PG_READY marker.
//
// Run A: RESULT=PREFIX_HANG_REPRODUCED (stdout reader closed at readiness).
// Run B: RESULT=INSTRUMENTED_PREFIX_DID_NOT_HANG, but also added a
//   client.query wrapper + three extra same-connection GUC queries before
//   drills -- two simultaneous differences, not isolated.
// This run removes Run B's query/session instrumentation entirely and
// keeps only continuous stdout draining, to isolate that one variable.
//
// full-schema.mjs, the migration SQL, and test-embedded-pg-server.mjs are
// read-only inputs; none are edited.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* Same dynamic-import shim fullSchemaFixture.pg.test.ts uses: ts-jest compiles
   a plain `await import()` down to require(), which cannot load an ES module
   on this Node version. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(150_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-repro-stall-pg-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const DRILLS_FILE = 'pilot_slice_postgres_drills_migration.sql';
const WATCH_AFTER_DRILLS_ATTEMPT_MS = 30_000;
const PRE_DRILLS_WATCHDOG_MS = 90_000;
const SERVER_LOG_RING_BUFFER_MAX_LINES = 4_000;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let helper: {
  applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<{ order: string[]; rounds: number }>;
  listMigrationFiles: (infraDir?: string) => Promise<string[]>;
};

// The single intentional Run-A -> Run-C difference: this stream is kept
// drained for the life of the test instead of being closed at readiness.
// The bounded ring buffer is retained only as the mechanism for keeping it
// drained (per authorization) -- its contents are not otherwise inspected
// or reported by this run, since no log-based localization is in scope here.
const serverLogRingBuffer: string[] = [];
function pushServerLogLine(line: string) {
  serverLogRingBuffer.push(line);
  if (serverLogRingBuffer.length > SERVER_LOG_RING_BUFFER_MAX_LINES) {
    serverLogRingBuffer.shift();
  }
}

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

async function freshEmptyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // Single intentional difference from Run A: this readline interface is
  // never closed, so serverProcess.stdout keeps being actively drained for
  // the whole test instead of sitting unconsumed after readiness.
  const rl = readline.createInterface({ input: serverProcess.stdout });
  rl.on('line', pushServerLogLine);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);
    const readyListener = (line: string) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.off('line', readyListener);
        resolve();
      }
    };
    rl.on('line', readyListener);
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  helper = await nativeDynamicImport(pathToFileURL(HELPER_PATH).href) as unknown as typeof helper;
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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

async function captureObserverSnapshot(observerClient: Client, workerPid: number) {
  const blockingPidsResult = await observerClient.query<{ blocking_pids: number[] }>(
    'select pg_blocking_pids($1) as blocking_pids',
    [workerPid],
  );
  const blockingPids: number[] = blockingPidsResult.rows[0]?.blocking_pids ?? [];
  const relevantPids = [workerPid, ...blockingPids];

  const activity = await observerClient.query(
    `
      select
        pid, usename, application_name, state, wait_event_type, wait_event,
        xact_start, query_start, state_change, query as current_query,
        extract(epoch from (now() - query_start)) as query_duration_seconds,
        extract(epoch from (now() - xact_start)) as xact_duration_seconds
      from pg_stat_activity
      where pid = any($1::int[])
      order by pid
    `,
    [relevantPids],
  );

  let locks;
  try {
    locks = await observerClient.query(
      `
        select
          l.pid, l.locktype, d.datname as database, l.relation::regclass::text as relation,
          l.page, l.tuple, l.transactionid, l.virtualxid, l.virtualtransaction,
          l.mode, l.granted, l.fastpath, l.waitstart
        from pg_locks l
        left join pg_database d on d.oid = l.database
        where l.pid = any($1::int[])
        order by l.pid, l.granted desc
      `,
      [relevantPids],
    );
  } catch {
    locks = await observerClient.query(
      `
        select
          l.pid, l.locktype, d.datname as database, l.relation::regclass::text as relation,
          l.page, l.tuple, l.transactionid, l.virtualxid, l.virtualtransaction,
          l.mode, l.granted, l.fastpath
        from pg_locks l
        left join pg_database d on d.oid = l.database
        where l.pid = any($1::int[])
        order by l.pid, l.granted desc
      `,
      [relevantPids],
    );
  }

  return { blockingPids, activity: activity.rows, locks: locks.rows };
}

describe('BASE-02 drills-migration stall — stdout-drain-only isolation (Run C)', () => {
  test('real 42-file prefix, continuous stdout draining, no query wrapper (matches Run A otherwise)', async () => {
    const dbName = 'repro_stall_drainonly';
    const client = await freshEmptyDatabase(dbName);
    const observerClient = new Client({ connectionString: connectionStringFor(dbName) });
    await observerClient.connect();

    const isolatedDir = path.join(os.tmpdir(), `ppbf-repro-stall-drainonly-infra-${Date.now()}`);
    let applyOutcome: { type: 'resolved'; result: { order: string[]; rounds: number } } | { type: 'rejected'; error: unknown } | null = null;

    try {
      const allMigrations = await helper.listMigrationFiles(INFRA_DIR);
      const drillsIndex = allMigrations.indexOf(DRILLS_FILE);
      if (drillsIndex === -1) {
        throw new Error(`${DRILLS_FILE} not found by listMigrationFiles(INFRA_DIR) -- cannot build a prefix.`);
      }
      const prefix = allMigrations.slice(0, drillsIndex + 1);
      const finalPrefixMigration = prefix[prefix.length - 1];

      console.log(`PREFIX_COUNT=${prefix.length}`);
      console.log(`FIRST_PREFIX_MIGRATION=${prefix[0]}`);
      console.log(`FINAL_PREFIX_MIGRATION=${finalPrefixMigration}`);
      if (finalPrefixMigration !== DRILLS_FILE) {
        throw new Error(`FINAL_PREFIX_MIGRATION was "${finalPrefixMigration}", expected "${DRILLS_FILE}". Refusing to proceed.`);
      }

      await fs.mkdir(isolatedDir, { recursive: true });
      await fs.copyFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), path.join(isolatedDir, 'pilot_slice_postgres.sql'));
      await Promise.all(prefix.map((file) => fs.copyFile(path.join(INFRA_DIR, file), path.join(isolatedDir, file))));

      const workerPidResult = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      const workerPid = workerPidResult.rows[0].pid;
      console.log(`WORKER_PID=${workerPid}`);

      // Same watcher as Run A/Run B: timestamps drills' own attempt/applied/
      // failed trace lines via console.error interception. No query wrapper
      // is installed on `client` anywhere in this file -- it is passed to
      // applyFullSchema unmodified, exactly as in Run A.
      let drillsAttemptAt: number | null = null;
      let drillsResultAt: number | null = null;
      let drillsOutcome: 'applied' | 'failed' | null = null;
      let drillsFailedError: string | null = null;

      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        const line = args.map((a) => String(a)).join(' ');
        if (line.includes('[full-schema] attempt') && line.includes(DRILLS_FILE) && drillsAttemptAt === null) {
          drillsAttemptAt = Date.now();
        }
        if (line.includes('[full-schema] applied') && line.includes(DRILLS_FILE) && drillsResultAt === null) {
          drillsResultAt = Date.now();
          drillsOutcome = 'applied';
        }
        if (line.includes('[full-schema] failed') && line.includes(DRILLS_FILE) && drillsResultAt === null) {
          drillsResultAt = Date.now();
          drillsOutcome = 'failed';
          const match = line.match(/error=(.*)$/);
          drillsFailedError = match ? match[1] : null;
        }
        originalConsoleError(...(args as []));
      };

      const applyPromise = helper
        .applyFullSchema(client, { infraDir: isolatedDir })
        .then((result) => { applyOutcome = { type: 'resolved', result }; })
        .catch((error) => { applyOutcome = { type: 'rejected', error }; });
      void applyPromise;

      const pollStartedAt = Date.now();
      let verdict:
        | { kind: 'STDOUT_DRAIN_ONLY_DID_NOT_HANG'; elapsedMs: number }
        | { kind: 'STDOUT_DRAIN_ONLY_HANG_REPRODUCED'; elapsedAtCaptureMs: number; snapshot: Awaited<ReturnType<typeof captureObserverSnapshot>> }
        | { kind: 'DRILLS_NEVER_ATTEMPTED'; applyOutcome: typeof applyOutcome }
        | { kind: 'PRE_DRILLS_WATCHDOG_TRIPPED' }
        | null = null;

      while (verdict === null) {
        await sleep(250);

        if (applyOutcome !== null && drillsAttemptAt === null) {
          verdict = { kind: 'DRILLS_NEVER_ATTEMPTED', applyOutcome };
          break;
        }

        if (drillsAttemptAt === null) {
          if (Date.now() - pollStartedAt >= PRE_DRILLS_WATCHDOG_MS) {
            verdict = { kind: 'PRE_DRILLS_WATCHDOG_TRIPPED' };
            break;
          }
          continue;
        }

        if (drillsResultAt !== null) {
          verdict = { kind: 'STDOUT_DRAIN_ONLY_DID_NOT_HANG', elapsedMs: drillsResultAt - drillsAttemptAt };
          break;
        }

        if (Date.now() - drillsAttemptAt >= WATCH_AFTER_DRILLS_ATTEMPT_MS) {
          const snapshot = await captureObserverSnapshot(observerClient, workerPid);
          verdict = {
            kind: 'STDOUT_DRAIN_ONLY_HANG_REPRODUCED',
            elapsedAtCaptureMs: Date.now() - drillsAttemptAt,
            snapshot,
          };
          break;
        }
      }

      console.error = originalConsoleError;

      console.log(`DRILLS_ATTEMPT_TIMESTAMP=${drillsAttemptAt ? new Date(drillsAttemptAt).toISOString() : 'null'}`);
      console.log(`DRILLS_RESULT_TIMESTAMP=${drillsResultAt ? new Date(drillsResultAt).toISOString() : 'null'}`);
      console.log(`RESULT=${verdict.kind}`);

      if (verdict.kind === 'STDOUT_DRAIN_ONLY_DID_NOT_HANG') {
        console.log(`DRILLS_ELAPSED_MS=${verdict.elapsedMs}`);
        console.log(`DRILLS_OUTCOME=${drillsOutcome}`);
        if (drillsFailedError) console.log(`DRILLS_FAILED_ERROR=${drillsFailedError}`);
      } else if (verdict.kind === 'STDOUT_DRAIN_ONLY_HANG_REPRODUCED') {
        console.log(`ELAPSED_AT_CAPTURE_MS=${verdict.elapsedAtCaptureMs}`);
        console.log(`BLOCKING_PIDS=${JSON.stringify(verdict.snapshot.blockingPids)}`);
        console.log(`PG_STAT_ACTIVITY_JSON=${JSON.stringify(verdict.snapshot.activity, null, 2)}`);
        console.log(`PG_LOCKS_JSON=${JSON.stringify(verdict.snapshot.locks, null, 2)}`);
      } else if (verdict.kind === 'DRILLS_NEVER_ATTEMPTED') {
        const outcome = verdict.applyOutcome;
        if (outcome?.type === 'rejected') {
          const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          console.log(`UNEXPECTED_APPLY_REJECTION=${msg}`);
        }
      }

      expect(verdict).not.toBeNull();
    } finally {
      await observerClient.end().catch(() => {});
      await fs.rm(isolatedDir, { recursive: true, force: true }).catch(() => {});
      if (applyOutcome !== null) {
        await client.end().catch(() => {});
      }
    }
  });
});
