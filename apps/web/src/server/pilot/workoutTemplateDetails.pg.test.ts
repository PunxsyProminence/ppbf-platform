// Workout template details (lane YR, YR-a; Overwatch step-1 ruling Q3 A): the
// workout_template_details migration adds `details jsonb not null default '{}'`,
// checked to be a JSON object, to pilot.workout_templates and
// pilot.workout_template_items. It applies in `all` order and re-applies as a
// no-op; rows that existed before it keep every value and read '{}'; the
// object checks refuse anything but an object; readiness refuses an environment
// missing any piece it asserts; the migration refuses a database without the
// two tables.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'workout_template_details';
const EMPTY_DATABASE = 'workout_template_details_empty';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-workout-template-details-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.join(WEB_DIR, 'scripts/pilot-apply-workout-template-details-migration.mjs');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_workout_template_details_migration.sql');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let applyMigrationTransaction: (c: Client, sql: string) => Promise<void>;
let fullOrder: string[];

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

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });
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
  serverProcess.stdout.resume();

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (c: Client, opts?: { infraDir?: string }) => Promise<{ order: string[] }>;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE}`);
  await admin.query(`create database ${DATABASE}`);
  await admin.query(`drop database if exists ${EMPTY_DATABASE}`);
  await admin.query(`create database ${EMPTY_DATABASE}`);
  await admin.end();
  client = new Client({ connectionString: connectionStringFor(DATABASE) });
  await client.connect();
  fullOrder = (await applyFullSchema(client, { infraDir: INFRA_DIR })).order;
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runner.applyMigrationTransaction as (c: Client, sql: string) => Promise<void>;
});

afterAll(async () => {
  await client?.end().catch(() => {});
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

const migrationSql = () => fs.readFile(MIGRATION_PATH, 'utf8');

const GYM = 'gym_template_details';
const TEMPLATE_ID = 'wtp_00000000000a01';
const ITEM_ID = 'wti_00000000000a01';

async function createGym(organizationId: string): Promise<void> {
  await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [organizationId]);
}

async function insertTemplate(organizationId: string, templateId: string, details?: string): Promise<void> {
  await client.query(
    `insert into pilot.workout_templates (organization_id, template_id, lineage_id, name, session_type, difficulty, duration_minutes, intent${details === undefined ? '' : ', details'})
     values ($1, $2, $2, $3, 'technical', 'beginner', 60, 'An existing template'${details === undefined ? '' : ', $4::jsonb'})`,
    details === undefined ? [organizationId, templateId, `Template ${templateId}`] : [organizationId, templateId, `Template ${templateId}`, details],
  );
}

async function insertItem(organizationId: string, templateId: string, itemId: string, ordinal: number, details?: string): Promise<void> {
  await client.query(
    `insert into pilot.workout_template_items (organization_id, item_id, template_id, ordinal, block, free_text_drill, duration_minutes, contact_level${details === undefined ? '' : ', details'})
     values ($1, $2, $3, $4, 'warmup', 'Jump rope', 5, 'none'${details === undefined ? '' : ', $5::jsonb'})`,
    details === undefined ? [organizationId, itemId, templateId, ordinal] : [organizationId, itemId, templateId, ordinal, details],
  );
}

async function snapshot(organizationId: string) {
  const templates = await client.query(
    `select * from pilot.workout_templates where organization_id = $1 order by template_id`,
    [organizationId],
  );
  const items = await client.query(
    `select * from pilot.workout_template_items where organization_id = $1 order by item_id`,
    [organizationId],
  );
  return { templates: templates.rows, items: items.rows };
}

const without = <T extends Record<string, unknown>>(row: T, key: string) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));

describe('the workout_template_details migration', () => {
  it('runs in `all` order after workout-templates-v2, and its runner re-applies it as a no-op', async () => {
    const at = (file: string) => fullOrder.findIndex((entry) => path.basename(entry) === file);
    expect(at('pilot_slice_postgres_workout_template_details_migration.sql')).toBeGreaterThan(
      at('pilot_slice_postgres_workout_templates_v2_migration.sql'),
    );
    const constraintsBefore = await client.query(
      `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid in ('pilot.workout_templates'::regclass, 'pilot.workout_template_items'::regclass) order by 1, 2`,
    );
    const sql = await migrationSql();
    await applyMigrationTransaction(client, sql);
    await applyMigrationTransaction(client, sql);
    const constraintsAfter = await client.query(
      `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid in ('pilot.workout_templates'::regclass, 'pilot.workout_template_items'::regclass) order by 1, 2`,
    );
    expect(constraintsAfter.rows).toEqual(constraintsBefore.rows);

    const columns = await client.query(
      `select table_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'pilot' and table_name in ('workout_templates', 'workout_template_items') and column_name = 'details'
        order by table_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: 'workout_template_items', data_type: 'jsonb', is_nullable: 'NO', column_default: "'{}'::jsonb" },
      { table_name: 'workout_templates', data_type: 'jsonb', is_nullable: 'NO', column_default: "'{}'::jsonb" },
    ]);
    // Postgres 18 lists NOT NULL in pg_constraint too; the object checks are the CHECK ones.
    const checks = constraintsAfter.rows.filter((row) => /^CHECK .*details/.test(row.def));
    expect(checks).toEqual([
      { rel: 'pilot.workout_template_items', conname: 'pilot_wti_details_check', def: "CHECK ((jsonb_typeof(details) = 'object'::text))" },
      { rel: 'pilot.workout_templates', conname: 'pilot_workout_templates_details_check', def: "CHECK ((jsonb_typeof(details) = 'object'::text))" },
    ]);
  });

  it('leaves every existing row as it was: each value kept, details {}', async () => {
    await createGym(GYM);
    // Back to the schema before this migration, inside a transaction, with rows written then.
    await client.query('BEGIN');
    try {
      await client.query('alter table pilot.workout_template_items drop column details');
      await client.query('alter table pilot.workout_templates drop column details');
      await insertTemplate(GYM, TEMPLATE_ID);
      await insertItem(GYM, TEMPLATE_ID, ITEM_ID, 1);
      const before = await snapshot(GYM);
      expect(before.templates).toHaveLength(1);
      expect(before.items).toHaveLength(1);

      const sql = await migrationSql();
      // The migration SQL has no BEGIN/COMMIT of its own, so it runs inside this transaction and
      // migrates exactly the rows written above; twice, to show a re-run changes nothing.
      await client.query(sql);
      await client.query(sql);
      const after = await snapshot(GYM);
      expect(after.templates.map((row) => without(row, 'details'))).toEqual(before.templates);
      expect(after.items.map((row) => without(row, 'details'))).toEqual(before.items);
      expect(after.templates.map((row) => row.details)).toEqual([{}]);
      expect(after.items.map((row) => row.details)).toEqual([{}]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    await applyMigrationTransaction(client, await migrationSql());
  });

  it('stores an object as written and refuses anything else, on both tables', async () => {
    const gym = 'gym_template_details_checks';
    await createGym(gym);
    const object = '{"contact_structure": "split_non_contact_then_contact", "owner_passages": [{"doc": "DOC-027"}]}';
    await insertTemplate(gym, 'wtp_00000000000b01', object);
    await insertItem(gym, 'wtp_00000000000b01', 'wti_00000000000b01', 1, '{"phase": "Main set", "time": "20–24 min"}');
    const stored = await snapshot(gym);
    expect(stored.templates[0].details).toEqual(JSON.parse(object));
    expect(stored.items[0].details).toEqual({ phase: 'Main set', time: '20–24 min' });

    // JSON null is a jsonb value, not SQL NULL: the object check refuses it like the rest.
    for (const [index, bad] of ['[]', '"text"', '3', 'null'].entries()) {
      await expect(insertTemplate(gym, `wtp_00000000000c0${index}`, bad)).rejects.toMatchObject({ code: '23514' });
      await expect(insertItem(gym, 'wtp_00000000000b01', `wti_00000000000c0${index}`, 2, bad)).rejects.toMatchObject({ code: '23514' });
    }
    // SQL NULL is refused by NOT NULL.
    await expect(client.query(
      `update pilot.workout_templates set details = null where organization_id = $1`,
      [gym],
    )).rejects.toMatchObject({ code: '23502' });
    await expect(insertTemplate(gym, 'wtp_00000000000d01', '[1]')).rejects.toMatchObject({ constraint: 'pilot_workout_templates_details_check' });
    await expect(insertItem(gym, 'wtp_00000000000b01', 'wti_00000000000d01', 3, '[1]')).rejects.toMatchObject({ constraint: 'pilot_wti_details_check' });
  });

  it('refuses a database without the two template tables', async () => {
    const empty = new Client({ connectionString: connectionStringFor(EMPTY_DATABASE) });
    await empty.connect();
    try {
      await empty.query('create schema if not exists pilot');
      await expect(empty.query(await migrationSql())).rejects.toThrow('WORKOUT_TEMPLATE_DETAILS_NOT_READY');
    } finally {
      await empty.end();
    }
  });
});

