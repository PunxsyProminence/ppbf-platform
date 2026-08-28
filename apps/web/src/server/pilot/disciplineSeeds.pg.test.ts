// Real PostgreSQL-backed test for the discipline registry a new gym starts with.
//
// WHAT CANNOT BE PROVEN BY READING CODE, and is the whole reason this file
// exists: pilot.drill_library, pilot.session_scripts and pilot.cohort_definitions
// each carry a composite foreign key to pilot.disciplines AND default their
// discipline column to 'boxing'. So a gym whose registry is empty cannot hold a
// drill, a session script or a cohort at all -- including rows that never name a
// discipline, because the default is itself an unregistered reference.
//
// createOrganization is the path that creates a gym after an operator has run
// the seed loaders, and the loaders only ever seed one organization per run.
// Before this, such a gym was created with an empty registry and met a bare
// 23503 at its first training-content write, a long way from the cause.
//
// The negative control below is the load-bearing case. It creates an
// organization the way the platform used to -- a bare insert, no seeding -- and
// proves the same write fails. Without it, every other case here would still
// pass if seedDefaultDisciplines were deleted tomorrow, because a test that
// only ever exercises the fixed path cannot tell the fix from its absence.
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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-discipline-seeds-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_discipline_seeds';

/** Base schema, then every migration these two tables and their FKs need. */
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // The compliance migration references pilot.video_sessions, so it comes first.
  'pilot_slice_postgres_video_sessions_migration.sql',
  'pilot_slice_postgres_compliance_migration.sql',
  'pilot_slice_postgres_safety_gate_matrix_migration.sql',
  // multidiscipline's grappling_exposure references pilot.activity_log, and it
  // ALTERS pilot.drill_library -- so the v3 library has to exist before it, the
  // same order apply-migrations.yml's `all` list uses (v3 at 50, multidiscipline
  // at 63). Getting this backwards is what the ordering assertion in
  // migrationDispatchCoverage.test.ts exists to catch.
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_multidiscipline_migration.sql',
  'pilot_slice_postgres_session_scripts_migration.sql',
  'pilot_slice_postgres_competence_cohorts_migration.sql',
  'pilot_slice_postgres_drill_library_discipline_fk_migration.sql',
  'pilot_slice_postgres_session_scripts_discipline_fk_migration.sql',
  'pilot_slice_postgres_cohort_definitions_discipline_fk_migration.sql',
];

const FOREIGN_KEY_VIOLATION = '23503';

const SEEDED_ORG = 'org-seeded-by-create';
const BARE_ORG = 'org-created-the-old-way';
const CREATOR = 'acct-platform-owner';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let auth: typeof import('./auth');
let seeds: typeof import('./disciplineSeeds');

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

async function freshClient(): Promise<Client> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  return client;
}

/** A drill naming no discipline, so the column default is what is tested. */
async function insertDrillUsingTheDefault(client: Client, organizationId: string, drillId: string) {
  return client.query(
    `insert into pilot.drill_library (
       organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
       standard_setup, execution, what_good_looks_like, what_bad_looks_like
     )
     values ($1, $2, $2, $3, 'defense', 'behavior', 'purpose', 'setup', 'execution', 'good', 'bad')`,
    [organizationId, drillId, `Drill ${drillId}`],
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  for (const file of MIGRATIONS) {
    await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  auth = await import('./auth');
  seeds = await import('./disciplineSeeds');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();

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

describe('a gym created after the operator seed run', () => {
  test('starts with the whole discipline registry', async () => {
    await auth.createOrganization(SEEDED_ORG, 'Seeded Gym', CREATOR);

    const client = await freshClient();
    try {
      const rows = await client.query(
        'select discipline, active from pilot.disciplines where organization_id = $1 order by discipline',
        [SEEDED_ORG],
      );

      expect(rows.rows.map((row) => row.discipline)).toEqual(
        [...seeds.DEFAULT_DISCIPLINES].map((seed) => seed.discipline).sort(),
      );
      // Registered is not the same as running: three lanes ship inactive.
      expect(rows.rows.filter((row) => row.active).map((row) => row.discipline))
        .toEqual(['boxing', 'conditioning']);
    } finally {
      await client.end();
    }
  });

  test('can hold a drill that names no discipline, which is the column default', async () => {
    // THE HAZARD, stated as the write that used to fail. 'boxing' is never
    // mentioned by this insert; it arrives from the column default and is a
    // foreign key reference like any other.
    const client = await freshClient();
    try {
      await expect(insertDrillUsingTheDefault(client, SEEDED_ORG, 'drl-default')).resolves.toBeDefined();

      const stored = await client.query(
        'select discipline from pilot.drill_library where organization_id = $1 and drill_id = $2',
        [SEEDED_ORG, 'drl-default'],
      );
      expect(stored.rows[0].discipline).toBe('boxing');
    } finally {
      await client.end();
    }
  });

  test('can hold a session script that names no discipline either', async () => {
    const client = await freshClient();
    try {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
        [CREATOR, SEEDED_ORG],
      );

      await expect(
        client.query(
          `insert into pilot.session_scripts (
             organization_id, script_id, lineage_id, name, created_by_account_id
           )
           values ($1, 'scr-default', 'scr-default', 'Default script', $2)`,
          [SEEDED_ORG, CREATOR],
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  test('can hold a cohort definition, which is the one that gates contact', async () => {
    // Third table, same default, and the one with a safety consequence: a
    // cohort is what decides whether an athlete may take contact. A gym that
    // cannot write one has no contact gating at all.
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.cohort_definitions (organization_id, cohort_id, cohort_name)
           values ($1, 'coh-default', 'Beginners')`,
          [SEEDED_ORG],
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });
});

describe('the control: a gym created the way the platform used to', () => {
  test('cannot hold a drill at all, which is what this seeding prevents', async () => {
    // NOT A HYPOTHETICAL. This is the row createOrganization wrote before the
    // seeding was added, and the error a gym met at its first drill. If
    // seedDefaultDisciplines were removed, every case above would fail and
    // this one would still pass -- which is how this file tells the fix from
    // its absence.
    const client = await freshClient();
    try {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, 'Unseeded Gym', 'active') on conflict do nothing`,
        [BARE_ORG],
      );

      await expect(insertDrillUsingTheDefault(client, BARE_ORG, 'drl-doomed'))
        .rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    } finally {
      await client.end();
    }
  });
});

describe('re-running it', () => {
  test('adds no duplicate and does not overturn what the gym decided', async () => {
    // The registry's own key makes the insert a no-op, and that matters
    // because a gym deactivating a lane it does not run is a decision. A
    // second create must not switch wrestling back on.
    const client = await freshClient();
    try {
      await client.query(
        `update pilot.disciplines set active = true, display_name = 'Folkstyle Wrestling'
         where organization_id = $1 and discipline = 'wrestling'`,
        [SEEDED_ORG],
      );

      await auth.createOrganization(SEEDED_ORG, 'Seeded Gym', CREATOR);

      const rows = await client.query(
        'select display_name, active from pilot.disciplines where organization_id = $1 and discipline = $2',
        [SEEDED_ORG, 'wrestling'],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].display_name).toBe('Folkstyle Wrestling');
      expect(rows.rows[0].active).toBe(true);

      const total = await client.query(
        'select count(*)::int as n from pilot.disciplines where organization_id = $1',
        [SEEDED_ORG],
      );
      expect(total.rows[0].n).toBe(seeds.DEFAULT_DISCIPLINES.length);
    } finally {
      await client.end();
    }
  });
});
