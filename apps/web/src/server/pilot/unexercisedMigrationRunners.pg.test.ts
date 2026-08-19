// The migration runners that NO suite drove through its real entrypoint.
//
// WHY THIS FILE EXISTS
//   #488 shipped a readiness assertion that could not pass on any database:
//   it searched pg_get_constraintdef() for the literal `between 1 and 5`,
//   while Postgres deparses a CHECK from the parsed tree and emits
//   `>= 1 AND <= 5`. The schema was correct throughout. The assertion was the
//   defect, and it only ran for the first time during a real staging
//   dispatch, which it then blocked along with every migration ordered behind
//   it.
//
//   The reason nothing caught it is structural: a `.pg.test.ts` suite that
//   applies migration SQL with `client.query(sql)` proves the SQL and never
//   executes the runner's READINESS_QUERY. On the parent commit of this
//   branch, 32 of 105 pg suites drove a real runner entrypoint, leaving 51 of
//   the 83 runners that export `applyMigrationTransaction` with their
//   readiness assertion never once executed against a real Postgres.
//
//   Most of those 51 had an existing suite that applies the same SQL, and
//   were closed by adding a runner block to it. These four had no suite at
//   all -- no `.pg.test.ts` file anywhere referenced their migration -- so
//   there was nothing to extend. Hence a suite of their own.
//
// REGISTRATION REQUIRED -- READ BEFORE TRUSTING THIS FILE
//   pre-release-migrations.yml derives its suite list from the
//   `test:migrations` chain in apps/web/package.json, and `npm test` excludes
//   `.pg.test.ts` by construction. Until a
//   `test:migrations:unexercised-runners` script exists AND is chained into
//   `test:migrations`, this file runs nowhere automatically -- which looks
//   exactly like coverage without being any. The branch that added this file
//   was scoped to `.pg.test.ts` only and could not make that edit. Run it by
//   hand with:
//     node --experimental-vm-modules ../../node_modules/jest/bin/jest.js \
//       --runTestsByPath src/server/pilot/unexercisedMigrationRunners.pg.test.ts \
//       --testTimeout=180000
//
// Spins up the same disposable, local-only embedded Postgres every other
// migration suite uses. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-unexercised-runners-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type ApplyMigrationTransaction = (client: Client, sql: string) => Promise<void>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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

/**
 * The runner is loaded out of apps/web/scripts, not reimplemented here. The
 * READINESS_QUERY the assertions below exercise is therefore the one that
 * ships and the one a dispatch runs -- restating it in this file would let
 * the copy stay correct while the shipped one rots, which is precisely the
 * failure being regression-tested.
 */
async function loadRunner(basename: string): Promise<ApplyMigrationTransaction> {
  const runnerModule = await nativeDynamicImport(
    pathToFileURL(path.join(SCRIPTS_DIR, basename)).href,
  );
  const apply = runnerModule.applyMigrationTransaction;
  expect(typeof apply).toBe('function');
  return apply as ApplyMigrationTransaction;
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
  return client;
}

