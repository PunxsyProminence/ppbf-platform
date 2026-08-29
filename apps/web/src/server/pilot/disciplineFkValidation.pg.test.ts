// Real PostgreSQL-backed contract test for the discipline-fk-validation
// migration (owner decision OD-2026-08-28-006, "go with recommendation").
//
// The migration issues three `validate constraint` statements, and that is the
// only statement in this repository that CAN FAIL ON DATA. Everything worth
// proving about it is therefore behavioural rather than syntactic, and none of
// it can be established by reading SQL:
//
//   (1) on clean data the three keys actually MOVE from convalidated = false to
//       convalidated = true -- asserted against pg_constraint, not against the
//       absence of an error, because a migration that silently did nothing
//       would also raise nothing;
//   (2) against a violating row it FAILS, and leaves the constraint installed,
//       enforcing and still NOT VALID -- nothing half-done;
//   (3) re-running is safe and the keys stay validated, which is what makes it
//       survivable under the `all` chain that re-runs every migration on every
//       dispatch;
//   (4) a MISSING constraint is SKIPPED rather than raised on -- and the skip is
//       announced, not silent -- while the other two still validate;
//   (5) existing rows are untouched.
//
// (2) is the case only a real database settles, and the planted row can only
// exist because the keys were installed NOT VALID: that is the one state in
// which a row violating an enforcing foreign key can be sitting in the table.
// So the violation is planted BEFORE the FK migration runs, which is exactly how
// a real one would have got there.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-discipline-fk-validation-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_discipline_fk_validation_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-discipline-fk-validation-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as drillLibraryDisciplineFk.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

// Everything the three foreign keys need to exist at all: the registry
// (multidiscipline) plus each of the three tables they constrain. The order is
// the `all` order, not the alphabetical one -- drill-library-v3 creates its
// table long before the registry it must reference is created.
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_multidiscipline_migration.sql',
  'pilot_slice_postgres_session_scripts_migration.sql',
  'pilot_slice_postgres_competence_cohorts_migration.sql',
];

/**
 * The three FK migrations this one validates, keyed the way the rest of the
 * file refers to them. Read from disk rather than restated, so a change to any
 * of them is a change to this suite's fixture too.
 */
const FK_MIGRATION_FILES = {
  drillLibrary: 'pilot_slice_postgres_drill_library_discipline_fk_migration.sql',
  sessionScripts: 'pilot_slice_postgres_session_scripts_discipline_fk_migration.sql',
  cohortDefinitions: 'pilot_slice_postgres_cohort_definitions_discipline_fk_migration.sql',
} as const;

type FkKey = keyof typeof FK_MIGRATION_FILES;

const CONSTRAINTS: Record<FkKey, { name: string; table: string }> = {
  drillLibrary: { name: 'pilot_drill_library_discipline_fk', table: 'pilot.drill_library' },
  sessionScripts: { name: 'pilot_session_scripts_discipline_fk', table: 'pilot.session_scripts' },
  cohortDefinitions: { name: 'pilot_cohortdef_discipline_fk', table: 'pilot.cohort_definitions' },
};

const ALL_FK_KEYS = Object.keys(CONSTRAINTS) as FkKey[];

const ORG_A = 'org-disc-validate-a';
const COACH_A = 'acct-disc-validate-coach-a';

const FK_VIOLATION = '23503';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let schemaSql: string[];
let migrationSql: string;
let fkMigrationSql: Record<FkKey, string>;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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
  for (const sql of schemaSql) {
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
  return client;
}

/**
 * A database carrying ONLY the base schema, so none of the three constrained
 * tables exists at all. `pilot_slice_postgres.sql` creates neither
 * drill_library, session_scripts nor cohort_definitions -- those arrive with
 * drill-library-v3, session-scripts and competence-cohorts.
 */
async function baseSchemaOnlyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(schemaSql[0]);
  return client;
}

/** Registers a discipline for one organization, the way seed-disciplines.mjs does. */
function registerDiscipline(
  client: Client,
  organizationId: string,
  discipline: string,
  lane = 'striking',
  exposureModel = 'head_impact',
) {
  return client.query(
    `insert into pilot.disciplines
       (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, $2, $2, $3, $4) on conflict do nothing`,
    [organizationId, discipline, lane, exposureModel],
  );
}

