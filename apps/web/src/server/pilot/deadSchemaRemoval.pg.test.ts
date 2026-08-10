// Real PostgreSQL-backed contract test for the dead-schema removal migration
// (drops pilot.messages, pilot.skills, pilot.staff).
//
// Four things need proving, and none can be proven by reading SQL:
//
// 1. Against a database still carrying the three old tables (the shape every
//    existing staging/production environment has today, since the base
//    schema created them until this same change edited it), the migration
//    actually drops all three.
// 2. It is idempotent: re-running against a database where they are already
//    gone is a no-op success, not an error.
// 3. The readiness check's own polarity is inverted from every other
//    migration in this repo (it asserts ABSENCE, not presence) -- proven by
//    a negative control: a database where one of the three still exists must
//    fail readiness, not silently pass.
// 4. Dropping succeeds even when a table holds rows -- confirms this is a
//    plain DROP, not something that would refuse on non-empty tables.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-dead-schema-removal-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_dead_schema_removal_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-dead-schema-removal-migration.mjs',
);

const ORG_A = 'org-dead-schema-a';

// The exact pre-removal shape, as it existed in both the base schema and the
// multiorg migration before this change edited them out of both. Used to put
// a fresh database into the state every real environment is in today, since
// freshDatabase() below builds from the ALREADY-EDITED base schema (which no
// longer creates these tables at all).
const LEGACY_TABLES_SQL = `
  create table if not exists pilot.messages (
    organization_id text not null references pilot.organizations(organization_id),
    message_id uuid not null,
    sender_account_id text not null references pilot.accounts(account_id),
    recipient_account_id text not null references pilot.accounts(account_id),
    body text not null,
    created_at timestamptz not null default now(),
    primary key (organization_id, message_id)
  );
  create table if not exists pilot.skills (
    organization_id text not null references pilot.organizations(organization_id),
    skill_id uuid not null,
    athlete_id text not null,
    skill_name text not null,
    level text not null,
    recorded_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (organization_id, skill_id)
  );
  create table if not exists pilot.staff (
    organization_id text not null references pilot.organizations(organization_id),
    staff_id text not null,
    account_id text null references pilot.accounts(account_id),
    full_name text not null,
    title text not null,
    active_flag boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (organization_id, staff_id)
  );
`;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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
 * Fresh database with the (already-edited) base schema and one organization.
 * `withLegacyTables` recreates the three old tables directly, putting the
 * database into the shape every real environment is in today -- the base
 * schema alone can no longer produce it, now that this change removed them
 * from it.
 */
async function freshDatabase(name: string, { withLegacyTables = false } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_A],
  );

  if (withLegacyTables) {
    await client.query(LEGACY_TABLES_SQL);
  }

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
});

describe('dead schema removal migration against real Postgres', () => {
  test('the base schema no longer creates any of the three tables', async () => {
    const client = await freshDatabase('ppbf_test_dead_schema_base_absent');
    try {
      const rows = await client.query(
        `select to_regclass('pilot.messages') as messages,
                to_regclass('pilot.skills') as skills,
                to_regclass('pilot.staff') as staff`,
      );
      expect(rows.rows[0]).toEqual({ messages: null, skills: null, staff: null });
    } finally {
      await client.end();
    }
  });

  // NEGATIVE CONTROL. This readiness check's polarity is inverted from every
  // other migration's own runner (it asserts absence). If it silently passed
  // while a table still existed, this migration could report success on a
  // production environment that had not actually been cleaned up.
  test('the readiness check REFUSES a database where a legacy table still exists', async () => {
    const client = await freshDatabase('ppbf_test_dead_schema_readiness_negative', { withLegacyTables: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DEAD_SCHEMA_REMOVAL_NOT_READY/,
      );

      const table = await client.query(`select to_regclass('pilot.messages') as t`);
      expect(table.rows[0].t).not.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('drops all three tables from a database carrying the legacy shape', async () => {
    const client = await freshDatabase('ppbf_test_dead_schema_drop', { withLegacyTables: true });
    try {
      const before = await client.query(
        `select to_regclass('pilot.messages') as messages,
                to_regclass('pilot.skills') as skills,
                to_regclass('pilot.staff') as staff`,
      );
      expect(before.rows[0].messages).not.toBeNull();
      expect(before.rows[0].skills).not.toBeNull();
      expect(before.rows[0].staff).not.toBeNull();

      await applyMigrationTransaction(client, migrationSql);

      const after = await client.query(
        `select to_regclass('pilot.messages') as messages,
                to_regclass('pilot.skills') as skills,
                to_regclass('pilot.staff') as staff`,
      );
      expect(after.rows[0]).toEqual({ messages: null, skills: null, staff: null });
    } finally {
      await client.end();
    }
  });

  test('drops cleanly even when the tables hold rows', async () => {
    const client = await freshDatabase('ppbf_test_dead_schema_drop_with_rows', { withLegacyTables: true });
    try {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ('acct-dead-schema-1', 'coach', $1, 'microsoft')`,
        [ORG_A],
      );
      await client.query(
        `insert into pilot.messages (organization_id, message_id, sender_account_id, recipient_account_id, body)
         values ($1, gen_random_uuid(), 'acct-dead-schema-1', 'acct-dead-schema-1', 'hello')`,
        [ORG_A],
      );
      await client.query(
        `insert into pilot.staff (organization_id, staff_id, full_name, title)
         values ($1, 'staff-1', 'Someone', 'Assistant Coach')`,
        [ORG_A],
      );

      await applyMigrationTransaction(client, migrationSql);

      const after = await client.query(`select to_regclass('pilot.messages') as t`);
      expect(after.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op against a database that never had the tables', async () => {
    const client = await freshDatabase('ppbf_test_dead_schema_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const after = await client.query(
        `select to_regclass('pilot.messages') as messages,
                to_regclass('pilot.skills') as skills,
                to_regclass('pilot.staff') as staff`,
      );
      expect(after.rows[0]).toEqual({ messages: null, skills: null, staff: null });
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op after the legacy tables were already dropped', async () => {
    const client = await freshDatabase('ppbf_test_dead_schema_idempotent_after_legacy', { withLegacyTables: true });
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const after = await client.query(`select to_regclass('pilot.messages') as t`);
      expect(after.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });
});