function migration(file: string): Promise<string> {
  return fs.readFile(path.join(INFRA_DIR, file), 'utf8');
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

  baseSchemaSql = await migration('pilot_slice_postgres.sql');
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

// Sixteen columns asserted one by one, three CHECK clauses matched against
// pg_get_constraintdef() output, two indexes matched by name. Every one of
// those is the same kind of string comparison that was wrong in #488, and
// none of them had ever run.
describe('profile identity runner', () => {
  const SQL = 'pilot_slice_postgres_profile_identity_migration.sql';
  const RUNNER = 'pilot-apply-profile-identity-migration.mjs';

  test('REFUSES a database where the migration never ran', async () => {
    const applyMigrationTransaction = await loadRunner(RUNNER);
    const client = await freshDatabase('unexercised_profile_no');
    try {
      // pilot.account_profiles is not in the base schema, so this is exactly
      // the state a dispatch against a stale environment would meet.
      //
      // It fails closed, but NOT through the runner's own sentinel. The first
      // clause of READINESS_QUERY uses to_regclass(), which returns null for
      // a missing relation, but the three CHECK clauses after it use
      // `'pilot.account_profiles'::regclass`, and that cast RAISES instead.
      // So assertReadiness() is never reached and the operator gets a raw
      // Postgres error rather than ACCOUNT_PROFILES_TABLE_NOT_READY.
      // Asserting what ships, not what the runner appears to promise --
      // expecting the sentinel here would be asserting a fiction. Reported
      // separately; the fix is a runner change, out of scope for this branch.
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /relation "pilot.account_profiles" does not exist/,
      );
      const table = await client.query(`select to_regclass('pilot.account_profiles') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner(RUNNER);
    const client = await freshDatabase('unexercised_profile_ok');
    try {
      const sql = await migration(SQL);
      await applyMigrationTransaction(client, sql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, sql);

      // And the vocabulary the readiness check matched as TEXT is a database
      // fact, not just a substring of a constraint definition -- the same
      // distinction #488 turned on.
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ('org-profile', 'org-profile', 'active')`,
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ('acct-profile', 'coach', 'org-profile', 'microsoft')`,
      );
      await expect(
        client.query(
          `insert into pilot.account_profiles (organization_id, account_id, corner)
           values ('org-profile', 'acct-profile', 'chartreuse')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });
});

describe('public interest runner', () => {
  const SQL = 'pilot_slice_postgres_public_interest_migration.sql';
  const RUNNER = 'pilot-apply-public-interest-migration.mjs';

  test('REFUSES a database where the migration never ran', async () => {
    const applyMigrationTransaction = await loadRunner(RUNNER);
    const client = await freshDatabase('unexercised_pubint_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /PUBLIC_INTEREST_SUBMISSIONS_TABLE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner(RUNNER);
    const client = await freshDatabase('unexercised_pubint_ok');
    try {
      const sql = await migration(SQL);
      await applyMigrationTransaction(client, sql);
      await applyMigrationTransaction(client, sql);
    } finally {
      await client.end();
    }
  });
});

describe('scheduler tables runner', () => {
  const SQL = 'pilot_slice_postgres_scheduler_tables_migration.sql';
  const RUNNER = 'pilot-apply-scheduler-tables-migration.mjs';
  const TABLES = [
    'pilot.scheduler_attendance',
    'pilot.scheduler_coaching_requests',
    'pilot.scheduler_registrations',
    'pilot.scheduler_classes',
  ];

  // Worth stating plainly, because it changes what this runner's green light
  // means: pilot_slice_postgres.sql already creates all four scheduler
  // tables. So against any database that got the base schema, this readiness
  // check passes whether or not the migration ran -- it reports on the end
  // state, and the end state is already satisfied by the base. Reaching the
  // genuine pre-migration state takes an explicit drop.
  test('REFUSES a database where the tables are absent', async () => {
    const applyMigrationTransaction = await loadRunner(RUNNER);
    const client = await freshDatabase('unexercised_schedtab_no');
    try {
      for (const table of TABLES) {
        await client.query(`drop table if exists ${table} cascade`);
      }
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SCHEDULER_TABLES_NOT_READY/,
      );
      const still = await client.query(`select to_regclass('pilot.scheduler_classes') as t`);
      expect(still.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner(RUNNER);
    const client = await freshDatabase('unexercised_schedtab_ok');
    try {
      for (const table of TABLES) {
        await client.query(`drop table if exists ${table} cascade`);
      }
      const sql = await migration(SQL);
      await applyMigrationTransaction(client, sql);
      await applyMigrationTransaction(client, sql);
      for (const table of TABLES) {
        const present = await client.query(`select to_regclass($1) as t`, [table]);
        expect(present.rows[0].t).not.toBeNull();
      }
    } finally {
      await client.end();
    }
  });
});

describe('scheduler registration race runner', () => {
  const SQL = 'pilot_slice_postgres_scheduler_registration_race_migration.sql';
  const RUNNER = 'pilot-apply-scheduler-race-migration.mjs';

  test('REFUSES a database where the unique index never landed', async () => {
    const applyMigrationTransaction = await loadRunner(RUNNER);
    const client = await freshDatabase('unexercised_schedrace_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SCHEDULER_REGISTRATIONS_UNIQUE_INDEX_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('ACCEPTS a correctly migrated database, and the index is a real fact', async () => {
    const applyMigrationTransaction = await loadRunner(RUNNER);
    const client = await freshDatabase('unexercised_schedrace_ok');
    try {
      const sql = await migration(SQL);
      await applyMigrationTransaction(client, sql);
      await applyMigrationTransaction(client, sql);

      // The readiness check matches the index BY NAME. A name is not a
      // guarantee of behavior, so prove the behavior: the same athlete cannot
      // hold two active registrations for one class.
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ('org-race', 'org-race', 'active')`,
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ('acct-race-coach', 'coach', 'org-race', 'microsoft')`,
      );
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
            emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ('org-race', 'ath-race', 'Race Athlete', '2012-01-01', '100', 'active',
                 'contact', true, 'acct-race-coach', now(), now())`,
      );
      await client.query(
        `insert into pilot.scheduler_classes
           (organization_id, class_id, title, start_at, end_at, location, capacity,
            scheduled_by_account_id, coach_account_id, status)
         values ('org-race', 'cls-race', 'Youth Boxing', now() + interval '1 day',
                 now() + interval '1 day 1 hour', 'Main Floor', 10,
                 'acct-race-coach', 'acct-race-coach', 'open')`,
      );

      const register = (registrationId: string) =>
        client.query(
          `insert into pilot.scheduler_registrations
             (organization_id, registration_id, class_id, athlete_id,
            requested_by_role, requested_by_account_id, status)
           values ('org-race', $1, 'cls-race', 'ath-race', 'coach', 'acct-race-coach', 'registered')`,
          [registrationId],
        );

      await register('reg-race-1');
      await expect(register('reg-race-2')).rejects.toMatchObject({ code: '23505' });
    } finally {
      await client.end();
    }
  });
});
