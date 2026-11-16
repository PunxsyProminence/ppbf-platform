// Real PostgreSQL-backed contract test for the drill Long Road label migration
// (OD-2026-11-15-002 ruling 1: 'Long Road practice', a fifth field_provenance
// value, not a draft).
//
// What has to be proven, and none of it by reading the SQL:
//
// 1. 'Long Road practice' is rejected before the migration and accepted after,
//    and the column is still constrained (a paraphrase is still refused).
// 2. Strictly ADDITIVE: the four values the old CHECK accepted still are, and
//    no stored row is relabelled.
// 3. Exactly one CHECK, under the SAME name every reader addresses, validated.
// 4. THE RE-RUN HAZARD IS CLOSED. drill_owner_authored_label re-runs on every
//    `all` dispatch and used to re-add its four-value list unconditionally;
//    once a 'Long Road practice' row exists that re-add fails and the chain
//    stops. Proven on today's production shape (v3 + owner-authored, then this
//    migration, then owner-authored again) and on a full rebuild re-run twice
//    in the workflow's own `all` order.
// 5. The guard only ever SKIPS a check that already holds every value: a
//    narrower check, a second check, or a misnamed one is still replaced.
// 6. The readiness check refuses a database where the migration did not land.
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

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-long-road-label-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const APPLY_ORDER_PATH = path.resolve(__dirname, '../../../scripts/migration-apply-order.mjs');
const LONG_ROAD_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-long-road-label-migration.mjs',
);
const OWNER_AUTHORED_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-owner-authored-label-migration.mjs',
);

const V3_FILE = 'pilot_slice_postgres_drill_library_v3_migration.sql';
const OWNER_AUTHORED_FILE = 'pilot_slice_postgres_drill_owner_authored_label_migration.sql';
const LONG_ROAD_FILE = 'pilot_slice_postgres_drill_long_road_label_migration.sql';
const CHECK_DROP_FILE = 'pilot_slice_postgres_drill_library_check_drop_migration.sql';
const CONSTRAINT = 'pilot_drill_library_field_provenance_check';

const ORG = 'org-long-road';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type ApplyMigration = (client: Client, sql: string) => Promise<void>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSql: string;
let v3Sql: string;
let ownerAuthoredSql: string;
let longRoadSql: string;
let applyLongRoad: ApplyMigration;
let applyOwnerAuthored: ApplyMigration;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let migrationApplyOrder: (opts?: { infraDir?: string }) => string[];

const SOURCE_MANUAL = 'PPBF source manual v3';
const LITERATURE_DRAFT =
  'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION';
const CRAFT_DRAFT = 'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION';
const OWNER_AUTHORED = 'PPBF owner-authored';
const LONG_ROAD = 'Long Road practice';
const OLD_VALUES = [SOURCE_MANUAL, LITERATURE_DRAFT, CRAFT_DRAFT, OWNER_AUTHORED];
const ALL_VALUES = [...OLD_VALUES, LONG_ROAD];

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

async function addOrganization(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1,$1,'active')`,
    [ORG],
  );
}

/** Base schema + drill library v3 only: three values. */
async function v3Database(name: string): Promise<Client> {
  const client = await emptyDatabase(name);
  await client.query(baseSql);
  await client.query(v3Sql);
  await addOrganization(client);
  return client;
}

// The owner-authored file as production ran it (origin/main d826ae06, before
// this change): drop every field_provenance CHECK, add the four values, no
// guard. Production is in the state this leaves.
const OLD_OWNER_AUTHORED_SQL = `
do $$
declare
  existing record;
begin
  for existing in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'pilot'
      and rel.relname = 'drill_library'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%field_provenance%'
  loop
    execute format('alter table pilot.drill_library drop constraint %I', existing.conname);
  end loop;

  alter table pilot.drill_library
    add constraint pilot_drill_library_field_provenance_check
    check (field_provenance in (
      'PPBF source manual v3',
      'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION',
      'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION',
      'PPBF owner-authored'
    ));
end $$;
`;

/** Today's production shape for this column: v3 then the OLD owner-authored file, four values. */
async function productionTodayDatabase(name: string): Promise<Client> {
  const client = await v3Database(name);
  await applyOwnerAuthored(client, OLD_OWNER_AUTHORED_SQL);
  return client;
}

let drillSeq = 0;
async function insertDrill(client: Client, fieldProvenance: string): Promise<string> {
  drillSeq += 1;
  const id = `lr-${drillSeq}`;
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like, field_provenance)
     values ($1,$2,$2,$2,'c','t','p','s','e','g','b',$3)`,
    [ORG, id, fieldProvenance],
  );
  return id;
}