/** Every NOT NULL column without a default, so a rejection is always the key. */
function insertDrill(
  client: Client,
  opts: { organizationId: string; drillId: string; discipline: string },
) {
  return client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like, discipline)
     values ($1,$2,$2,$3,'defense','the lesson','the purpose','the setup','the execution',
             'good','bad',$4)`,
    [opts.organizationId, opts.drillId, `Drill ${opts.drillId}`, opts.discipline],
  );
}

function insertScript(
  client: Client,
  opts: { organizationId: string; scriptId: string; createdBy: string; discipline: string },
) {
  return client.query(
    `insert into pilot.session_scripts
       (organization_id, script_id, lineage_id, version, name, discipline, created_by_account_id)
     values ($1,$2,$2,1,$3,$4,$5)`,
    [
      opts.organizationId,
      opts.scriptId,
      `Script ${opts.scriptId}`,
      opts.discipline,
      opts.createdBy,
    ],
  );
}

function insertCohort(
  client: Client,
  opts: { organizationId: string; cohortId: string; discipline: string },
) {
  return client.query(
    `insert into pilot.cohort_definitions
       (organization_id, cohort_id, cohort_name, contact_permitted, discipline)
     values ($1,$2,$3,'none',$4)`,
    [opts.organizationId, opts.cohortId, `Cohort ${opts.cohortId}`, opts.discipline],
  );
}

/**
 * `convalidated` for one constraint, plus the facts that make the answer mean
 * something: that it is still installed, and still a foreign key. `null` means
 * no such constraint on that table.
 */
async function constraintState(
  client: Client,
  key: FkKey,
): Promise<{ convalidated: boolean; contype: string } | null> {
  const { name, table } = CONSTRAINTS[key];
  const rows = await client.query(
    `select convalidated, contype from pg_constraint
     where conname = $1 and conrelid = to_regclass($2)`,
    [name, table],
  );
  if (rows.rows.length === 0) return null;
  return { convalidated: rows.rows[0].convalidated as boolean, contype: rows.rows[0].contype as string };
}

/** Applies the FK migrations named, leaving any others uninstalled. */
async function installForeignKeys(client: Client, keys: readonly FkKey[]): Promise<void> {
  for (const key of keys) {
    await client.query(fkMigrationSql[key]);
  }
}

/** Registers `boxing` for ORG_A and installs the three keys against clean rows. */
async function cleanDatabaseWithAllKeys(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  await registerDiscipline(client, ORG_A, 'boxing');
  await insertDrill(client, { organizationId: ORG_A, drillId: 'drl-clean', discipline: 'boxing' });
  await insertScript(client, {
    organizationId: ORG_A, scriptId: 'scr-clean', createdBy: COACH_A, discipline: 'boxing',
  });
  await insertCohort(client, {
    organizationId: ORG_A, cohortId: 'coh-clean', discipline: 'boxing',
  });
  await installForeignKeys(client, ALL_FK_KEYS);
  return client;
}

/** Collects `raise notice` output, which is the migration's whole report. */
function captureNotices(client: Client): string[] {
  const collected: string[] = [];
  client.on('notice', (notice) => {
    if (notice.message) collected.push(notice.message);
  });
  return collected;
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

  schemaSql = await Promise.all(
    SCHEMA_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const fkEntries = await Promise.all(
    ALL_FK_KEYS.map(async (key) => [
      key,
      await fs.readFile(path.join(INFRA_DIR, FK_MIGRATION_FILES[key]), 'utf8'),
    ] as const),
  );
  fkMigrationSql = Object.fromEntries(fkEntries) as Record<FkKey, string>;

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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

describe('on clean data the three keys stop being NOT VALID', () => {
  test('all three move from convalidated = false to convalidated = true', async () => {
    // THE CENTRAL ASSERTION, and it is deliberately made against pg_constraint
    // rather than against the migration not throwing. A file that issued no
    // statement at all -- a guard whose condition never matched, a block
    // commented out -- also throws nothing, and would pass any test whose only
    // evidence was the absence of an error. The before/after pair is what makes
    // the claim.
    const client = await cleanDatabaseWithAllKeys('dfkv_clean');
    try {
      for (const key of ALL_FK_KEYS) {
        expect(await constraintState(client, key)).toEqual({ convalidated: false, contype: 'f' });
      }

      await client.query(migrationSql);

      for (const key of ALL_FK_KEYS) {
        expect(await constraintState(client, key)).toEqual({ convalidated: true, contype: 'f' });
      }
    } finally {
      await client.end();
    }
  });

  test('it announces what it did, naming each constraint', async () => {
    // The migration's entire report is `raise notice`. If those go missing an
    // operator reading a dispatch log cannot tell a validated key from one that
    // was never there -- which is the failure mode the skip branch is most
    // exposed to, so the announcement is asserted rather than assumed.
    const client = await cleanDatabaseWithAllKeys('dfkv_notices');
    const notices = captureNotices(client);
    try {
      await client.query(migrationSql);

      expect(notices.filter((line) => line.includes('VALIDATED'))).toHaveLength(3);
      for (const key of ALL_FK_KEYS) {
        expect(notices.some((line) => line.includes('VALIDATED') && line.includes(CONSTRAINTS[key].name)))
          .toBe(true);
      }
      expect(notices.some((line) => line.includes('SKIPPED'))).toBe(false);
    } finally {
      await client.end();
    }
  });

  test('the rows that were already there are untouched', async () => {
    // `validate constraint` reads rows; it must not write them. Asserted on the
    // whole row rather than on a count, because a count survives a rewrite.
    const client = await cleanDatabaseWithAllKeys('dfkv_rows_intact');
    try {
      const before = await client.query(
        `select organization_id, drill_id, name, discipline, category
         from pilot.drill_library order by drill_id`,
      );
      const scriptsBefore = await client.query(
        `select organization_id, script_id, name, discipline from pilot.session_scripts`,
      );
      const cohortsBefore = await client.query(
        `select organization_id, cohort_id, cohort_name, discipline, contact_permitted
         from pilot.cohort_definitions`,
      );

      await client.query(migrationSql);

      expect((await client.query(
        `select organization_id, drill_id, name, discipline, category
         from pilot.drill_library order by drill_id`,
      )).rows).toEqual(before.rows);
      expect((await client.query(
        `select organization_id, script_id, name, discipline from pilot.session_scripts`,
      )).rows).toEqual(scriptsBefore.rows);
      expect((await client.query(
        `select organization_id, cohort_id, cohort_name, discipline, contact_permitted
         from pilot.cohort_definitions`,
      )).rows).toEqual(cohortsBefore.rows);
    } finally {
      await client.end();
    }
  });

  test('re-running is safe and the keys stay validated', async () => {
    // The `all` chain re-runs every migration on every dispatch, so the third
    // pass has to survive the first two. The guard takes the NO-OP branch here
    // and issues no statement at all, which is stronger than the measured 1 ms
    // catalog no-op OD-2026-08-28-006 recorded for a repeat `validate`.
    const client = await cleanDatabaseWithAllKeys('dfkv_rerun');
    try {
      await client.query(migrationSql);
      const notices = captureNotices(client);
      await client.query(migrationSql);
      await client.query(migrationSql);

      for (const key of ALL_FK_KEYS) {
        expect(await constraintState(client, key)).toEqual({ convalidated: true, contype: 'f' });
      }
      expect(notices.filter((line) => line.includes('NO-OP'))).toHaveLength(6);
      expect(notices.some((line) => line.includes('VALIDATED'))).toBe(false);
    } finally {
      await client.end();
    }
  });
});

describe('against a violating row it fails, and leaves nothing half-done', () => {
  /**
   * Plants a drill naming a discipline ORG_A has not registered, BEFORE the FK
   * migration installs the key. That ordering is the point: NOT VALID skipping
   * the existing rows is the only way such a row can be sitting under an
   * enforcing foreign key, so it is the only honest way to build this fixture.
   */
  async function databaseWithPlantedViolation(name: string): Promise<Client> {
    const client = await freshDatabase(name);
    await registerDiscipline(client, ORG_A, 'boxing');
    await insertDrill(client, { organizationId: ORG_A, drillId: 'drl-ok', discipline: 'boxing' });
    await insertDrill(client, {
      organizationId: ORG_A, drillId: 'drl-legacy', discipline: 'general',
    });
    await insertScript(client, {
      organizationId: ORG_A, scriptId: 'scr-clean', createdBy: COACH_A, discipline: 'boxing',
    });
    await insertCohort(client, {
      organizationId: ORG_A, cohortId: 'coh-clean', discipline: 'boxing',
    });
    await installForeignKeys(client, ALL_FK_KEYS);
    return client;
  }

  test('the migration FAILS, naming the constraint', async () => {
    const client = await databaseWithPlantedViolation('dfkv_violation_fails');
    try {
      // 'general' passes the drill library's pre-existing CHECK and is in no
      // registry, so it is the one unregistered value a real legacy row can
      // actually hold -- the production census found none, and this is what one
      // would do if it existed.
      await expect(client.query(migrationSql)).rejects.toMatchObject({
        code: FK_VIOLATION,
        message: expect.stringContaining('pilot_drill_library_discipline_fk'),
      });
    } finally {
      await client.end();
    }
  });

  test('the constraint is left installed, enforcing, and still NOT VALID', async () => {
    // The precise post-failure state the SQL header promises. A failure that
    // dropped the key, or left it half-marked, would be far worse than the
    // failure itself: the column would stop being governed at the moment
    // somebody discovered a bad row in it.
    const client = await databaseWithPlantedViolation('dfkv_violation_state');
    try {
      await expect(client.query(migrationSql)).rejects.toMatchObject({ code: FK_VIOLATION });

      expect(await constraintState(client, 'drillLibrary'))
        .toEqual({ convalidated: false, contype: 'f' });

      // Still ENFORCING, which `convalidated: false` alone does not prove -- a
      // dropped-and-re-added-NOT-VALID key would read identically in the
      // catalog. A new unregistered write must still be refused.
      //
      // 'conditioning' rather than an invented discipline, and the difference is
      // measured rather than stylistic: the first version of this case used
      // 'judo' and got 23514, because pilot_drill_library_discipline_check
      // refused it before the foreign key was ever consulted. That would have
      // proved the CHECK was enforcing and said nothing at all about the key.
      // 'conditioning' passes the CHECK and is absent from this organization's
      // registry, so 23503 here can only be the foreign key.
      await expect(
        insertDrill(client, { organizationId: ORG_A, drillId: 'drl-new', discipline: 'conditioning' }),
      ).rejects.toMatchObject({ code: FK_VIOLATION });

      // And a legal write still works, so the key is enforcing rather than
      // simply broken.
      await insertDrill(client, {
        organizationId: ORG_A, drillId: 'drl-new-ok', discipline: 'boxing',
      });
    } finally {
      await client.end();
    }
  });

  test('the offending row survives: a failed validate is not a data-loss event', async () => {
    const client = await databaseWithPlantedViolation('dfkv_violation_rows');
    try {
      await expect(client.query(migrationSql)).rejects.toMatchObject({ code: FK_VIOLATION });

      const row = await client.query(
        `select discipline, name from pilot.drill_library where drill_id = 'drl-legacy'`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].discipline).toBe('general');
      expect(row.rows[0].name).toBe('Drill drl-legacy');
    } finally {
      await client.end();
    }
  });

  test('the two keys whose tables are clean are rolled back too, so the run is all-or-nothing', async () => {
    // The three blocks are one multi-statement query, which Postgres wraps in a
    // single implicit transaction -- and the runner opens an explicit one on top
    // of that. So a failure in the FIRST block leaves the other two exactly as
    // they were. "Nothing half-done" is a claim about the whole migration, not
    // just about the constraint that failed, and this is the half of it a reader
    // is most likely to assume rather than check.
    const client = await databaseWithPlantedViolation('dfkv_violation_atomic');
    try {
      await expect(client.query(migrationSql)).rejects.toMatchObject({ code: FK_VIOLATION });

      for (const key of ALL_FK_KEYS) {
        expect(await constraintState(client, key)).toEqual({ convalidated: false, contype: 'f' });
      }
    } finally {
      await client.end();
    }
  });

  test('Postgres names ONE offending key, which is why the census exists', async () => {
    // The SQL header tells an operator to run pilot:check-discipline-values
    // rather than validating repeatedly, and this is the measurement behind that
    // instruction. Two offending rows are planted; the failure reports one.
    // Validating again after fixing it would report the other, one dispatch at a
    // time, from a live database.
    const client = await freshDatabase('dfkv_one_key');
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      await insertDrill(client, { organizationId: ORG_A, drillId: 'drl-x', discipline: 'general' });
      await insertDrill(client, { organizationId: ORG_A, drillId: 'drl-y', discipline: 'combatives' });
      await installForeignKeys(client, ALL_FK_KEYS);

      const failure = await client.query(migrationSql).catch((error: unknown) => error);
      const detail = (failure as { detail?: string }).detail ?? '';
      expect((failure as { code?: string }).code).toBe(FK_VIOLATION);

      const named = ['general', 'combatives'].filter((value) => detail.includes(value));
      expect(named).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});

describe('a constraint that is not installed is SKIPPED, out loud, not raised on', () => {
  test('the migration completes and the other two still validate', async () => {
    // THE GUARD'S WHOLE REASON, and the case that distinguishes this migration
    // from drill-library-check-drop, whose guard raises. Dropping a constraint
    // without its replacement leaves a column ungoverned, so that one must
    // refuse. Here a missing key means there is nothing to validate and nothing
    // is made worse -- while raising would take down an `all` dispatch, and
    // every migration after this one in it, on any environment that has not yet
    // applied the FK migrations.
    const client = await freshDatabase('dfkv_absent');
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      await insertScript(client, {
        organizationId: ORG_A, scriptId: 'scr-clean', createdBy: COACH_A, discipline: 'boxing',
      });
      await insertCohort(client, {
        organizationId: ORG_A, cohortId: 'coh-clean', discipline: 'boxing',
      });
      // drill_library's key is deliberately never installed.
      await installForeignKeys(client, ['sessionScripts', 'cohortDefinitions']);
      expect(await constraintState(client, 'drillLibrary')).toBeNull();

      await client.query(migrationSql);

      expect(await constraintState(client, 'drillLibrary')).toBeNull();
      expect(await constraintState(client, 'sessionScripts'))
        .toEqual({ convalidated: true, contype: 'f' });
      expect(await constraintState(client, 'cohortDefinitions'))
        .toEqual({ convalidated: true, contype: 'f' });
    } finally {
      await client.end();
    }
  });

  test('the skip is announced, naming the constraint and why', async () => {
    // A silent skip is the failure mode this repository has been bitten by: a
    // guard that quietly does nothing and reports PASS looks identical, in a
    // dispatch log, to one that did the work. Without this assertion the skip
    // branch above would be indistinguishable from success.
    const client = await freshDatabase('dfkv_absent_notice');
    const notices = captureNotices(client);
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      await installForeignKeys(client, ['sessionScripts', 'cohortDefinitions']);

      await client.query(migrationSql);

      const skipped = notices.filter((line) => line.includes('SKIPPED'));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toContain('pilot_drill_library_discipline_fk');
      expect(skipped[0]).toContain('drill-library-discipline-fk');
      expect(notices.filter((line) => line.includes('VALIDATED'))).toHaveLength(2);
    } finally {
      await client.end();
    }
  });

  test('with none of the three installed it still completes, skipping all three', async () => {
    // The state a fresh environment is in if this migration is ever reached
    // before the three that create the keys. It must not raise -- and it must
    // not report having validated anything either.
    const client = await freshDatabase('dfkv_absent_all');
    const notices = captureNotices(client);
    try {
      await client.query(migrationSql);

      for (const key of ALL_FK_KEYS) {
        expect(await constraintState(client, key)).toBeNull();
      }
      expect(notices.filter((line) => line.includes('SKIPPED'))).toHaveLength(3);
      expect(notices.some((line) => line.includes('VALIDATED'))).toBe(false);
    } finally {
      await client.end();
    }
  });

  test('it survives a database where the three TABLES do not exist either', async () => {
    // Why the guard reads `to_regclass('pilot.drill_library')` rather than
    // `'pilot.drill_library'::regclass`. The cast raises 42P01 where the table
    // is absent -- before the guard is ever consulted -- so a migration written
    // that way would take down an `all` dispatch on precisely the environment
    // the skip branch exists to protect. to_regclass returns null,
    // `conrelid = null` matches nothing, and all three blocks skip.
    const client = await baseSchemaOnlyDatabase('dfkv_no_tables');
    const notices = captureNotices(client);
    try {
      for (const key of ALL_FK_KEYS) {
        const present = await client.query(`select to_regclass($1) is not null as ok`, [
          CONSTRAINTS[key].table,
        ]);
        expect(present.rows[0].ok).toBe(false);
      }

      await client.query(migrationSql);

      expect(notices.filter((line) => line.includes('SKIPPED'))).toHaveLength(3);
    } finally {
      await client.end();
    }
  });

  test('a CHECK constraint wearing a foreign key name does not satisfy the guard', async () => {
    // `contype = 'f'` rather than the name alone. A name-only lookup would find
    // this CHECK, and `validate constraint` against it would mean something
    // else entirely. The migration must treat it as absent and skip.
    const client = await freshDatabase('dfkv_wrong_contype');
    const notices = captureNotices(client);
    try {
      await client.query(
        `alter table pilot.drill_library
           add constraint pilot_drill_library_discipline_fk check (discipline <> 'nonsense')
           not valid`,
      );

      await client.query(migrationSql);

      expect(await constraintState(client, 'drillLibrary'))
        .toEqual({ convalidated: false, contype: 'c' });
      expect(notices.some((line) => line.includes('SKIPPED')
        && line.includes('pilot_drill_library_discipline_fk'))).toBe(true);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-discipline-fk-validation-migration.mjs's READINESS_QUERY
// -- the assertion that gates the dispatch, and the code whose first real
// execution would otherwise be against a live environment. #488 is what that
// costs: an assertion that could not pass on ANY database, found only by a
// staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported out
// of the shipped runner and executes the shipped READINESS_QUERY, so this cannot
// stay green while the runner rots.
describe('discipline FK validation runner readiness assertion', () => {
  test('it REFUSES a database where the keys exist and the migration never ran', async () => {
    // The state this migration exists to leave behind: three installed,
    // enforcing, NOT VALID keys. Readiness must be false here, or it is
    // asserting nothing.
    const client = await cleanDatabaseWithAllKeys('dfkv_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DISCIPLINE_FK_VALIDATION_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('it ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await cleanDatabaseWithAllKeys('dfkv_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      for (const key of ALL_FK_KEYS) {
        expect(await constraintState(client, key)).toEqual({ convalidated: true, contype: 'f' });
      }
    } finally {
      await client.end();
    }
  });

  test('it ACCEPTS a database whose keys are absent, so a skip is not a failed dispatch', async () => {
    // The readiness query deliberately asserts "no un-validated discipline key
    // is left", not "all three are validated". Demanding the second would turn
    // every skip back into the dispatch failure the skip exists to avoid --
    // on exactly the environments least able to absorb one.
    const client = await freshDatabase('dfkv_rdy_absent');
    try {
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });

  test('it REFUSES when only some of the installed keys were validated', async () => {
    // A partial result must not read as success. Two keys are installed and
    // validated by hand; the third is installed and left NOT VALID, standing in
    // for a migration that lost a block.
    const client = await freshDatabase('dfkv_rdy_partial');
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      await installForeignKeys(client, ALL_FK_KEYS);
      await client.query(
        `alter table pilot.session_scripts
           validate constraint pilot_session_scripts_discipline_fk`,
      );
      await client.query(
        `alter table pilot.cohort_definitions
           validate constraint pilot_cohortdef_discipline_fk`,
      );

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DISCIPLINE_FK_VALIDATION_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });
});
