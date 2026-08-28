// Real PostgreSQL-backed contract test for the cohort-definitions-discipline-fk
// migration (owner decision 2026-08-27).
//
// The third table with this defect, and the one where it reaches furthest.
// cohort_definitions is not content: every row carries contact_permitted and
// regulatory age bounds, so it decides which athletes share a room and how hard
// they may go in it. A cohort naming an unregistered discipline holds a contact
// permission against a risk model that does not exist.
//
// What needs proving that reading SQL cannot prove, and what the owner decision
// actually required of it:
//
//   (1) existing rows are PRESERVED, whatever they contain -- including a
//       discipline nobody registered;
//   (2) new unregistered references are REJECTED;
//   (3) no registry row is FABRICATED to make anything pass;
//   (4) the constraint can be VALIDATED later, deliberately, once someone has
//       measured the rows.
//
// (1) and (4) are the pair that only a real database can settle. `not valid`
// is a promise about two different moments -- it skips the existing rows now,
// and it leaves a `validate constraint` that will scan them later -- and the
// only way to know both halves are true is to put an offending row in the
// table, apply the migration, and then watch validation refuse it.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-cohort-definitions-discipline-fk-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_cohort_definitions_discipline_fk_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-cohort-definitions-discipline-fk-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as sparringAttemptContexts.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

// The registry is created by multidiscipline, which itself widens drill_library
// and references activity_log -- so this is the chain multidiscipline.pg.test.ts
// builds, plus competence-cohorts.
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_multidiscipline_migration.sql',
  'pilot_slice_postgres_competence_cohorts_migration.sql',
];

const ORG_A = 'org-cohort-fk-a';
const ORG_B = 'org-cohort-fk-b';
const COACH_A = 'acct-cohort-fk-coach-a';
const COACH_B = 'acct-cohort-fk-coach-b';