async function provenanceChecks(client: Client): Promise<{ conname: string; def: string; convalidated: boolean }[]> {
  const result = await client.query<{ conname: string; def: string; convalidated: boolean }>(
    `select con.conname, pg_get_constraintdef(con.oid) as def, con.convalidated
     from pg_constraint con
     join pg_class rel on rel.oid = con.conrelid
     join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'pilot' and rel.relname = 'drill_library'
       and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%field_provenance%'`,
  );
  return result.rows;
}

/** The literals the single CHECK admits, read back from the catalog. */
async function admittedValues(client: Client): Promise<string[]> {
  const checks = await provenanceChecks(client);
  expect(checks).toHaveLength(1);
  return [...checks[0].def.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) => m[1].replace(/''/g, "'")).sort();
}

async function expectFiveValueCheck(client: Client): Promise<void> {
  const checks = await provenanceChecks(client);
  expect(checks).toHaveLength(1);
  expect(checks[0].conname).toBe(CONSTRAINT);
  expect(checks[0].convalidated).toBe(true);
  expect(await admittedValues(client)).toEqual([...ALL_VALUES].sort());
}

async function storedRows(client: Client): Promise<{ drill_id: string; field_provenance: string }[]> {
  const result = await client.query<{ drill_id: string; field_provenance: string }>(
    'select drill_id, field_provenance from pilot.drill_library order by drill_id',
  );
  return result.rows;
}

async function constraintComment(client: Client): Promise<string | null> {
  const result = await client.query<{ comment: string | null }>(
    `select obj_description(oid, 'pg_constraint') as comment from pg_constraint
     where conname = $1 and conrelid = 'pilot.drill_library'::regclass`,
    [CONSTRAINT],
  );
  return result.rows[0]?.comment ?? null;
}

