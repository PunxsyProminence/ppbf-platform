// Real PostgreSQL-backed suite for
// infra/azure/pilot_slice_postgres_scheduler_class_plan_migration.sql (lane
// W4-5, SP-3): a scheduled class names the session plan it will run.
//
// THE MIGRATION IS TESTED ON THE SCHEMA IT WILL MEET: `before` is the base
// schema plus every migration ahead of this one in the apply workflow's own
// order (scripts/lib/full-schema.mjs); the migration is then applied THROUGH
// ITS RUNNER, so the runner's readiness gate is exercised too. A third
// database is built by applyFullSchema itself, the path every other pg suite
// takes, to show the `all` list carries this migration. It is the same schema,
// not the same server: this is the embedded Postgres the suites use (18), and
// the runner's exact-text checks have not been run on the version staging and
// production run.
//
// What needs a real database to prove:
//
// 1. ADDITIVE. It adds one nullable column, one key and one index, changes no
//    existing row, leaves the plan table as it was, and re-applies as a no-op
//    that does not wait on an ordinary class write.
// 2. The runner refuses a database where it never ran, and, for each key of
//    its readiness gate, at least one database where that rule is missing or
//    looser (examples, not every way a rule could be loosened).
// 3. The rules the DATABASE holds: a class names only a plan of its own gym,
//    or none; a deleted plan unlinks the class and keeps it in its gym.
//
// The module that writes the column (schedulerDb.ts createSchedulerClasses) is
// tested in schedulerCreateClasses.pg.test.ts. Spins up the same disposable,
// local-only embedded Postgres the other migration suites use. It NEVER
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

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-scheduler-class-plan-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-scheduler-class-plan-migration.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_scheduler_class_plan_migration.sql';

// Two template databases, cloned per test: the schema just BEFORE this
// migration, and the same with it applied. FULL is what applyFullSchema builds.
const BEFORE = 'ppbf_test_classplan_before';
const AFTER = 'ppbf_test_classplan_after';
const FULL = 'ppbf_test_classplan_full';

const ORG = 'org-classplan-a';
const OTHER_ORG = 'org-classplan-b';
const COACH = 'coach-classplan-a';
const OTHER_COACH = 'coach-classplan-b';
const PLAN = 'plan-classplan-a1';
const SECOND_PLAN = 'plan-classplan-a2';
const OTHER_PLAN = 'plan-classplan-b1';
const CLASS = 'class-classplan-a1';
const SECOND_CLASS = 'class-classplan-a2';
const OTHER_CLASS = 'class-classplan-b1';

const CLASSES_TABLE = 'pilot.scheduler_classes';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let migrationFilesInOrder: string[];
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let databaseCount = 0;
/** The name of the database cloneOf made last, for a second connection to it. */
let lastClone = '';

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

async function asAdmin<T>(work: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

/** A fresh copy of one of the templates, connected. The caller ends it. */
async function cloneOf(template: typeof BEFORE | typeof AFTER | typeof FULL): Promise<Client> {
  databaseCount += 1;
  const name = `ppbf_test_classplan_${databaseCount}`;
  lastClone = name;
  await asAdmin(async (admin) => {
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name} template ${template}`);
  });
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** The runner's transaction with no SQL to apply: readiness alone decides. */
function readinessOnly(client: Client): Promise<void> {
  return applyMigrationTransaction(client, 'select 1');
}

/** Two gyms; a coach in each; two plans of the first gym, one of the second; classes in each. */
async function seed(client: Client): Promise<void> {
  for (const [org, coach] of [[ORG, COACH], [OTHER_ORG, OTHER_COACH]] as const) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
    await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [coach, org]);
    // A plan's discipline (default 'boxing') must be one of its gym's (pilot_session_scripts_discipline_fk).
    await client.query(
      `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
      [org],
    );
  }
  for (const [org, plan, coach] of [
    [ORG, PLAN, COACH],
    [ORG, SECOND_PLAN, COACH],
    [OTHER_ORG, OTHER_PLAN, OTHER_COACH],
  ] as const) {
    await client.query(
      `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, created_by_account_id)
       values ($1, $2, $2, 1, 'Evening plan', $3)`,
      [org, plan, coach],
    );
  }
  for (const [org, klass, coach] of [
    [ORG, CLASS, COACH],
    [ORG, SECOND_CLASS, COACH],
    [OTHER_ORG, OTHER_CLASS, OTHER_COACH],
  ] as const) {
    await insertClass(client, org, klass, coach);
  }
}