const FK_VIOLATION = '23503';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let schemaSql: string[];
let migrationSql: string;
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
  for (const org of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft'), ($3, 'coach', $4, 'microsoft')
     on conflict do nothing`,
    [COACH_A, ORG_A, COACH_B, ORG_B],
  );
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

function insertCohort(
  client: Client,
  opts: {
    organizationId: string;
    cohortId: string;
    discipline?: string;
    omitDiscipline?: boolean;
    contactPermitted?: string;
  },
) {
  const columns = ['organization_id', 'cohort_id', 'cohort_name', 'contact_permitted'];
  const values: unknown[] = [
    opts.organizationId,
    opts.cohortId,
    `Cohort ${opts.cohortId}`,
    // Named rather than defaulted so the gating column is always a deliberate
    // value in these fixtures -- this table's whole point is that it gates.
    opts.contactPermitted ?? 'none',
  ];

  if (!opts.omitDiscipline) {
    columns.push('discipline');
    // Written explicitly even when it is the column default, because the
    // default is exactly the path a constraint is easiest to leave a hole in.
    values.push(opts.discipline ?? 'boxing');
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
  return client.query(
    `insert into pilot.cohort_definitions (${columns.join(', ')}) values (${placeholders})`,
    values,
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

  schemaSql = await Promise.all(
    SCHEMA_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

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

describe('a cohort may only name a discipline its organization runs', () => {
  test('a registered discipline is accepted and an unregistered one is refused', async () => {
    const client = await freshDatabase('cdfk_basic');
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      await client.query(migrationSql);
      await client.query(migrationSql); // idempotent re-apply

      await insertCohort(client, { organizationId: ORG_A, cohortId: 'coh-ok' });

      // 'conditioning' is a real discipline in the seed vocabulary, and this
      // organization has not registered it. Being a plausible discipline is not
      // the test -- being one THIS gym runs is.
      await expect(
        insertCohort(client, {
          organizationId: ORG_A, cohortId: 'coh-unregistered', discipline: 'conditioning',
        }),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
    } finally {
      await client.end();
    }
  });

  test('the column default is constrained too, not exempt from it', async () => {
    // discipline is `not null default 'boxing'`. A cohort written without naming
    // a discipline still names one, and it is the single most likely way for an
    // unregistered reference to be created -- by a caller who never thought
    // about disciplines at all.
    const client = await freshDatabase('cdfk_default');
    try {
      await client.query(migrationSql);

      await expect(
        insertCohort(client, {
          organizationId: ORG_A, cohortId: 'coh-default', omitDiscipline: true,
        }),
      ).rejects.toMatchObject({ code: FK_VIOLATION });

      await registerDiscipline(client, ORG_A, 'boxing');
      await insertCohort(client, {
        organizationId: ORG_A, cohortId: 'coh-default', omitDiscipline: true,
      });
    } finally {
      await client.end();
    }
  });

  test('the reference is organization-scoped: another gym registering it is not enough', async () => {
    // THE TENANCY PROPERTY. Both columns are in the key, so this is a fact about
    // the constraint's shape and not about any query. A single-column FK to a
    // global discipline list would admit the ORG_B row below, and every other
    // case in this file would still pass.
    const client = await freshDatabase('cdfk_tenancy');
    try {
      await registerDiscipline(client, ORG_A, 'wrestling', 'grappling', 'positional_grappling');
      await registerDiscipline(client, ORG_B, 'boxing');
      await client.query(migrationSql);

      await insertCohort(client, {
        organizationId: ORG_A, cohortId: 'coh-a-wrestling', discipline: 'wrestling',
      });

      await expect(
        insertCohort(client, {
          organizationId: ORG_B, cohortId: 'coh-b-wrestling', discipline: 'wrestling',
        }),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
    } finally {
      await client.end();
    }
  });

  test("'grappling' is a lane, not a discipline, and is refused as one", async () => {
    // 'grappling' is a value of pilot.disciplines.lane -- the lane wrestling and
    // bjj belong to -- and was never a discipline. The owner decision was
    // explicit that a historical test having inserted it is not a reason to
    // admit it.
    const client = await freshDatabase('cdfk_lane');
    try {
      await registerDiscipline(client, ORG_A, 'wrestling', 'grappling', 'positional_grappling');
      await client.query(migrationSql);

      await expect(
        insertCohort(client, {
          organizationId: ORG_A, cohortId: 'coh-lane', discipline: 'grappling',
        }),
      ).rejects.toMatchObject({ code: FK_VIOLATION });

      // And it is refused BECAUSE it is a lane rather than because the gym runs
      // no grappling: wrestling, whose lane IS 'grappling', is registered here
      // and inserts fine.
      await insertCohort(client, {
        organizationId: ORG_A, cohortId: 'coh-wrestling', discipline: 'wrestling',
      });
    } finally {
      await client.end();
    }
  });

  test('a cohort granting contact cannot name an unregistered discipline either', async () => {
    // The reason this table matters most of the three, asserted rather than
    // only argued in the header. contact_permitted is what the row grants;
    // the registry is where the discipline's exposure model lives. Granting
    // open_sparring against a discipline with no registry row is the exact
    // combination the constraint exists to make impossible.
    const client = await freshDatabase('cdfk_contact');
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      await client.query(migrationSql);

      await expect(
        insertCohort(client, {
          organizationId: ORG_A,
          cohortId: 'coh-contact',
          discipline: 'bjj',
          contactPermitted: 'open_sparring',
        }),
      ).rejects.toMatchObject({ code: FK_VIOLATION });

      // Registering it is what makes the grant legible: now the exposure model
      // exists to be looked up, and the same row is accepted.
      await registerDiscipline(client, ORG_A, 'bjj', 'grappling', 'positional_grappling');
      await insertCohort(client, {
        organizationId: ORG_A,
        cohortId: 'coh-contact',
        discipline: 'bjj',
        contactPermitted: 'open_sparring',
      });
    } finally {
      await client.end();
    }
  });
});

describe('what happens to rows that are already there', () => {
  test('an unregistered legacy row SURVIVES the migration, unchanged and still readable', async () => {
    // OWNER CONDITION (1). Production was observed on 2026-08-24 to hold 6
    // cohort definitions against 5 registered disciplines, but that is a
    // loader's output rather than a read of the table, and no other environment
    // has been measured at all. So the migration must be correct against a row
    // it did not expect -- which is what this builds on purpose.
    const client = await freshDatabase('cdfk_legacy');
    try {
      await insertCohort(client, {
        organizationId: ORG_A, cohortId: 'coh-legacy', discipline: 'general',
      });

      await client.query(migrationSql);

      const row = await client.query(
        `select discipline, cohort_name, contact_permitted from pilot.cohort_definitions
         where organization_id = $1 and cohort_id = 'coh-legacy'`,
        [ORG_A],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].discipline).toBe('general');
      expect(row.rows[0].cohort_name).toBe('Cohort coh-legacy');
      // The gating column is untouched too. A migration that "repaired" a row
      // by neutralising its contact permission would preserve the row and
      // silently change what it means.
      expect(row.rows[0].contact_permitted).toBe('none');
    } finally {
      await client.end();
    }
  });

  test('the migration FABRICATES no registry row to make anything pass', async () => {
    // OWNER CONDITION (3), stated as its own case because it is the tempting
    // shortcut: a migration that inserted the missing pilot.disciplines rows
    // would make every other case in this file pass while silently inventing
    // the gym's curriculum -- and here, inventing an exposure model for a
    // discipline it is simultaneously permitting contact in.
    const client = await freshDatabase('cdfk_nofabricate');
    try {
      await insertCohort(client, {
        organizationId: ORG_A, cohortId: 'coh-legacy', discipline: 'general',
      });

      await client.query(migrationSql);

      const registry = await client.query(`select count(*)::int as n from pilot.disciplines`);
      expect(registry.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a legacy row is preserved AND still blocks validation, which is the whole point of NOT VALID', async () => {
    // OWNER CONDITION (4), and the case that proves the other three are not
    // vacuous.
    //
    // If the constraint had been created VALID, the migration itself would have
    // failed here. If it were created and then quietly validated, this
    // `validate constraint` would pass and prove nothing. It is only meaningful
    // because the offending row is still in the table.
    const client = await freshDatabase('cdfk_validate');
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      // 'conditioning' rather than 'general' on purpose: the resolution step
      // below registers whatever this row names, and registering 'general' --
      // which the owner decision is explicit is NOT an authoritative discipline
      // -- would read as this file endorsing it.
      await insertCohort(client, {
        organizationId: ORG_A, cohortId: 'coh-legacy', discipline: 'conditioning',
      });

      await client.query(migrationSql);

      await expect(
        client.query(
          `alter table pilot.cohort_definitions
             validate constraint pilot_cohortdef_discipline_fk`,
        ),
      ).rejects.toMatchObject({ code: FK_VIOLATION });

      // The row is still there after the refused validation -- a failed
      // VALIDATE must not be a data-loss event.
      const still = await client.query(
        `select discipline from pilot.cohort_definitions
         where organization_id = $1 and cohort_id = 'coh-legacy'`,
        [ORG_A],
      );
      expect(still.rows[0].discipline).toBe('conditioning');

      // A human resolves the row -- here, by registering what the gym actually
      // runs. The point is only that SOMEONE decides; the migration did not.
      await registerDiscipline(client, ORG_A, 'conditioning', 'non_contact', 'none');
      await client.query(
        `alter table pilot.cohort_definitions
           validate constraint pilot_cohortdef_discipline_fk`,
      );

      const validated = await client.query(
        `select convalidated from pg_constraint
         where conname = 'pilot_cohortdef_discipline_fk'`,
      );
      expect(validated.rows[0].convalidated).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('the constraint is installed NOT VALID', async () => {
    // Asserted directly as well as behaviorally. The behavioral cases above
    // would all still pass if a future edit created the constraint valid on a
    // table that happened to be empty at apply time -- and that version would
    // then fail against a real environment, at dispatch, which is the most
    // expensive place to find out.
    const client = await freshDatabase('cdfk_notvalid');
    try {
      await client.query(migrationSql);

      const row = await client.query(
        `select convalidated, contype, confupdtype, confdeltype from pg_constraint
         where conname = 'pilot_cohortdef_discipline_fk'
           and conrelid = to_regclass('pilot.cohort_definitions')`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].convalidated).toBe(false);
      expect(row.rows[0].contype).toBe('f');
      // 'a' is NO ACTION on both sides. It matters more here than on the other
      // two tables: ON DELETE CASCADE would mean unregistering a discipline
      // silently deletes the cohort definitions that gate contact for it,
      // taking the regulatory bounds and the rulebook citation with them.
      expect(row.rows[0].confupdtype).toBe('a');
      expect(row.rows[0].confdeltype).toBe('a');
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-cohort-definitions-discipline-fk-migration.mjs's
// READINESS_QUERY -- the assertion that gates the dispatch, and the code whose
// first real execution would otherwise be against a live environment. #488 is
// what that costs: an assertion that could not pass on ANY database, found only
// by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported out
// of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots.
describe('cohort definitions discipline FK runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('cdfk_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /COHORT_DEFINITIONS_DISCIPLINE_FK_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('cdfk_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });

  test('the runner still ACCEPTS after the constraint has been validated', async () => {
    // The readiness query deliberately does not assert `not convalidated`. If it
    // did, the release lane validating the constraint -- the intended next step
    // -- would turn every subsequent `all` dispatch red.
    const client = await freshDatabase('cdfk_rdy_validated');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `alter table pilot.cohort_definitions
           validate constraint pilot_cohortdef_discipline_fk`,
      );
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
