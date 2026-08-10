// Real PostgreSQL-backed contract test for the competence-cohorts and method-naming
// migrations (pilot.competence_levels, pilot.athlete_competence, pilot.v_athlete_tenure,
// pilot.cohort_definitions, pilot.methods) and their seed loader running against a real
// transaction.
//
// What needs proving, and cannot be proven by reading SQL or a mocked-query unit test:
//
// 1. pilot_cohortdef_reg_basis holds: a cohort with an age bound and no regulatory_basis is
//    rejected; the same row with a regulatory_basis is accepted.
// 2. pilot_athcomp_current (the partial unique index) holds: two "current" (superseded_by is
//    null) competence rows for the same athlete+domain is rejected; superseding the first
//    row before inserting a second is accepted.
// 3. pilot.v_athlete_tenure buckets tenure_band on training HOURS, not calendar time or
//    session count alone -- an athlete enrolled long ago with few logged minutes must not
//    land in 'established'.
// 4. seed-competence-cohorts.mjs loads exactly 6 levels and 6 cohorts, idempotently, and of
//    the 6 real seeded cohorts exactly one (Competition Squad) carries a regulatory_basis --
//    matching the README's claim that age survives as a regulatory floor on exactly one
//    cohort, not as a general grouping axis.
// 5. The method-naming migration's own insert lands the single 'reset_method' row and is
//    idempotent under re-application.
//
// Spins up the same disposable, local-only embedded Postgres the other migration suites
// use. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-competence-cohorts-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const COHORTS_MIGRATION_FILE = 'pilot_slice_postgres_competence_cohorts_migration.sql';
const METHOD_MIGRATION_FILE = 'pilot_slice_postgres_method_naming_migration.sql';
const COHORTS_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-competence-cohorts-migration.mjs',
);
const METHOD_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-method-naming-migration.mjs',
);
const SEED_LOADER_PATH = path.resolve(__dirname, '../../../scripts/seed-competence-cohorts.mjs');
const SEED_DIR = path.resolve(__dirname, '../../../seed-data/competence-cohorts');
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
];

const ORG_A = 'org-competence-cohorts-a';
const COACH_A = 'acct-competence-cohorts-coach-a';
const ATHLETE_A = 'athlete-competence-cohorts-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string[];
let cohortsMigrationSql: string;
let methodMigrationSql: string;
let applyCohortsMigration: (client: Client, sql: string) => Promise<void>;
let applyMethodMigration: (client: Client, sql: string) => Promise<void>;
let seedAll: (
  client: Client,
  seedDir: string,
  placeholders: { organizationId: string },
  opts?: { dryRun?: boolean },
) => Promise<void>;

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  for (const sql of baseSchemaSql) {
    await client.query(sql);
  }

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_A, ORG_A],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Test Athlete', '2010-01-01', 'unassigned', 'active', 'n/a', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_A, ATHLETE_A, COACH_A],
  );

  return client;
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

  baseSchemaSql = await Promise.all(
    SCHEMA_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  cohortsMigrationSql = await fs.readFile(path.join(INFRA_DIR, COHORTS_MIGRATION_FILE), 'utf8');
  methodMigrationSql = await fs.readFile(path.join(INFRA_DIR, METHOD_MIGRATION_FILE), 'utf8');

  const cohortsRunner = await nativeDynamicImport(pathToFileURL(COHORTS_RUNNER_PATH).href);
  applyCohortsMigration = cohortsRunner.applyMigrationTransaction as typeof applyCohortsMigration;

  const methodRunner = await nativeDynamicImport(pathToFileURL(METHOD_RUNNER_PATH).href);
  applyMethodMigration = methodRunner.applyMigrationTransaction as typeof applyMethodMigration;

  const seedModule = await nativeDynamicImport(pathToFileURL(SEED_LOADER_PATH).href);
  seedAll = seedModule.seedAll as typeof seedAll;
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
});