describe('before the label', () => {
  test("'Long Road practice' is rejected on today's four-value CHECK", async () => {
    const client = await productionTodayDatabase('ppbf_lr_before');
    try {
      await expect(insertDrill(client, LONG_ROAD)).rejects.toMatchObject({ code: '23514' });
      await expect(insertDrill(client, OWNER_AUTHORED)).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });
});

describe('after the label', () => {
  test('accepts Long Road practice, still accepts the four old values, and nothing else', async () => {
    const client = await productionTodayDatabase('ppbf_lr_after');
    try {
      await applyLongRoad(client, longRoadSql);
      for (const value of ALL_VALUES) {
        await expect(insertDrill(client, value)).resolves.toBeDefined();
      }
      // Still constrained: a paraphrase, a trailing space, or blank is a refusal.
      for (const value of ['Long road practice', 'Long Road practice ', 'Long Road', '']) {
        await expect(insertDrill(client, value)).rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await client.end();
    }
  });

  test('no stored row is relabelled', async () => {
    const client = await productionTodayDatabase('ppbf_lr_rows_untouched');
    try {
      for (const value of OLD_VALUES) await insertDrill(client, value);
      const before = await storedRows(client);
      await applyLongRoad(client, longRoadSql);
      expect(await storedRows(client)).toEqual(before);
      expect(before.map((row) => row.field_provenance).sort()).toEqual([...OLD_VALUES].sort());
    } finally {
      await client.end();
    }
  });

  test('exactly one validated CHECK, under the name every reader addresses, with exactly the five values', async () => {
    const client = await productionTodayDatabase('ppbf_lr_single_check');
    try {
      await applyLongRoad(client, longRoadSql);
      await expectFiveValueCheck(client);
      expect(await constraintComment(client)).toContain('Long Road practice');
    } finally {
      await client.end();
    }
  });
});

describe('the re-run hazard', () => {
  test("today's production shape: v3 + owner-authored -> Long Road -> owner-authored again keeps five", async () => {
    const client = await productionTodayDatabase('ppbf_lr_prod_today');
    try {
      for (const value of OLD_VALUES) await insertDrill(client, value);
      await applyLongRoad(client, longRoadSql);
      const longRoadId = await insertDrill(client, LONG_ROAD);
      const before = await storedRows(client);

      // The hazard, made concrete: a four-value re-add on this database is
      // refused by the stored 'Long Road practice' row. This is what the old
      // owner-authored file did on every `all` run.
      await client.query('BEGIN');
      await expect(client.query(`
        alter table pilot.drill_library drop constraint ${CONSTRAINT};
        alter table pilot.drill_library add constraint ${CONSTRAINT}
          check (field_provenance in (${OLD_VALUES.map((v) => `'${v}'`).join(', ')}));
      `)).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK');

      // The guarded file leaves the wider check alone, through its own runner
      // (whose readiness accepts a superset of its four values).
      await applyOwnerAuthored(client, ownerAuthoredSql);
      await client.query(v3Sql);
      await applyLongRoad(client, longRoadSql);
      await applyOwnerAuthored(client, ownerAuthoredSql);

      await expectFiveValueCheck(client);
      expect(await storedRows(client)).toEqual(before);
      expect(before.find((row) => row.drill_id === longRoadId)?.field_provenance).toBe(LONG_ROAD);
      await expect(insertDrill(client, LONG_ROAD)).resolves.toBeDefined();
      // A skipped re-run does not overwrite the wider check's comment.
      expect(await constraintComment(client)).toContain('Long Road practice');
    } finally {
      await client.end();
    }
  });

  test('a full rebuild in `all` order, then two re-runs of every file that touches the CHECK, in that order', async () => {
    const client = await emptyDatabase('ppbf_lr_all_order');
    try {
      await applyFullSchema(client, { infraDir: INFRA_DIR });
      await addOrganization(client);
      // On the full schema a drill's discipline must exist for its gym
      // (drill_library_discipline_fk); the column defaults to 'boxing'.
      await client.query(
        `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
         values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
        [ORG],
      );
      await expectFiveValueCheck(client);

      for (const value of ALL_VALUES) await insertDrill(client, value);
      const before = await storedRows(client);

      // The files a re-run of `all` puts against this CHECK, in the order the
      // workflow's `all` arm runs them (read from the workflow, not copied).
      const order = migrationApplyOrder({ infraDir: INFRA_DIR }).map((file) => path.basename(file));
      const touching = order.filter((file) => [V3_FILE, OWNER_AUTHORED_FILE, LONG_ROAD_FILE, CHECK_DROP_FILE].includes(file));
      expect(touching).toHaveLength(4);
      expect(touching.indexOf(LONG_ROAD_FILE)).toBeGreaterThan(touching.indexOf(OWNER_AUTHORED_FILE));
      expect(touching.indexOf(OWNER_AUTHORED_FILE)).toBeGreaterThan(touching.indexOf(V3_FILE));

      for (let round = 0; round < 2; round += 1) {
        for (const file of touching) {
          await client.query('BEGIN');
          await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
          await client.query('COMMIT');
        }
      }

      await expectFiveValueCheck(client);
      expect(await storedRows(client)).toEqual(before);
      await expect(insertDrill(client, LONG_ROAD)).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  test('the re-run set above is complete: no other migration names or drops a CHECK on this column', async () => {
    const files = (await fs.readdir(INFRA_DIR)).filter((name) => /^pilot_slice_postgres.*\.sql$/.test(name));
    const naming: string[] = [];
    const droppingDrillLibraryChecks: string[] = [];
    const reshapingTheColumn: string[] = [];
    for (const file of files) {
      const sql = await fs.readFile(path.join(INFRA_DIR, file), 'utf8');
      if (sql.includes(CONSTRAINT)) naming.push(file);
      if (sql.includes('drill_library') && /drop\s+constraint/i.test(sql)) droppingDrillLibraryChecks.push(file);
      if (/(alter|drop)\s+column\s+(if\s+exists\s+)?field_provenance/i.test(sql)) reshapingTheColumn.push(file);
    }
    expect(naming.sort()).toEqual([LONG_ROAD_FILE, OWNER_AUTHORED_FILE, V3_FILE].sort());
    // check-drop removes pilot_drill_library_discipline_check by name only; it is
    // in the re-run set above so the proof covers it anyway.
    expect(droppingDrillLibraryChecks.sort()).toEqual([CHECK_DROP_FILE, LONG_ROAD_FILE, OWNER_AUTHORED_FILE].sort());
    expect(reshapingTheColumn).toEqual([]);
  });
});

describe('the guard only skips a check that already holds every value', () => {
  test("v3's three-value CHECK is replaced with five", async () => {
    const client = await v3Database('ppbf_lr_from_v3');
    try {
      await insertDrill(client, SOURCE_MANUAL);
      await applyLongRoad(client, longRoadSql);
      await expectFiveValueCheck(client);
    } finally {
      await client.end();
    }
  });

  test("owner-authored's four-value CHECK (Long Road missing) is replaced with five", async () => {
    const client = await productionTodayDatabase('ppbf_lr_from_owner');
    try {
      expect(await admittedValues(client)).toEqual([...OLD_VALUES].sort());
      await applyLongRoad(client, longRoadSql);
      await expectFiveValueCheck(client);
    } finally {
      await client.end();
    }
  });

  test('owner-authored still replaces a narrower v3 CHECK (its guard does not stop the widening)', async () => {
    const client = await v3Database('ppbf_lr_owner_from_v3');
    try {
      await applyOwnerAuthored(client, ownerAuthoredSql);
      expect(await admittedValues(client)).toEqual([...OLD_VALUES].sort());
    } finally {
      await client.end();
    }
  });

  test('a second CHECK on the column is not a reason to skip: both go, one five-value CHECK remains', async () => {
    const client = await productionTodayDatabase('ppbf_lr_two_checks');
    try {
      await applyLongRoad(client, longRoadSql);
      await client.query(
        `alter table pilot.drill_library add constraint extra_field_provenance_check check (field_provenance <> '')`,
      );
      expect(await provenanceChecks(client)).toHaveLength(2);
      await applyLongRoad(client, longRoadSql);
      await expectFiveValueCheck(client);
    } finally {
      await client.end();
    }
  });

  test('a five-value CHECK under another name is replaced under the shared name', async () => {
    const client = await productionTodayDatabase('ppbf_lr_misnamed');
    try {
      await client.query(`alter table pilot.drill_library drop constraint ${CONSTRAINT}`);
      await client.query(
        `alter table pilot.drill_library add constraint stray_provenance_check
           check (field_provenance in (${ALL_VALUES.map((v) => `'${v}'`).join(', ')}))`,
      );
      await applyLongRoad(client, longRoadSql);
      await expectFiveValueCheck(client);
    } finally {
      await client.end();
    }
  });
});

describe('migration mechanics', () => {
  test('re-running is a no-op, and does not accumulate constraints', async () => {
    const client = await productionTodayDatabase('ppbf_lr_idempotent');
    try {
      await applyLongRoad(client, longRoadSql);
      await applyLongRoad(client, longRoadSql);
      await applyLongRoad(client, longRoadSql);
      await expectFiveValueCheck(client);
    } finally {
      await client.end();
    }
  });

  test('the SQL refuses to run before the drill library exists', async () => {
    const client = await emptyDatabase('ppbf_lr_bare');
    try {
      await client.query(baseSql);
      await expect(applyLongRoad(client, longRoadSql)).rejects.toThrow(/DRILL_LONG_ROAD_LABEL_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test('the readiness check REFUSES a no-op migration that changed nothing', async () => {
    const client = await productionTodayDatabase('ppbf_lr_noop');
    try {
      await expect(applyLongRoad(client, 'select 1')).rejects.toThrow(/DRILL_LONG_ROAD_LABEL_NOT_READY/);
      // And the four-value list is still in force: nothing was dropped on the way out.
      expect(await admittedValues(client)).toEqual([...OLD_VALUES].sort());
      await expect(insertDrill(client, LONG_ROAD)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('the readiness check REFUSES a migration that left the column unconstrained', async () => {
    const client = await productionTodayDatabase('ppbf_lr_dropped');
    try {
      await expect(
        applyLongRoad(client, `alter table pilot.drill_library drop constraint ${CONSTRAINT}`),
      ).rejects.toThrow(/DRILL_LONG_ROAD_LABEL_NOT_READY/);
      expect(await provenanceChecks(client)).toHaveLength(1);
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
  v3Sql = await fs.readFile(path.join(INFRA_DIR, V3_FILE), 'utf8');
  ownerAuthoredSql = await fs.readFile(path.join(INFRA_DIR, OWNER_AUTHORED_FILE), 'utf8');
  longRoadSql = await fs.readFile(path.join(INFRA_DIR, LONG_ROAD_FILE), 'utf8');

  const longRoadRunner = await nativeDynamicImport(pathToFileURL(LONG_ROAD_RUNNER_PATH).href);
  applyLongRoad = longRoadRunner.applyMigrationTransaction as ApplyMigration;
  const ownerRunner = await nativeDynamicImport(pathToFileURL(OWNER_AUTHORED_RUNNER_PATH).href);
  applyOwnerAuthored = ownerRunner.applyMigrationTransaction as ApplyMigration;
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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});
