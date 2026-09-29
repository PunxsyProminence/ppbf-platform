// Real PostgreSQL-backed test for pilot_waivers_status_check.
//
// Owner, 2026-09-29, Q3 answer A: hold pilot.waivers.status to the readers'
// vocabulary in the database. This proves the before state (the column takes
// anything), that the migration refuses every near-miss and admits exactly the
// four values, that it refuses to apply over a non-exact row rather than
// half-applying, and that the runner refuses a database whose constraint is
// missing, unvalidated, or admits a different set.
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

import { WAIVER_STATUSES } from './waiverCompliance';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module. Building it through Function keeps a real dynamic import
   in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-waiver-status-check-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_waiver_status_check_migration.sql');
const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-waiver-status-check-migration.mjs',
);

const ORG_ID = 'org-waiver-status-check';
const COACH = 'coach@example.test';
const ATHLETE = 'ath-status-check';

/* Near-misses a caller could plausibly send. Every one is refused. The first
   three are the case-and-padding forms every reader ACCEPTS after normalising,
   which is exactly why the constraint had to wait for a measurement. */
const REFUSED = [' Signed ', 'SIGNED', 'Signed', 'signed ', '', 'pending', 'active', 'approved'];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let migrationSql: string;

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

/** Base schema, and the organization, coach and athlete a waiver row needs. */
async function freshDatabase(name: string): Promise<Client> {
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
     values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Status Child', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $3, now(), now())`,
    [ORG_ID, ATHLETE, COACH],
  );

  return client;
}

async function insertWaiver(client: Client, status: string) {
  const result = await client.query<{ waiver_id: string }>(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
        signed_at, consent_version, status)
     values ($1, gen_random_uuid(), $2, 'general', 'Guardian', 'parent', now(), 'v1', $3)
     returning waiver_id`,
    [ORG_ID, ATHLETE, status],
  );
  return result.rows[0].waiver_id;
}

async function constraintShape(client: Client) {
  const result = await client.query<{ contype: string; convalidated: boolean; definition: string }>(
    `select contype, convalidated, pg_get_constraintdef(oid) as definition
       from pg_constraint
      where conname = 'pilot_waivers_status_check'
        and conrelid = to_regclass('pilot.waivers')`,
  );
  return result.rows[0] ?? null;
}

/** The single-quoted literals in a constraint definition. */
function literalsIn(definition: string): string[] {
  return [...definition.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'"));
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
  migrationSql = await fs.readFile(MIGRATION_PATH, 'utf8');
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

describe('the column, before anything is changed', () => {
  /* THE BEFORE STATE IS MEASURED, NOT ASSUMED. Without this the constraint
     below would have no demonstrated cause. */
  it('stores any text at all', async () => {
    const client = await freshDatabase('ppbf_test_waiver_status_before');
    try {
      expect(await constraintShape(client)).toBeNull();
      await insertWaiver(client, ' Signed ');
      await insertWaiver(client, 'pending');
      const rows = await client.query('select status from pilot.waivers order by status');
      expect(rows.rows.map((row) => row.status)).toEqual([' Signed ', 'pending']);
    } finally {
      await client.end();
    }
  });
});

describe('what the migration changes', () => {
  let client: Client;

  beforeAll(async () => {
    client = await freshDatabase('ppbf_test_waiver_status_after');
    await client.query(migrationSql);
  });

  afterAll(async () => {
    await client.end();
  });

  it('adds a validated CHECK', async () => {
    const shape = await constraintShape(client);
    expect(shape).toMatchObject({ contype: 'c', convalidated: true });
  });

  it('admits exactly the reader vocabulary, no more and no fewer', async () => {
    const shape = await constraintShape(client);
    expect([...literalsIn(shape?.definition ?? '')].sort()).toEqual([...WAIVER_STATUSES].sort());
  });

  it.each([...WAIVER_STATUSES])('accepts %p', async (status) => {
    await expect(insertWaiver(client, status)).resolves.toEqual(expect.any(String));
  });

  it.each(REFUSED)('refuses %p with 23514', async (status) => {
    await expect(insertWaiver(client, status)).rejects.toMatchObject({
      code: '23514',
      constraint: 'pilot_waivers_status_check',
    });
  });

  it('refuses an update to a value outside the vocabulary, not only an insert', async () => {
    const waiverId = await insertWaiver(client, 'signed');
    await expect(
      client.query(`update pilot.waivers set status = 'SIGNED' where waiver_id = $1`, [waiverId]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('applying it', () => {
  it('re-applying is a no-op, so `all` can run it against any environment', async () => {
    const client = await freshDatabase('ppbf_test_waiver_status_idempotent');
    try {
      await client.query(migrationSql);
      const first = await constraintShape(client);
      await client.query(migrationSql);
      expect(await constraintShape(client)).toEqual(first);
    } finally {
      await client.end();
    }
  });

  it('keeps every exact row already on file', async () => {
    const client = await freshDatabase('ppbf_test_waiver_status_existing');
    try {
      for (const status of WAIVER_STATUSES) {
        await insertWaiver(client, status);
      }
      await client.query(migrationSql);
      const count = await client.query('select count(*)::int as n from pilot.waivers');
      expect(count.rows[0].n).toBe(WAIVER_STATUSES.length);
    } finally {
      await client.end();
    }
  });

  it('refuses to apply at all over a row outside the vocabulary', async () => {
    /* Validated, not `not valid`: the ALTER scans the rows and fails with
       23514 rather than installing a constraint that records the existing
       rows were never checked. Nothing is created and nothing is rewritten;
       what to do with the row is a data decision this migration does not
       take. */
    const client = await freshDatabase('ppbf_test_waiver_status_dirty');
    try {
      await insertWaiver(client, 'signed');
      await insertWaiver(client, ' Signed ');
      await expect(client.query(migrationSql)).rejects.toMatchObject({ code: '23514' });
      expect(await constraintShape(client)).toBeNull();
      const rows = await client.query('select status from pilot.waivers order by status');
      expect(rows.rows.map((row) => row.status)).toEqual([' Signed ', 'signed']);
    } finally {
      await client.end();
    }
  });
});

describe('the runner refuses a database the migration did not reach', () => {
  async function loadRunner() {
    return nativeDynamicImport(pathToFileURL(RUNNER_PATH).href) as Promise<{
      applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
    }>;
  }

  it('accepts the real migration, and accepts it twice', async () => {
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_waiver_status_runner_ok');
    try {
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
      expect(await constraintShape(client)).toMatchObject({ contype: 'c', convalidated: true });
    } finally {
      await client.end();
    }
  });

  it('throws when the SQL did not create the constraint', async () => {
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_waiver_status_runner_unmigrated');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'WAIVER_STATUS_CHECK_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });

  it('throws when a same-named constraint admits a different vocabulary', async () => {
    /* The near-miss the catalog guard cannot see: the add is skipped when a
       constraint by this name exists, so a database already carrying a wider
       or narrower one would keep it and the SQL would report success. */
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_waiver_status_runner_wrong_set');
    try {
      await client.query(
        `alter table pilot.waivers add constraint pilot_waivers_status_check
           check (status in ('signed', 'declined', 'withdrawn', 'missing', 'pending'))`,
      );
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        'WAIVER_STATUS_CHECK_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });

  it('throws when the constraint was never validated', async () => {
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_waiver_status_runner_not_valid');
    try {
      await client.query(
        `alter table pilot.waivers add constraint pilot_waivers_status_check
           check (status in ('signed', 'declined', 'withdrawn', 'missing')) not valid`,
      );
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        'WAIVER_STATUS_CHECK_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });
});
