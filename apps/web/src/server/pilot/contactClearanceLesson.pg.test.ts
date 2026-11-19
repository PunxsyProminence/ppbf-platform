// Real PostgreSQL-backed contract test for the contact clearance lesson
// migration (Jason's card OW25-45 B; lane SH, PR SH-2).
//
// The contact_medical_clearance gate's stored lesson told people to "Set status
// to 'cleared' in the Medical Status panel" -- the Decision Loop panel, which no
// longer sets anything once clearance is set on the Clearance Board. What has to
// be proven, and none of it by reading the SQL:
//
// 1. A row still holding the exact old seed text is updated to the new text.
// 2. A row a gym edited is left exactly as it was, every column.
// 3. Nothing else changes: the training_hold gate, every other column of the
//    updated row except requirement_text and updated_at, other organizations'
//    edited rows.
// 4. A re-run changes nothing, updated_at included.
// 5. The runner's readiness check refuses a database where the old text is
//    still stored, and rolls the transaction back.
// 6. On a full rebuild in the workflow's `all` order the lesson migration runs
//    after the safety-gate-matrix migration, and a gym seeded by that order
//    ends with the new text -- the same string safetyGateSeeds.ts inserts for a
//    gym created later.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { DEFAULT_SAFETY_GATES } from './safetyGateSeeds';

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-contact-clearance-lesson-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const APPLY_ORDER_PATH = path.resolve(__dirname, '../../../scripts/migration-apply-order.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-contact-clearance-lesson-migration.mjs');
const MATRIX_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-safety-gate-matrix-migration.mjs');

const MATRIX_FILE = 'pilot_slice_postgres_safety_gate_matrix_migration.sql';
const LESSON_FILE = 'pilot_slice_postgres_contact_clearance_lesson_migration.sql';

const OLD_LESSON =
  "This athlete needs an explicit 'cleared' medical administrative status on file before taking contact. "
  + "Set status to 'cleared' in the Medical Status panel once a clearance decision has been made; the "
  + 'observation is kept either way, and contact logged without a current clearance raises a near miss for '
  + 'coach/admin review.';
const NEW_LESSON =
  "This athlete needs an explicit 'cleared' medical administrative status on file before taking contact. "
  + "Set the athlete's clearance on the Clearance Board (a coach or the office) once a clearance decision has "
  + 'been made; the observation is kept either way, and contact logged without a current clearance raises a '
  + 'near miss for coach/admin review.';
const EDITED_LESSON = 'Our gym: ask the head coach before any contact. Clearance forms live at the front desk.';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type ApplyMigration = (client: Client, sql: string) => Promise<void>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSql: string;
let matrixSql: string;
let lessonSql: string;
let applyLesson: ApplyMigration;
let applyMatrix: ApplyMigration;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let migrationApplyOrder: (opts?: { infraDir?: string }) => string[];

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

