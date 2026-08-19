// Real PostgreSQL-backed test for announcements.ts.
//
// pilot.announcements only just became migration-owned (#111 removed the
// request-path DDL that used to create it), and the schema-ownership test
// that guards against the DDL's return is textual. This suite proves the
// module's real INSERT/SELECT against base schema + announcements migration,
// per the post-#89 real-SQL policy (audit finding F2) — including the limit
// clamp, which is interpolated rather than bound and deserves execution.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-announce-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_announcements';

const ORG_A = 'org-ann-a';
const ORG_B = 'org-ann-b';

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-announcements-migration.mjs',
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
let announcements: typeof import('./announcements');

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
  // Like the volunteer-program runner, the announcements runner opens the
  // transaction itself; the SQL file carries no boundaries of its own.
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_announcements_migration.sql'), 'utf8'),
  );
  // Placement, kind, active and the schedule bounds arrive in a second file;
  // the `all` loop orders it after the one above and so does this setup.
  await migrateClient.query(
    await fs.readFile(
      path.join(INFRA_DIR, 'pilot_slice_postgres_announcement_placements_migration.sql'),
      'utf8',
    ),
  );
  for (const orgId of [ORG_A, ORG_B]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  announcements = await import('./announcements');
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

describe('announcements.ts against the real schema', () => {
  test('createAnnouncement persists and listAnnouncements returns newest first', async () => {
    const first = await announcements.createAnnouncement({
      organizationId: ORG_A,
      message: 'Gym closed Friday for ring maintenance.',
      authorName: 'Coach A',
      authorRole: 'coach',
    });
    expect(first.announcement_id).toMatch(/^[0-9a-f-]{36}$/);

    // A later row must sort before the first; created_at has now() default
    // resolution finer than this test's two inserts on most systems, but the
    // module orders by created_at desc, so force distinct timestamps.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await announcements.createAnnouncement({
      organizationId: ORG_A,
      message: 'New heavy bags arrive Monday.',
      authorName: 'Board Secretary',
      authorRole: 'board-secretary',
    });

    const listed = await announcements.listAnnouncements(ORG_A);
    expect(listed.map((a) => a.message)).toEqual([
      'New heavy bags arrive Monday.',
      'Gym closed Friday for ring maintenance.',
    ]);
  });

  test('reads are organization-scoped', async () => {
    expect(await announcements.listAnnouncements(ORG_B)).toEqual([]);
  });

  test('the limit clamp holds at the SQL level', async () => {
    for (let i = 0; i < 30; i += 1) {
      await announcements.createAnnouncement({
        organizationId: ORG_B,
        message: `Notice ${i}`,
        authorName: 'Admin',
        authorRole: 'admin',
      });
    }
    // Requests above the clamp return at most 25; nonsense values fall back
    // to the default of 8.
    expect((await announcements.listAnnouncements(ORG_B, 1000)).length).toBe(25);
    expect((await announcements.listAnnouncements(ORG_B, Number.NaN)).length).toBe(8);
    expect((await announcements.listAnnouncements(ORG_B, 1)).length).toBe(1);
  });

  test('an announcement written with no placement given lands on the sign-in surface, live', async () => {
    const live = await announcements.listLiveAnnouncements(ORG_A, { placement: 'gym_notices', kind: 'notice' });
    expect(live.map((a) => a.message)).toContain('Gym closed Friday for ring maintenance.');
    expect(live[0]?.placement).toBe('gym_notices');
    expect(live[0]?.active).toBe(true);
  });

  test('an everywhere item reaches every placement, and a placed one reaches only its own', async () => {
    const ORG_C = 'org-ann-c';
    const { query } = await import('./db');
    await query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [ORG_C],
    );

    await announcements.createAnnouncement({
      organizationId: ORG_C,
      message: 'Hands up, chin down.',
      authorName: 'Coach C',
      authorRole: 'coach',
      placement: 'everywhere',
      kind: 'motivation',
    });
    await announcements.createAnnouncement({
      organizationId: ORG_C,
      message: 'Mouthguards checked at the door.',
      authorName: 'Coach C',
      authorRole: 'coach',
      placement: 'coach_workspace',
      kind: 'notice',
    });

    const athleteMotivation = await announcements.listLiveAnnouncements(ORG_C, {
      placement: 'athlete_workspace',
      kind: 'motivation',
    });
    expect(athleteMotivation.map((a) => a.message)).toEqual(['Hands up, chin down.']);

    const athleteNotices = await announcements.listLiveAnnouncements(ORG_C, {
      placement: 'athlete_workspace',
      kind: 'notice',
    });
    expect(athleteNotices).toEqual([]);

    const coachNotices = await announcements.listLiveAnnouncements(ORG_C, {
      placement: 'coach_workspace',
      kind: 'notice',
    });
    expect(coachNotices.map((a) => a.message)).toEqual(['Mouthguards checked at the door.']);
  });

  test('a scheduled, an expired, and a retired item all stay off the surface', async () => {
    const ORG_D = 'org-ann-d';
    const { query } = await import('./db');
    await query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [ORG_D],
    );

    const hourFromNow = new Date(Date.now() + 3_600_000).toISOString();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();

    await announcements.createAnnouncement({
      organizationId: ORG_D,
      message: 'Not yet.',
      authorName: 'Admin',
      authorRole: 'admin',
      startsAt: hourFromNow,
    });
    await announcements.createAnnouncement({
      organizationId: ORG_D,
      message: 'Already over.',
      authorName: 'Admin',
      authorRole: 'admin',
      endsAt: hourAgo,
    });
    const retired = await announcements.createAnnouncement({
      organizationId: ORG_D,
      message: 'Pulled down.',
      authorName: 'Admin',
      authorRole: 'admin',
    });
    const live = await announcements.createAnnouncement({
      organizationId: ORG_D,
      message: 'Running now.',
      authorName: 'Admin',
      authorRole: 'admin',
      startsAt: hourAgo,
      endsAt: hourFromNow,
    });

    await announcements.setAnnouncementActive({
      organizationId: ORG_D,
      announcementId: retired.announcement_id,
      active: false,
    });

    const visible = await announcements.listLiveAnnouncements(ORG_D, { placement: 'gym_notices', kind: 'notice' });
    expect(visible.map((a) => a.message)).toEqual(['Running now.']);
    expect(visible[0]?.announcement_id).toBe(live.announcement_id);

    // The authoring view still sees all four, because retiring is not deleting.
    expect((await announcements.listAnnouncements(ORG_D, 25)).length).toBe(4);
  });

  test('retiring an announcement belonging to another organization changes nothing', async () => {
    const foreign = await announcements.createAnnouncement({
      organizationId: ORG_A,
      message: 'Org A only.',
      authorName: 'Coach A',
      authorRole: 'coach',
    });

    const result = await announcements.setAnnouncementActive({
      organizationId: ORG_B,
      announcementId: foreign.announcement_id,
      active: false,
    });

    expect(result).toBeNull();
    const stillLive = await announcements.listLiveAnnouncements(ORG_A, { placement: 'gym_notices', kind: 'notice' });
    expect(stillLive.map((a) => a.message)).toContain('Org A only.');
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// The suite above migrates one database in beforeAll with a plain
// `client.query` and then tests the module on top of it. That proves the
// schema and proves nothing about scripts/pilot-apply-announcements-migration.mjs's
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
describe('announcements runner readiness assertion', () => {
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
    const client = await runnerDatabase('ppbf_test_annc_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ANNOUNCEMENTS_TABLE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_annc_rdy_ok');
    try {
      const migrationSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_announcements_migration.sql'), 'utf8');
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
