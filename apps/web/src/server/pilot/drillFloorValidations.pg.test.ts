// Real PostgreSQL-backed contract test for the drill floor validations
// migration and module (OD-2026-10-06-026 ruling 3: "They stay drafts until a
// coach marks them floor-tested").
//
// Proven here, none of it by reading SQL:
// 1. The migration creates the table, its two cascading foreign keys, the role
//    CHECK and the index; re-running is a no-op; readiness refuses a bare
//    database and a no-op migration.
// 2. markDrillFloorTested records who and when for THIS gym; the list read
//    returns the newest mark per drill; a re-mark adds a row and keeps the
//    earlier one (append-only); another gym's drill id yields null and writes
//    nothing; a role outside the two named is refused by the database.
// 3. Deleting the reference drill removes its marks (cascade), so this table
//    can never block that deletion.
//
// The module's db calls are routed to the embedded server through a mocked
// ./db (the coachCards.pg.test.ts pattern). Local-only; never production.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-floor-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-floor-validations-migration.mjs',
);

const ORG = 'org-floor';
const OTHER_ORG = 'org-floor-other';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSql: string;
let drillLibrarySql: string;
let migrationSql: string;
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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
  withTransaction: jest.fn(),
}));

import { listFloorValidations, markDrillFloorTested } from './drillFloorValidations';

/** A database with the drill library applied, two gyms, and one reference drill each. */
async function freshDatabase(name: string, migrated = true): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSql);
  await client.query(drillLibrarySql);
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1,$1,'active')`,
      [org],
    );
    await client.query(
      `insert into pilot.drill_library
         (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
          standard_setup, execution, what_good_looks_like, what_bad_looks_like, field_provenance)
       values ($1,'drl-1','drl-1','Draft drill','technical','t','p','s','e','g','b',
               'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION')`,
      [org],
    );
  }
  if (migrated) await applyMigrationTransaction(client, migrationSql);
  activeClient = client;
  return client;
}

async function rowCount(client: Client): Promise<number> {
  const result = await client.query<{ n: number }>(`select count(*)::int as n from pilot.drill_floor_validations`);
  return result.rows[0].n;
}

describe('the migration', () => {
  test('creates the table and its guards; re-running is a no-op', async () => {
    const client = await freshDatabase('ppbf_floor_migration');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      // Keys and CHECKs only: newer Postgres also lists NOT NULL as constraints.
      const constraints = await client.query<{ conname: string }>(
        `select conname from pg_constraint
         where conrelid = 'pilot.drill_floor_validations'::regclass and contype in ('p', 'f', 'c')
         order by conname`,
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        'drill_floor_validations_organization_id_fkey',
        'pilot_drill_floor_validations_drill_fk',
        'pilot_drill_floor_validations_pkey',
        'pilot_drill_floor_validations_role_check',
      ]);
      const index = await client.query(`select to_regclass('pilot.idx_pilot_drill_floor_validations_org_drill_newest') as i`);
      expect(index.rows[0].i).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('the readiness check REFUSES a database where the drill library never landed', async () => {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query('drop database if exists ppbf_floor_bare');
    await admin.query('create database ppbf_floor_bare');
    await admin.end();
    const client = new Client({ connectionString: connectionStringFor('ppbf_floor_bare') });
    await client.connect();
    try {
      await client.query(baseSql);
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(/DRILL_FLOOR_VALIDATIONS_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test('the readiness check REFUSES a no-op migration that changed nothing', async () => {
    const client = await freshDatabase('ppbf_floor_noop', false);
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(/DRILL_FLOOR_VALIDATIONS_NOT_READY/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('marking a reference drill floor-tested for a gym', () => {
  test('records who and when; the list read returns it for this gym only', async () => {
    const client = await freshDatabase('ppbf_floor_mark');
    try {
      expect(await listFloorValidations(ORG, ['drl-1'])).toEqual({});

      const mark = await markDrillFloorTested({
        organizationId: ORG, drillId: 'drl-1', validatedByAccountId: 'acct-coach', validatedByRole: 'coach', note: ' Ran it Tuesday ',
      });
      expect(mark).toMatchObject({
        organization_id: ORG, drill_id: 'drl-1', validated_by_account_id: 'acct-coach', validated_by_role: 'coach', note: 'Ran it Tuesday',
      });
      expect(mark?.validation_id).toMatch(/^dfv_/);
      expect(mark?.validated_at).toBeTruthy();

      expect(await listFloorValidations(ORG, ['drl-1'])).toEqual({ 'drl-1': mark });
      expect(await listFloorValidations(ORG)).toEqual({ 'drl-1': mark });
      // The other gym has the same drill id and no mark: a gym's floor time is its own.
      expect(await listFloorValidations(OTHER_ORG, ['drl-1'])).toEqual({});
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a re-mark adds a row and becomes current; the earlier mark is kept as history', async () => {
    const client = await freshDatabase('ppbf_floor_remark');
    try {
      const first = await markDrillFloorTested({ organizationId: ORG, drillId: 'drl-1', validatedByAccountId: 'acct-a', validatedByRole: 'coach' });
      // Push the first mark into the past so "newest" is decided by time, not luck.
      await client.query(`update pilot.drill_floor_validations set validated_at = validated_at - interval '1 day' where validation_id = $1`, [first?.validation_id]);
      const second = await markDrillFloorTested({ organizationId: ORG, drillId: 'drl-1', validatedByAccountId: 'acct-b', validatedByRole: 'organization_admin' });

      expect(await rowCount(client)).toBe(2);
      const current = await listFloorValidations(ORG, ['drl-1']);
      expect(current['drl-1'].validation_id).toBe(second?.validation_id);
      expect(current['drl-1'].validated_by_account_id).toBe('acct-b');
      const history = await client.query<{ validated_by_account_id: string }>(
        `select validated_by_account_id from pilot.drill_floor_validations order by validated_at`,
      );
      expect(history.rows.map((row) => row.validated_by_account_id)).toEqual(['acct-a', 'acct-b']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a drill id this gym does not hold yields null and writes nothing', async () => {
    const client = await freshDatabase('ppbf_floor_cross_org');
    try {
      const result = await markDrillFloorTested({ organizationId: ORG, drillId: 'drl-missing', validatedByAccountId: 'acct-a', validatedByRole: 'coach' });
      expect(result).toBeNull();
      expect(await rowCount(client)).toBe(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('the database refuses a role outside coach and organization_admin', async () => {
    const client = await freshDatabase('ppbf_floor_role');
    try {
      await expect(
        client.query(
          `insert into pilot.drill_floor_validations (organization_id, validation_id, drill_id, validated_by_account_id, validated_by_role)
           values ($1, 'dfv_x', 'drl-1', 'acct', 'admin')`,
          [ORG],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('deleting the reference drill removes its marks, so they never block that deletion', async () => {
    const client = await freshDatabase('ppbf_floor_cascade');
    try {
      await markDrillFloorTested({ organizationId: ORG, drillId: 'drl-1', validatedByAccountId: 'acct-a', validatedByRole: 'coach' });
      expect(await rowCount(client)).toBe(1);
      await client.query(`delete from pilot.drill_library where organization_id = $1 and drill_id = 'drl-1'`, [ORG]);
      expect(await rowCount(client)).toBe(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  baseSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  drillLibrarySql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_drill_library_v3_migration.sql'), 'utf8',
  );
  migrationSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_drill_floor_validations_migration.sql'), 'utf8',
  );

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as typeof applyMigrationTransaction;
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
    const safetyTimer = setTimeout(finish, 10_000);
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