describe('competence cohorts migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_competence_cohorts_readiness_negative');
    try {
      await expect(applyCohortsMigration(client, 'select 1')).rejects.toThrow(
        /COMPETENCE_COHORTS_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.competence_levels') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_competence_cohorts_idempotent');
    try {
      await applyCohortsMigration(client, cohortsMigrationSql);
      await applyCohortsMigration(client, cohortsMigrationSql);
      await applyCohortsMigration(client, cohortsMigrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_complevel_pkey', 'pilot_cohortdef_reg_basis', 'pilot_cohortdef_pkey')`,
      );
      expect(constraints.rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });
});

describe('method naming migration against real Postgres', () => {
  test('lands exactly one reset_method row and is idempotent', async () => {
    const client = await freshDatabase('ppbf_test_method_naming');
    try {
      await applyMethodMigration(client, methodMigrationSql);
      await applyMethodMigration(client, methodMigrationSql);
      await applyMethodMigration(client, methodMigrationSql);

      const rows = await client.query(`select method_key, display_name, cycle_phases from pilot.methods`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].method_key).toBe('reset_method');
      expect(rows.rows[0].display_name).toBe('Reset Method');
      expect(rows.rows[0].cycle_phases).toBe('observe -> decide -> execute -> reset');
    } finally {
      await client.end();
    }
  });
});

describe('pilot_cohortdef_reg_basis', () => {
  let client: Client;

  beforeEach(async () => {
    client = await freshDatabase('ppbf_test_cohortdef_reg_basis');
    await applyCohortsMigration(client, cohortsMigrationSql);
  });

  afterEach(async () => {
    await client.end();
  });

  test('an age bound with no regulatory_basis is rejected', async () => {
    await expect(
      client.query(
        `insert into pilot.cohort_definitions
           (organization_id, cohort_id, cohort_name, min_age_regulatory)
         values ($1, 'coh-invented-age', 'Invented Age Band', 8)`,
        [ORG_A],
      ),
    ).rejects.toThrow(/pilot_cohortdef_reg_basis/);
  });

  test('the same age bound with a regulatory_basis is accepted', async () => {
    const result = await client.query(
      `insert into pilot.cohort_definitions
         (organization_id, cohort_id, cohort_name, min_age_regulatory, regulatory_basis)
       values ($1, 'coh-cited-age', 'Competition Squad', 8, 'USA Boxing minimum competition age')
       returning cohort_id`,
      [ORG_A],
    );
    expect(result.rows[0].cohort_id).toBe('coh-cited-age');
  });

  test('no age bound at all needs no regulatory_basis', async () => {
    const result = await client.query(
      `insert into pilot.cohort_definitions (organization_id, cohort_id, cohort_name)
       values ($1, 'coh-no-age', 'Open Floor')
       returning cohort_id`,
      [ORG_A],
    );
    expect(result.rows[0].cohort_id).toBe('coh-no-age');
  });
});

