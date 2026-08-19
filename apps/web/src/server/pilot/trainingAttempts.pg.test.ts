// Real PostgreSQL-backed contract test for the training-attempts migration.
//
// What needs proving that reading SQL cannot prove: the migration creates
// the ledger from nothing; re-applying it is a no-op; the metric/direction
// vocabularies are enforced by the database; the verdict-requires-target
// rule holds in both directions (a made/failed with no target is refused,
// a target with no verdict is refused, a target-less measurement is legal);
// and the tenancy shape holds via the composite athlete FK.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-training-attempts-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_training_attempts_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-training-attempts-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-attempts';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-attempts-admin';
const COACH_ID = 'acct-attempts-coach';
const ATHLETE_ID = 'ath-attempts-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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
     values ($1, $2, 'Attempts Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
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


function insertAttempt(client: Client, attemptId: string, overrides: Record<string, string | number | boolean | null> = {}) {
  return client.query(
    `insert into pilot.training_attempts
       (organization_id, attempt_id, athlete_id, metric_kind, direction, target_value, achieved_value, made, recorded_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      overrides.organization_id ?? ORG_ID,
      attemptId,
      ATHLETE_ID,
      overrides.metric_kind ?? 'reps',
      overrides.direction ?? 'at_least',
      'target_value' in overrides ? overrides.target_value : 10,
      overrides.achieved_value ?? 7,
      'made' in overrides ? overrides.made : false,
      ADMIN_ID,
    ],
  );
}

describe('training attempts migration', () => {
  test('creates the ledger from nothing and a failed attempt is a first-class row', async () => {
    const client = await freshDatabase('attempts_fresh');
    try {
      await client.query(migrationSql);
      await insertAttempt(client, 'att-miss');

      const rows = await client.query(
        `select t.made, t.target_value::int as target, t.achieved_value::int as achieved, a.full_name
         from pilot.training_attempts t
         join pilot.athletes a on a.organization_id = t.organization_id and a.athlete_id = t.athlete_id
         where t.organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{ made: false, target: 10, achieved: 7, full_name: 'Attempts Athlete' }]);
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('attempts_noop');
    try {
      await client.query(migrationSql);
      await insertAttempt(client, 'att-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select attempt_id from pilot.training_attempts where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.attempt_id)).toEqual(['att-keep']);
    } finally {
      await client.end();
    }
  });

  test('the vocabularies and the verdict-requires-target rule are database facts', async () => {
    const client = await freshDatabase('attempts_vocab');
    try {
      await client.query(migrationSql);

      await expect(insertAttempt(client, 'att-bad-metric', { metric_kind: 'vibes' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertAttempt(client, 'att-bad-dir', { direction: 'sideways' }))
        .rejects.toMatchObject({ code: '23514' });
      // A verdict with no target has no basis; a target with no verdict is
      // half a record. Both refused by the same constraint.
      await expect(insertAttempt(client, 'att-verdictless', { made: null }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertAttempt(client, 'att-baseless', { target_value: null, made: false }))
        .rejects.toMatchObject({ code: '23514' });
      // A measurement: no target, no verdict -- legal.
      await insertAttempt(client, 'att-measured', { target_value: null, made: null });
    } finally {
      await client.end();
    }
  });

  test('tenancy is composite: an attempt cannot claim an athlete from another organization', async () => {
    const client = await freshDatabase('attempts_tenancy');
    try {
      await client.query(migrationSql);

      await expect(insertAttempt(client, 'att-cross', { organization_id: OTHER_ORG_ID }))
        .rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-training-attempts-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('training attempts runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('tratt_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /TRAINING_ATTEMPTS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('tratt_rdy_ok');
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