/** A class as createSchedulerClasses wrote one before this migration: no plan column named. */
function insertClass(client: Client, org: string, klass: string, coach: string) {
  return client.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity,
        scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, 'Youth boxing', now() + interval '1 day', now() + interval '1 day 1 hour', 'Main floor', 20,
             $3, $3, 'open')`,
    [org, klass, coach],
  );
}

function link(client: Client, klass: string, plan: string | null, org = ORG) {
  return client.query(
    `update pilot.scheduler_classes set script_id = $3 where organization_id = $1 and class_id = $2`,
    [org, klass, plan],
  );
}

async function classRow(client: Client, klass: string, org = ORG) {
  const { rows } = await client.query(
    `select to_jsonb(c) as row from pilot.scheduler_classes c where organization_id = $1 and class_id = $2`,
    [org, klass],
  );
  return rows[0]?.row as Record<string, unknown> | undefined;
}

async function constraintNames(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ conname: string }>(
    `select conname from pg_constraint where conrelid = $1::regclass order by conname`,
    [table],
  );
  return rows.map((row) => row.conname);
}

async function columnNames(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ attname: string }>(
    `select attname from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum`,
    [table],
  );
  return rows.map((row) => row.attname);
}

async function indexNames(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname || '.' || tablename = $1 order by indexname`,
    [table],
  );
  return rows.map((row) => row.indexname);
}

