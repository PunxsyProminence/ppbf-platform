// Real PostgreSQL contract test for pilot_slice_postgres_milestone_undo_migration.sql (lane L43,
// F-133; OD-2026-10-17-003: "10-minute undo of their own mark; never touches a coach's mark;
// history kept").
//
// What needs a real database to prove: that the column lands on a table that already holds
// awards without touching them; that re-applying is a no-op; that the database itself refuses an
// undone coach award (and a parent's) while admitting the athlete's own, and admits a coach award
// that brings an undone row back; that the file holds nothing destructive and touches no other
// table; and that the runner's readiness refuses a result it did not produce -- a widened or
// unvalidated check of the same name, a column of the wrong shape, a widened key.
// Spins up the disposable local embedded Postgres the other migration suites use. It never
// connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-milestone-undo-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-milestone-undo-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_milestone_undo_migration.sql';

const ORG = 'org-mundo';
const COACH = 'acct-mundo-coach';
const ATHLETE_ACCOUNT = 'acct-mundo-athlete';
const ATHLETE = 'ATH-MUNDO-1';
const SELF_KEY = 'own_wraps';
const COACH_KEY = 'first_full_round';
const CHECK = 'pilot_athlete_milestones_undo_self_only';

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

/** Built once with the whole schema and the fixtures; every test gets its own copy of it. */
const TEMPLATE_DB = 'mundo_template';

async function createDatabase(name: string, template?: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(template ? `create database ${name} template ${template}` : `create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function freshDatabase(name: string): Promise<Client> {
  return createDatabase(name, TEMPLATE_DB);
}

async function buildTemplate(): Promise<void> {
  const client = await createDatabase(TEMPLATE_DB);
  try {
    await seedTemplate(client);
  } finally {
    await client.end();
  }
}

async function seedTemplate(client: Client): Promise<void> {
  // The whole schema in the `all` order, which now includes this migration.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $3, 'microsoft'), ($2, 'athlete', $3, 'microsoft')`,
    [COACH, ATHLETE_ACCOUNT, ORG],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
       emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Milestone Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG, ATHLETE, COACH],
  );
}

/** An award as the application writes one: the athlete's own, or a coach's. */
function award(client: Client, key: string, role: 'self' | 'coach' | 'parent', account: string) {
  return client.query(
    `insert into pilot.athlete_milestones (organization_id, athlete_id, milestone_key, awarded_by_role, awarded_by_account_id)
     values ($1, $2, $3, $4, $5)`,
    [ORG, ATHLETE, key, role, account],
  );
}

function setUndone(client: Client, key: string) {
  return client.query(
    `update pilot.athlete_milestones set undone_at = now()
      where organization_id = $1 and athlete_id = $2 and milestone_key = $3`,
    [ORG, ATHLETE, key],
  );
}

async function awardsOf(client: Client) {
  const rows = await client.query(
    `select milestone_key, awarded_by_role, awarded_by_account_id, note, awarded_at, undone_at
       from pilot.athlete_milestones order by milestone_key`,
  );
  return rows.rows;
}