describe('pilot_athcomp_current partial unique index', () => {
  let client: Client;

  beforeEach(async () => {
    client = await freshDatabase('ppbf_test_athcomp_current');
    await applyCohortsMigration(client, cohortsMigrationSql);
    await client.query(
      `insert into pilot.competence_levels (organization_id, level_key, ordinal, display_name, observable_test)
       values ($1, 'exploring', 1, 'Exploring', 'Attempts it.'),
              ($1, 'forming', 2, 'Forming', 'Correct when cued.')`,
      [ORG_A],
    );
  });

  afterEach(async () => {
    await client.end();
  });

  test('a second current row for the same athlete+domain is rejected', async () => {
    await client.query(
      `insert into pilot.athlete_competence
         (organization_id, competence_id, athlete_id, domain, level_key, basis, assessed_by_account_id, assessed_on)
       values ($1, 'comp-1', $2, 'footwork', 'exploring', 'coach_observation', $3, current_date)`,
      [ORG_A, ATHLETE_A, COACH_A],
    );

    await expect(
      client.query(
        `insert into pilot.athlete_competence
           (organization_id, competence_id, athlete_id, domain, level_key, basis, assessed_by_account_id, assessed_on)
         values ($1, 'comp-2', $2, 'footwork', 'forming', 'coach_observation', $3, current_date)`,
        [ORG_A, ATHLETE_A, COACH_A],
      ),
    ).rejects.toThrow(/pilot_athcomp_current/);
  });

  test('superseding the first row before inserting a second is accepted, and history survives', async () => {
    await client.query(
      `insert into pilot.athlete_competence
         (organization_id, competence_id, athlete_id, domain, level_key, basis, assessed_by_account_id, assessed_on)
       values ($1, 'comp-1', $2, 'footwork', 'exploring', 'coach_observation', $3, current_date)`,
      [ORG_A, ATHLETE_A, COACH_A],
    );
    // Must supersede comp-1 BEFORE inserting comp-2 -- the partial unique index enforces "at
    // most one current row" at insert time, so a second current row while comp-1 is still
    // current is exactly the case the previous test proves gets rejected.
    await client.query(
      `update pilot.athlete_competence set superseded_by = 'comp-2' where organization_id = $1 and competence_id = 'comp-1'`,
      [ORG_A],
    );
    await client.query(
      `insert into pilot.athlete_competence
         (organization_id, competence_id, athlete_id, domain, level_key, basis, assessed_by_account_id, assessed_on)
       values ($1, 'comp-2', $2, 'footwork', 'forming', 'coach_observation', $3, current_date)`,
      [ORG_A, ATHLETE_A, COACH_A],
    );

    const history = await client.query(
      `select competence_id, superseded_by from pilot.athlete_competence
       where organization_id = $1 and athlete_id = $2 order by competence_id`,
      [ORG_A, ATHLETE_A],
    );
    expect(history.rows).toEqual([
      { competence_id: 'comp-1', superseded_by: 'comp-2' },
      { competence_id: 'comp-2', superseded_by: null },
    ]);
  });

  test('an assessment_result basis with no assessment_id is rejected', async () => {
    await expect(
      client.query(
        `insert into pilot.athlete_competence
           (organization_id, competence_id, athlete_id, domain, level_key, basis, assessed_by_account_id, assessed_on)
         values ($1, 'comp-3', $2, 'defense', 'exploring', 'assessment_result', $3, current_date)`,
        [ORG_A, ATHLETE_A, COACH_A],
      ),
    ).rejects.toThrow(/pilot_athcomp_assessment_basis/);
  });
});

