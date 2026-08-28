// Real PostgreSQL-backed contract test for the drill-library-check-drop
// migration.
//
// OWNER DECISION, VERBATIM: "drop the check and let the registry govern."
//
// What a reader of the SQL cannot know, and what only a real database settles:
//
//   (1) 'bjj' -- a REGISTERED discipline the CHECK refused -- becomes writable.
//       That is the entire point of the change, and it is the one thing that
//       must be observed rather than argued.
//   (2) 'general' does NOT become writable. The ERROR CODE is the evidence, and
//       measuring it corrected the expectation this file was first written with
//       -- see the case itself. 'general' PASSES the CHECK, so the CHECK was
//       never what refused it; the foreign key was, and still is. 23503 before,
//       23503 after.
//   (3) A gym that registers a discipline of its own can then file drills under
//       it. This is what "let the registry govern" actually buys, and it was
//       impossible before because the CHECK capped every organization at the
//       same five literals.
//   (4) Existing rows are untouched.
//   (5) The migration REFUSES to drop the CHECK when the foreign key is absent.
//       This is the safety property that matters most: a database with neither
//       constraint has an ungoverned discipline column, which is strictly worse
//       than either state the owner was choosing between. A silent skip would
//       be worse still -- the dispatch would report PASS and the operator would
//       believe the drop happened.
//   (6) drill-library-v3 does not put the CHECK back. The `all` chain re-runs
//       every migration on every dispatch, so a drop that a later dispatch
//       undoes is not a drop.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-library-check-drop-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_drill_library_check_drop_migration.sql';
const FK_MIGRATION_FILE = 'pilot_slice_postgres_drill_library_discipline_fk_migration.sql';
const V3_MIGRATION_FILE = 'pilot_slice_postgres_drill_library_v3_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-library-check-drop-migration.mjs',
);
// The drill-library-v3 runner is loaded here as well, because this change edits
// its readiness assertion. See the describe block at the bottom of this file.
const V3_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-library-v3-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as drillLibraryDisciplineFk.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

// The same chain drillLibraryDisciplineFk.pg.test.ts builds, and the order is
// the one the `all` loop uses: drill-library-v3 creates the table and the CHECK
// at 49, and the registry this migration hands authority to is not created
// until 62.
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
  V3_MIGRATION_FILE,
  'pilot_slice_postgres_multidiscipline_migration.sql',
];

const ORG_A = 'org-drill-drop-a';
const ORG_B = 'org-drill-drop-b';
const COACH_A = 'acct-drill-drop-coach-a';
const COACH_B = 'acct-drill-drop-coach-b';

const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

const CHECK_NAME = 'pilot_drill_library_discipline_check';
const FK_NAME = 'pilot_drill_library_discipline_fk';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let schemaSql: string[];
let migrationSql: string;
let fkMigrationSql: string;
let v3MigrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyV3MigrationTransaction: (client: Client, sql: string) => Promise<void>;

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
 * A database in the state this migration expects to find: the table, the
 * registry, the CHECK, and -- unless `withFk` is false -- the foreign key the
 * drop hands authority to.
 *
 * `withFk: false` is not a convenience. It is the case the FK-absence guard
 * exists for, and it is the only way to build a database where dropping the
 * CHECK would leave the column ungoverned.
 */
