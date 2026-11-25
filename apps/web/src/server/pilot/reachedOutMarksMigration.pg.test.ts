// Real PostgreSQL-backed test for the athlete-reached-out-marks migration
// (lane W4-6, SC-3a-1; OW27-33 B; Overwatch W4-6 Q4 A: who and when only, one
// current mark per athlete, a take-back keeps the row). The runner is driven
// through its real entrypoint, so its readiness check runs against a real
// Postgres here.
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

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-reached-out-marks-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_reached_out_marks_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-athlete-reached-out-marks-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-reachedout';
const OTHER_ORG_ID = 'org-reachedout-elsewhere';
const COACH_ID = 'acct-reachedout-coach';
const T = 'pilot.athlete_reached_out_marks';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let databaseCount = 0;

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
 * The full schema, two gyms, a coach, and two athletes in the first gym and one
 * in the other. `runRunner: false` leaves the table as the full schema (the
 * workflow's `all` list) built it; `preMigration` drops it.
 */
async function freshDatabase({ preMigration = false, runRunner = true } = {}): Promise<{ client: Client; name: string }> {
  databaseCount += 1;
  const name = `reachedout_${databaseCount}`;
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
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
     values ($1, 'coach', $2, 'microsoft', null, null) on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  for (const [org, athlete] of [[ORG_ID, 'ada'], [ORG_ID, 'ben'], [OTHER_ORG_ID, 'ada']]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1, $2, $2, '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [org, athlete, COACH_ID],
    );
  }
  if (preMigration) {
    await client.query(`drop table if exists ${T} cascade`);
  } else if (runRunner) {
    await applyMigrationTransaction(client, migrationSql);
  }
  return { client, name };
}