describe('pilot.v_athlete_tenure', () => {
  let client: Client;

  beforeEach(async () => {
    client = await freshDatabase('ppbf_test_athlete_tenure');
    await applyCohortsMigration(client, cohortsMigrationSql);
  });

  afterEach(async () => {
    await client.end();
  });

  async function logActivity(startingOccurredOn: string, durationMinutes: number, count = 1) {
    // pilot_activity_log_one_per_occurrence is keyed on (person, occurred_on, domain, class,
    // started_at) -- one row per session on a given day for a given person. Each iteration
    // needs its own occurred_on to represent a distinct session, not the same day repeated.
    const start = new Date(`${startingOccurredOn}T00:00:00Z`);
    for (let i = 0; i < count; i += 1) {
      const occurredOn = new Date(start.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await client.query(
        `insert into pilot.activity_log
           (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type,
            occurred_on, duration_minutes, capture_method, recorded_by_role, recorded_by_account_id)
         values ($1, $2, $5, $3, 'boxing_training', 'technical_session', $4, $6, 'coach_override', 'coach', $5)`,
        [ORG_A, `act-${occurredOn}-${i}-${durationMinutes}`, ATHLETE_A, occurredOn, COACH_A, durationMinutes],
      );
    }
  }

  test('an athlete enrolled long ago but rarely attending is NOT banded as established', async () => {
    // Enrolled 18 months ago, but attended only twice for 60 minutes each -- 2 hours total.
    await logActivity('2025-02-01', 60, 1);
    await logActivity('2025-03-01', 60, 1);

    const result = await client.query(
      `select tenure_band, sessions_logged, hours_logged from pilot.v_athlete_tenure
       where organization_id = $1 and athlete_id = $2`,
      [ORG_A, ATHLETE_A],
    );
    expect(Number(result.rows[0].sessions_logged)).toBe(2);
    expect(result.rows[0].tenure_band).toBe('insufficient_history');
  });

  test('a high volume of training hours bands as established regardless of when it started', async () => {
    // 20 sessions of 8 hours (480 min) each = 9600 minutes = 160 hours, well past the 9000-minute floor.
    await logActivity('2026-08-01', 480, 20);

    const result = await client.query(
      `select tenure_band, hours_logged from pilot.v_athlete_tenure
       where organization_id = $1 and athlete_id = $2`,
      [ORG_A, ATHLETE_A],
    );
    expect(Number(result.rows[0].hours_logged)).toBeCloseTo(160, 1);
    expect(result.rows[0].tenure_band).toBe('established');
  });
});

describe('seed-competence-cohorts.mjs against real Postgres', () => {
  test('seeds exactly 6 competence levels and 6 cohort definitions', async () => {
    const client = await freshDatabase('ppbf_test_competence_cohorts_seed');
    try {
      await applyCohortsMigration(client, cohortsMigrationSql);
      await seedAll(client, SEED_DIR, { organizationId: ORG_A });

      const levels = await client.query(`select count(*)::int as n from pilot.competence_levels where organization_id = $1`, [ORG_A]);
      const cohorts = await client.query(`select count(*)::int as n from pilot.cohort_definitions where organization_id = $1`, [ORG_A]);
      expect(levels.rows[0].n).toBe(6);
      expect(cohorts.rows[0].n).toBe(6);
    } finally {
      await client.end();
    }
  });

  test('exactly one of the 6 seeded cohorts carries a regulatory_basis, and it is Competition Squad', async () => {
    const client = await freshDatabase('ppbf_test_competence_cohorts_seed_reg_basis');
    try {
      await applyCohortsMigration(client, cohortsMigrationSql);
      await seedAll(client, SEED_DIR, { organizationId: ORG_A });

      const withRegBasis = await client.query(
        `select cohort_name, min_age_regulatory, regulatory_basis from pilot.cohort_definitions
         where organization_id = $1 and regulatory_basis <> ''`,
        [ORG_A],
      );
      expect(withRegBasis.rows).toHaveLength(1);
      expect(withRegBasis.rows[0].cohort_name).toBe('Competition Squad');
      expect(withRegBasis.rows[0].min_age_regulatory).toBe(8);
    } finally {
      await client.end();
    }
  });

  test('re-running is idempotent: no duplicates, no error', async () => {
    const client = await freshDatabase('ppbf_test_competence_cohorts_seed_idempotent');
    try {
      await applyCohortsMigration(client, cohortsMigrationSql);
      await seedAll(client, SEED_DIR, { organizationId: ORG_A });
      await seedAll(client, SEED_DIR, { organizationId: ORG_A });

      const levels = await client.query(`select count(*)::int as n from pilot.competence_levels where organization_id = $1`, [ORG_A]);
      expect(levels.rows[0].n).toBe(6);
    } finally {
      await client.end();
    }
  });

  test('--dry-run writes nothing', async () => {
    const client = await freshDatabase('ppbf_test_competence_cohorts_seed_dry_run');
    try {
      await applyCohortsMigration(client, cohortsMigrationSql);
      await seedAll(client, SEED_DIR, { organizationId: ORG_A }, { dryRun: true });

      const levels = await client.query(`select count(*)::int as n from pilot.competence_levels where organization_id = $1`, [ORG_A]);
      expect(levels.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
