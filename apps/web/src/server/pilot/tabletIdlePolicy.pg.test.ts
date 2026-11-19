// Real PostgreSQL-backed test for the organization-tablet-idle-policy migration
// and tabletIdlePolicy.ts on top of it (lane U1, AS2-a; OW25-53 A: the gym admin
// sets the gym tablet's idle sign-out time, first value 1 hour). './db' is
// mocked to route into the embedded server (the restMarks.pg.test.ts pattern;
// withTransaction runs a real BEGIN/COMMIT/ROLLBACK), so the module's real SQL
// and audit.ts's run against real rows. The runner is driven through its real
// entrypoint, so its readiness check runs against a real Postgres here.
//
// It NEVER connects to production or staging: an embedded server on a free
// local port, in a throwaway data directory.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

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
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

import { readTabletIdlePolicy, setTabletIdlePolicy } from './tabletIdlePolicy';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-tablet-idle-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_organization_tablet_idle_policy_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-organization-tablet-idle-policy-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-tabletidle';
const OTHER_ORG_ID = 'org-tabletidle-elsewhere';
const ADMIN_ID = 'acct-tabletidle-admin';
const OTHER_ADMIN_ID = 'acct-tabletidle-other-admin';
const COACH_ID = 'acct-tabletidle-coach';
const SECOND_ADMIN_ID = 'acct-tabletidle-second-admin'; // a second gym admin in ORG_ID

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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

/** The full schema, two gyms, a gym admin in each and a coach in the first. */
async function freshDatabase(name: string, { preMigration = false } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
     values ($1, 'organization_admin', $4, 'microsoft', null, null),
            ($2, 'organization_admin', $5, 'microsoft', null, null),
            ($3, 'coach',              $4, 'microsoft', null, null),
            ($6, 'organization_admin', $4, 'microsoft', null, null)
     on conflict do nothing`,
    [ADMIN_ID, OTHER_ADMIN_ID, COACH_ID, ORG_ID, OTHER_ORG_ID, SECOND_ADMIN_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.organization_tablet_idle_policy cascade');
  } else {
    // Idempotent: a no-op once the workflow's `all` list carries it.
    await applyMigrationTransaction(client, migrationSql);
  }
  return client;
}

async function auditRows(client: Client) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
       from pilot.audit_events where entity_type = 'organization_tablet_idle_policy' order by created_at`,
  );
  return rows;
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

  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
});

