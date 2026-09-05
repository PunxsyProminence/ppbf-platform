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
  applyFullSchema: (client: Client, opts?: { infraDir?: string; workflowPath?: string }) => Promise<{ order: string[]; rounds: number }>;
  listMigrationFiles: (infraDir?: string, workflowPath?: string) => Promise<string[]>;
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
    // A small disposable workflow naming only this tiny universe's one slug.
    // Without it, migrationApplyOrder() would validate brokenDir's one file
    // against the REAL apply-migrations.yml and reject it for manifest
    // mismatch before the deliberately-broken SQL is ever attempted -- this
    // test would fail for the wrong reason.
    const brokenWorkflowPath = path.join(os.tmpdir(), `ppbf-broken-workflow-${Date.now()}.yml`);
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
      await fs.writeFile(brokenWorkflowPath, 'for m in deliberately-broken; do\n');

      await expect(helper.applyFullSchema(client, { infraDir: brokenDir, workflowPath: brokenWorkflowPath }))
        .rejects.toThrow(/deliberately_broken/);
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
      await fs.rm(brokenWorkflowPath, { force: true });
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
    const evolutionWorkflowPath = path.join(os.tmpdir(), `ppbf-offline-evolution-workflow-${Date.now()}.yml`);
    const evolutionPath = path.resolve(__dirname, '../../../scripts/lib/offline-db-evolution.mjs');
    const evolution = await nativeDynamicImport(pathToFileURL(evolutionPath).href) as unknown as {
      baselineMigrationHistory: (client: Client, opts: { infraDir: string; workflowPath: string }) => Promise<{ recorded: number; total: number }>;
      applyPendingMigrations: (client: Client, opts: { infraDir: string; workflowPath: string }) => Promise<{ applied: string[]; rounds: number }>;
    };

    // `if not exists` matters here, not just as style: the final case below
    // re-executes this file after a harmless content change, and a reused
    // local database's real migrations are only safe to re-run at all
    // because they are written this way (the same idempotent convention
    // production's own re-run-everything model relies on).
    const firstMigration = [
      'create schema if not exists pilot;',
      'create table if not exists pilot.base02_reuse_fixture (id text primary key, value text not null);',
    ].join('\n');

    try {
      await fs.mkdir(evolutionDir, { recursive: true });
      // A base-schema stand-in and a small workflow naming this universe's
      // slugs -- migrationApplyOrder() requires both, even for a synthetic
      // infraDir with no relation to the real repository corpus. The
      // workflow only names `existing` at first, matching how the real
      // apply-migrations.yml only ever names migrations that already exist
      // by the time they are added to it.
      await fs.writeFile(path.join(evolutionDir, 'pilot_slice_postgres.sql'), '-- synthetic base schema stand-in\n');
      await fs.writeFile(evolutionWorkflowPath, 'for m in existing; do\n');
      await fs.writeFile(path.join(evolutionDir, 'pilot_slice_postgres_existing_migration.sql'), firstMigration);
      await client.query(firstMigration);
      await client.query(
        "insert into pilot.base02_reuse_fixture (id, value) values ('sentinel', 'preserve-me')",
      );

      const baseline = await evolution.baselineMigrationHistory(
        client, { infraDir: evolutionDir, workflowPath: evolutionWorkflowPath },
      );
      expect(baseline.recorded).toBe(1);

      await fs.writeFile(
        path.join(evolutionDir, 'pilot_slice_postgres_new_migration.sql'),
        [
          'alter table pilot.base02_reuse_fixture add column evolved text;',
          "update pilot.base02_reuse_fixture set evolved = 'applied' where id = 'sentinel';",
        ].join('\n'),
      );
      await fs.writeFile(evolutionWorkflowPath, 'for m in existing new; do\n');

      const first = await evolution.applyPendingMigrations(
        client, { infraDir: evolutionDir, workflowPath: evolutionWorkflowPath },
      );
      expect(first.applied).toEqual(['pilot_slice_postgres_new_migration.sql']);

      const preserved = await client.query<{ id: string; value: string; evolved: string }>(
        "select id, value, evolved from pilot.base02_reuse_fixture where id = 'sentinel'",
      );
      expect(preserved.rows).toEqual([{
        id: 'sentinel',
        value: 'preserve-me',
        evolved: 'applied',
      }]);

      const second = await evolution.applyPendingMigrations(
        client, { infraDir: evolutionDir, workflowPath: evolutionWorkflowPath },
      );
      expect(second.applied).toEqual([]);
      expect(second.rounds).toBe(0);

      // A sanctioned local edit (owner policy, 2026-09-03): the reconciliation
      // cache re-executes the changed file rather than refusing forever. The
      // change is comment-only, so the idempotent CREATE still no-ops and
      // existing data is untouched -- this proves reconciliation, not just
      // "did not crash".
      await fs.writeFile(
        path.join(evolutionDir, 'pilot_slice_postgres_existing_migration.sql'),
        firstMigration + '\n-- changed after baseline\n',
      );

      const third = await evolution.applyPendingMigrations(
        client, { infraDir: evolutionDir, workflowPath: evolutionWorkflowPath },
      );
      expect(third.applied).toEqual(['pilot_slice_postgres_existing_migration.sql']);

      const stillPreserved = await client.query<{ id: string; value: string; evolved: string }>(
        "select id, value, evolved from pilot.base02_reuse_fixture where id = 'sentinel'",
      );
      expect(stillPreserved.rows).toEqual([{
        id: 'sentinel',
        value: 'preserve-me',
        evolved: 'applied',
      }]);
    } finally {
      await fs.rm(evolutionDir, { recursive: true, force: true });
      await fs.rm(evolutionWorkflowPath, { force: true });
      await client.end();
    }
  });

  test('legacy baseline actually executes every migration instead of recording it unproven', async () => {
    const client = await freshEmptyDatabase('offline_legacy_baseline_proof');
    const legacyDir = path.join(os.tmpdir(), `ppbf-offline-legacy-${Date.now()}`);
    const legacyWorkflowPath = path.join(os.tmpdir(), `ppbf-offline-legacy-workflow-${Date.now()}.yml`);
    const evolutionPath = path.resolve(__dirname, '../../../scripts/lib/offline-db-evolution.mjs');
    const evolution = await nativeDynamicImport(pathToFileURL(evolutionPath).href) as unknown as {
      baselineMigrationHistory: (client: Client, opts: { infraDir: string; workflowPath: string }) => Promise<{ recorded: number; total: number }>;
    };

    try {
      await fs.mkdir(legacyDir, { recursive: true });
      // Simulates a database an OLDER checkout created directly -- the way
      // the platform used to, not through any migration file -- so its
      // schema already has this table, but nothing has ever proven it
      // against what the CURRENT manifest actually names.
      await client.query('create schema pilot');
      await client.query('create table pilot.legacy_fixture (id text primary key)');

      await fs.writeFile(path.join(legacyDir, 'pilot_slice_postgres.sql'), '-- synthetic base schema stand-in\n');
      await fs.writeFile(legacyWorkflowPath, 'for m in legacy added-after-legacy-start; do\n');
      await fs.writeFile(
        path.join(legacyDir, 'pilot_slice_postgres_legacy_migration.sql'),
        'create table if not exists pilot.legacy_fixture (id text primary key);\n',
      );
      // A migration the current checkout has that this legacy database's
      // last real start never saw -- exactly the shape that broke
      // disciplineSeeds.pg.test.ts: the manifest names it, but nothing has
      // ever proven its schema effect actually exists.
      await fs.writeFile(
        path.join(legacyDir, 'pilot_slice_postgres_added_after_legacy_start_migration.sql'),
        'alter table pilot.legacy_fixture add column added_after_legacy_start text;\n',
      );

      const baseline = await evolution.baselineMigrationHistory(
        client, { infraDir: legacyDir, workflowPath: legacyWorkflowPath },
      );
      expect(baseline.recorded).toBe(2);

      const column = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'pilot' and table_name = 'legacy_fixture'
            and column_name = 'added_after_legacy_start'`,
      );
      // The old blind-insert baseline would have recorded this migration as
      // applied without ever running it; this column existing for real is
      // the proof that it was actually executed.
      expect(column.rows).toHaveLength(1);
    } finally {
      await fs.rm(legacyDir, { recursive: true, force: true });
      await fs.rm(legacyWorkflowPath, { force: true });
      await client.end();
    }
  });

  test('reconciliation applies migrations in authoritative order, not filename order', async () => {
    const client = await freshEmptyDatabase('offline_authoritative_order');
    const orderDir = path.join(os.tmpdir(), `ppbf-offline-order-${Date.now()}`);
    const orderWorkflowPath = path.join(os.tmpdir(), `ppbf-offline-order-workflow-${Date.now()}.yml`);
    const evolutionPath = path.resolve(__dirname, '../../../scripts/lib/offline-db-evolution.mjs');
    const evolution = await nativeDynamicImport(pathToFileURL(evolutionPath).href) as unknown as {
      baselineMigrationHistory: (client: Client, opts: { infraDir: string; workflowPath: string }) => Promise<{ recorded: number; total: number }>;
    };

    try {
      await fs.mkdir(orderDir, { recursive: true });
      // baselineMigrationHistory creates its own history table under the
      // pilot schema before any migration runs, so the schema must already
      // exist -- unlike the other synthetic fixtures above, neither of this
      // test's two migrations creates it.
      await client.query('create schema pilot');
      await fs.writeFile(path.join(orderDir, 'pilot_slice_postgres.sql'), '-- synthetic base schema stand-in\n');
      // Deliberately ordered so alphabetical (aaa... before zzz...) and
      // authoritative (zzz... before aaa..., per the workflow below) disagree.
      // Under alphabetical order the insert below would hit "relation
      // pilot.order_fixture does not exist" -- the table is only created by
      // the file that sorts AFTER it.
      await fs.writeFile(
        path.join(orderDir, 'pilot_slice_postgres_aaa_seed_note_migration.sql'),
        "insert into pilot.order_fixture (id, note) values ('sentinel', 'seeded-after-column-exists');\n",
      );
      await fs.writeFile(
        path.join(orderDir, 'pilot_slice_postgres_zzz_table_and_column_migration.sql'),
        'create table pilot.order_fixture (id text primary key);\n'
        + 'alter table pilot.order_fixture add column note text;\n',
      );
      await fs.writeFile(orderWorkflowPath, 'for m in zzz-table-and-column aaa-seed-note; do\n');

      const baseline = await evolution.baselineMigrationHistory(
        client, { infraDir: orderDir, workflowPath: orderWorkflowPath },
      );
      expect(baseline.recorded).toBe(2);

      const seeded = await client.query<{ id: string; note: string }>(
        "select id, note from pilot.order_fixture where id = 'sentinel'",
      );
      expect(seeded.rows).toEqual([{ id: 'sentinel', note: 'seeded-after-column-exists' }]);
    } finally {
      await fs.rm(orderDir, { recursive: true, force: true });
      await fs.rm(orderWorkflowPath, { force: true });
      await client.end();
    }
  });

  test('a migration that fails to apply cannot advance the reconciliation cache or destroy data', async () => {
    const client = await freshEmptyDatabase('offline_reconciliation_atomicity');
    const failureDir = path.join(os.tmpdir(), `ppbf-offline-failure-${Date.now()}`);
    const failureWorkflowPath = path.join(os.tmpdir(), `ppbf-offline-failure-workflow-${Date.now()}.yml`);
    const evolutionPath = path.resolve(__dirname, '../../../scripts/lib/offline-db-evolution.mjs');
    const evolution = await nativeDynamicImport(pathToFileURL(evolutionPath).href) as unknown as {
      baselineMigrationHistory: (client: Client, opts: { infraDir: string; workflowPath: string }) => Promise<{ recorded: number; total: number }>;
      applyPendingMigrations: (client: Client, opts: { infraDir: string; workflowPath: string }) => Promise<{ applied: string[]; rounds: number }>;
    };

    const MIGRATION_FILE = 'pilot_slice_postgres_failure_probe_migration.sql';
    const migrationPath = path.join(failureDir, MIGRATION_FILE);

    try {
      await fs.mkdir(failureDir, { recursive: true });
      // baselineMigrationHistory creates its own history table under the
      // pilot schema before any migration runs, so the schema must already
      // exist -- the migration's own `create schema if not exists` only
      // runs once reconciliation reaches it, which is too late for that.
      await client.query('create schema pilot');
      await fs.writeFile(path.join(failureDir, 'pilot_slice_postgres.sql'), '-- synthetic base schema stand-in\n');
      await fs.writeFile(failureWorkflowPath, 'for m in failure-probe; do\n');
      await fs.writeFile(
        migrationPath,
        'create schema if not exists pilot;\n'
        + 'create table if not exists pilot.failure_probe (id text primary key, note text);\n'
        + "insert into pilot.failure_probe (id, note) values ('v1', 'initial') on conflict (id) do nothing;\n",
      );

      const baseline = await evolution.baselineMigrationHistory(
        client, { infraDir: failureDir, workflowPath: failureWorkflowPath },
      );
      expect(baseline.recorded).toBe(1);

      const v1Recorded = await client.query<{ sha256: string; applied_at: Date }>(
        `select sha256, applied_at from pilot.offline_runtime_schema_history where migration_file = '${MIGRATION_FILE}'`,
      );
      expect(v1Recorded.rows).toHaveLength(1);
      const v1Sha = v1Recorded.rows[0].sha256;
      const v1AppliedAt = v1Recorded.rows[0].applied_at;

      // V2: the same file, rewritten. It stages an observable mutation, then
      // fails with a deterministic error before its transaction can commit --
      // proving both the mutation and the cache row it would have written are
      // rolled back together, not just that the call rejects.
      await fs.writeFile(
        migrationPath,
        'create schema if not exists pilot;\n'
        + 'create table if not exists pilot.failure_probe (id text primary key, note text);\n'
        + "insert into pilot.failure_probe (id, note) values ('v2-should-not-persist', 'observable-mutation');\n"
        + 'select 1/0;\n',
      );

      await expect(
        evolution.applyPendingMigrations(client, { infraDir: failureDir, workflowPath: failureWorkflowPath }),
      ).rejects.toThrow(new RegExp(MIGRATION_FILE.replace(/\./g, '\\.')));

      const stillSentinel = await client.query<{ id: string }>(
        "select id from pilot.failure_probe where id = 'v1'",
      );
      expect(stillSentinel.rows).toEqual([{ id: 'v1' }]);

      const shouldNotExist = await client.query<{ id: string }>(
        "select id from pilot.failure_probe where id = 'v2-should-not-persist'",
      );
      expect(shouldNotExist.rows).toEqual([]);

      const afterFailure = await client.query<{ sha256: string; applied_at: Date }>(
        `select sha256, applied_at from pilot.offline_runtime_schema_history where migration_file = '${MIGRATION_FILE}'`,
      );
      expect(afterFailure.rows).toHaveLength(1);
      expect(afterFailure.rows[0].sha256).toBe(v1Sha);
      expect(afterFailure.rows[0].applied_at).toEqual(v1AppliedAt);

      // V3: a valid, corrected version of the same file -- proves the
      // migration stayed pending/recoverable rather than being permanently
      // stuck after V2 failed.
      await fs.writeFile(
        migrationPath,
        'create schema if not exists pilot;\n'
        + 'create table if not exists pilot.failure_probe (id text primary key, note text);\n'
        + "insert into pilot.failure_probe (id, note) values ('v3', 'corrected') on conflict (id) do nothing;\n",
      );

      const retry = await evolution.applyPendingMigrations(
        client, { infraDir: failureDir, workflowPath: failureWorkflowPath },
      );
      expect(retry.applied).toEqual([MIGRATION_FILE]);

      const v3Row = await client.query<{ id: string }>("select id from pilot.failure_probe where id = 'v3'");
      expect(v3Row.rows).toEqual([{ id: 'v3' }]);

      const afterRetry = await client.query<{ sha256: string }>(
        `select sha256 from pilot.offline_runtime_schema_history where migration_file = '${MIGRATION_FILE}'`,
      );
      expect(afterRetry.rows[0].sha256).not.toBe(v1Sha);
    } finally {
      await fs.rm(failureDir, { recursive: true, force: true });
      await fs.rm(failureWorkflowPath, { force: true });
      await client.end();
    }
  });

  test('an existing but empty migration history requires explicit recovery consent before replay', async () => {
    const client = await freshEmptyDatabase('offline_empty_history_consent');
    const consentDir = path.join(os.tmpdir(), `ppbf-offline-empty-history-${Date.now()}`);
    const consentWorkflowPath = path.join(os.tmpdir(), `ppbf-offline-empty-history-workflow-${Date.now()}.yml`);
    const evolutionPath = path.resolve(__dirname, '../../../scripts/lib/offline-db-evolution.mjs');
    const evolution = await nativeDynamicImport(pathToFileURL(evolutionPath).href) as unknown as {
      applyPendingMigrations: (client: Client, opts: { infraDir: string; workflowPath: string }) => Promise<{ applied: string[]; rounds: number }>;
    };

    const CONSENT_FLAG = 'PPBF_OFFLINE_ALLOW_EMPTY_HISTORY_RECOVERY';
    const hadConsentFlag = Object.prototype.hasOwnProperty.call(process.env, CONSENT_FLAG);
    const originalConsentFlag = process.env[CONSENT_FLAG];

    try {
      await fs.mkdir(consentDir, { recursive: true });
      // An already-evolved database whose history ledger is empty for an
      // unknown reason -- created directly, not via baselineMigrationHistory
      // or a simulated crash, so this reproduces the exact ambiguous state
      // the guard exists for rather than one specific cause of it.
      await client.query('create schema pilot');
      await client.query(
        'create table pilot.offline_runtime_schema_history ('
        + 'migration_file text primary key, sha256 text not null, '
        + 'applied_at timestamptz not null default now())',
      );
      await client.query('create table pilot.consent_sentinel (id text primary key)');
      await client.query("insert into pilot.consent_sentinel (id) values ('pre-existing')");

      await fs.writeFile(path.join(consentDir, 'pilot_slice_postgres.sql'), '-- synthetic base schema stand-in\n');
      await fs.writeFile(consentWorkflowPath, 'for m in consent-probe; do\n');
      await fs.writeFile(
        path.join(consentDir, 'pilot_slice_postgres_consent_probe_migration.sql'),
        'create table if not exists pilot.consent_probe (id text primary key);\n'
        + "insert into pilot.consent_probe (id) values ('recovered') on conflict (id) do nothing;\n",
      );

      delete process.env[CONSENT_FLAG];

      await expect(
        evolution.applyPendingMigrations(client, { infraDir: consentDir, workflowPath: consentWorkflowPath }),
      ).rejects.toThrow(new RegExp(CONSENT_FLAG));

      const noConsentProbe = await client.query<{ table_name: string | null }>(
        "select to_regclass('pilot.consent_probe') as table_name",
      );
      expect(noConsentProbe.rows[0].table_name).toBeNull();

      const sentinelUnchanged = await client.query<{ id: string }>('select id from pilot.consent_sentinel');
      expect(sentinelUnchanged.rows).toEqual([{ id: 'pre-existing' }]);

      const historyStillEmpty = await client.query<{ count: number }>(
        'select count(*)::int as count from pilot.offline_runtime_schema_history',
      );
      expect(historyStillEmpty.rows[0].count).toBe(0);

      process.env[CONSENT_FLAG] = 'true';

      const recovered = await evolution.applyPendingMigrations(
        client, { infraDir: consentDir, workflowPath: consentWorkflowPath },
      );
      expect(recovered.applied).toEqual(['pilot_slice_postgres_consent_probe_migration.sql']);

      const recoveredRow = await client.query<{ id: string }>(
        "select id from pilot.consent_probe where id = 'recovered'",
      );
      expect(recoveredRow.rows).toEqual([{ id: 'recovered' }]);

      const historyNowHasRow = await client.query(
        "select sha256 from pilot.offline_runtime_schema_history where migration_file = 'pilot_slice_postgres_consent_probe_migration.sql'",
      );
      expect(historyNowHasRow.rows).toHaveLength(1);
    } finally {
      if (hadConsentFlag) {
        process.env[CONSENT_FLAG] = originalConsentFlag;
      } else {
        delete process.env[CONSENT_FLAG];
      }
      await fs.rm(consentDir, { recursive: true, force: true });
      await fs.rm(consentWorkflowPath, { force: true });
      await client.end();
    }
  });
});
