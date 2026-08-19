// Real PostgreSQL-backed contract test for the parent hub placement
// migration.
//
// Three things need proving, and none can be proven by reading SQL:
//
// 1. The gap is real. Every migrated environment already has the placement
//    check constraint, so a check that only asks whether the constraint is
//    there passes with or without this migration. The first test therefore
//    inserts a 'parent_hub' row against the four-value constraint and
//    requires the write to FAIL -- if that ever starts passing, the rest of
//    this file is measuring nothing.
//
// 2. Widening did not open the set. 'parent_hub' must be accepted and an
//    unrecognized placement must still be refused, because a placement that
//    names no surface renders nowhere at all.
//
// 3. Re-running the ORIGINAL placements migration after this one must not
//    downgrade the constraint back to four values. Its ADD is catalog-guarded
//    by constraint name, and this file re-creates the constraint under the
//    same name, so the guard has to hold. The `all` loop replays every
//    migration on every dispatch; if the guard ever broke, every full run
//    would silently strand parent-addressed rows behind a constraint that
//    no longer admits them.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-parent-hub-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_parent_hub_placement_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-parent-hub-placement-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-parent-hub';
const OTHER_ORG_ID = 'org-parent-hub-other';

// The read path the parent hub uses: one organization's items for one
// surface, of one kind, still active and inside their window, newest first.
// 'everywhere' is included by every surface.
const READ_PATH_SQL = `
  select announcement_id, message, placement, kind
  from pilot.announcements
  where organization_id = $1
    and placement in ($2, 'everywhere')
    and kind = $3
    and active
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
  order by created_at desc`;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let baseSchemaSql: string;
let announcementsSql: string;
let placementsSql: string;

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
 * Fresh database in the state every migrated environment is already in: base
 * schema, pilot.announcements, and the four-value placement vocabulary. This
 * migration is NOT applied here -- each test decides when to apply it.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(announcementsSql);
  await client.query(placementsSql);
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  return client;
}

async function insertPlaced(
  client: Client,
  values: { message: string; placement: string; kind?: string; organizationId?: string },
): Promise<string> {
  const announcementId = randomUUID();
  await client.query(
    `insert into pilot.announcements
       (organization_id, announcement_id, message, author_name, author_role, placement, kind)
     values ($1, $2, $3, 'Coach Ruiz', 'coach', $4, $5)`,
    [
      values.organizationId ?? ORG_ID,
      announcementId,
      values.message,
      values.placement,
      values.kind ?? 'notice',
    ],
  );
  return announcementId;
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  // pilot.announcements is not in the base schema; its own migration creates
  // it, and the placements migration adds the four-value vocabulary this file
  // widens -- the same order the `all` loop applies them in.
  announcementsSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_announcements_migration.sql'), 'utf8');
  placementsSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_announcement_placements_migration.sql'), 'utf8');
  // Like the placements runner, this runner opens the transaction itself, so
  // the file applies here as plain statements exactly as the runner sends it.
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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
});

describe('parent hub placement migration against real Postgres', () => {
  test('the gap is real: without the migration a parent_hub write is refused', async () => {
    const client = await freshDatabase('ppbf_test_parent_hub_absent');
    try {
      await expect(
        insertPlaced(client, { message: 'Pickup moves to the side door.', placement: 'parent_hub' }),
      ).rejects.toThrow(/pilot_announcements_placement_check/);
    } finally {
      await client.end();
    }
  });

  test('parent_hub is accepted afterwards, and the set is still closed', async () => {
    const client = await freshDatabase('ppbf_test_parent_hub_vocabulary');
    try {
      await client.query(migrationSql);

      for (const placement of [
        'gym_notices',
        'athlete_workspace',
        'coach_workspace',
        'parent_hub',
        'everywhere',
      ]) {
        await insertPlaced(client, { message: `Notice for ${placement}`, placement });
      }

      await expect(
        insertPlaced(client, { message: 'Nowhere', placement: 'lobby_tv' }),
      ).rejects.toThrow(/pilot_announcements_placement_check/);
    } finally {
      await client.end();
    }
  });

  test('the parent hub read draws its own board and the gym-wide one, nothing else', async () => {
    const client = await freshDatabase('ppbf_test_parent_hub_readpath');
    try {
      await client.query(migrationSql);

      await insertPlaced(client, { message: 'Consent forms due Friday.', placement: 'parent_hub' });
      await insertPlaced(client, { message: 'Gym closed Monday.', placement: 'everywhere' });
      await insertPlaced(client, { message: 'Athlete-only item.', placement: 'athlete_workspace' });
      await insertPlaced(client, { message: 'Coach-only item.', placement: 'coach_workspace' });
      await insertPlaced(client, {
        message: 'Another gym entirely.',
        placement: 'parent_hub',
        organizationId: OTHER_ORG_ID,
      });

      const rows = await client.query(READ_PATH_SQL, [ORG_ID, 'parent_hub', 'notice']);
      expect(rows.rows.map((r: { message: string }) => r.message).sort()).toEqual([
        'Consent forms due Friday.',
        'Gym closed Monday.',
      ]);
    } finally {
      await client.end();
    }
  });

  test('re-running this migration, or the original one after it, keeps the five values', async () => {
    const client = await freshDatabase('ppbf_test_parent_hub_idempotent');
    try {
      await client.query(migrationSql);
      const keptId = await insertPlaced(client, {
        message: 'Family night is back.',
        placement: 'parent_hub',
      });

      await client.query(migrationSql);
      // The `all` loop replays announcement-placements on every dispatch. Its
      // ADD is guarded by constraint name, so it must be a no-op here rather
      // than a downgrade back to the four-value set.
      await client.query(placementsSql);
      await client.query(migrationSql);

      await insertPlaced(client, { message: 'Still addressable.', placement: 'parent_hub' });

      const kept = await client.query(
        `select placement from pilot.announcements
         where organization_id = $1 and announcement_id = $2`,
        [ORG_ID, keptId],
      );
      expect(kept.rows).toEqual([{ placement: 'parent_hub' }]);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-parent-hub-placement-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('parent hub placement runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('phub_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /PARENT_HUB_PLACEMENT_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('phub_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
