// Real PostgreSQL contract test for pilot_slice_postgres_family_support_records_migration.sql
// (PH-12, issue #1593: support the gym actually provided to a child's family).
//
// What needs a real database to prove: that a record says only what happened (no future date,
// gym time); that only an admin seat records it and is named; that it binds to its own gym's
// athlete; that it is never edited and the one change by hand is retiring it, once; that it is
// never deleted by hand, stays when its recorder's account goes, and goes with its athlete; that
// re-applying is a no-op; that the file holds nothing destructive; and that the runner's readiness
// refuses a result it did not produce. Spins up the disposable local embedded Postgres the other
// migration suites use. It never connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-support-records-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-family-support-records-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_family_support_records_migration.sql';

const ORG = 'org-sup';
const OTHER_ORG = 'org-sup-other';
const COACH = 'acct-sup-coach';
const ADMIN = 'acct-sup-admin';
const OTHER_ADMIN = 'acct-sup-admin-b';
const ATHLETE = 'ATH-SUP-1';
const OTHER_ATHLETE = 'ATH-SUP-2';
const OTHER_ONLY = 'ATH-SUP-X';

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyRunner: Apply;
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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  if (schema === 'none') return client;

  // The whole schema in the `all` order, which now includes this migration.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $4, 'microsoft'), ($2, 'organization_admin', $4, 'microsoft'), ($3, 'admin', $4, 'microsoft')`,
    [COACH, ADMIN, OTHER_ADMIN, ORG],
  );
  for (const [org, athleteId] of [[ORG, ATHLETE], [ORG, OTHER_ATHLETE], [OTHER_ORG, OTHER_ONLY]] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Support Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, COACH],
    );
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
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

function record(
  client: Client,
  values: { org?: string; athleteId?: string; kind?: string; providedOn?: string; recorder?: string | null; role?: string } = {},
) {
  return client.query(
    `insert into pilot.family_support_records (organization_id, athlete_id, support_kind, provided_on, recorded_by_account_id, recorded_by_role)
     values ($1, $2, $3, $4::date, $5, $6)
     returning record_id::text as record_id`,
    [
      values.org ?? ORG,
      values.athleteId ?? ATHLETE,
      values.kind ?? 'Transportation to the October 12 tournament',
      values.providedOn ?? '2026-10-12',
      values.recorder === undefined ? ADMIN : values.recorder,
      values.role ?? 'organization_admin',
    ],
  );
}