describe('readiness: every clause it asserts is one a broken environment fails', () => {
  const breakages: [string, string][] = [
    ['the template object check', 'alter table pilot.workout_templates drop constraint pilot_workout_templates_details_check'],
    ['the item object check', 'alter table pilot.workout_template_items drop constraint pilot_wti_details_check'],
    ['the template column default', "alter table pilot.workout_templates alter column details set default '{\"a\": 1}'::jsonb"],
    ['the item column NOT NULL', 'alter table pilot.workout_template_items alter column details drop not null'],
    [
      'the template column type',
      `alter table pilot.workout_templates drop constraint pilot_workout_templates_details_check,
         alter column details drop default, alter column details type text using details::text,
         add constraint pilot_workout_templates_details_check check (details is not null)`,
    ],
  ];

  it.each(breakages)('%s', async (_what, breakage) => {
    // What the migration would re-add is left out, so only readiness can catch the break.
    const readinessOnly = 'select 1';
    // The runner opens its own transaction; inside this one, its ROLLBACK also undoes the
    // breakage, so the next case starts from a whole schema.
    await client.query('BEGIN');
    try {
      await client.query(breakage);
      await expect(applyMigrationTransaction(client, readinessOnly)).rejects.toThrow('WORKOUT_TEMPLATE_DETAILS_NOT_READY');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
    await applyMigrationTransaction(client, await migrationSql());
  });
});
