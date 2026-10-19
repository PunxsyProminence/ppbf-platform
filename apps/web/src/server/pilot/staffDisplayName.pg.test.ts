// Real PostgreSQL contract test for pilot_slice_postgres_staff_display_name_migration.sql
// (coach display names, parent-portal Q1 part B).
//
// What needs a real database to prove: that the column is nullable with no default, so every
// profile written before or without a name reads NULL; that a name is refused blank, all spaces,
// with a leading or trailing space, or over 60 characters, and kept as sent at 1 and at 60; that
// one account carries a different name at each of two gyms; that re-applying the file is a no-op;
// that the file holds nothing destructive; and that the runner's readiness assertion refuses a
// result it did not produce, including a database with no pilot.account_profiles at all. Spins up
// the disposable local embedded Postgres the other migration suites use. It never connects to
// production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-staff-display-name-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-staff-display-name-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_staff_display_name_migration.sql';
const CHECK = 'pilot_account_profiles_staff_display_name_check';

const ORG = 'org-sdn';
const OTHER_ORG = 'org-sdn-other';
const COACH = 'acct-sdn-coach';

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
     values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG],
  );
  return client;
}

/** A profile row with only its key, the way profileDb.ts first writes one, or with a name. */
async function insertProfile(client: Client, org: string, name?: string): Promise<void> {
  if (name === undefined) {
    await client.query('insert into pilot.account_profiles (organization_id, account_id) values ($1, $2)', [org, COACH]);
    return;
  }
  await client.query(
    'insert into pilot.account_profiles (organization_id, account_id, staff_display_name) values ($1, $2, $3)',
    [org, COACH, name],
  );
}

async function storedName(client: Client, org: string): Promise<unknown[]> {
  const rows = await client.query(
    'select staff_display_name from pilot.account_profiles where organization_id = $1 and account_id = $2',
    [org, COACH],
  );
  return rows.rows.map((row) => row.staff_display_name);
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error('expected the write to be refused');
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

describe('staff display name migration (coach display names, Q1 part B)', () => {
  test('a profile without a name reads NULL; a typed name is kept as sent', async () => {
    const client = await freshDatabase('sdn_basic');
    try {
      await insertProfile(client, ORG);
      expect(await storedName(client, ORG)).toEqual([null]);

      await client.query(
        'update pilot.account_profiles set staff_display_name = $3 where organization_id = $1 and account_id = $2',
        [ORG, COACH, "Mike O'Neill"],
      );
      expect(await storedName(client, ORG)).toEqual(["Mike O'Neill"]);
    } finally {
      await client.end();
    }
  });

  test('one account carries a different name at each gym', async () => {
    const client = await freshDatabase('sdn_two_gyms');
    try {
      await insertProfile(client, ORG, 'Mike Neale');
      await insertProfile(client, OTHER_ORG, 'Coach Mike');
      expect(await storedName(client, ORG)).toEqual(['Mike Neale']);
      expect(await storedName(client, OTHER_ORG)).toEqual(['Coach Mike']);
    } finally {
      await client.end();
    }
  });

  test('a name is refused blank, all spaces, padded, or over 60 characters; 1 and 60 are kept', async () => {
    const client = await freshDatabase('sdn_limits');
    try {
      for (const bad of ['', '   ', ' Mike', 'Mike ', 'm'.repeat(61)]) {
        const refused = await refusal(insertProfile(client, ORG, bad));
        expect(refused.code).toBe('23514');
        expect(refused.constraint).toBe(CHECK);
      }
      await insertProfile(client, ORG, 'M');
      expect(await storedName(client, ORG)).toEqual(['M']);
      const longest = `${'m'.repeat(29)} ${'n'.repeat(30)}`;
      expect(longest).toHaveLength(60);
      await insertProfile(client, OTHER_ORG, longest);
      expect(await storedName(client, OTHER_ORG)).toEqual([longest]);
    } finally {
      await client.end();
    }
  });

  test('a profile written before the migration keeps a NULL name', async () => {
    const client = await freshDatabase('sdn_before');
    try {
      // The schema as it stood before this file: the column (and with it the check) is not there.
      await client.query('alter table pilot.account_profiles drop column staff_display_name');
      await insertProfile(client, ORG);

      await applyRunner(client, migrationSql);

      expect(await storedName(client, ORG)).toEqual([null]);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive, sets no default, and adds its check only when the table has none of that name', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\bupdate\s+pilot\./);
    expect(sql).not.toMatch(/\bdefault\b/);
    // A re-run (the `all` chain) must not re-validate the check.
    expect(sql).toMatch(new RegExp(`if not exists \\(\\s*select 1 from pg_constraint\\s+where conname = '${CHECK}'`));
  });

  test('a re-run leaves the check and the names as they are; the runner refuses a same-named check with a wider rule', async () => {
    const client = await freshDatabase('sdn_check_wide');
    try {
      await insertProfile(client, ORG, 'Mike Neale');
      const checkOid = () => client.query(
        `select oid from pg_constraint where conname = $1 and conrelid = to_regclass('pilot.account_profiles')`,
        [CHECK],
      );
      const before = await checkOid();
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);
      expect((await checkOid()).rows).toEqual(before.rows);
      expect(await storedName(client, ORG)).toEqual(['Mike Neale']);

      await client.query(`alter table pilot.account_profiles drop constraint ${CHECK}`);
      await client.query(
        `alter table pilot.account_profiles add constraint ${CHECK} check (staff_display_name is null or char_length(staff_display_name) <= 200)`,
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('STAFF_DISPLAY_NAME_NOT_READY: check_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result without the check', async () => {
    const client = await freshDatabase('sdn_check_missing');
    try {
      await expect(
        applyRunner(client, `alter table pilot.account_profiles drop constraint ${CHECK}`),
      ).rejects.toThrow('STAFF_DISPLAY_NAME_NOT_READY: check_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a pre-existing staff_display_name column that is NOT NULL', async () => {
    const client = await freshDatabase('sdn_column_not_null');
    try {
      await client.query('alter table pilot.account_profiles drop column staff_display_name');
      await client.query(`alter table pilot.account_profiles add column staff_display_name text not null default 'Coach'`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('STAFF_DISPLAY_NAME_NOT_READY: column_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a pre-existing staff_display_name column with a default', async () => {
    const client = await freshDatabase('sdn_column_default');
    try {
      await client.query('alter table pilot.account_profiles drop column staff_display_name');
      await client.query(`alter table pilot.account_profiles add column staff_display_name text default 'Coach'`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('STAFF_DISPLAY_NAME_NOT_READY: column_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a database without pilot.account_profiles, by name, before running the file', async () => {
    // An empty database: the profile-identity migration has not run there.
    const client = await freshDatabase('sdn_no_table', 'none');
    try {
      await expect(applyRunner(client, migrationSql)).rejects.toThrow(
        'STAFF_DISPLAY_NAME_NOT_READY: table_ready (pilot.account_profiles is missing; apply profile-identity first)',
      );
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    const client = await freshDatabase('sdn_not_ready');
    try {
      await client.query('alter table pilot.account_profiles drop column staff_display_name');
      // "Applying" a statement that creates nothing must not commit.
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('STAFF_DISPLAY_NAME_NOT_READY: column_ready, check_ready');
    } finally {
      await client.end();
    }
  });
});