/** The column, key and index as PostgreSQL prints them, and the column's comment. */
async function printedRules(client: Client) {
  const { rows } = await client.query(
    `select
       (select format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else ' null' end
                || case when a.atthasdef then ' default' else '' end
          from pg_attribute a
         where a.attrelid = 'pilot.scheduler_classes'::regclass and a.attname = 'script_id' and not a.attisdropped) as column_shape,
       (select pg_get_constraintdef(c.oid)
          from pg_constraint c
         where c.conrelid = 'pilot.scheduler_classes'::regclass and c.conname = 'pilot_scheduler_classes_script_fk') as foreign_key,
       pg_get_indexdef(to_regclass('pilot.pilot_scheduler_classes_script')) as index,
       col_description('pilot.scheduler_classes'::regclass,
         (select attnum from pg_attribute
           where attrelid = 'pilot.scheduler_classes'::regclass and attname = 'script_id' and not attisdropped)::int) as comment`,
  );
  return rows[0] as { column_shape: string | null; foreign_key: string | null; index: string | null; comment: string | null };
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const listMigrationFiles = helper.listMigrationFiles as (infraDir?: string) => Promise<string[]>;
  const applyFullSchema = helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  const baseSchemaFile = helper.BASE_SCHEMA_FILE as string;
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runner.applyMigrationTransaction as typeof applyMigrationTransaction;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  migrationFilesInOrder = await listMigrationFiles(INFRA_DIR);

  // BEFORE: the base schema, then every migration ahead of this one, in the
  // workflow's order, each in its own transaction (as applyFullSchema does).
  const ahead = migrationFilesInOrder.slice(0, migrationFilesInOrder.indexOf(MIGRATION_FILE));
  await asAdmin(async (admin) => {
    await admin.query(`drop database if exists ${AFTER}`);
    await admin.query(`drop database if exists ${BEFORE}`);
    await admin.query(`drop database if exists ${FULL}`);
    await admin.query(`create database ${BEFORE}`);
    await admin.query(`create database ${FULL}`);
  });
  const before = new Client({ connectionString: connectionStringFor(BEFORE) });
  await before.connect();
  try {
    await before.query(await fs.readFile(path.join(INFRA_DIR, baseSchemaFile), 'utf8'));
    for (const file of ahead) {
      await before.query('BEGIN');
      await before.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
      await before.query('COMMIT');
    }
    await seed(before);
  } finally {
    await before.end();
  }

  // AFTER: a copy of BEFORE with the migration applied through its runner.
  await asAdmin((admin) => admin.query(`create database ${AFTER} template ${BEFORE}`));
  const after = new Client({ connectionString: connectionStringFor(AFTER) });
  await after.connect();
  try {
    await applyMigrationTransaction(after, migrationSql);
  } finally {
    await after.end();
  }

  // FULL: what every other pg suite builds, from nothing.
  const full = new Client({ connectionString: connectionStringFor(FULL) });
  await full.connect();
  try {
    await applyFullSchema(full, { infraDir: INFRA_DIR });
  } finally {
    await full.end();
  }
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
  // On Windows kill() terminates the server script outright, so its own
  // cleanup never runs and Postgres may still hold files here for a moment.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

describe('where the migration sits', () => {
  test('it is applied after every migration it depends on', () => {
    const position = (file: string) => migrationFilesInOrder.indexOf(file);

    expect(position(MIGRATION_FILE)).toBeGreaterThan(-1);
    for (const dependency of [
      'pilot_slice_postgres_scheduler_tables_migration.sql',
      'pilot_slice_postgres_session_scripts_migration.sql',
    ]) {
      expect(position(dependency)).toBeGreaterThan(-1);
      expect(position(dependency)).toBeLessThan(position(MIGRATION_FILE));
    }
  });

  test('the full schema every pg suite builds carries the column, the key and the index exactly', async () => {
    const client = await cloneOf(FULL);
    try {
      await expect(readinessOnly(client)).resolves.toBeUndefined();
      const printed = await printedRules(client);
      expect(printed.column_shape).toBe('text null');
      expect(printed.foreign_key).toBe(
        'FOREIGN KEY (organization_id, script_id) REFERENCES pilot.session_scripts(organization_id, script_id) ON DELETE SET NULL (script_id)',
      );
      expect(printed.index).toBe(
        'CREATE INDEX pilot_scheduler_classes_script ON pilot.scheduler_classes USING btree (organization_id, script_id) WHERE (script_id IS NOT NULL)',
      );
      expect(printed.comment).toMatch(/^The session plan this class runs \(lane W4-5\), or null for a class with no plan\./);
      // The runner's database and the full schema are the same shape.
      const after = await cloneOf(AFTER);
      try {
        expect(await printedRules(after)).toEqual(printed);
      } finally {
        await after.end();
      }
    } finally {
      await client.end();
    }
  });
});

describe('the migration is additive', () => {
  test('it adds the column, key and index, changes no existing row, leaves the plan table alone, and re-applies as a no-op', async () => {
    const client = await cloneOf(BEFORE);
    try {
      expect(await columnNames(client, CLASSES_TABLE)).not.toContain('script_id');

      const rows = async (table: string, key: string) =>
        (await client.query(`select to_jsonb(t) as row from ${table} t order by ${key}`)).rows.map(({ row }) => row);
      const shape = async (table: string) => [
        await columnNames(client, table),
        await constraintNames(client, table),
        await indexNames(client, table),
      ];
      const classesBefore = await rows(CLASSES_TABLE, 'class_id');
      const plansBefore = await rows('pilot.session_scripts', 'script_id');
      const [classColumns, classConstraints, classIndexes] = await shape(CLASSES_TABLE);
      const untouched = ['pilot.session_scripts', 'pilot.scheduler_registrations', 'pilot.scheduler_attendance'];
      // One query at a time: a pg Client runs one, and queues the rest with a deprecation warning.
      const shapesOf = async (tables: string[]) => {
        const shapes = [];
        for (const table of tables) shapes.push(await shape(table));
        return shapes;
      };
      const shapeBefore = await shapesOf(untouched);

      await applyMigrationTransaction(client, migrationSql);
      await link(client, CLASS, PLAN);
      // The `all` chain re-runs every migration on every dispatch.
      await applyMigrationTransaction(client, migrationSql);

      // Existing rows are the same rows, with the new column empty (the link made between the two
      // applications aside, which the re-run kept).
      expect(await rows(CLASSES_TABLE, 'class_id')).toEqual(
        classesBefore.map((row) => ({ ...row, script_id: row.class_id === CLASS ? PLAN : null })),
      );
      expect(await rows('pilot.session_scripts', 'script_id')).toEqual(plansBefore);
      // The class table gained exactly its three rules; the plan table and the class's other
      // tables are the same shape.
      expect(await shape(CLASSES_TABLE)).toEqual([
        [...classColumns, 'script_id'],
        [...classConstraints, 'pilot_scheduler_classes_script_fk'].sort(),
        [...classIndexes, 'pilot_scheduler_classes_script'].sort(),
      ]);
      expect(await shapesOf(untouched)).toEqual(shapeBefore);
      await expect(readinessOnly(client)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('a database where the column was dropped gets the column, the key and the index back', async () => {
    const client = await cloneOf(AFTER);
    try {
      const printed = await printedRules(client);
      // Dropping the column takes the key and the index with it: the state before the migration.
      await client.query(`alter table ${CLASSES_TABLE} drop column script_id`);
      expect(await constraintNames(client, CLASSES_TABLE)).not.toContain('pilot_scheduler_classes_script_fk');
      expect(await indexNames(client, CLASSES_TABLE)).not.toContain('pilot_scheduler_classes_script');
      await expect(readinessOnly(client)).rejects.toThrow(/SCHEDULER_CLASS_PLAN_NOT_READY/);

      await applyMigrationTransaction(client, migrationSql);
      expect(await printedRules(client)).toEqual(printed);
    } finally {
      await client.end();
    }
  });

  test('the insert the app ran before this migration still works, and names no plan', async () => {
    const client = await cloneOf(AFTER);
    try {
      await insertClass(client, ORG, 'class-classplan-today', COACH);
      expect(await classRow(client, 'class-classplan-today')).toMatchObject({ organization_id: ORG, script_id: null });
    } finally {
      await client.end();
    }
  });

  test('a re-run takes no lock on the class table', async () => {
    // Reviewer J on #2238: the column comment, written on every re-run, took SHARE UPDATE EXCLUSIVE,
    // so a VACUUM, ANALYZE or CREATE INDEX on the table could time the `all` chain out.
    const client = await cloneOf(AFTER);
    try {
      await client.query('BEGIN');
      await client.query(migrationSql);
      const held = await client.query<{ mode: string }>(
        `select mode from pg_locks
          where pid = pg_backend_pid() and locktype = 'relation' and relation = to_regclass('${CLASSES_TABLE}')`,
      );
      await client.query('ROLLBACK');
      expect(held.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a re-run does not wait on a class write in progress', async () => {
    const client = await cloneOf(AFTER);
    const writer = new Client({ connectionString: connectionStringFor(lastClone) });
    await writer.connect();
    try {
      // Another transaction mid-write on the class table, as a schedule save would be.
      await writer.query('BEGIN');
      await link(writer, SECOND_CLASS, SECOND_PLAN);
      const started = Date.now();
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
      await writer.query('COMMIT');
      expect(await classRow(client, SECOND_CLASS)).toMatchObject({ script_id: SECOND_PLAN });
    } finally {
      await writer.end();
      await client.end();
    }
  });
});

describe('the migration fails loudly on a database missing what it needs', () => {
  test('with the plan table missing it raises, and adds nothing to the class table', async () => {
    const client = await cloneOf(BEFORE);
    try {
      await client.query('drop table pilot.session_scripts cascade');
      await expect(applyMigrationTransaction(client, migrationSql))
        .rejects.toThrow(/pilot\.session_scripts is missing: apply the session-scripts migration first/);
      expect(await columnNames(client, CLASSES_TABLE)).not.toContain('script_id');
    } finally {
      await client.end();
    }
  });

  test('with the class table missing it raises', async () => {
    const client = await cloneOf(BEFORE);
    try {
      await client.query(`drop table ${CLASSES_TABLE} cascade`);
      await expect(applyMigrationTransaction(client, migrationSql))
        .rejects.toThrow(/pilot\.scheduler_classes is missing: apply the scheduler-tables migration first/);
    } finally {
      await client.end();
    }
  });
});

describe('the runner', () => {
  /** The gate's refusal, naming exactly this key (not a longer key that ends with it). */
  const refusalNaming = (key: string) => new RegExp(`SCHEDULER_CLASS_PLAN_NOT_READY: (.*, )?${key}(, .*)?$`);

  test('refuses a database where the migration never ran, naming what is missing', async () => {
    const client = await cloneOf(BEFORE);
    try {
      await expect(readinessOnly(client)).rejects.toThrow(refusalNaming('class_plan_column_ready'));
    } finally {
      await client.end();
    }
  });

  test('passes on a database where it ran', async () => {
    const client = await cloneOf(AFTER);
    try {
      await expect(readinessOnly(client)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  const recreateKey = (clause: string) =>
    `alter table ${CLASSES_TABLE} drop constraint pilot_scheduler_classes_script_fk,
       add constraint pilot_scheduler_classes_script_fk ${clause}`;
  const recreateIndex = (definition: string) =>
    `drop index pilot.pilot_scheduler_classes_script;
     create ${definition}`;

  // At least one case for EVERY key of the gate. Each is the migrated database with one rule
  // missing or looser and everything else right, and the refusal names that rule and no other
  // (a type change, for one, keeps the key and the index).
  test.each([
    // class_plan_column_ready
    ['script_id NOT NULL', 'class_plan_column_ready',
      `update ${CLASSES_TABLE} set script_id = '${PLAN}' where organization_id = '${ORG}';
       delete from ${CLASSES_TABLE} where organization_id <> '${ORG}';
       alter table ${CLASSES_TABLE} alter column script_id set not null`],
    ['script_id with a default', 'class_plan_column_ready',
      `alter table ${CLASSES_TABLE} alter column script_id set default '${PLAN}'`],
    ['script_id of another type', 'class_plan_column_ready',
      `alter table ${CLASSES_TABLE} alter column script_id type varchar(64)`],
    // Reviewer J on #2238: each case from here to the end of the key's cases passed the gate before.
    // The index is rebuilt under the default collation, so only the column's rule is wrong.
    ['script_id under another collation', 'class_plan_column_ready',
      `alter table ${CLASSES_TABLE} alter column script_id type text collate "C";
       ${recreateIndex(`index pilot_scheduler_classes_script on ${CLASSES_TABLE}(organization_id, script_id collate "default")
         where script_id is not null`)}`],
    // class_plan_fk_ready
    ['the plan key dropped', 'class_plan_fk_ready',
      `alter table ${CLASSES_TABLE} drop constraint pilot_scheduler_classes_script_fk`],
    ['the plan key nulling the whole key (organization_id too)', 'class_plan_fk_ready',
      recreateKey(`foreign key (organization_id, script_id)
        references pilot.session_scripts(organization_id, script_id) on delete set null`)],
    ['the plan key cascading (a plan delete would delete the class)', 'class_plan_fk_ready',
      recreateKey(`foreign key (organization_id, script_id)
        references pilot.session_scripts(organization_id, script_id) on delete cascade`)],
    ['the plan key with no delete action', 'class_plan_fk_ready',
      recreateKey(`foreign key (organization_id, script_id)
        references pilot.session_scripts(organization_id, script_id)`)],
    ['the plan key NOT VALID', 'class_plan_fk_ready',
      recreateKey(`foreign key (organization_id, script_id)
        references pilot.session_scripts(organization_id, script_id) on delete set null (script_id) not valid`)],
    ['the plan key on script_id alone (any gym\'s plan)', 'class_plan_fk_ready',
      `create unique index classplan_script_id_only on pilot.session_scripts(script_id);
       ${recreateKey(`foreign key (script_id) references pilot.session_scripts(script_id) on delete set null (script_id)`)}`],
    ['the plan key deferrable', 'class_plan_fk_ready',
      recreateKey(`foreign key (organization_id, script_id)
        references pilot.session_scripts(organization_id, script_id) on delete set null (script_id)
        deferrable initially deferred`)],
    ['the plan key cascading an update', 'class_plan_fk_ready',
      recreateKey(`foreign key (organization_id, script_id)
        references pilot.session_scripts(organization_id, script_id) on update cascade on delete set null (script_id)`)],
    // MATCH FULL refuses a class with a gym and no plan, so it only validates on a table with no
    // classes; once there, every class scheduled without a plan would be refused (23503).
    ['the plan key MATCH FULL (every class with no plan refused)', 'class_plan_fk_ready',
      `delete from ${CLASSES_TABLE};
       ${recreateKey(`foreign key (organization_id, script_id)
         references pilot.session_scripts(organization_id, script_id) match full on delete set null (script_id)`)}`],
    // class_plan_index_ready
    ['the plan index dropped', 'class_plan_index_ready', 'drop index pilot.pilot_scheduler_classes_script'],
    ['the plan index over every class (another predicate)', 'class_plan_index_ready',
      recreateIndex(`index pilot_scheduler_classes_script on ${CLASSES_TABLE}(organization_id, script_id)`)],
    ['the plan index narrowed to open classes (another predicate)', 'class_plan_index_ready',
      recreateIndex(`index pilot_scheduler_classes_script on ${CLASSES_TABLE}(organization_id, script_id)
        where script_id is not null and status = 'open'`)],
    ['the plan index unique (one class per plan)', 'class_plan_index_ready',
      recreateIndex(`unique index pilot_scheduler_classes_script on ${CLASSES_TABLE}(organization_id, script_id)
        where script_id is not null`)],
    ['the plan index on script_id alone', 'class_plan_index_ready',
      recreateIndex(`index pilot_scheduler_classes_script on ${CLASSES_TABLE}(script_id) where script_id is not null`)],
    ['the plan index BRIN, not btree', 'class_plan_index_ready',
      recreateIndex(`index pilot_scheduler_classes_script on ${CLASSES_TABLE} using brin (organization_id, script_id)
        where script_id is not null`)],
    ['the plan index under another collation', 'class_plan_index_ready',
      recreateIndex(`index pilot_scheduler_classes_script on ${CLASSES_TABLE}(organization_id, script_id collate "C")
        where script_id is not null`)],
  ])('refuses a database with %s, and names it (%s)', async (_label, missing, breakIt) => {
    const client = await cloneOf(AFTER);
    try {
      // Outside the expectation: if the sabotage itself fails, the test fails here, not "passes".
      await client.query(breakIt);
      await expect(readinessOnly(client)).rejects.toThrow(new RegExp(`^SCHEDULER_CLASS_PLAN_NOT_READY: ${missing}$`));
    } finally {
      await client.end();
    }
  });

  test('every key of the gate has a case above', async () => {
    const client = await cloneOf(BEFORE);
    try {
      // On a database where nothing of it exists, the refusal names every key the gate has.
      const error = await readinessOnly(client).then(() => null, (caught: Error) => caught);
      const keys = (error?.message ?? '').replace('SCHEDULER_CLASS_PLAN_NOT_READY: ', '').split(', ').sort();
      expect(keys).toEqual(['class_plan_column_ready', 'class_plan_fk_ready', 'class_plan_index_ready']);
    } finally {
      await client.end();
    }
  });

  test('waits at most 10 seconds for its locks, and leaves nothing behind when it gives up', async () => {
    const client = await cloneOf(BEFORE);
    const blocker = new Client({ connectionString: connectionStringFor(lastClone) });
    await blocker.connect();
    try {
      // Another transaction mid-write on the class table: the first apply's new column needs the
      // table to itself.
      await blocker.query('BEGIN');
      await blocker.query(`update ${CLASSES_TABLE} set title = title where organization_id = $1`, [ORG]);
      const started = Date.now();
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(/lock timeout/i);
      expect(Date.now() - started).toBeLessThan(30_000);
      await blocker.query('ROLLBACK');
      expect(await columnNames(client, CLASSES_TABLE)).not.toContain('script_id');
    } finally {
      await blocker.end();
      await client.end();
    }
  });
});

describe('what the database itself holds', () => {
  test('a class names a plan of its own gym, or none', async () => {
    const client = await cloneOf(AFTER);
    try {
      await link(client, CLASS, PLAN);
      await link(client, SECOND_CLASS, SECOND_PLAN);
      await link(client, OTHER_CLASS, OTHER_PLAN, OTHER_ORG);
      await link(client, CLASS, null);
      expect(await classRow(client, CLASS)).toMatchObject({ script_id: null });
      expect(await classRow(client, SECOND_CLASS)).toMatchObject({ script_id: SECOND_PLAN });
    } finally {
      await client.end();
    }
  });

  test.each([
    ['another gym\'s plan', OTHER_PLAN],
    ['a plan id nobody made', 'plan-classplan-none'],
  ])('a class naming %s is refused by the key (23503)', async (_label, plan) => {
    const client = await cloneOf(AFTER);
    try {
      const insert = client.query(
        `insert into pilot.scheduler_classes
           (organization_id, class_id, title, start_at, end_at, location, capacity,
            scheduled_by_account_id, coach_account_id, status, script_id)
         values ($1, 'class-classplan-new', 'Youth boxing', now(), now() + interval '1 hour', 'Main floor', 20,
                 $2, $2, 'open', $3)`,
        [ORG, COACH, plan],
      );
      await expect(insert).rejects.toMatchObject({ code: '23503', constraint: 'pilot_scheduler_classes_script_fk' });
      await expect(link(client, CLASS, plan)).rejects.toMatchObject({ code: '23503' });
      expect(await classRow(client, 'class-classplan-new')).toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('a deleted plan unlinks its classes and keeps them, in their gym', async () => {
    const client = await cloneOf(AFTER);
    try {
      await link(client, CLASS, PLAN);
      await link(client, SECOND_CLASS, SECOND_PLAN);
      const before = await classRow(client, CLASS);

      // The app deletes no plan (sessionScriptAuthoring.ts header: "nothing here deletes a row").
      // This is what the key does if one ever goes.
      await client.query(`delete from pilot.session_scripts where organization_id = $1 and script_id = $2`, [ORG, PLAN]);

      expect(await classRow(client, CLASS)).toEqual({ ...before, script_id: null });
      expect(await classRow(client, CLASS)).toMatchObject({ organization_id: ORG });
      // Another plan's class is untouched.
      expect(await classRow(client, SECOND_CLASS)).toMatchObject({ script_id: SECOND_PLAN });
    } finally {
      await client.end();
    }
  });
});
