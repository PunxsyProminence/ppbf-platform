// What a migration runner's green light is actually worth.
//
// WHY THIS FILE EXISTS
//   Every pilot-apply-*.mjs runner ends by querying the database and
//   asserting its own migration landed. #488 shipped one that could never
//   pass (it matched `between 1 and 5` against a CHECK Postgres deparses as
//   `>= 1 AND <= 5`), and it failed loudly on a staging dispatch. The
//   inverse defect is quieter and worse: an assertion that can never FAIL.
//   Seven runners were reported as accepting a database their migration had
//   never reached. An operator gets a green attestation that proves nothing,
//   and a migration that silently did not apply is discovered from a 500 in
//   the gym rather than from the dispatch.
//
//   Driving each runner against a base-schema-only database (base schema
//   applied, migration NOT applied, `select 1` standing in for the migration
//   SQL) reproduced it exactly. All seven accepted. The cause is the same in
//   every case and it is not a typo in a query: pilot_slice_postgres.sql --
//   the bootstrap a new environment is built from -- already declares
//   everything these migrations create. The migrations exist for databases
//   that predate the base schema absorbing them.
//
//   That splits the seven in two, and the split is what this file records.
//
//   TWO had something to assert and now do. Their migrations contribute a
//   DATA effect the base schema does not: a backfill, and two seed rows.
//   Both runners now assert that effect and refuse a database that lacks it;
//   safetyGateMatrix.pg.test.ts and researchRequirementSubject.pg.test.ts
//   carry the detailed cases.
//
//   FIVE have nothing to assert, and no honest assertion exists to write.
//   Their SQL is a strict subset of the base schema -- applying it to a
//   base-schema database changes no table, column, index, constraint,
//   default, or row. `assertsNothingBeyondBaseSchema` below PROVES that per
//   runner rather than asserting it in prose, by diffing the full pilot
//   catalog across the migration. Inventing an assertion for these would
//   mean asserting something the migration does not produce -- a check that
//   fails on a correctly migrated database, which is #488 again.
//
//   The empty-delta tests are the forcing function. The day any of these
//   five migrations grows a real artifact, its delta test fails, and whoever
//   added the artifact is told -- at that moment, not during a dispatch --
//   that the runner's readiness assertion is now able to detect a failure
//   and needs to.
//
// Spins up the same disposable, local-only embedded Postgres every other
// migration suite uses. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-readiness-gates-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SCRIPTS_DIR = path.join(WEB_DIR, 'scripts');
const SERVER_SCRIPT_PATH = path.join(SCRIPTS_DIR, 'test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const WORKFLOW_PATH = path.resolve(__dirname, '../../../../../.github/workflows/apply-migrations.yml');

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules. Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type RunnerModule = {
  applyMigrationTransaction?: (client: Client, sql: string) => Promise<void>;
  run?: () => Promise<void>;
};

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;

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

/**
 * The runners are loaded out of apps/web/scripts, never reimplemented here.
 * The READINESS_QUERY these assertions exercise is therefore the one that
 * ships and the one a dispatch runs -- restating it in this file would let
 * the copy stay correct while the shipped one rots, which is precisely the
 * failure being regression-tested.
 */
async function loadRunner(basename: string): Promise<RunnerModule> {
  return (await nativeDynamicImport(
    pathToFileURL(path.join(SCRIPTS_DIR, basename)).href,
  )) as RunnerModule;
}

async function loadApply(basename: string): Promise<(client: Client, sql: string) => Promise<void>> {
  const runnerModule = await loadRunner(basename);
  expect(typeof runnerModule.applyMigrationTransaction).toBe('function');
  return runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
}

function migration(file: string): Promise<string> {
  return fs.readFile(path.join(INFRA_DIR, file), 'utf8');
}

let databaseCounter = 0;

/** A database at exactly the state a new environment is bootstrapped into. */
async function namedBaseSchemaDatabase(prefix: string): Promise<{ client: Client; name: string }> {
  const name = `${prefix}_${databaseCounter += 1}`;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  return { client, name };
}

async function baseSchemaDatabase(prefix: string): Promise<Client> {
  const { client } = await namedBaseSchemaDatabase(prefix);
  return client;
}

/** A gym, a coach, an athlete: the rows a seed or backfill has work to do against. */
async function seedGym(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ('org-gates', 'Gates Gym', 'active')`,
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ('acct-gates', 'coach', 'org-gates', 'microsoft')`,
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ('org-gates', 'ath-gates', 'Gates Athlete', '2012-01-01', 'fly', 'active',
             'Guardian 555-0100', true, 'acct-gates', now(), now())`,
  );
}

/**
 * Every artifact the pilot schema holds, as comparable strings.
 *
 * Constraints are read through pg_get_constraintdef() -- Postgres's own
 * deparse of the parsed tree, the very thing #488 got wrong by matching the
 * source text instead. Comparing two deparses of the same server sidesteps
 * that: whatever Postgres emits, it emits identically on both sides, so a
 * difference here is a real difference in the database.
 */
const CATALOG_SNAPSHOT = `
  select 'COLUMN ' || table_name || '.' || column_name || ' ' || data_type
         || ' null=' || is_nullable || ' default=' || coalesce(column_default, '-') as item
  from information_schema.columns
  where table_schema = 'pilot'
  union all
  select 'CONSTRAINT ' || conrelid::regclass::text || ' ' || conname
         || ' :: ' || pg_get_constraintdef(oid)
  from pg_constraint
  where connamespace = 'pilot'::regnamespace
  union all
  select 'INDEX ' || indexname || ' :: ' || indexdef
  from pg_indexes
  where schemaname = 'pilot'
  order by 1
`;

async function catalogOf(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ item: string }>(CATALOG_SNAPSHOT);
  return rows.map((row) => row.item);
}

async function rowCensusOf(client: Client): Promise<Record<string, number>> {
  const { rows: tables } = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'pilot' and table_type = 'BASE TABLE' order by 1`,
  );
  const census: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from pilot.${table}`);
    census[table] = Number(rows[0].n);
  }
  return census;
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

  baseSchemaSql = await migration('pilot_slice_postgres.sql');
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

// ---------------------------------------------------------------------------
// The five runners whose migration adds nothing the base schema does not.
// ---------------------------------------------------------------------------

const BASE_SCHEMA_SUBSUMED = [
  {
    name: 'coach-coverage',
    runner: 'pilot-apply-coach-coverage-migration.mjs',
    sql: 'pilot_slice_postgres_coach_coverage_migration.sql',
    sentinel: 'COACH_COVERAGE_NOT_READY',
    // pilot.coach_coverage, pilot_coach_coverage_athlete_fk,
    // pilot_coach_coverage_window_check and idx_pilot_coach_coverage_lookup
    // are all declared verbatim by the base schema.
  },
  {
    name: 'dead-schema-removal',
    runner: 'pilot-apply-dead-schema-removal-migration.mjs',
    sql: 'pilot_slice_postgres_dead_schema_removal_migration.sql',
    sentinel: 'DEAD_SCHEMA_REMOVAL_NOT_READY',
    // A DROP-only migration. Its own comments record that the create
    // statements for pilot.messages/skills/staff were removed from the base
    // schema in the same change, so a database built from the base schema
    // never had them and there is no positive artifact to assert. What the
    // runner checks -- all three absent -- is the correct end state and does
    // fail on the only database where this migration has work to do.
  },
  {
    name: 'safety-escalations',
    runner: 'pilot-apply-safety-escalations-migration.mjs',
    sql: 'pilot_slice_postgres_safety_escalations_migration.sql',
    sentinel: 'SAFETY_ESCALATIONS_NOT_READY',
    // The table, the widened source_type vocabulary the DO block repairs, and
    // both indexes are all in the base schema. The vocabulary clauses do fail
    // on a database still carrying the pre-widening constraint, which is the
    // state the DO block exists for.
  },
  {
    name: 'scheduler-tables',
    runner: 'pilot-apply-scheduler-tables-migration.mjs',
    sql: 'pilot_slice_postgres_scheduler_tables_migration.sql',
    sentinel: 'SCHEDULER_TABLES_NOT_READY',
    // All four tables and all five indexes are in the base schema, which is
    // in fact AHEAD of this migration: the base schema's
    // scheduler_attendance.method already admits 'parent', widened later by
    // the attendance-parent-method migration.
  },
  {
    name: 'training-holds',
    runner: 'pilot-apply-training-holds-migration.mjs',
    sql: 'pilot_slice_postgres_training_holds_migration.sql',
    sentinel: 'TRAINING_HOLDS_NOT_READY',
    // pilot.training_holds, both named constraints, and both indexes
    // (including the partial unique idx_training_holds_one_active) are
    // declared verbatim by the base schema.
  },
] as const;

describe.each(BASE_SCHEMA_SUBSUMED)(
  '$name: the base schema already contains everything the migration creates',
  ({ name, runner, sql, sentinel }) => {
    test('applying the migration to a base-schema database changes nothing', async () => {
      const client = await baseSchemaDatabase(`gates_delta_${name.replace(/-/g, '_')}`);
      try {
        await seedGym(client);

        const beforeCatalog = await catalogOf(client);
        const beforeRows = await rowCensusOf(client);

        await client.query(await migration(sql));

        const afterCatalog = await catalogOf(client);
        const afterRows = await rowCensusOf(client);

        // If this ever fails, the migration grew something real. Read the
        // diff, then go strengthen the runner's READINESS_QUERY to assert it
        // -- that is now possible, and until it happens the runner's green
        // light still means nothing.
        expect(afterCatalog).toEqual(beforeCatalog);
        expect(afterRows).toEqual(beforeRows);
      } finally {
        await client.end();
      }
    });

    // THE CONSEQUENCE, stated as a test rather than left in a comment.
    //
    // This is NOT a behavior worth having. It is pinned because it is the
    // documented, reproduced state of a shipped runner, and because leaving
    // it undocumented is how it survived this long. The test above is what
    // makes it defensible: there is provably nothing for the assertion to
    // key on, so the alternative is not a better assertion, it is a fabricated
    // one that fails on correctly migrated databases.
    //
    // The fix is a schema fact, not a query: give the migration something the
    // base schema does not have (a migration ledger row would do it for all
    // five at once), then assert that. Until then a dispatch of one of these
    // five attests that the END STATE is right -- which it verifies honestly
    // -- and not that this migration ran.
    test('so its readiness assertion cannot refuse a database the migration never reached', async () => {
      const applyMigrationTransaction = await loadApply(runner);
      const client = await baseSchemaDatabase(`gates_accept_${name.replace(/-/g, '_')}`);
      try {
        await seedGym(client);

        // 'select 1' stands in for the migration SQL: the transaction opens,
        // no migration runs, and the readiness query is asked anyway.
        await expect(applyMigrationTransaction(client, 'select 1')).resolves.toBeUndefined();
        expect(sentinel).toMatch(/_NOT_READY$/);
      } finally {
        await client.end();
      }
    });

    test('and it still ACCEPTS a migrated database, twice over', async () => {
      const applyMigrationTransaction = await loadApply(runner);
      const client = await baseSchemaDatabase(`gates_ok_${name.replace(/-/g, '_')}`);
      try {
        await seedGym(client);
        const migrationSql = await migration(sql);
        await applyMigrationTransaction(client, migrationSql);
        // The `all` chain re-runs every migration on every dispatch (#489),
        // so the second pass has to survive its own first pass.
        await applyMigrationTransaction(client, migrationSql);
      } finally {
        await client.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// The two that had a real effect to assert, and now assert it.
// ---------------------------------------------------------------------------

describe('the two runners whose migration does contribute something', () => {
  test('safety-gate-matrix seeds gates the base schema does not, and now refuses a gym missing them', async () => {
    const applyMigrationTransaction = await loadApply('pilot-apply-safety-gate-matrix-migration.mjs');
    const client = await baseSchemaDatabase('gates_sgm');
    try {
      await seedGym(client);

      // The delta is rows, not schema: the base schema creates both tables
      // and both indexes but seeds nothing.
      const before = await catalogOf(client);
      await client.query(await migration('pilot_slice_postgres_safety_gate_matrix_migration.sql'));
      expect(await catalogOf(client)).toEqual(before);

      const seeded = await client.query<{ gate_key: string }>(
        `select gate_key from pilot.safety_gates where organization_id = 'org-gates' order by gate_key`,
      );
      expect(seeded.rows.map((row) => row.gate_key)).toEqual(['contact_medical_clearance', 'training_hold']);

      // Both gates are required now, not just the first.
      await client.query(`delete from pilot.safety_gates where gate_key = 'training_hold'`);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SAFETY_GATE_MATRIX_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('research-requirement-subject backfills subject_id, and now refuses a database that never did', async () => {
    const applyMigrationTransaction = await loadApply(
      'pilot-apply-research-requirement-subject-migration.mjs',
    );
    const client = await baseSchemaDatabase('gates_rrs');
    try {
      await seedGym(client);
      await client.query(
        `insert into pilot.shadow_research_requirements
           (organization_id, source_event_name, source_entity_type, source_entity_id,
            research_requirement, knowledge_gap, evidence_label, source_status,
            source_confidence_tier, source_verification_state, created_by_account_id,
            created_by_role, metadata)
         values ('org-gates', 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED', 'shadow_library_claim',
                 'ath-gates', 'Strengthen evidence', 'Evidence is thin', 'ath-gates', 'weak',
                 'INSUFFICIENT', 'unknown', 'acct-gates', 'coach', '{}'::jsonb)`,
      );

      // The column is in the base schema. The BACKFILL is not.
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /RESEARCH_REQUIREMENT_SUBJECT_NOT_READY/,
      );

      const migrationSql = await migration(
        'pilot_slice_postgres_research_requirement_subject_migration.sql',
      );
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const backfilled = await client.query<{ subject_id: string | null }>(
        'select subject_id from pilot.shadow_research_requirements',
      );
      expect(backfilled.rows).toEqual([{ subject_id: 'ath-gates' }]);
    } finally {
      await client.end();
    }
  });
});

// ---------------------------------------------------------------------------
// The whole `all` chain, through every runner's real entrypoint, in the real
// order, twice.
// ---------------------------------------------------------------------------

/**
 * The migration order is read out of apply-migrations.yml rather than
 * restated, so this test cannot drift from the workflow a dispatch actually
 * runs. The workflow's own comment calls the list hand-maintained and
 * therefore a hazard; reading it here means a reordering that breaks a
 * dependency fails in CI instead of on staging.
 */
async function chainOrderFromWorkflow(): Promise<string[]> {
  const workflow = await fs.readFile(WORKFLOW_PATH, 'utf8');
  const match = workflow.match(/for m in ([^;]+); do/);
  expect(match).not.toBeNull();
  return (match as RegExpMatchArray)[1].trim().split(/\s+/);
}

describe('the all chain', () => {
  test('every runner in workflow order completes end to end, and a second full pass is a no-op', async () => {
    const chain = await chainOrderFromWorkflow();
    expect(chain.length).toBeGreaterThan(90);

    const packageJson = JSON.parse(
      await fs.readFile(path.join(WEB_DIR, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    const { client, name: databaseName } = await namedBaseSchemaDatabase('gates_all_chain');
    try {
      await seedGym(client);
      // A legacy row for the backfill and a gym for the seeds, so the two
      // strengthened assertions are exercised rather than passing vacuously.
      await client.query(
        `insert into pilot.shadow_research_requirements
           (organization_id, source_event_name, source_entity_type, source_entity_id,
            research_requirement, knowledge_gap, evidence_label, source_status,
            source_confidence_tier, source_verification_state, created_by_account_id,
            created_by_role, metadata)
         values ('org-gates', 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED', 'shadow_library_claim',
                 'ath-gates', 'Strengthen evidence', 'Evidence is thin', 'ath-gates', 'weak',
                 'INSUFFICIENT', 'unknown', 'acct-gates', 'coach', '{}'::jsonb)`,
      );
    } finally {
      await client.end();
    }

    // Three pre-export runners (multiorg, onboarding, data-retention-deletion)
    // hardcode ssl:{rejectUnauthorized:true}, export nothing, and self-execute
    // at import, so run() cannot reach embedded Postgres. Their SQL is applied
    // directly; they carry no readiness assertion to exercise.
    const noEntrypoint = new Set(['multiorg', 'onboarding', 'data-retention-deletion']);

    const applyOne = async (name: string): Promise<void> => {
      // pilot-apply-shadow-runtime-migration.mjs DELETES
      // AZURE_POSTGRES_CONNECTION_STRING from process.env after reading it.
      // Under the workflow each runner is its own `npm run` process so that is
      // invisible; driving them in one process means restoring the
      // environment per runner.
      // Jest already sets NODE_ENV='test'; the runners' resolveSslConfig()
      // requires both that and the opt-in below before it will talk plaintext.
      process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
      process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(databaseName);
      process.env.PPBF_EXPECTED_POSTGRES_HOSTNAME = 'localhost';
      process.env.PPBF_EXPECTED_POSTGRES_DATABASE = databaseName;

      const script = packageJson.scripts[`pilot:apply-${name}`];
      expect(script).toBeDefined();
      const relativePath = script.replace(/^node\s+/, '').trim();

      if (noEntrypoint.has(name)) {
        const source = await fs.readFile(path.join(WEB_DIR, relativePath), 'utf8');
        const sqlFile = source.match(/(pilot_slice_postgres[A-Za-z0-9_]*\.sql)/);
        expect(sqlFile).not.toBeNull();
        const direct = new Client({ connectionString: connectionStringFor(databaseName) });
        await direct.connect();
        try {
          await direct.query(await migration((sqlFile as RegExpMatchArray)[1]));
        } finally {
          await direct.end();
        }
        return;
      }

      const runnerModule = await loadRunner(path.basename(relativePath));
      expect(typeof runnerModule.run).toBe('function');
      await (runnerModule.run as () => Promise<void>)();
    };

    const consoleLog = console.log;
    console.log = () => {};
    try {
      for (const name of chain) {
        await applyOne(name);
      }
      // #489: the chain re-runs every migration on every dispatch, so a
      // second full pass over the database the first one produced has to
      // succeed too -- including every readiness assertion a second time.
      for (const name of chain) {
        await applyOne(name);
      }
    } finally {
      console.log = consoleLog;
    }

    const verify = new Client({ connectionString: connectionStringFor(databaseName) });
    await verify.connect();
    try {
      const gates = await verify.query<{ gate_key: string }>(
        `select gate_key from pilot.safety_gates where organization_id = 'org-gates' order by gate_key`,
      );
      expect(gates.rows.map((row) => row.gate_key)).toEqual([
        'contact_medical_clearance',
        'training_hold',
      ]);
      const backfilled = await verify.query<{ subject_id: string | null }>(
        'select subject_id from pilot.shadow_research_requirements',
      );
      expect(backfilled.rows).toEqual([{ subject_id: 'ath-gates' }]);
    } finally {
      await verify.end();
    }
  });
});