afterEach(() => {
  activeClient = null;
  jest.restoreAllMocks();
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

describe('organization tablet idle policy migration', () => {
  test('creates the table from nothing, passes the runner readiness check, and a re-apply keeps the row', async () => {
    const client = await freshDatabase('tabletidle_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.organization_tablet_idle_policy') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `insert into pilot.organization_tablet_idle_policy (organization_id, idle_minutes, set_by_account_id)
         values ($1, 30, $2)`,
        [ORG_ID, ADMIN_ID],
      );
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query('select organization_id, idle_minutes from pilot.organization_tablet_idle_policy');
      expect(rows).toEqual([{ organization_id: ORG_ID, idle_minutes: 30 }]);
    } finally {
      await client.end();
    }
  });

  test('the readiness check refuses a table whose list is not the ruled one', async () => {
    const client = await freshDatabase('tabletidle_drift');
    try {
      await client.query(
        `alter table pilot.organization_tablet_idle_policy
           drop constraint pilot_org_tablet_idle_minutes_check,
           add constraint pilot_org_tablet_idle_minutes_check check (idle_minutes in (1, 15, 30, 60, 120, 240))`,
      );
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('ORGANIZATION_TABLET_IDLE_POLICY_TABLE_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test('the database refuses any time off the list, and takes each one on it', async () => {
    const client = await freshDatabase('tabletidle_check');
    try {
      for (const minutes of [1, 0, 45, 480, -60]) {
        await expect(client.query(
          `insert into pilot.organization_tablet_idle_policy (organization_id, idle_minutes, set_by_account_id)
           values ($1, $2, $3)`,
          [ORG_ID, minutes, ADMIN_ID],
        )).rejects.toMatchObject({ code: '23514' });
      }
      for (const minutes of [15, 30, 60, 120, 240]) {
        await client.query(
          `insert into pilot.organization_tablet_idle_policy (organization_id, idle_minutes, set_by_account_id)
           values ($1, $2, $3)
           on conflict (organization_id) do update set idle_minutes = excluded.idle_minutes`,
          [ORG_ID, minutes, ADMIN_ID],
        );
      }
      const { rows } = await client.query('select idle_minutes from pilot.organization_tablet_idle_policy');
      expect(rows).toEqual([{ idle_minutes: 240 }]);
    } finally {
      await client.end();
    }
  });
});

describe('tabletIdlePolicy.ts on a real database', () => {
  test('a gym with no row reads one hour, marked as the default', async () => {
    activeClient = await freshDatabase('tabletidle_default');
    try {
      await expect(readTabletIdlePolicy(ORG_ID)).resolves.toEqual({ idle_minutes: 60, is_default: true });
    } finally {
      await activeClient.end();
    }
  });

  test('the gym admin sets it, a second gym admin changes it, and each change is audited with the old and new value; the other gym is untouched', async () => {
    const client = await freshDatabase('tabletidle_set');
    activeClient = client;
    try {
      await expect(setTabletIdlePolicy({
        organizationId: ORG_ID, actorAccountId: ADMIN_ID, actorRole: 'organization_admin', idleMinutes: 30,
      })).resolves.toEqual({ idle_minutes: 30, is_default: false });
      const first = await client.query('select set_at from pilot.organization_tablet_idle_policy where organization_id = $1', [ORG_ID]);
      // The change is made by the gym's second admin: the row must name them and move set_at.
      await setTabletIdlePolicy({
        organizationId: ORG_ID, actorAccountId: SECOND_ADMIN_ID, actorRole: 'organization_admin', idleMinutes: 120,
      });

      await expect(readTabletIdlePolicy(ORG_ID)).resolves.toEqual({ idle_minutes: 120, is_default: false });
      await expect(readTabletIdlePolicy(OTHER_ORG_ID)).resolves.toEqual({ idle_minutes: 60, is_default: true });

      const { rows } = await client.query(
        'select organization_id, idle_minutes, set_by_account_id from pilot.organization_tablet_idle_policy',
      );
      expect(rows).toEqual([{ organization_id: ORG_ID, idle_minutes: 120, set_by_account_id: SECOND_ADMIN_ID }]);
      const second = await client.query('select set_at from pilot.organization_tablet_idle_policy where organization_id = $1', [ORG_ID]);
      expect(second.rows[0].set_at.getTime()).toBeGreaterThan(first.rows[0].set_at.getTime());

      expect(await auditRows(client)).toEqual([
        {
          event_type: 'update', actor_account_id: ADMIN_ID, actor_role: 'organization_admin', organization_id: ORG_ID,
          entity_id: ORG_ID, details: { idle_minutes: 30, previous_idle_minutes: null },
        },
        {
          event_type: 'update', actor_account_id: SECOND_ADMIN_ID, actor_role: 'organization_admin', organization_id: ORG_ID,
          entity_id: ORG_ID, details: { idle_minutes: 120, previous_idle_minutes: 30 },
        },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a coach is refused and a time off the list is refused: no row and no audit either way', async () => {
    const client = await freshDatabase('tabletidle_refused');
    activeClient = client;
    try {
      await expect(setTabletIdlePolicy({
        organizationId: ORG_ID, actorAccountId: COACH_ID, actorRole: 'coach', idleMinutes: 30,
      })).rejects.toMatchObject({ status: 403 });
      await expect(setTabletIdlePolicy({
        organizationId: ORG_ID, actorAccountId: ADMIN_ID, actorRole: 'organization_admin', idleMinutes: 5,
      })).rejects.toMatchObject({ status: 400 });

      const { rows } = await client.query('select count(*)::int as n from pilot.organization_tablet_idle_policy');
      expect(rows[0].n).toBe(0);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