async function mark(client: Client, athleteId: string, { org = ORG_ID, role = 'coach' } = {}) {
  await client.query(
    `insert into ${T} (organization_id, athlete_id, marked_by_account_id, marked_by_role) values ($1, $2, $3, $4)`,
    [org, athleteId, COACH_ID, role],
  );
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
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

describe('athlete reached-out marks migration', () => {
  test('the full schema (the workflow\'s `all` list) carries the table on its own, and it passes readiness', async () => {
    const { client } = await freshDatabase({ runRunner: false });
    try {
      const { rows } = await client.query(`select to_regclass('${T}') is not null as present`);
      expect(rows[0].present).toBe(true);
      await expect(applyMigrationTransaction(client, 'select 1')).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('creates the table from nothing, passes readiness, and a re-apply keeps the row', async () => {
    const { client } = await freshDatabase({ preMigration: true });
    try {
      expect((await client.query(`select to_regclass('${T}') as t`)).rows[0].t).toBeNull();
      await applyMigrationTransaction(client, migrationSql);
      expect((await client.query(`select count(*)::int as n from ${T}`)).rows[0].n).toBe(0);
      await mark(client, 'ada');
      await applyMigrationTransaction(client, migrationSql);
      const { rows } = await client.query(`select organization_id, athlete_id, marked_by_role from ${T}`);
      expect(rows).toEqual([{ organization_id: ORG_ID, athlete_id: 'ada', marked_by_role: 'coach' }]);
    } finally {
      await client.end();
    }
  });

  test('a refused readiness check rolls back everything the run did', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(`alter table ${T} add column note text`);
      await expect(applyMigrationTransaction(client, 'create table pilot.zz_reached_out_probe (x integer)'))
        .rejects.toThrow('ATHLETE_REACHED_OUT_MARKS_TABLE_NOT_READY: columns_ready');
      expect((await client.query(`select to_regclass('pilot.zz_reached_out_probe') is null as gone`)).rows[0].gone).toBe(true);
    } finally {
      await client.end();
    }
  });

  // Each piece of the readiness check, refused on its own and named in the error.
  test.each([
    ['columns_ready', 'an extra column (a note)', `alter table ${T} add column note text`],
    ['organization_id_ready', 'organization_id with a default', `alter table ${T} alter column organization_id set default 'org-x'`],
    ['athlete_id_ready', 'athlete_id a varchar', `alter table ${T} alter column athlete_id type varchar(200)`],
    ['marked_by_account_id_ready', 'marked_by_account_id nullable', `alter table ${T} alter column marked_by_account_id drop not null`],
    ['marked_by_role_ready', 'marked_by_role with a default', `alter table ${T} alter column marked_by_role set default 'coach'`],
    ['marked_at_ready', 'marked_at with no default', `alter table ${T} alter column marked_at drop default`],
    ['marked_at_ready', 'marked_at nullable', `alter table ${T} alter column marked_at drop not null`],
    ['cleared_at_ready', 'cleared_at not null', `alter table ${T} alter column cleared_at set default now(), alter column cleared_at set not null`],
    ['cleared_by_account_id_ready', 'cleared_by_account_id with a default', `alter table ${T} alter column cleared_by_account_id set default 'x'`],
    ['checks_ready', 'a role list that is not the answered one',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_role_check,
         add constraint pilot_athlete_reached_out_marks_role_check check (marked_by_role in ('coach', 'organization_admin', 'admin', 'parent'))`],
    ['checks_ready', 'the take-back pair loosened',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_clear_check,
         add constraint pilot_athlete_reached_out_marks_clear_check check (cleared_at is null or cleared_by_account_id is not null)`],
    ['checks_ready', 'a CHECK not validated',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_clear_check,
         add constraint pilot_athlete_reached_out_marks_clear_check check ((cleared_at is null) = (cleared_by_account_id is null)) not valid`],
    ['checks_ready', 'a third CHECK', `alter table ${T} add constraint zz_extra check (marked_by_account_id <> '')`],
    ['primary_key_ready', 'no primary key', `alter table ${T} drop constraint athlete_reached_out_marks_pkey cascade`],
    ['no_other_unique_ready', 'an extra unique constraint', `alter table ${T} add constraint zz_unique unique (organization_id, marked_at)`],
    ['no_other_unique_ready', 'a unique index', `create unique index zz_unique_index on ${T} (marked_by_account_id, athlete_id)`],
    ['foreign_key_count_ready', 'a third foreign key',
      `alter table ${T} add constraint zz_org_again foreign key (organization_id) references pilot.organizations(organization_id)`],
    ['organization_fk_ready', 'the gym foreign key with no action on delete',
      `alter table ${T} drop constraint athlete_reached_out_marks_organization_id_fkey,
         add constraint athlete_reached_out_marks_organization_id_fkey foreign key (organization_id) references pilot.organizations(organization_id)`],
    ['organization_fk_ready', 'the gym foreign key cascading on update',
      `alter table ${T} drop constraint athlete_reached_out_marks_organization_id_fkey,
         add constraint athlete_reached_out_marks_organization_id_fkey foreign key (organization_id)
           references pilot.organizations(organization_id) on delete cascade on update cascade`],
    ['athlete_fk_ready', 'the athlete foreign key with no action on delete',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_athlete_fk,
         add constraint pilot_athlete_reached_out_marks_athlete_fk foreign key (organization_id, athlete_id)
           references pilot.athletes(organization_id, athlete_id)`],
    ['athlete_fk_ready', 'the athlete foreign key deferrable',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_athlete_fk,
         add constraint pilot_athlete_reached_out_marks_athlete_fk foreign key (organization_id, athlete_id)
           references pilot.athletes(organization_id, athlete_id) on delete cascade deferrable`],
  ])('readiness refuses %s: %s', async (piece, _label, alteration) => {
    const { client } = await freshDatabase();
    try {
      await client.query(alteration);
      const refusal = applyMigrationTransaction(client, 'select 1');
      await expect(refusal).rejects.toThrow('ATHLETE_REACHED_OUT_MARKS_TABLE_NOT_READY');
      await expect(refusal).rejects.toThrow(piece);
    } finally {
      await client.end();
    }
  });

  test('only the three staff roles may hold a mark', async () => {
    const { client } = await freshDatabase();
    try {
      for (const role of ['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner', '']) {
        await expect(mark(client, 'ada', { role })).rejects.toMatchObject({ code: '23514' });
      }
      for (const [athlete, role] of [['ada', 'coach'], ['ben', 'organization_admin']]) {
        await mark(client, athlete, { role });
      }
      await client.query(`delete from ${T}`);
      await mark(client, 'ada', { role: 'admin' });
    } finally {
      await client.end();
    }
  });

  test('one current mark per athlete; a take-back names who, and only a take-back does', async () => {
    const { client } = await freshDatabase();
    try {
      await mark(client, 'ada');
      await expect(mark(client, 'ada')).rejects.toMatchObject({ code: '23505' });
      await expect(client.query(`update ${T} set cleared_at = now() where athlete_id = 'ada'`)).rejects.toMatchObject({ code: '23514' });
      await expect(client.query(`update ${T} set cleared_by_account_id = $1 where athlete_id = 'ada'`, [COACH_ID]))
        .rejects.toMatchObject({ code: '23514' });
      await client.query(`update ${T} set cleared_at = now(), cleared_by_account_id = $1 where athlete_id = 'ada'`, [COACH_ID]);
      const { rows } = await client.query(`select athlete_id, cleared_at is not null as cleared from ${T}`);
      expect(rows).toEqual([{ athlete_id: 'ada', cleared: true }]);
    } finally {
      await client.end();
    }
  });

  // (A gym cannot be deleted while it has athletes, pilot.athletes' own foreign key, so a mark,
  // which needs an athlete, goes with its athlete first; the gym cascade is the backstop.)
  test('a mark names a live athlete of its own gym; deleting the athlete takes the mark', async () => {
    const { client } = await freshDatabase();
    try {
      await expect(mark(client, 'nobody')).rejects.toMatchObject({ code: '23503' });
      // The other gym's athlete id, under this gym: refused.
      await expect(mark(client, 'ada', { org: 'org-nowhere' })).rejects.toMatchObject({ code: '23503' });
      await mark(client, 'ada');
      await mark(client, 'ben');
      await mark(client, 'ada', { org: OTHER_ORG_ID });
      await client.query(`delete from pilot.athletes where organization_id = $1 and athlete_id = 'ben'`, [ORG_ID]);
      // The other gym's athlete of the same id goes; this gym's 'ada' and her mark stay.
      await client.query(`delete from pilot.athletes where organization_id = $1 and athlete_id = 'ada'`, [OTHER_ORG_ID]);
      const { rows } = await client.query(`select organization_id, athlete_id from ${T} order by 1, 2`);
      expect(rows).toEqual([{ organization_id: ORG_ID, athlete_id: 'ada' }]);
    } finally {
      await client.end();
    }
  });

  test('the runner gives up after its lock timeout instead of queueing writes behind a busy athletes table', async () => {
    const { client, name } = await freshDatabase({ preMigration: true });
    const holder = new Client({ connectionString: connectionStringFor(name) });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('lock table pilot.athletes in row exclusive mode');
      const started = Date.now();
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
      expect((await client.query(`select to_regclass('${T}') is null as absent`)).rows[0].absent).toBe(true);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
      await client.end();
    }
  });
});
