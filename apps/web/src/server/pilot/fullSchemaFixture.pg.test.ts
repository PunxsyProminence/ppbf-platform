// Proves the thing every other .pg.test.ts assumes and none of them check:
// that the schema production runs can be built from this repository at all.
//
// WHY THIS SUITE EXISTS. Each pg suite hand-picks its migrations, so between
// them they prove that ~99 individual files each work in isolation against a
// database of the author's choosing. Nothing proved they work TOGETHER, and
// nothing proved a suite's chosen subset resembles production.
//
// The cost of that showed up on 2026-08-27: adding `deleted_at is null` to
// access.ts broke fourteen suites at once, none about deletion. They had built
// databases without the data-retention migration and then called shared code
// that assumed production's schema -- so they were not testing a smaller
// production, they were testing a database that has never existed.
//
// This suite is the standing guard. If a migration is added that cannot be
// applied alongside the others, it fails HERE, in a suite whose name says what
// went wrong -- rather than as an unrelated-looking column error in whichever
// suites happen to touch the affected table.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module on this Node version. Building the import through Function
   keeps a real dynamic import in the emitted code, which Node honors under
   --experimental-vm-modules (the flag every test:migrations:* script already
   passes). Same pattern as guardianMediaConsentMigration.pg.test.ts. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-full-schema-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let helper: {
  applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<{ order: string[]; rounds: number }>;
  listMigrationFiles: (infraDir?: string) => Promise<string[]>;
};

// BASE-02 diagnostic-only addition: keeps serverProcess.stdout actively
// drained for the whole fixture run instead of leaving it unconsumed after
// readiness (see beforeAll). Bounded so this cannot grow memory without
// limit. Not otherwise inspected by this run -- draining is the variable
// under test, not the buffer's contents.
const SERVER_LOG_RING_BUFFER_MAX_LINES = 4_000;
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