async function emptyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function addOrganization(client: Client, organizationId: string): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1,$1,'active')`,
    [organizationId],
  );
}

interface GateRow {
  organization_id: string;
  gate_id: string;
  gate_key: string;
  name: string;
  category: string;
  enforcement: string;
  requirement_text: string;
  active_flag: boolean;
  created_at: string;
  updated_at: string;
}

async function gates(client: Client): Promise<GateRow[]> {
  const result = await client.query<GateRow>(
    `select organization_id, gate_id, gate_key, name, category, enforcement, requirement_text, active_flag,
            created_at::text, updated_at::text
     from pilot.safety_gates order by organization_id, gate_key`,
  );
  return result.rows;
}

/**
 * Production's shape: base schema and the safety-gate-matrix migration, three
 * gyms, every lesson then set to a known value with an old updated_at:
 * org-exact holds the old seed text, org-edited a lesson of its own, and
 * org-other the old text on a gym that also edited its training_hold lesson.
 */
async function productionShapeDatabase(name: string): Promise<Client> {
  const client = await emptyDatabase(name);
  await client.query(baseSql);
  for (const organizationId of ['org-exact', 'org-edited', 'org-other']) {
    await addOrganization(client, organizationId);
  }
  await client.query(matrixSql);
  await client.query(
    `update pilot.safety_gates
        set requirement_text = case
              when organization_id = 'org-edited' and gate_key = 'contact_medical_clearance' then $2
              when gate_key = 'contact_medical_clearance' then $1
              when organization_id = 'org-other' and gate_key = 'training_hold' then $3
              else requirement_text end,
            updated_at = timestamptz '2026-01-01 00:00:00+00'`,
    [OLD_LESSON, EDITED_LESSON, 'Hold lesson edited by this gym.'],
  );
  return client;
}

describe('the update', () => {
  test('an exact-match row gets the new lesson; an edited row and every other gate are untouched', async () => {
    const client = await productionShapeDatabase('ppbf_ccl_update');
    try {
      const before = await gates(client);
      expect(before.filter((row) => row.gate_key === 'contact_medical_clearance')).toHaveLength(3);

      await applyLesson(client, lessonSql);
      const after = await gates(client);
      expect(after).toHaveLength(before.length);

      for (const row of after) {
        const was = before.find((old) => old.gate_id === row.gate_id && old.organization_id === row.organization_id)!;
        const updated = row.gate_key === 'contact_medical_clearance' && was.requirement_text === OLD_LESSON;
        if (updated) {
          expect(row.requirement_text).toBe(NEW_LESSON);
          expect(row.updated_at).not.toBe(was.updated_at);
          // Every other column exactly as it was.
          const unchanged = (gate: GateRow) => ({ ...gate, requirement_text: null, updated_at: null });
          expect(unchanged(row)).toEqual(unchanged(was));
        } else {
          expect(row).toEqual(was);
        }
      }

      const lesson = (org: string) => after.find((row) => row.organization_id === org && row.gate_key === 'contact_medical_clearance')!;
      expect(lesson('org-exact').requirement_text).toBe(NEW_LESSON);
      expect(lesson('org-other').requirement_text).toBe(NEW_LESSON);
      expect(lesson('org-edited').requirement_text).toBe(EDITED_LESSON);
    } finally {
      await client.end();
    }
  });

  test('a lesson that differs from the old seed by one character is a gym edit, and is left alone', async () => {
    const client = await productionShapeDatabase('ppbf_ccl_near_miss');
    try {
      const nearly = `${OLD_LESSON} `;
      await client.query(
        "update pilot.safety_gates set requirement_text = $1 where organization_id = 'org-exact' and gate_key = 'contact_medical_clearance'",
        [nearly],
      );
      const pick = (rows: GateRow[]) => rows.find((gate) => gate.organization_id === 'org-exact' && gate.gate_key === 'contact_medical_clearance')!;
      const before = pick(await gates(client));
      await applyLesson(client, lessonSql);
      expect(pick(await gates(client))).toEqual(before);
      expect(before.requirement_text).toBe(nearly);
    } finally {
      await client.end();
    }
  });

  test('a re-run changes nothing, updated_at included', async () => {
    const client = await productionShapeDatabase('ppbf_ccl_rerun');
    try {
      await applyLesson(client, lessonSql);
      const once = await gates(client);
      await applyLesson(client, lessonSql);
      await applyLesson(client, lessonSql);
      expect(await gates(client)).toEqual(once);
    } finally {
      await client.end();
    }
  });

  test('a database with no safety_gates table is refused, not silently passed', async () => {
    const client = await emptyDatabase('ppbf_ccl_no_table');
    try {
      // Nothing applied at all: the migration has nothing to update and says so.
      await expect(applyLesson(client, lessonSql)).rejects.toThrow(/CONTACT_CLEARANCE_LESSON_NOT_READY/);
    } finally {
      await client.end();
    }
  });
});

describe('the safety-gate-matrix migration, re-run', () => {
  test('through its own runner on a database that already has the gates, changes 0 rows', async () => {
    const client = await productionShapeDatabase('ppbf_ccl_matrix_rerun');
    try {
      // Before the lesson migration and after it: neither re-run touches a row,
      // whatever lesson text the matrix file carries.
      const before = await gates(client);
      await applyMatrix(client, matrixSql);
      expect(await gates(client)).toEqual(before);

      await applyLesson(client, lessonSql);
      const after = await gates(client);
      await applyMatrix(client, matrixSql);
      await applyMatrix(client, matrixSql);
      expect(await gates(client)).toEqual(after);
    } finally {
      await client.end();
    }
  });
});

describe('the readiness check', () => {
  test('refuses a database that still holds the old lesson, and rolls back', async () => {
    const client = await productionShapeDatabase('ppbf_ccl_readiness');
    try {
      const before = await gates(client);
      // The runner's transaction with SQL that does nothing to the lesson.
      await expect(applyLesson(client, 'select 1;')).rejects.toThrow('CONTACT_CLEARANCE_LESSON_NOT_READY');
      expect(await gates(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });
});

describe('a full rebuild in `all` order', () => {
  test('the lesson migration runs after the matrix, and a seeded gym ends with the seed module text', async () => {
    const order = migrationApplyOrder({ infraDir: INFRA_DIR }).map((file) => path.basename(file));
    expect(order.indexOf(LESSON_FILE)).toBeGreaterThan(order.indexOf(MATRIX_FILE));
    expect(order.indexOf(MATRIX_FILE)).toBeGreaterThan(-1);

    const client = await emptyDatabase('ppbf_ccl_all_order');
    try {
      // A fresh database: the base schema and every migration in `all` order.
      await applyFullSchema(client, { infraDir: INFRA_DIR });
      await addOrganization(client, 'org-rebuild');
      // Then `all` again, every file in the workflow's order, as a dispatch of
      // `all` runs it: the matrix seeds the new gym with its (earlier) lesson,
      // and the lesson migration, later in the order, replaces exactly that.
      const order = migrationApplyOrder({ infraDir: INFRA_DIR });
      for (const file of order) {
        await client.query(await fs.readFile(path.isAbsolute(file) ? file : path.join(INFRA_DIR, file), 'utf8'));
      }

      const lesson = (await gates(client)).find((row) => row.organization_id === 'org-rebuild' && row.gate_key === 'contact_medical_clearance')!;
      expect(lesson.requirement_text).toBe(NEW_LESSON);
      const seed = DEFAULT_SAFETY_GATES.find((gate) => gate.gateKey === 'contact_medical_clearance')!;
      expect(seed.requirementText).toBe(NEW_LESSON);
    } finally {
      await client.end();
    }
  });
});

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

  baseSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  matrixSql = await fs.readFile(path.join(INFRA_DIR, MATRIX_FILE), 'utf8');
  lessonSql = await fs.readFile(path.join(INFRA_DIR, LESSON_FILE), 'utf8');

  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyLesson = runner.applyMigrationTransaction as ApplyMigration;
  const matrixRunner = await nativeDynamicImport(pathToFileURL(MATRIX_RUNNER_PATH).href);
  applyMatrix = matrixRunner.applyMigrationTransaction as ApplyMigration;
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  const applyOrder = await nativeDynamicImport(pathToFileURL(APPLY_ORDER_PATH).href);
  migrationApplyOrder = applyOrder.migrationApplyOrder as typeof migrationApplyOrder;
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
    const safetyTimer = setTimeout(finish, 10_000);
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  // Windows can still hold the data folder for a moment after the server
  // exits (EBUSY); the test-start sweep in test-embedded-pg-server.mjs clears
  // a leftover folder, so a failed removal here is not a test failure.
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
});
