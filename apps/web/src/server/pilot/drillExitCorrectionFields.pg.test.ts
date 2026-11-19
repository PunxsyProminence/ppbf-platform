// Drill exit_condition and correction_path (lane NW-b; PK-197 A in
// docs/backbone/HANDOFF_NOTE.md): the drill-exit-correction-fields migration adds
// both as `text not null default ''` to pilot.drill_library. It applies in `all`
// order after drill-library-v3 and re-applies as a no-op; rows that existed
// before it keep every value and read ''; a written value is kept as written;
// readiness refuses an environment whose column is nullable or has another
// default; the migration refuses a database without pilot.drill_library.
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
const DATABASE = 'drill_exit_correction_fields';
const EMPTY_DATABASE = 'drill_exit_correction_fields_empty';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-exit-correction-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.join(WEB_DIR, 'scripts/pilot-apply-drill-exit-correction-fields-migration.mjs');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_drill_exit_correction_fields_migration.sql');

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

const GYM = 'gym_exit_correction';
const FIELDS = ['exit_condition', 'correction_path'] as const;

async function createGym(organizationId: string): Promise<void> {
  await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [organizationId]);
  await client.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [organizationId],
  );
}

async function insertDrill(organizationId: string, drillId: string, extra: Record<string, string> = {}): Promise<void> {
  const names = Object.keys(extra);
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, name, discipline, category, difficulty,
        target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like,
        common_errors, corrections, equipment_needed, grounding_claim_ids, field_provenance${names.map((name) => `, ${name}`).join('')})
     values ($1, $2, $2, 1, $3, 'boxing', 'footwork', 'beginner', 'Target.', 'Purpose.', 'Setup.', 'Steps.', 'Good.', 'Bad.',
             'Errors.', 'Corrections.', 'Gloves', array[]::text[], 'Long Road practice'${names.map((_, index) => `, $${index + 4}`).join('')})`,
    [organizationId, drillId, `Drill ${drillId}`, ...Object.values(extra)],
  );
}

async function snapshot(organizationId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query(`select * from pilot.drill_library where organization_id = $1 order by drill_id`, [organizationId]);
  return rows;
}

const without = (row: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(row).filter(([name]) => !keys.includes(name)));

const COLUMNS_QUERY = `select column_name, data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'pilot' and table_name = 'drill_library' and column_name in ('exit_condition', 'correction_path')
  order by column_name`;

describe('the drill-exit-correction-fields migration', () => {
  it('runs in `all` order after drill-library-v3, and its runner re-applies it as a no-op', async () => {
    const at = (file: string) => fullOrder.findIndex((entry) => path.basename(entry) === file);
    expect(at('pilot_slice_postgres_drill_exit_correction_fields_migration.sql')).toBeGreaterThan(
      at('pilot_slice_postgres_drill_library_v3_migration.sql'),
    );
    const sql = await migrationSql();
    await applyMigrationTransaction(client, sql);
    await applyMigrationTransaction(client, sql);
    const columns = await client.query(COLUMNS_QUERY);
    expect(columns.rows).toEqual([
      { column_name: 'correction_path', data_type: 'text', is_nullable: 'NO', column_default: "''::text" },
      { column_name: 'exit_condition', data_type: 'text', is_nullable: 'NO', column_default: "''::text" },
    ]);
  });

  it('leaves every existing row as it was, both new fields empty', async () => {
    await createGym(GYM);
    // Back to the schema before this migration, inside a transaction, with rows written then.
    await client.query('BEGIN');
    try {
      for (const field of FIELDS) await client.query(`alter table pilot.drill_library drop column ${field}`);
      await insertDrill(GYM, 'drl_00000000000a01');
      await insertDrill(GYM, 'drl_00000000000a02');
      const before = await snapshot(GYM);
      expect(before).toHaveLength(2);
      const sql = await migrationSql();
      // No BEGIN/COMMIT in the SQL: it migrates the rows written above; twice, the second a no-op.
      await client.query(sql);
      await client.query(sql);
      const after = await snapshot(GYM);
      expect(after.map((row) => without(row, FIELDS))).toEqual(before);
      for (const row of after) {
        expect(row.exit_condition).toBe('');
        expect(row.correction_path).toBe('');
      }
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('keeps a written value as written, line break included, and refuses NULL', async () => {
    const gym = `${GYM}_written`;
    await createGym(gym);
    const exitText = 'Three clean rounds — no reaching.';
    const correctionText = 'First: reset the stance.\nThen: shorten the step.';
    await insertDrill(gym, 'drl_00000000000b01', { exit_condition: exitText, correction_path: correctionText });
    const [row] = await snapshot(gym);
    expect(row.exit_condition).toBe(exitText);
    expect(row.correction_path).toBe(correctionText);
    for (const field of FIELDS) {
      await expect(client.query(`update pilot.drill_library set ${field} = null where organization_id = $1`, [gym]))
        .rejects.toMatchObject({ code: '23502' });
    }
  });

  it('readiness refuses a column left nullable or with another default, and rolls back', async () => {
    const sql = await migrationSql();
    for (const broken of [
      'alter table pilot.drill_library alter column exit_condition drop not null;',
      "alter table pilot.drill_library alter column correction_path set default 'x';",
    ]) {
      await expect(applyMigrationTransaction(client, `${sql}\n${broken}`)).rejects.toThrow('DRILL_EXIT_CORRECTION_FIELDS_NOT_READY');
      const columns = await client.query(COLUMNS_QUERY);
      expect(columns.rows.map((column) => [column.is_nullable, column.column_default])).toEqual([
        ['NO', "''::text"],
        ['NO', "''::text"],
      ]);
    }
  });

  it('refuses a database without pilot.drill_library', async () => {
    const empty = new Client({ connectionString: connectionStringFor(EMPTY_DATABASE) });
    await empty.connect();
    try {
      await expect(empty.query(await migrationSql())).rejects.toThrow(/DRILL_EXIT_CORRECTION_FIELDS_NOT_READY/);
    } finally {
      await empty.end();
    }
  });
});
