// Workout template details (lane YR, YR-a; Overwatch step-1 ruling Q3 A,
// OD-2026-11-17-001 and the one_source ruling A): the workout_template_details
// migration adds `details jsonb not null default '{}'`, checked to be a JSON
// object, to pilot.workout_templates and pilot.workout_template_items; widens
// workout_templates_duration_minutes_check to 1-180 minutes; and redefines
// pilot_wti_one_source as "a drill, free text or a non-empty details". It
// applies in `all` order and re-applies as a no-op; rows that existed before it
// keep every value and read '{}'; the checks refuse what they should;
// pilot_wti_no_contact_volume is untouched; readiness refuses an environment
// missing any piece it asserts, or still holding an old definition; the
// migration refuses a database without the two tables.
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

/** pilot_wti_one_source before this migration (workout_templates_v2): exactly one of the two. */
const OLD_ONE_SOURCE = '((drill_id is not null and free_text_drill is null) or (drill_id is null and free_text_drill is not null))';

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
    const def = (conname: string) => constraintsAfter.rows.find((row) => row.conname === conname)?.def;
    expect(def('pilot_wti_details_check')).toBe("CHECK ((jsonb_typeof(details) = 'object'::text))");
    expect(def('pilot_workout_templates_details_check')).toBe("CHECK ((jsonb_typeof(details) = 'object'::text))");
    expect(def('workout_templates_duration_minutes_check')).toBe('CHECK (((duration_minutes >= 1) AND (duration_minutes <= 180)))');
    expect(def('pilot_wti_one_source')).toBe("CHECK (((drill_id IS NOT NULL) OR (free_text_drill IS NOT NULL) OR (details <> '{}'::jsonb)))");
    // Unchanged (OD-2026-11-17-002): contact above light_technical carries no minutes.
    expect(def('pilot_wti_no_contact_volume')).toMatch(/contact_level.*duration_minutes IS NULL.*rep_count IS NULL/);
  });

  it('leaves every existing row as it was: each value kept, details {}', async () => {
    await createGym(GYM);
    // Back to the schema before this migration, inside a transaction, with rows written then.
    await client.query('BEGIN');
    try {
      // Dropping details drops the new pilot_wti_one_source with it; the old definitions go back.
      await client.query('alter table pilot.workout_template_items drop column details');
      await client.query('alter table pilot.workout_templates drop column details');
      await client.query(`alter table pilot.workout_template_items add constraint pilot_wti_one_source check ${OLD_ONE_SOURCE}`);
      await client.query(`alter table pilot.workout_templates drop constraint workout_templates_duration_minutes_check,
        add constraint workout_templates_duration_minutes_check check (duration_minutes between 15 and 180)`);
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
      const defs = await client.query<{ conname: string; def: string }>(
        `select conname, pg_get_constraintdef(oid) as def from pg_constraint
          where conname in ('workout_templates_duration_minutes_check', 'pilot_wti_one_source') order by conname`,
      );
      expect(defs.rows).toEqual([
        { conname: 'pilot_wti_one_source', def: "CHECK (((drill_id IS NOT NULL) OR (free_text_drill IS NOT NULL) OR (details <> '{}'::jsonb)))" },
        { conname: 'workout_templates_duration_minutes_check', def: 'CHECK (((duration_minutes >= 1) AND (duration_minutes <= 180)))' },
      ]);
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

  it('takes 1 to 180 minutes, and an item with a drill, free text or details; refuses the rest', async () => {
    const gym = 'gym_template_wider_checks';
    await createGym(gym);
    const template = (id: string, minutes: number) => client.query(
      `insert into pilot.workout_templates (organization_id, template_id, lineage_id, name, session_type, difficulty, duration_minutes, intent)
       values ($1, $2, $2, $2, 'technical', 'beginner', $3, 'x')`,
      [gym, id, minutes],
    );
    await template('wtp_00000000000e01', 10);
    await template('wtp_00000000000e02', 1);
    await template('wtp_00000000000e03', 180);
    for (const minutes of [0, 181]) {
      await expect(template(`wtp_00000000000e9${minutes === 0 ? 0 : 1}`, minutes))
        .rejects.toMatchObject({ code: '23514', constraint: 'workout_templates_duration_minutes_check' });
    }
    const item = (ordinal: number, drill: string | null, text: string | null, details: string) => client.query(
      `insert into pilot.workout_template_items (organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill, contact_level, details)
       values ($1, $2, 'wtp_00000000000e01', $3, 'warmup', $4, $5, 'none', $6::jsonb)`,
      [gym, `wti_00000000000e0${ordinal}`, ordinal, drill, text, details],
    );
    await client.query(
      `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
      [gym],
    );
    await client.query(
      `insert into pilot.drill_library
         (organization_id, drill_id, lineage_id, version, name, discipline, category, difficulty, target_behavior,
          purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like)
       values ($1, 'drl_00000000000e01', 'drl_00000000000e01', 1, 'Fixture drill', 'boxing', 'technical', 'beginner', 'x', 'x', 'x', 'x', 'x', 'x')`,
      [gym],
    );
    // Neither a drill nor text, but details (a scripted class's parts): taken.
    await item(1, null, null, '{"parts": {"Drill": ["Jump rope."]}}');
    // Free text only, and a drill only: taken, as before.
    await item(2, null, 'Shadow', '{}');
    await item(3, 'drl_00000000000e01', null, '{}');
    // A drill and its dosage as text: taken now.
    await item(6, 'drl_00000000000e01', '4 x 30 s maximal', '{}');
    // Nothing at all: refused.
    await expect(item(4, null, null, '{}')).rejects.toMatchObject({ code: '23514', constraint: 'pilot_wti_one_source' });
    // Contact above light_technical still carries no minutes (pilot_wti_no_contact_volume, unchanged).
    await expect(client.query(
      `insert into pilot.workout_template_items (organization_id, item_id, template_id, ordinal, block, free_text_drill, contact_level, duration_minutes)
       values ($1, 'wti_00000000000e05', 'wtp_00000000000e01', 5, 'sparring', 'Technical sparring', 'controlled_sparring', 20)`,
      [gym],
    )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_wti_no_contact_volume' });
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
    // An old definition back in place (NOT VALID: rows the wider check took stay; readiness alone must catch it).
    [
      'the old 15-180 duration range',
      `alter table pilot.workout_templates drop constraint workout_templates_duration_minutes_check,
         add constraint workout_templates_duration_minutes_check check (duration_minutes between 15 and 180) not valid`,
    ],
    [
      'the old exactly-one-source rule',
      `alter table pilot.workout_template_items drop constraint pilot_wti_one_source,
         add constraint pilot_wti_one_source check ${OLD_ONE_SOURCE} not valid`,
    ],
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
