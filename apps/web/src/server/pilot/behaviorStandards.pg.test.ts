// Real PostgreSQL-backed contract test for the behavior-standards
// migration (module 125).
//
// What needs proving that reading SQL cannot prove: the table creates from
// nothing and the recognitions link column/FK are added additively; the
// migration re-applies as a no-op; a recognition can carry a typed
// standard link (and survives the standard being retired); and -- the
// point of the module -- NO per-athlete conduct table is created here.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-behavior-standards-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_behavior_standards_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-behavior-standards-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-standards';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-standards-admin';
const COACH_ID = 'acct-standards-coach';
const ATHLETE_ID = 'ath-standards-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let achievementsSql: string;
let baseSchemaSql: string;

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(achievementsSql);
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'coach', $2, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Standards Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
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
  achievementsSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_achievements_migration.sql'), 'utf8');
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});







describe('behavior standards migration', () => {
  test('adds standards and the typed recognition link, re-applies cleanly, and creates no conduct log', async () => {
    const client = await freshDatabase('standards_fresh');
    try {
      await client.query(migrationSql);
      await client.query(migrationSql);

      await client.query(
        `insert into pilot.behavior_standards
           (organization_id, standard_id, standard_name, recognition_kind, created_by_account_id)
         values ($1, 'std-1', 'Reset after frustration', 'took_the_correction', $2)`,
        [ORG_ID, ADMIN_ID],
      );

      // Meeting a standard is an ordinary recognition carrying a typed link.
      await client.query(
        `insert into pilot.recognitions
           (organization_id, recognition_id, athlete_id, coach_account_id, coach_display_name, kind, note, standard_id)
         values ($1, 'rec-1', $2, $3, 'Coach A', 'took_the_correction', 'walked away and came back', 'std-1')`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );

      // A link to a standard that does not exist is refused.
      await expect(client.query(
        `insert into pilot.recognitions
           (organization_id, recognition_id, athlete_id, coach_account_id, coach_display_name, kind, standard_id)
         values ($1, 'rec-bad', $2, $3, 'Coach A', 'took_the_correction', 'std-nope')`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23503' });

      // Recognitions without a standard stay legal -- most are not about one.
      await client.query(
        `insert into pilot.recognitions
           (organization_id, recognition_id, athlete_id, coach_account_id, coach_display_name, kind)
         values ($1, 'rec-2', $2, $3, 'Coach A', 'good_partner')`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );

      // THE POINT: this migration creates no per-athlete conduct table.
      const conductTables = await client.query(
        `select table_name from information_schema.tables
         where table_schema = 'pilot'
           and (table_name like '%conduct%' or table_name like '%discipline%' or table_name like '%behavior_incident%')`,
      );
      expect(conductTables.rows).toEqual([]);

      const linked = await client.query(
        `select recognition_id, standard_id from pilot.recognitions where organization_id = $1 order by recognition_id`,
        [ORG_ID],
      );
      expect(linked.rows).toEqual([
        { recognition_id: 'rec-1', standard_id: 'std-1' },
        { recognition_id: 'rec-2', standard_id: null },
      ]);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-behavior-standards-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('behavior standards runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('behstd_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /BEHAVIOR_STANDARDS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('behstd_rdy_ok');
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