async function freshDatabase(name: string, options: { withFk?: boolean } = {}): Promise<Client> {
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
  if (options.withFk !== false) {
    await client.query(fkMigrationSql);
  }
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

/**
 * Every NOT NULL column without a default, so a rejection is always the
 * constraint under test rather than an incomplete row.
 */
function insertDrill(
  client: Client,
  opts: { organizationId: string; drillId: string; discipline?: string },
) {
  const columns = [
    'organization_id', 'drill_id', 'lineage_id', 'name', 'category', 'target_behavior',
    'purpose', 'standard_setup', 'execution', 'what_good_looks_like', 'what_bad_looks_like',
    'discipline',
  ];
  const values: unknown[] = [
    opts.organizationId, opts.drillId, opts.drillId, `Drill ${opts.drillId}`, 'defense',
    'the lesson', 'the purpose', 'the setup', 'the execution', 'good', 'bad',
    opts.discipline ?? 'boxing',
  ];

  const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
  return client.query(
    `insert into pilot.drill_library (${columns.join(', ')}) values (${placeholders})`,
    values,
  );
}

async function constraintNames(client: Client): Promise<string[]> {
  const rows = await client.query(
    `select conname from pg_constraint
     where conrelid = to_regclass('pilot.drill_library')
       and conname in ($1, $2)
     order by conname`,
    [CHECK_NAME, FK_NAME],
  );
  return rows.rows.map((row: { conname: string }) => row.conname);
}

/** The SQLSTATE a write actually failed with, or null if it succeeded. */
async function refusalCodeFor(
  client: Client,
  opts: { organizationId: string; drillId: string; discipline: string },
): Promise<string | null> {
  try {
    await insertDrill(client, opts);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
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
  fkMigrationSql = await fs.readFile(path.join(INFRA_DIR, FK_MIGRATION_FILE), 'utf8');
  v3MigrationSql = await fs.readFile(path.join(INFRA_DIR, V3_MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  const v3RunnerModule = await nativeDynamicImport(pathToFileURL(V3_RUNNER_PATH).href);
  applyV3MigrationTransaction = v3RunnerModule.applyMigrationTransaction as (
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

describe('the starting state this migration was written against', () => {
  // Negative control for the whole file. Every case below is a claim about a
  // CHANGE, and a change can only be observed against a measured "before". If
  // the CHECK were not actually installed by drill-library-v3, or the FK not
  // actually installed by the FK migration, the cases below would still pass
  // while proving nothing at all.
  test('both constraints are installed before this migration runs', async () => {
    const client = await freshDatabase('dlcd_before');
    try {
      expect(await constraintNames(client)).toEqual([CHECK_NAME, FK_NAME]);
    } finally {
      await client.end();
    }
  });
});

describe("a registered discipline the CHECK refused becomes writable", () => {
  test("'bjj' is refused BEFORE and accepted AFTER -- the change's whole point", async () => {
    // bjj IS in the seeded registry
    // (apps/web/seed-data/multidiscipline/seed_disciplines.csv), so a gym can
    // register it, and before this migration it still could not file a single
    // bjj drill: the five-literal CHECK does not contain the value.
    const client = await freshDatabase('dlcd_bjj');
    try {
      await registerDiscipline(client, ORG_A, 'bjj', 'grappling', 'positional_grappling');

      // MEASURED, not assumed. The code is what identifies WHICH constraint
      // refused, and that is the fact this migration changes.
      expect(
        await refusalCodeFor(client, { organizationId: ORG_A, drillId: 'drl-bjj-before', discipline: 'bjj' }),
      ).toBe(CHECK_VIOLATION);

      await client.query(migrationSql);

      expect(
        await refusalCodeFor(client, { organizationId: ORG_A, drillId: 'drl-bjj-after', discipline: 'bjj' }),
      ).toBeNull();

      const stored = await client.query(
        `select discipline from pilot.drill_library
         where organization_id = $1 and drill_id = 'drl-bjj-after'`,
        [ORG_A],
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].discipline).toBe('bjj');
    } finally {
      await client.end();
    }
  });

  test('the CHECK is gone from the catalog and the foreign key is still there', async () => {
    // Asserted structurally as well as behaviourally. A migration that somehow
    // widened the CHECK instead of dropping it would pass the bjj case above
    // and be a different change from the one the owner ratified.
    const client = await freshDatabase('dlcd_catalog');
    try {
      await client.query(migrationSql);
      expect(await constraintNames(client)).toEqual([FK_NAME]);
    } finally {
      await client.end();
    }
  });
});

describe('dropping the CHECK does not open what the registry never held', () => {
  test("'general' is refused BEFORE and STILL refused AFTER, by the same constraint, with the same code", async () => {
    // 'general' is the one value the CHECK ADMITTED that no registry contains.
    // The intuition to guard against is "the CHECK was what refused 'general',
    // so dropping it lets 'general' in". It was not, and it does not.
    //
    // BOTH CODES ARE MEASURED, AND THE MEASUREMENT CORRECTED THE EXPECTATION
    // THIS CASE WAS FIRST WRITTEN WITH. It was written asserting 23514 before
    // and 23503 after -- a code CHANGE -- and the run returned 23503 for both.
    // That is right, and the reasoning behind the guess was wrong: 'general'
    // satisfies the CHECK, so the CHECK never refused it. The foreign key was
    // already the only thing standing in its way, and it still is. Dropping the
    // CHECK changes nothing about 'general' -- not the outcome, and not even
    // which constraint reports it.
    const client = await freshDatabase('dlcd_general');
    try {
      await registerDiscipline(client, ORG_A, 'boxing');

      const before = await refusalCodeFor(client, {
        organizationId: ORG_A, drillId: 'drl-general-before', discipline: 'general',
      });

      await client.query(migrationSql);

      const after = await refusalCodeFor(client, {
        organizationId: ORG_A, drillId: 'drl-general-after', discipline: 'general',
      });

      expect(before).toBe(FK_VIOLATION);
      expect(after).toBe(FK_VIOLATION);

      // And no row landed either way.
      const rows = await client.query(
        `select count(*)::int as n from pilot.drill_library where organization_id = $1`,
        [ORG_A],
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('an arbitrary unregistered value is refused by the foreign key after the drop', async () => {
    // 'judo' was never in the CHECK's vocabulary and is in no registry. Before
    // the migration two constraints refused it; after, one does. The column is
    // not free text.
    const client = await freshDatabase('dlcd_judo');
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      await client.query(migrationSql);

      expect(
        await refusalCodeFor(client, { organizationId: ORG_A, drillId: 'drl-judo', discipline: 'judo' }),
      ).toBe(FK_VIOLATION);
    } finally {
      await client.end();
    }
  });

  test('the migration fabricates no registry row to make anything pass', async () => {
    // The tempting shortcut, and the one the FK migration's header explicitly
    // refused: inserting a 'general' discipline would make 'general' writable
    // and give an unregistered value the appearance of authority precisely
    // because a constraint was inconvenient.
    const client = await freshDatabase('dlcd_nofabricate');
    try {
      await client.query(migrationSql);

      const registry = await client.query(`select count(*)::int as n from pilot.disciplines`);
      expect(registry.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('the registry, and only the registry, now decides', () => {
  test('a gym that registers a discipline of its own can immediately file drills under it', async () => {
    // THE MEANING OF THE DECISION. Before this migration no organization could
    // do this for ANY value outside the five literals, however legitimately it
    // ran the discipline -- the CHECK is one hard-coded vocabulary for every
    // gym, and which disciplines a gym runs is per-organization data. That is
    // the entire reason pilot.disciplines is keyed (organization_id,
    // discipline).
    const client = await freshDatabase('dlcd_own_discipline');
    try {
      await client.query(migrationSql);

      // Refused first: registering is what makes it writable, not the drop.
      expect(
        await refusalCodeFor(client, { organizationId: ORG_A, drillId: 'drl-judo-a', discipline: 'judo' }),
      ).toBe(FK_VIOLATION);

      await registerDiscipline(client, ORG_A, 'judo', 'grappling', 'positional_grappling');

      expect(
        await refusalCodeFor(client, { organizationId: ORG_A, drillId: 'drl-judo-a', discipline: 'judo' }),
      ).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the reference is still organization-scoped: another gym registering it is not enough', async () => {
    // THE TENANCY PROPERTY, re-asserted after the drop. Widening what a column
    // accepts is exactly the moment an isolation boundary can be lost by
    // accident, so it is measured rather than inherited from the FK suite.
    const client = await freshDatabase('dlcd_tenancy');
    try {
      await registerDiscipline(client, ORG_A, 'judo', 'grappling', 'positional_grappling');
      await registerDiscipline(client, ORG_B, 'boxing');
      await client.query(migrationSql);

      expect(
        await refusalCodeFor(client, { organizationId: ORG_A, drillId: 'drl-judo-a', discipline: 'judo' }),
      ).toBeNull();

      expect(
        await refusalCodeFor(client, { organizationId: ORG_B, drillId: 'drl-judo-b', discipline: 'judo' }),
      ).toBe(FK_VIOLATION);
    } finally {
      await client.end();
    }
  });

  test('the foreign key is left NOT VALID exactly as it was found', async () => {
    // Validating the key is a SEPARATE, unratified owner decision, and it is
    // the statement that can fail on real data. A migration that quietly
    // validated it while dropping the CHECK would be doing two things and
    // reporting one.
    const client = await freshDatabase('dlcd_notvalid');
    try {
      await client.query(migrationSql);

      const row = await client.query(
        `select convalidated from pg_constraint
         where conname = $1 and conrelid = to_regclass('pilot.drill_library')`,
        [FK_NAME],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].convalidated).toBe(false);
    } finally {
      await client.end();
    }
  });
});

describe('what happens to rows that are already there', () => {
  test('existing rows are untouched, including one the dropped CHECK was the only thing permitting', async () => {
    // Dropping a CHECK reads no row and writes no row. The 'general' row is
    // planted deliberately: it is the value the CHECK admitted and the registry
    // never held, so it is the row whose survival is least obvious.
    //
    // Production was measured CLEAN on 2026-08-28 (run 33175617223) -- no
    // drill_library row anywhere names a discipline the registry does not hold,
    // so no such row is believed to exist. It is built here anyway, because a
    // migration must be correct against the row it did not expect.
    // `withFk: false` so the rows can be planted first. The foreign key is
    // installed NOT VALID, which skips the rows already in the table but
    // enforces every new INSERT -- so a 'general' row can only be created the
    // way a real one was: before the key existed.
    const client = await freshDatabase('dlcd_existing', { withFk: false });
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      await insertDrill(client, { organizationId: ORG_A, drillId: 'drl-legacy', discipline: 'general' });
      await insertDrill(client, { organizationId: ORG_A, drillId: 'drl-boxing', discipline: 'boxing' });
      await client.query(fkMigrationSql);

      const before = await client.query(
        `select drill_id, discipline, name, version, active from pilot.drill_library
         where organization_id = $1 order by drill_id`,
        [ORG_A],
      );

      await client.query(migrationSql);

      const after = await client.query(
        `select drill_id, discipline, name, version, active from pilot.drill_library
         where organization_id = $1 order by drill_id`,
        [ORG_A],
      );

      expect(before.rows.map((row: { discipline: string }) => row.discipline))
        .toEqual(['boxing', 'general']);
      expect(after.rows).toEqual(before.rows);
    } finally {
      await client.end();
    }
  });

  test('re-running the migration is a no-op', async () => {
    // The `all` chain re-runs every migration on every dispatch, so the second
    // pass has to survive the first. A bare `alter table ... drop constraint`
    // would raise on the second pass and turn every future dispatch red.
    const client = await freshDatabase('dlcd_idempotent');
    try {
      await registerDiscipline(client, ORG_A, 'bjj', 'grappling', 'positional_grappling');
      await client.query(migrationSql);
      await insertDrill(client, { organizationId: ORG_A, drillId: 'drl-bjj', discipline: 'bjj' });

      await client.query(migrationSql);
      await client.query(migrationSql);

      expect(await constraintNames(client)).toEqual([FK_NAME]);
      const rows = await client.query(
        `select count(*)::int as n from pilot.drill_library where organization_id = $1`,
        [ORG_A],
      );
      expect(rows.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});

describe('the migration refuses to leave the column ungoverned', () => {
  // THE SAFETY PROPERTY THAT MATTERS MOST.
  //
  // This file removes one of two authorities over pilot.drill_library
  // .discipline. Applied where the other one is absent -- an environment where
  // the FK migration was never run, or a rebuild whose order slipped -- it
  // would leave the column as free text with nothing checking it. That is
  // strictly worse than either state the owner was choosing between.

  test('with the foreign key ABSENT it RAISES rather than dropping', async () => {
    const client = await freshDatabase('dlcd_guard_raises', { withFk: false });
    try {
      // The precondition, measured: the CHECK is the ONLY thing governing the
      // column here.
      expect(await constraintNames(client)).toEqual([CHECK_NAME]);

      await expect(client.query(migrationSql)).rejects.toMatchObject({
        message: expect.stringContaining('pilot_drill_library_discipline_fk is missing'),
      });

      // AND THE CHECK IS STILL THERE. A guard that raised after dropping would
      // satisfy the assertion above and still have destroyed the property it
      // exists to protect.
      expect(await constraintNames(client)).toEqual([CHECK_NAME]);

      // Still enforced, not merely still listed.
      expect(
        await refusalCodeFor(client, { organizationId: ORG_A, drillId: 'drl-bjj', discipline: 'bjj' }),
      ).toBe(CHECK_VIOLATION);
    } finally {
      await client.end();
    }
  });

  test('it RAISES rather than skipping, so a dispatch cannot report PASS having done nothing', async () => {
    // The distinction this case exists for. A guarded no-op would leave the
    // operator believing the drop happened, and the next person to look would
    // find the CHECK still installed with no record of why. The exception names
    // what is missing and what to apply first; both halves are asserted,
    // because an exception that does not say what to do is a different failure.
    const client = await freshDatabase('dlcd_guard_message', { withFk: false });
    try {
      const failure = await client.query(migrationSql).then(
        () => null,
        (error: { message?: string }) => error,
      );

      expect(failure).not.toBeNull();
      expect(failure?.message).toContain('pilot_drill_library_discipline_fk is missing');
      expect(failure?.message).toContain('ungoverned');
      expect(failure?.message).toContain('drill-library-discipline-fk');
    } finally {
      await client.end();
    }
  });

  test('a CHECK constraint wearing the foreign key\'s name does not satisfy the guard', async () => {
    // The guard tests contype and confrelid, not the name alone. Without that,
    // any constraint carrying the name -- including one enforcing something
    // else entirely -- would be accepted as the authority the drop hands over
    // to, and the column would end up governed by nothing that governs
    // disciplines.
    const client = await freshDatabase('dlcd_guard_wrong_type', { withFk: false });
    try {
      await client.query(
        `alter table pilot.drill_library
           add constraint ${FK_NAME} check (version > 0)`,
      );

      await expect(client.query(migrationSql)).rejects.toMatchObject({
        message: expect.stringContaining('pilot_drill_library_discipline_fk is missing'),
      });
    } finally {
      await client.end();
    }
  });

  test('the table being absent raises too, rather than silently succeeding', async () => {
    const client = await freshDatabase('dlcd_guard_no_table', { withFk: false });
    try {
      await client.query('drop table pilot.drill_library cascade');

      await expect(client.query(migrationSql)).rejects.toMatchObject({
        message: expect.stringContaining('pilot.drill_library is missing'),
      });
    } finally {
      await client.end();
    }
  });
});

describe('drill-library-v3 does not put the CHECK back', () => {
  // A drop that the next dispatch undoes is not a drop. The `all` loop re-runs
  // EVERY migration in order on every dispatch, and drill-library-v3 -- which
  // installs this CHECK -- runs at 49, long before this migration at the end of
  // the list. Its DO block is guarded on `if not exists`, so once the CHECK is
  // dropped it would create it again on the very next dispatch.
  //
  // Two consequences, and the second is the serious one:
  //
  //   * the drop would be undone and redone on every dispatch, so no
  //     environment's state between migrations would mean what it says;
  //   * `alter table ... add constraint ... check` VALIDATES existing rows, so
  //     the first bjj drill any gym files would make drill-library-v3 fail with
  //     23514 and take the whole dispatch down -- the change delivering a
  //     capability whose use breaks the rebuild path.
  //
  // drill-library-v3 therefore installs the literal CHECK only while the
  // registry foreign key is NOT yet present. On a fresh rebuild that is still
  // the historical sequence (v3 at 49 creates it, the FK arrives later, this
  // migration drops it); on an already-migrated environment it is a no-op. The
  // column is never left ungoverned in either direction.

  test('re-running drill-library-v3 after the drop does not re-create the CHECK', async () => {
    const client = await freshDatabase('dlcd_v3_reapply');
    try {
      await client.query(migrationSql);
      expect(await constraintNames(client)).toEqual([FK_NAME]);

      await client.query(v3MigrationSql);

      expect(await constraintNames(client)).toEqual([FK_NAME]);
    } finally {
      await client.end();
    }
  });

  test('re-running drill-library-v3 does not fail against a row the dropped CHECK would have refused', async () => {
    // The consequence that is not merely untidy. Without the gate this ALTER
    // scans the table, finds the bjj row, and dies with 23514 -- every
    // subsequent `apply-migrations all` dispatch red, in the migration that
    // creates half the drill schema.
    const client = await freshDatabase('dlcd_v3_reapply_bjj');
    try {
      await registerDiscipline(client, ORG_A, 'bjj', 'grappling', 'positional_grappling');
      await client.query(migrationSql);
      await insertDrill(client, { organizationId: ORG_A, drillId: 'drl-bjj', discipline: 'bjj' });

      await client.query(v3MigrationSql);

      expect(await constraintNames(client)).toEqual([FK_NAME]);
      const rows = await client.query(
        `select discipline from pilot.drill_library
         where organization_id = $1 and drill_id = 'drl-bjj'`,
        [ORG_A],
      );
      expect(rows.rows[0].discipline).toBe('bjj');
    } finally {
      await client.end();
    }
  });

  test('drill-library-v3 still installs the CHECK when the foreign key is absent', async () => {
    // The other half of the gate, and the one that keeps the column governed on
    // a fresh rebuild: between v3 at 49 and the FK migration much later there
    // is no registry key, so the literal CHECK must still be created there.
    // Without this case the gate could be narrowed to "never create it" and
    // every other assertion in this file would still pass.
    const client = await freshDatabase('dlcd_v3_no_fk', { withFk: false });
    try {
      expect(await constraintNames(client)).toEqual([CHECK_NAME]);

      await client.query('alter table pilot.drill_library drop constraint ' + CHECK_NAME);
      expect(await constraintNames(client)).toEqual([]);

      await client.query(v3MigrationSql);

      expect(await constraintNames(client)).toEqual([CHECK_NAME]);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-drill-library-check-drop-migration.mjs's READINESS_QUERY
// -- the assertion that gates the dispatch, and the code whose first real
// execution would otherwise be against a live environment. #488 is what that
// costs: an assertion that could not pass on ANY database, found only by a
// staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported out
// of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots.
describe('drill library check drop runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('dlcd_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_LIBRARY_CHECK_DROP_NOT_READY/,
      );
      // The rollback left the CHECK in place; a refused readiness must not be a
      // half-applied migration.
      expect(await constraintNames(client)).toEqual([CHECK_NAME, FK_NAME]);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES an UNGOVERNED column even when the migration itself did nothing', async () => {
    // The state no dispatch may ever report as ready: the CHECK gone AND the
    // foreign key gone, so the discipline column is free text.
    //
    // The migration's own guard cannot reach this case -- it raises before
    // dropping -- so the readiness query is reached here with a no-op SQL
    // against a database somebody else put in that state. That is the point:
    // the runner's job is to describe the database it is leaving behind, not to
    // trust the file it just ran. Without this case the
    // `discipline_fk_still_governing` clause could be deleted and every other
    // assertion in this file would still pass.
    const client = await freshDatabase('dlcd_rdy_free_text');
    try {
      await client.query('alter table pilot.drill_library drop constraint ' + CHECK_NAME);
      await client.query('alter table pilot.drill_library drop constraint ' + FK_NAME);
      expect(await constraintNames(client)).toEqual([]);

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_LIBRARY_CHECK_DROP_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database whose foreign key has gone missing', async () => {
    // The readiness half of the safety property. If both constraints were
    // absent the column would be ungoverned, and no dispatch may report PASS
    // for that state.
    const client = await freshDatabase('dlcd_rdy_ungoverned');
    try {
      await client.query('alter table pilot.drill_library drop constraint ' + FK_NAME);

      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow();

      // Rolled back whole: the CHECK is still there, because the SQL's own
      // guard raised before dropping it.
      expect(await constraintNames(client)).toEqual([CHECK_NAME]);
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('dlcd_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch, so the
      // second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);

      expect(await constraintNames(client)).toEqual([FK_NAME]);
    } finally {
      await client.end();
    }
  });

  test('the runner still ACCEPTS after the foreign key has been validated', async () => {
    // The readiness query deliberately does not assert `not convalidated`.
    // Validating the key is the intended, separate next step; a readiness check
    // that refused it would turn every subsequent `all` dispatch red at the
    // moment the release lane did the right thing.
    const client = await freshDatabase('dlcd_rdy_validated');
    try {
      await registerDiscipline(client, ORG_A, 'boxing');
      await applyMigrationTransaction(client, migrationSql);
      await client.query(`alter table pilot.drill_library validate constraint ${FK_NAME}`);

      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});

// The drill-library-v3 RUNNER's readiness assertion, which this change also
// edits.
//
// That runner used to assert pilot_drill_library_discipline_check outright,
// vocabulary and all. Left alone, the first `all` dispatch after this drop
// would have died there -- in the migration that creates half the drill schema,
// nowhere near the migration that caused it. The clause now asserts the
// PROPERTY the CHECK was standing in for: the discipline column is governed by
// the registry key, or -- before that key exists -- by the literal CHECK.
//
// Both directions are exercised here rather than in drillLibraryV3.pg.test.ts,
// because it is this change that made the clause conditional and this file that
// owns the reason. The query is never restated: `applyMigrationTransaction` is
// imported out of the shipped v3 runner.
describe('the drill-library-v3 runner after the CHECK is gone', () => {
  test('it ACCEPTS a database where the CHECK has been dropped and the key governs', async () => {
    // THE REGRESSION THIS EDIT EXISTS FOR. Without it this is the assertion
    // that turns every dispatch red the moment the drop lands.
    const client = await freshDatabase('dlcd_v3_rdy_after_drop');
    try {
      await client.query(migrationSql);
      expect(await constraintNames(client)).toEqual([FK_NAME]);

      await applyV3MigrationTransaction(client, v3MigrationSql);
    } finally {
      await client.end();
    }
  });

  test('it still REFUSES a database where NEITHER constraint governs the column', async () => {
    // The clause is an OR, not a deletion. If it had simply been removed, an
    // ungoverned discipline column would pass v3 readiness silently -- and that
    // is the one state this whole change must never reach.
    const client = await freshDatabase('dlcd_v3_rdy_free_text');
    try {
      await client.query('alter table pilot.drill_library drop constraint ' + CHECK_NAME);
      await client.query('alter table pilot.drill_library drop constraint ' + FK_NAME);

      await expect(applyV3MigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_LIBRARY_V3_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });
});