beforeAll(async () => {
  PG_PORT = await findFreePort();

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

  // BASE-02 diagnostic: this readline interface is deliberately never
  // closed (previously: rl.close() on the ready line), so serverProcess.stdout
  // stays actively drained for the entire fixture run instead of sitting
  // unconsumed after readiness. Everything else -- readiness detection,
  // the timeout guard, the exit rejection -- is unchanged.
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

describe('the schema production runs can be built from this repository', () => {
  test('every migration in infra/azure applies alongside every other one', async () => {
    const client = await freshEmptyDatabase('fullschema_all');
    try {
      const available = await helper.listMigrationFiles(INFRA_DIR);
      // Guards the assertion below against going vacuous: if the directory
      // read ever returned nothing, "all of them applied" would be trivially
      // true and this suite would pass while proving nothing.
      expect(available.length).toBeGreaterThan(50);

      const { order, rounds } = await helper.applyFullSchema(client, { infraDir: INFRA_DIR });

      // applyFullSchema throws when it cannot place a file, so reaching here
      // already means success; this pins the count so a silently shrinking
      // migration set is visible.
      expect(order).toHaveLength(available.length);
      expect(new Set(order)).toEqual(new Set(available));
      expect(rounds).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  test('the built schema carries columns a hand-picked fixture would have missed', async () => {
    const client = await freshEmptyDatabase('fullschema_columns');
    try {
      await helper.applyFullSchema(client, { infraDir: INFRA_DIR });

      // Named deliberately: athletes.deleted_at is THE column whose absence
      // broke fourteen suites, and it exists only because the data-retention
      // migration ran. A fixture built from the base schema alone does not
      // have it, which is the whole failure this file guards.
      const result = await client.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
          where table_schema = 'pilot'
            and (table_name, column_name) in (
              ('athletes', 'deleted_at'),
              ('accounts', 'deleted_at')
            )`,
      );
      expect(result.rows).toHaveLength(2);
    } finally {
      await client.end();
    }
  });

  test('a migration that cannot apply is reported by name, not swallowed', async () => {
    const client = await freshEmptyDatabase('fullschema_broken');
    const brokenDir = path.join(os.tmpdir(), `ppbf-broken-infra-${Date.now()}`);
    try {
      // A directory holding the real base schema plus one migration that can
      // never succeed. Without this case, applyFullSchema could loop forever
      // or return quietly on a broken migration and nothing would notice.
      await fs.mkdir(brokenDir, { recursive: true });
      await fs.copyFile(
        path.join(INFRA_DIR, 'pilot_slice_postgres.sql'),
        path.join(brokenDir, 'pilot_slice_postgres.sql'),
      );
      await fs.writeFile(
        path.join(brokenDir, 'pilot_slice_postgres_deliberately_broken_migration.sql'),
        'alter table pilot.no_such_table add column nope text;\n',
      );

      await expect(helper.applyFullSchema(client, { infraDir: brokenDir }))
        .rejects.toThrow(/deliberately_broken/);
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
      await client.end();
    }
  });
});

describe('offline reused database schema evolution', () => {
  test('requires an explicit baseline for a reused database without migration history', async () => {
    const client = await freshEmptyDatabase('offline_reuse_requires_baseline');
    const evolutionDir = path.join(os.tmpdir(), `ppbf-offline-evolution-empty-${Date.now()}`);
    const evolutionPath = path.resolve(__dirname, '../../../scripts/lib/offline-db-evolution.mjs');
    const evolution = await nativeDynamicImport(pathToFileURL(evolutionPath).href) as unknown as {
      applyPendingMigrations: (client: Client, opts: { infraDir: string }) => Promise<{ applied: string[]; rounds: number }>;
    };

    try {
      await fs.mkdir(evolutionDir, { recursive: true });
      await fs.writeFile(
        path.join(evolutionDir, '001_existing.sql'),
        'create schema if not exists pilot;\ncreate table pilot.base02_reuse_fixture (id text primary key);\n',
      );
      await client.query('create schema pilot');
      await client.query('create table pilot.base02_reuse_fixture (id text primary key)');

      await expect(
        evolution.applyPendingMigrations(client, { infraDir: evolutionDir }),
      ).rejects.toThrow(/Explicit baseline is required/);
    } finally {
      await fs.rm(evolutionDir, { recursive: true, force: true });
      await client.end();
    }
  });

  test('applies only new migrations, preserves existing rows, and is idempotent', async () => {
    const client = await freshEmptyDatabase('offline_reuse_evolution');
    const evolutionDir = path.join(os.tmpdir(), `ppbf-offline-evolution-${Date.now()}`);
    const evolutionPath = path.resolve(__dirname, '../../../scripts/lib/offline-db-evolution.mjs');
    const evolution = await nativeDynamicImport(pathToFileURL(evolutionPath).href) as unknown as {
      baselineMigrationHistory: (client: Client, opts: { infraDir: string }) => Promise<{ recorded: number; total: number }>;
      applyPendingMigrations: (client: Client, opts: { infraDir: string }) => Promise<{ applied: string[]; rounds: number }>;
    };

    const firstMigration = [
      'create schema if not exists pilot;',
      'create table pilot.base02_reuse_fixture (id text primary key, value text not null);',
    ].join('\n');

    try {
      await fs.mkdir(evolutionDir, { recursive: true });
      await fs.writeFile(path.join(evolutionDir, '001_existing.sql'), firstMigration);
      await client.query(firstMigration);
      await client.query(
        "insert into pilot.base02_reuse_fixture (id, value) values ('sentinel', 'preserve-me')",
      );

      const baseline = await evolution.baselineMigrationHistory(client, { infraDir: evolutionDir });
      expect(baseline.recorded).toBe(1);

      await fs.writeFile(
        path.join(evolutionDir, '002_new.sql'),
        [
          'alter table pilot.base02_reuse_fixture add column evolved text;',
          "update pilot.base02_reuse_fixture set evolved = 'applied' where id = 'sentinel';",
        ].join('\n'),
      );

      const first = await evolution.applyPendingMigrations(client, { infraDir: evolutionDir });
      expect(first.applied).toEqual(['002_new.sql']);

      const preserved = await client.query<{ id: string; value: string; evolved: string }>(
        "select id, value, evolved from pilot.base02_reuse_fixture where id = 'sentinel'",
      );
      expect(preserved.rows).toEqual([{
        id: 'sentinel',
        value: 'preserve-me',
        evolved: 'applied',
      }]);

      const second = await evolution.applyPendingMigrations(client, { infraDir: evolutionDir });
      expect(second.applied).toEqual([]);
      expect(second.rounds).toBe(0);

      await fs.writeFile(
        path.join(evolutionDir, '001_existing.sql'),
        firstMigration + '\n-- changed after baseline\n',
      );

      await expect(
        evolution.applyPendingMigrations(client, { infraDir: evolutionDir }),
      ).rejects.toThrow(/changed after it was recorded/);
    } finally {
      await fs.rm(evolutionDir, { recursive: true, force: true });
      await client.end();
    }
  });
});
