import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

/* The schema half of W-D1, against real PostgreSQL.
 *
 * The promote route's own suite mocks the database, so nothing there can tell
 * whether the pointer it writes is actually constrained. These are the four
 * guarantees OD-2026-09-16-001 asks the schema to hold and that only a live
 * database can answer: the pointer is optional, it is organization-scoped, it
 * does not cascade, and the same reference drill cannot be promoted twice even
 * under a different operational name.
 *
 * Also asserted here, because the runner is the only thing standing between a
 * half-applied migration and a dispatch that reports success: the runner's
 * readiness query refuses a database missing any one of those guarantees, and
 * accepts a re-run. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_drill_reference_provenance';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-reference-provenance-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const BASE_SCHEMA_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres.sql');
// The drills migration adds a foreign key from pilot.drill_assignments, which the
// progression migration creates, so the chain starts there -- the same order
// drillVersioning.pg.test.ts uses and the same order the `all` list applies.
const PROGRESSION_MIGRATION = path.join(INFRA_DIR, 'pilot_slice_postgres_progression_migration.sql');
const DRILLS_MIGRATION = path.join(INFRA_DIR, 'pilot_slice_postgres_drills_migration.sql');
const DRILL_VERSIONING_MIGRATION = path.join(
  INFRA_DIR,
  'pilot_slice_postgres_drill_versioning_migration.sql',
);
const DRILL_LIBRARY_MIGRATION = path.join(
  INFRA_DIR,
  'pilot_slice_postgres_drill_library_v3_migration.sql',
);
const PROVENANCE_MIGRATION = path.join(
  INFRA_DIR,
  'pilot_slice_postgres_drill_reference_provenance_migration.sql',
);
const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-reference-provenance-migration.mjs',
);

const ORG_ID = 'org-wd1-home';
const OTHER_ORG_ID = 'org-wd1-elsewhere';
const REFERENCE_DRILL_ID = 'drl_wd1_reference';
const OTHER_ORG_REFERENCE_DRILL_ID = 'drl_wd1_reference_elsewhere';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let runner: {
  applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
};

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

// The dependency chain this migration sits on top of, applied in the same order
// the workflow's `all` list applies it.
async function applyDrillSchema(target: Client): Promise<void> {
  await target.query(await fs.readFile(BASE_SCHEMA_PATH, 'utf8'));
  await target.query(await fs.readFile(PROGRESSION_MIGRATION, 'utf8'));
  await target.query(await fs.readFile(DRILLS_MIGRATION, 'utf8'));
  await target.query(await fs.readFile(DRILL_VERSIONING_MIGRATION, 'utf8'));
  await target.query(await fs.readFile(DRILL_LIBRARY_MIGRATION, 'utf8'));
}

async function seedOrganizations(target: Client): Promise<void> {
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await target.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  // No pilot.disciplines rows: this chain stops at drill-library-v3, which
  // installs pilot_drill_library_discipline_check precisely when the later
  // discipline foreign key is absent. The default discipline 'boxing' satisfies
  // it, so the fixture needs no registry table it does not otherwise depend on.
}

async function seedReferenceDrill(
  target: Client,
  organizationId: string,
  drillId: string,
): Promise<void> {
  await target.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like)
     values ($1, $2, $2, $3, 'technical', 'b', 'p', 's', 'e', 'g', 'bad')
     on conflict do nothing`,
    [organizationId, drillId, `Reference ${drillId}`],
  );
}

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const fresh = new Client({ connectionString: connectionStringFor(name) });
  await fresh.connect();
  await applyDrillSchema(fresh);
  await seedOrganizations(fresh);
  return fresh;
}

async function insertOperationalDrill(
  target: Client,
  params: { drillId: string; name: string; organizationId?: string; referenceDrillId?: string | null },
): Promise<void> {
  await target.query(
    `insert into pilot.drills
       (organization_id, drill_id, name, category, focus, reference_drill_id)
     values ($1, $2, $3, 'technical', 'what it is for', $4)`,
    [
      params.organizationId ?? ORG_ID,
      params.drillId,
      params.name,
      params.referenceDrillId ?? null,
    ],
  );
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();
  await applyDrillSchema(client);
  await seedOrganizations(client);
  await seedReferenceDrill(client, ORG_ID, REFERENCE_DRILL_ID);
  await seedReferenceDrill(client, OTHER_ORG_ID, OTHER_ORG_REFERENCE_DRILL_ID);
  await client.query(await fs.readFile(PROVENANCE_MIGRATION, 'utf8'));

  runner = (await nativeDynamicImport(
    path.sep === '\\' ? `file:///${RUNNER_PATH.replace(/\\/g, '/')}` : RUNNER_PATH,
  )) as unknown as typeof runner;
});

afterAll(async () => {
  await client?.end();
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

afterEach(async () => {
  await client.query('delete from pilot.drills');
});

describe('pilot.drills.reference_drill_id', () => {
  test('a hand-authored operational drill may carry no reference pointer', async () => {
    // The whole existing library predates promotion, so NULL has to stay legal.
    await insertOperationalDrill(client, { drillId: 'op-hand-authored', name: 'Hand authored' });

    const stored = await client.query<{ reference_drill_id: string | null }>(
      `select reference_drill_id from pilot.drills where drill_id = 'op-hand-authored'`,
    );
    expect(stored.rows).toEqual([{ reference_drill_id: null }]);
  });

  test('a promoted drill keeps the exact reference drill id it came from', async () => {
    await insertOperationalDrill(client, {
      drillId: 'op-promoted',
      name: 'Promoted',
      referenceDrillId: REFERENCE_DRILL_ID,
    });

    const stored = await client.query<{ reference_drill_id: string | null }>(
      `select reference_drill_id from pilot.drills where drill_id = 'op-promoted'`,
    );
    expect(stored.rows).toEqual([{ reference_drill_id: REFERENCE_DRILL_ID }]);
  });

  test('the pointer cannot reach another gym reference drill', async () => {
    // The composite key is what makes this impossible. A scalar pointer would
    // have accepted it.
    await expect(
      insertOperationalDrill(client, {
        drillId: 'op-cross-org',
        name: 'Cross org',
        referenceDrillId: OTHER_ORG_REFERENCE_DRILL_ID,
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('a reference drill id that exists in no gym is refused', async () => {
    await expect(
      insertOperationalDrill(client, {
        drillId: 'op-ghost',
        name: 'Ghost',
        referenceDrillId: 'drl_never_existed',
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('deleting a promoted reference drill is refused rather than cascading away the operational drill', async () => {
    await insertOperationalDrill(client, {
      drillId: 'op-no-cascade',
      name: 'No cascade',
      referenceDrillId: REFERENCE_DRILL_ID,
    });

    await expect(
      client.query(`delete from pilot.drill_library where organization_id = $1 and drill_id = $2`, [
        ORG_ID,
        REFERENCE_DRILL_ID,
      ]),
    ).rejects.toMatchObject({ code: '23503' });

    const survived = await client.query(
      `select 1 from pilot.drills where drill_id = 'op-no-cascade'`,
    );
    expect(survived.rowCount).toBe(1);
  });

  test('the same reference drill cannot be promoted twice in one gym, even under a different name', async () => {
    // The name index cannot catch this: the second row carries a different
    // name, and only the reference pointer says it is the same drill.
    await insertOperationalDrill(client, {
      drillId: 'op-first',
      name: 'First promotion',
      referenceDrillId: REFERENCE_DRILL_ID,
    });

    await expect(
      insertOperationalDrill(client, {
        drillId: 'op-second',
        name: 'Second promotion under another name',
        referenceDrillId: REFERENCE_DRILL_ID,
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'pilot_drills_one_reference_per_org' });
  });

  test('two hand-authored drills with no pointer do not collide with each other', async () => {
    // The uniqueness is partial for this reason: NULL is not a value that can
    // be duplicated, and the gym may author as many unpromoted drills as it likes.
    await insertOperationalDrill(client, { drillId: 'op-null-1', name: 'Null one' });
    await insertOperationalDrill(client, { drillId: 'op-null-2', name: 'Null two' });

    const stored = await client.query(
      `select 1 from pilot.drills where reference_drill_id is null`,
    );
    expect(stored.rowCount).toBe(2);
  });

  test('two gyms may each promote their own copy of a same-named reference drill', async () => {
    await insertOperationalDrill(client, {
      drillId: 'op-home',
      name: 'Shared name',
      referenceDrillId: REFERENCE_DRILL_ID,
    });
    await insertOperationalDrill(client, {
      drillId: 'op-elsewhere',
      organizationId: OTHER_ORG_ID,
      name: 'Shared name',
      referenceDrillId: OTHER_ORG_REFERENCE_DRILL_ID,
    });

    const stored = await client.query<{ organization_id: string }>(
      `select organization_id from pilot.drills where name = 'Shared name' order by organization_id`,
    );
    expect(stored.rows.map((row) => row.organization_id).sort()).toEqual(
      [ORG_ID, OTHER_ORG_ID].sort(),
    );
  });
});

describe('the migration runner', () => {
  test('is idempotent: applying it twice leaves the same constraints in place', async () => {
    const sql = await fs.readFile(PROVENANCE_MIGRATION, 'utf8');
    await runner.applyMigrationTransaction(client, sql);
    await runner.applyMigrationTransaction(client, sql);

    const shape = await client.query<{ fk: number; uq: number }>(`
      select
        (select count(*) from pg_constraint
          where conname = 'pilot_drills_reference_drill_fk'
            and conrelid = to_regclass('pilot.drills')) as fk,
        (select count(*) from pg_class
          where relname = 'pilot_drills_one_reference_per_org') as uq
    `);
    expect(shape.rows[0]).toEqual({ fk: '1', uq: '1' });
  });

  test('refuses a database where the migration never ran', async () => {
    const fresh = await freshDatabase('ppbf_test_drill_reference_provenance_unmigrated');
    try {
      await expect(
        runner.applyMigrationTransaction(fresh, 'select 1'),
      ).rejects.toThrow('DRILL_REFERENCE_PROVENANCE_NOT_READY');
    } finally {
      await fresh.end();
    }
  });

  test('refuses a database where the column exists but the duplicate-protection index does not', async () => {
    // Readiness has to assert the guarantees, not merely that something ran.
    const fresh = await freshDatabase('ppbf_test_drill_reference_provenance_no_index');
    try {
      await fresh.query(await fs.readFile(PROVENANCE_MIGRATION, 'utf8'));
      await fresh.query('drop index pilot.pilot_drills_one_reference_per_org');

      await expect(
        runner.applyMigrationTransaction(fresh, 'select 1'),
      ).rejects.toThrow('DRILL_REFERENCE_PROVENANCE_NOT_READY');
    } finally {
      await fresh.end();
    }
  });

  test('refuses a database where the foreign key was dropped', async () => {
    const fresh = await freshDatabase('ppbf_test_drill_reference_provenance_no_fk');
    try {
      await fresh.query(await fs.readFile(PROVENANCE_MIGRATION, 'utf8'));
      await fresh.query('alter table pilot.drills drop constraint pilot_drills_reference_drill_fk');

      await expect(
        runner.applyMigrationTransaction(fresh, 'select 1'),
      ).rejects.toThrow('DRILL_REFERENCE_PROVENANCE_NOT_READY');
    } finally {
      await fresh.end();
    }
  });
});