/** Puts the table back to how it stood before this migration, so the file can be applied to it. */
async function unmigrate(client: Client) {
  await client.query(`alter table pilot.athlete_milestones drop constraint ${CHECK}`);
  await client.query('alter table pilot.athlete_milestones drop column undone_at');
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
  await buildTemplate();
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

describe('milestone undo migration (L43, F-133)', () => {
  test('lands on a table that already holds awards without touching one, and re-applying is a no-op', async () => {
    const client = await freshDatabase('mundo_existing');
    try {
      await unmigrate(client);
      await award(client, SELF_KEY, 'self', ATHLETE_ACCOUNT);
      await award(client, COACH_KEY, 'coach', COACH);
      const before = await client.query(
        `select milestone_key, awarded_by_role, awarded_by_account_id, note, awarded_at
           from pilot.athlete_milestones order by milestone_key`,
      );

      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const after = await awardsOf(client);
      expect(after).toEqual(before.rows.map((row) => ({ ...row, undone_at: null })));
      expect(after).toHaveLength(2);
    } finally {
      await client.end();
    }
  });

  test("the athlete's own award can be stored as undone, and the row stays", async () => {
    const client = await freshDatabase('mundo_self');
    try {
      await award(client, SELF_KEY, 'self', ATHLETE_ACCOUNT);
      await setUndone(client, SELF_KEY);

      const [row] = await awardsOf(client);
      expect(row.milestone_key).toBe(SELF_KEY);
      expect(row.awarded_by_role).toBe('self');
      expect(row.undone_at).toBeInstanceOf(Date);
    } finally {
      await client.end();
    }
  });

  test("a coach's award can never be stored as undone -- nor one written as a parent's", async () => {
    const client = await freshDatabase('mundo_coach');
    try {
      await award(client, COACH_KEY, 'coach', COACH);
      await expect(setUndone(client, COACH_KEY)).rejects.toMatchObject({ code: '23514', constraint: CHECK });

      await award(client, SELF_KEY, 'parent', COACH);
      await expect(setUndone(client, SELF_KEY)).rejects.toMatchObject({ code: '23514', constraint: CHECK });

      // Nor written that way in one go.
      await expect(client.query(
        `insert into pilot.athlete_milestones (organization_id, athlete_id, milestone_key, awarded_by_role, undone_at)
         values ($1, $2, 'helped_new', 'coach', now())`,
        [ORG, ATHLETE],
      )).rejects.toMatchObject({ code: '23514', constraint: CHECK });

      // And a self row that is undone cannot be relabelled a coach's while it stays undone.
      await award(client, 'own_mile', 'self', ATHLETE_ACCOUNT);
      await setUndone(client, 'own_mile');
      await expect(client.query(
        `update pilot.athlete_milestones set awarded_by_role = 'coach'
          where organization_id = $1 and athlete_id = $2 and milestone_key = 'own_mile'`,
        [ORG, ATHLETE],
      )).rejects.toMatchObject({ code: '23514', constraint: CHECK });

      const rows = await awardsOf(client);
      expect(rows.every((row) => row.awarded_by_role === 'self' || row.undone_at === null)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('a coach award (or a later real mark) brings an undone row back in one statement', async () => {
    const client = await freshDatabase('mundo_revive');
    try {
      await award(client, SELF_KEY, 'self', ATHLETE_ACCOUNT);
      await setUndone(client, SELF_KEY);

      // The upsert shape the application uses to revive an undone row.
      await client.query(
        `insert into pilot.athlete_milestones (organization_id, athlete_id, milestone_key, awarded_by_role, awarded_by_account_id)
         values ($1, $2, $3, 'coach', $4)
         on conflict (organization_id, athlete_id, milestone_key) do update
           set awarded_by_role = excluded.awarded_by_role,
               awarded_by_account_id = excluded.awarded_by_account_id,
               awarded_at = now(),
               undone_at = null
         where pilot.athlete_milestones.undone_at is not null`,
        [ORG, ATHLETE, SELF_KEY, COACH],
      );

      const rows = await awardsOf(client);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ milestone_key: SELF_KEY, awarded_by_role: 'coach', awarded_by_account_id: COACH, undone_at: null });
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive and touches no table but athlete_milestones', () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\bupdate\s+pilot\./);
    expect(sql).not.toMatch(/\binsert\s+into\b/);
    expect(sql).not.toMatch(/\bnot\s+valid\b/);
    const tables = [...sql.matchAll(/\bpilot\.(\w+)/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    expect(new Set(tables)).toEqual(new Set(['athlete_milestones']));
  });

  test('the runner refuses a same-named check widened to admit an undone coach award', async () => {
    const client = await freshDatabase('mundo_widened');
    try {
      await client.query(`alter table pilot.athlete_milestones drop constraint ${CHECK}`);
      await client.query(
        `alter table pilot.athlete_milestones add constraint ${CHECK}
           check (undone_at is null or awarded_by_role = 'self' or awarded_by_role = 'coach')`,
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('MILESTONE_UNDO_NOT_READY: undo_self_only_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses the check when it is there but not validated', async () => {
    const client = await freshDatabase('mundo_not_valid');
    try {
      await client.query(`alter table pilot.athlete_milestones drop constraint ${CHECK}`);
      await client.query(
        `alter table pilot.athlete_milestones add constraint ${CHECK}
           check (undone_at is null or awarded_by_role = 'self') not valid`,
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('MILESTONE_UNDO_NOT_READY: undo_self_only_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a column of the wrong shape: a date, or not null', async () => {
    const client = await freshDatabase('mundo_column');
    try {
      await unmigrate(client);
      await client.query('alter table pilot.athlete_milestones add column undone_at date null');
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('MILESTONE_UNDO_NOT_READY: undone_at_ready');

      // The refused run rolled back, so only the hand-made date column is left to take away.
      await client.query('alter table pilot.athlete_milestones drop column undone_at');
      await client.query(`alter table pilot.athlete_milestones add column undone_at timestamptz not null default now()`);
      // On an empty table the check holds over a NOT NULL column; readiness must still refuse it.
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('MILESTONE_UNDO_NOT_READY: undone_at_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a primary key widened to hold more than one row per milestone', async () => {
    const client = await freshDatabase('mundo_key');
    try {
      await client.query('alter table pilot.athlete_milestones drop constraint pilot_athlete_milestones_pkey');
      await client.query(
        `alter table pilot.athlete_milestones add constraint pilot_athlete_milestones_pkey
           primary key (organization_id, athlete_id, milestone_key, awarded_at)`,
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('MILESTONE_UNDO_NOT_READY: one_award_per_milestone');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce, and commits nothing', async () => {
    const client = await freshDatabase('mundo_not_ready');
    try {
      await unmigrate(client);
      await expect(applyRunner(client, 'select 1')).rejects.toThrow(
        'MILESTONE_UNDO_NOT_READY: undone_at_ready, undo_self_only_ready',
      );
      const column = await client.query(
        `select 1 from information_schema.columns
          where table_schema = 'pilot' and table_name = 'athlete_milestones' and column_name = 'undone_at'`,
      );
      expect(column.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