describe('family support records migration (PH-12)', () => {
  test('a record is stored and read back, and re-applying through the runner is a no-op', async () => {
    const client = await freshDatabase('fsup_store');
    try {
      await record(client);
      await record(client, { kind: 'Gloves and wraps', providedOn: '2026-09-30', recorder: OTHER_ADMIN, role: 'admin' });
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const rows = await client.query(
        `select athlete_id, support_kind, to_char(provided_on, 'YYYY-MM-DD') as provided_on, recorded_by_account_id, recorded_by_role, retired_at
           from pilot.family_support_records order by provided_on desc`,
      );
      expect(rows.rows).toEqual([
        { athlete_id: ATHLETE, support_kind: 'Transportation to the October 12 tournament', provided_on: '2026-10-12', recorded_by_account_id: ADMIN, recorded_by_role: 'organization_admin', retired_at: null },
        { athlete_id: ATHLETE, support_kind: 'Gloves and wraps', provided_on: '2026-09-30', recorded_by_account_id: OTHER_ADMIN, recorded_by_role: 'admin', retired_at: null },
      ]);
    } finally {
      await client.end();
    }
  });

  test('only what happened: a date after today (gym time) is refused, today is not', async () => {
    const client = await freshDatabase('fsup_future');
    try {
      const today = await client.query(`select to_char((now() at time zone 'America/New_York')::date, 'YYYY-MM-DD') as d`);
      const tomorrow = await client.query(`select to_char((now() at time zone 'America/New_York')::date + 1, 'YYYY-MM-DD') as d`);
      await record(client, { providedOn: today.rows[0].d });
      await expect(record(client, { providedOn: tomorrow.rows[0].d })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_support_records_provided_past',
      });
    } finally {
      await client.end();
    }
  });

  test('a blank or overlong kind, a recorder who is not an admin, no recorder, and another gym’s athlete are refused', async () => {
    const client = await freshDatabase('fsup_checks');
    try {
      await expect(record(client, { kind: '  ' })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_support_records_kind_check' });
      await expect(record(client, { kind: 'x'.repeat(201) })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_support_records_kind_check' });
      for (const role of ['coach', 'parent', 'athlete', 'board']) {
        await expect(record(client, { role })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_support_records_role_check' });
      }
      await expect(record(client, { recorder: null })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_support_records_recorder_named' });
      await expect(record(client, { athleteId: OTHER_ONLY })).rejects.toMatchObject({ code: '23503', constraint: 'pilot_family_support_records_athlete_fk' });
      // A record is born live: it cannot arrive already retired.
      await expect(client.query(
        `insert into pilot.family_support_records
           (organization_id, athlete_id, support_kind, provided_on, recorded_by_account_id, recorded_by_role, retired_at, retired_by_account_id)
         values ($1, $2, 'x', '2026-10-01', $3, 'organization_admin', now(), $3)`,
        [ORG, ATHLETE, ADMIN],
      )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_support_records_born_live' });
      // The recorded time is the database's, not one sent in.
      const { rows: [{ record_id: stamped }] } = await client.query(
        `insert into pilot.family_support_records
           (organization_id, athlete_id, support_kind, provided_on, recorded_by_account_id, recorded_by_role, created_at)
         values ($1, $2, 'Stamped', '2026-10-01', $3, 'organization_admin', '2020-01-01')
         returning record_id::text as record_id`,
        [ORG, ATHLETE, ADMIN],
      );
      const createdAt = await client.query(
        `select created_at > now() - interval '1 minute' as now_stamped from pilot.family_support_records where record_id = $1::uuid`,
        [stamped],
      );
      expect(createdAt.rows).toEqual([{ now_stamped: true }]);
      const count = await client.query(`select count(*)::int as n from pilot.family_support_records where support_kind <> 'Stamped'`);
      expect(count.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a record is never edited: the one change is retiring it, once', async () => {
    const client = await freshDatabase('fsup_retire');
    try {
      const { rows: [{ record_id: id }] } = await record(client);
      for (const change of [
        `support_kind = 'Something else'`,
        `provided_on = '2026-01-01'`,
        `athlete_id = '${OTHER_ATHLETE}'`,
        `recorded_by_account_id = '${OTHER_ADMIN}'`,
        `recorded_by_role = 'admin'`,
        `retired_at = now(), retired_by_account_id = '${ADMIN}', support_kind = 'Changed while retiring'`,
        `retired_at = now()`,
        `retired_at = null`,
      ]) {
        await expect(client.query(`update pilot.family_support_records set ${change} where record_id = $1::uuid`, [id])).rejects.toMatchObject({
          code: '23514', constraint: 'pilot_family_support_records_only_retired',
        });
      }
      // Retired by a named admin, naming only who; the guard stamps the time.
      await client.query(
        `update pilot.family_support_records set retired_by_account_id = $2 where record_id = $1::uuid`,
        [id, ADMIN],
      );
      const retired = await client.query(
        `select retired_by_account_id, retired_at > now() - interval '1 minute' as now_stamped from pilot.family_support_records`,
      );
      expect(retired.rows).toEqual([{ retired_by_account_id: ADMIN, now_stamped: true }]);
      for (const change of ['retired_at = null', 'retired_at = now()', `retired_by_account_id = '${OTHER_ADMIN}'`]) {
        await expect(client.query(`update pilot.family_support_records set ${change} where record_id = $1::uuid`, [id])).rejects.toMatchObject({
          code: '23514', constraint: 'pilot_family_support_records_only_retired',
        });
      }
      const row = await client.query('select support_kind, retired_at is not null as retired from pilot.family_support_records');
      expect(row.rows).toEqual([{ support_kind: 'Transportation to the October 12 tournament', retired: true }]);
    } finally {
      await client.end();
    }
  });

  test('a record is not deleted by hand; it stays when its recorder account goes, and goes with its athlete', async () => {
    const client = await freshDatabase('fsup_cascade');
    try {
      const { rows: [{ record_id: id }] } = await record(client, { recorder: OTHER_ADMIN, role: 'admin' });
      await client.query(
        'update pilot.family_support_records set retired_at = now(), retired_by_account_id = $2 where record_id = $1::uuid',
        [id, OTHER_ADMIN],
      );
      await expect(client.query('delete from pilot.family_support_records')).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_support_records_no_delete',
      });
      await client.query('delete from pilot.accounts where account_id = $1', [OTHER_ADMIN]);
      const kept = await client.query(
        'select recorded_by_account_id, recorded_by_role, retired_by_account_id, retired_at is not null as retired from pilot.family_support_records',
      );
      expect(kept.rows).toEqual([{ recorded_by_account_id: null, recorded_by_role: 'admin', retired_by_account_id: null, retired: true }]);

      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE]);
      const left = await client.query('select count(*)::int as n from pilot.family_support_records');
      expect(left.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|schema|function)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\balter\s+table\b/);
  });

  test('the runner refuses a disabled guard, a weak same-named check and a wrong same-named index', async () => {
    const client = await freshDatabase('fsup_shape');
    try {
      await expect(
        applyRunner(client, 'alter table pilot.family_support_records disable trigger trg_family_support_records_guard'),
      ).rejects.toThrow('FAMILY_SUPPORT_RECORDS_NOT_READY: guard_ready');

      await client.query('alter table pilot.family_support_records drop constraint pilot_family_support_records_role_check');
      await client.query(`alter table pilot.family_support_records add constraint pilot_family_support_records_role_check
        check (recorded_by_role in ('organization_admin', 'admin', 'coach'))`);
      await client.query('drop index pilot.idx_family_support_records_athlete');
      await client.query('create index idx_family_support_records_athlete on pilot.family_support_records(athlete_id)');
      await expect(applyRunner(client, migrationSql)).rejects.toThrow(
        'FAMILY_SUPPORT_RECORDS_NOT_READY: checks_ready, athlete_index_ready',
      );
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    const client = await freshDatabase('fsup_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('FAMILY_SUPPORT_RECORDS_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
