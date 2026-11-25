// Real PostgreSQL-backed test for the organization-stopped-coming-policy
// migration (lane W4-6, SC-0a; OW27-30 A: the gym admin sets how many days
// without a present mark put an athlete on the "who has stopped coming" list,
// first value 2 weeks; Overwatch's W4-6 Q1 A: 7, 14, 21, 28, 42 or 56 days).
// The runner is driven through its real entrypoint, so its readiness check
// runs against a real Postgres here.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-stopped-coming-policy-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_organization_stopped_coming_policy_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-organization-stopped-coming-policy-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-stoppedcoming';
const OTHER_ORG_ID = 'org-stoppedcoming-elsewhere';
const ADMIN_ID = 'acct-stoppedcoming-admin';

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

/**
 * The full schema, two gyms and a gym admin in the first. `runRunner: false`
 * leaves the table exactly as the full schema (the workflow's `all` list)
 * built it, so a test can see what that list alone produces.
 */
async function freshDatabase(name: string, { preMigration = false, runRunner = true } = {}): Promise<Client> {
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
     values ($1, 'organization_admin', $2, 'microsoft', null, null)
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.organization_stopped_coming_policy cascade');
  } else if (runRunner) {
    // Idempotent: a no-op once the workflow's `all` list carries it.
    await applyMigrationTransaction(client, migrationSql);
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

  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
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

describe('organization stopped-coming policy migration', () => {
  test('the full schema (the workflow\'s `all` list) carries the table on its own, and it passes readiness', async () => {
    const client = await freshDatabase('stoppedcoming_all', { runRunner: false });
    try {
      const { rows } = await client.query(`select to_regclass('pilot.organization_stopped_coming_policy') is not null as present`);
      expect(rows[0].present).toBe(true);
      await expect(applyMigrationTransaction(client, 'select 1')).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('creates the table from nothing, passes the runner readiness check, and a re-apply keeps the row', async () => {
    const client = await freshDatabase('stoppedcoming_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.organization_stopped_coming_policy') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      // No row is written by the migration: every gym starts at the default.
      expect((await client.query('select count(*)::int as n from pilot.organization_stopped_coming_policy')).rows[0].n).toBe(0);
      await client.query(
        `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days, set_by_account_id)
         values ($1, 21, $2)`,
        [ORG_ID, ADMIN_ID],
      );
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query('select organization_id, gap_days from pilot.organization_stopped_coming_policy');
      expect(rows).toEqual([{ organization_id: ORG_ID, gap_days: 21 }]);
    } finally {
      await client.end();
    }
  });

  test('a refused readiness check rolls back everything the run did', async () => {
    const client = await freshDatabase('stoppedcoming_rollback');
    try {
      await client.query(
        `alter table pilot.organization_stopped_coming_policy
           drop constraint pilot_org_stopped_coming_gap_days_check,
           add constraint pilot_org_stopped_coming_gap_days_check check (gap_days in (1, 7, 14, 21, 28, 42, 56))`,
      );
      await expect(applyMigrationTransaction(client, 'create table pilot.zz_stopped_coming_probe (x integer)'))
        .rejects.toThrow('ORGANIZATION_STOPPED_COMING_POLICY_TABLE_NOT_READY: check_ready');
      const { rows } = await client.query(`select to_regclass('pilot.zz_stopped_coming_probe') is null as gone`);
      expect(rows[0].gone).toBe(true);
    } finally {
      await client.end();
    }
  });

  // Each piece of the readiness check, refused on its own and named in the error.
  const T = 'pilot.organization_stopped_coming_policy';
  test.each([
    ['check_ready', 'a CHECK whose list is not the answered one',
      `alter table ${T} drop constraint pilot_org_stopped_coming_gap_days_check,
         add constraint pilot_org_stopped_coming_gap_days_check check (gap_days in (1, 7, 14, 21, 28, 42, 56))`],
    ['check_ready', 'the CHECK not validated',
      `alter table ${T} drop constraint pilot_org_stopped_coming_gap_days_check,
         add constraint pilot_org_stopped_coming_gap_days_check check (gap_days in (7, 14, 21, 28, 42, 56)) not valid`],
    ['check_ready', 'a second CHECK', `alter table ${T} add constraint zz_extra_check check (gap_days <> 14)`],
    ['columns_ready', 'an extra column', `alter table ${T} add column note text`],
    ['gap_days_ready', 'gap_days nullable', `alter table ${T} alter column gap_days drop not null`],
    ['gap_days_ready', 'gap_days a bigint', `alter table ${T} alter column gap_days type bigint`],
    ['gap_days_ready', 'gap_days with a default', `alter table ${T} alter column gap_days set default 14`],
    ['set_at_ready', 'set_at nullable', `alter table ${T} alter column set_at drop not null`],
    ['set_at_ready', 'set_at with no default', `alter table ${T} alter column set_at drop default`],
    ['set_at_ready', 'set_at as text', `alter table ${T} alter column set_at type text using set_at::text`],
    ['set_by_account_id_ready', 'set_by_account_id not null', `alter table ${T} alter column set_by_account_id set not null`],
    ['primary_key_ready', 'no primary key',
      `alter table ${T} drop constraint organization_stopped_coming_policy_pkey cascade`],
    ['no_other_unique_ready', 'an extra unique constraint', `alter table ${T} add constraint zz_unique_gap unique (gap_days)`],
    ['no_other_unique_ready', 'a unique index', `create unique index zz_unique_gap_index on ${T} (gap_days)`],
    ['organization_id_ready', 'organization_id with a default', `alter table ${T} alter column organization_id set default 'org-x'`],
    ['set_by_account_id_ready', 'set_by_account_id a varchar', `alter table ${T} alter column set_by_account_id type varchar(200)`],
    ['foreign_key_count_ready', 'a third foreign key',
      `alter table ${T} add constraint zz_org_again foreign key (organization_id)
         references pilot.organizations(organization_id) on delete restrict`],
    ['organization_fk_ready', 'the gym foreign key cascading on update',
      `alter table ${T} drop constraint organization_stopped_coming_policy_organization_id_fkey,
         add constraint organization_stopped_coming_policy_organization_id_fkey foreign key (organization_id)
           references pilot.organizations(organization_id) on delete cascade on update cascade`],
    ['organization_fk_ready', 'the gym foreign key deferrable',
      `alter table ${T} drop constraint organization_stopped_coming_policy_organization_id_fkey,
         add constraint organization_stopped_coming_policy_organization_id_fkey foreign key (organization_id)
           references pilot.organizations(organization_id) on delete cascade deferrable`],
    ['set_by_fk_ready', 'the setter foreign key cascading on update',
      `alter table ${T} drop constraint organization_stopped_coming_policy_set_by_account_id_fkey,
         add constraint organization_stopped_coming_policy_set_by_account_id_fkey foreign key (set_by_account_id)
           references pilot.accounts(account_id) on delete set null on update cascade`],
    ['organization_fk_ready', 'the gym foreign key with no action on delete',
      `alter table ${T} drop constraint organization_stopped_coming_policy_organization_id_fkey,
         add constraint organization_stopped_coming_policy_organization_id_fkey foreign key (organization_id)
           references pilot.organizations(organization_id)`],
    ['set_by_fk_ready', 'the setter foreign key cascading on delete',
      `alter table ${T} drop constraint organization_stopped_coming_policy_set_by_account_id_fkey,
         add constraint organization_stopped_coming_policy_set_by_account_id_fkey foreign key (set_by_account_id)
           references pilot.accounts(account_id) on delete cascade`],
    ['set_by_fk_ready', 'the setter foreign key deferrable',
      `alter table ${T} drop constraint organization_stopped_coming_policy_set_by_account_id_fkey,
         add constraint organization_stopped_coming_policy_set_by_account_id_fkey foreign key (set_by_account_id)
           references pilot.accounts(account_id) on delete set null deferrable`],
  ])('readiness refuses %s: %s', async (piece, _label, alteration) => {
    const client = await freshDatabase(`stoppedcoming_r${Math.random().toString(36).slice(2, 10)}`);
    try {
      await client.query(alteration);
      const refusal = applyMigrationTransaction(client, 'select 1');
      await expect(refusal).rejects.toThrow('ORGANIZATION_STOPPED_COMING_POLICY_TABLE_NOT_READY');
      await expect(refusal).rejects.toThrow(piece);
    } finally {
      await client.end();
    }
  });

  test('the database refuses any number off the list, and takes each one on it', async () => {
    const client = await freshDatabase('stoppedcoming_check');
    try {
      for (const days of [0, 1, 6, 30, 57, 90, -14]) {
        await expect(client.query(
          `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days, set_by_account_id)
           values ($1, $2, $3)`,
          [ORG_ID, days, ADMIN_ID],
        )).rejects.toMatchObject({ code: '23514' });
      }
      await expect(client.query(
        `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days, set_by_account_id)
         values ($1, null, $2)`,
        [ORG_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23502' });
      for (const days of [7, 14, 21, 28, 42, 56]) {
        await client.query(
          `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days, set_by_account_id)
           values ($1, $2, $3)
           on conflict (organization_id) do update set gap_days = excluded.gap_days`,
          [ORG_ID, days, ADMIN_ID],
        );
      }
      const { rows } = await client.query('select gap_days from pilot.organization_stopped_coming_policy');
      expect(rows).toEqual([{ gap_days: 56 }]);
    } finally {
      await client.end();
    }
  });

  test('one row per gym; a gym that does not exist is refused; a removed admin leaves the setting with no setter; a removed gym takes its row', async () => {
    const client = await freshDatabase('stoppedcoming_keys');
    try {
      await client.query(
        `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days, set_by_account_id) values ($1, 14, $2)`,
        [ORG_ID, ADMIN_ID],
      );
      await expect(client.query(
        `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days, set_by_account_id) values ($1, 21, $2)`,
        [ORG_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23505' });
      await expect(client.query(
        `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days) values ('org-nowhere', 14)`,
      )).rejects.toMatchObject({ code: '23503' });

      await client.query('delete from pilot.accounts where account_id = $1', [ADMIN_ID]);
      const { rows } = await client.query('select organization_id, gap_days, set_by_account_id from pilot.organization_stopped_coming_policy');
      expect(rows).toEqual([{ organization_id: ORG_ID, gap_days: 14, set_by_account_id: null }]);

      await client.query(`insert into pilot.organization_stopped_coming_policy (organization_id, gap_days) values ($1, 28)`, [OTHER_ORG_ID]);
      await client.query('delete from pilot.organizations where organization_id = $1', [OTHER_ORG_ID]);
      const after = await client.query('select organization_id from pilot.organization_stopped_coming_policy order by 1');
      expect(after.rows).toEqual([{ organization_id: ORG_ID }]);
    } finally {
      await client.end();
    }
  });

  test('the runner gives up after its lock timeout instead of queueing writes behind a busy accounts table', async () => {
    const client = await freshDatabase('stoppedcoming_lock', { preMigration: true });
    const holder = new Client({ connectionString: connectionStringFor('stoppedcoming_lock') });
    await holder.connect();
    try {
      // A write in progress on pilot.accounts: the table's foreign key would wait for it.
      await holder.query('BEGIN');
      await holder.query('lock table pilot.accounts in row exclusive mode');
      const started = Date.now();
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
      const { rows } = await client.query(`select to_regclass('pilot.organization_stopped_coming_policy') is null as absent`);
      expect(rows[0].absent).toBe(true);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
      await client.end();
    }
  });
});
