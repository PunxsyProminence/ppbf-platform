// Real PostgreSQL-backed contract test for the drill library v3 migration
// (pilot.drill_library, pilot.drill_scale_levels, pilot.drill_stop_rules,
// pilot.drill_cues) and for drillLibraryV3.ts's read functions running
// against a real transaction.
//
// Five things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. difficulty and scale_level are genuinely independent axes: an advanced
//    drill can carry a scale-A row, a beginner drill can carry a scale-C
//    row -- no CHECK or trigger silently couples the two.
// 2. Exactly one is_starting_point row per drill, and it must be scale 'B'
//    -- pilot_drill_scale_one_start (a partial unique index) enforces the
//    "exactly one" half; a CHECK enforces which level it must be.
// 3. Two active drills sharing a name within one discipline are refused,
//    but the same name across two disciplines is allowed --
//    pilot_drill_library_one_active_name is scoped by discipline, not just
//    by organization.
// 4. The readiness check actually fails when the migration did not land,
//    and specifically when the grounding_claim_ids/field_provenance
//    columns this migration added beyond the literal uploaded spec are
//    missing.
// 5. getDrillWithDetail assembles one drill's scale levels, stop rules, and
//    cues correctly; listDrillLibrary filters by discipline/category/
//    difficulty and excludes inactive drills.
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

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import { getDrillWithDetail, listDrillLibrary } from './drillLibraryV3';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-library-v3-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_drill_library_v3_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-library-v3-migration.mjs',
);
const SEED_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/seed-drill-library.mjs');
const SEED_DIR = path.resolve(__dirname, '../../../seed-data/drill-library');

// The secondary-skill relation is a SEPARATE migration, and every test that
// reaches drillLibraryV3.ts's read functions now needs it applied.
//
// Not a stylistic choice: getDrillWithDetail selects from
// pilot.drill_secondary_skills, and listDrillLibrary names it inside an EXISTS
// subquery. PostgreSQL resolves table references when it PARSES a statement,
// not when it evaluates one -- so the subquery's table must exist even on the
// calls that pass a null filter and can never execute it. A fixture that
// applied only the v3 migration would fail with "relation does not exist" on a
// query that was asking about nothing.
const SECONDARY_MIGRATION_FILE = 'pilot_slice_postgres_drill_secondary_skills_migration.sql';
const SECONDARY_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-secondary-skills-migration.mjs',
);

const ORG_A = 'org-drilllib-a';
const ORG_B = 'org-drilllib-b';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let vocabularyWideningSql: string;
let secondarySkillsSql: string;
let baseSchemaSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applySecondarySkillsMigration: (client: Client, sql: string) => Promise<void>;
let seedAll: (
  client: Client,
  seedDir: string,
  placeholders: { organizationId: string; seedAccountId: string },
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
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_A],
  );

  activeClient = client;
  return client;
}

interface InsertDrillOptions {
  organizationId?: string;
  drillId: string;
  name: string;
  discipline?: string;
  category?: string;
  difficulty?: string;
  active?: boolean;
}

async function insertDrill(client: Client, opts: InsertDrillOptions): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, discipline, category, difficulty,
        target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like, active)
     values ($1,$2,$2,$3,$4,$5,$6,'Target behavior.','Purpose.','Setup.','Execution.','Good.','Bad.',$7)`,
    [
      opts.organizationId ?? ORG_A,
      opts.drillId,
      opts.name,
      opts.discipline ?? 'boxing',
      opts.category ?? 'footwork',
      opts.difficulty ?? 'intermediate',
      opts.active ?? true,
    ],
  );
}

async function insertScaleLevel(
  client: Client,
  opts: {
    organizationId?: string;
    scaleId: string;
    drillId: string;
    scaleLevel: 'A' | 'B' | 'C';
    isStartingPoint?: boolean;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.drill_scale_levels
       (organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description)
     values ($1,$2,$3,$4,$5,'Demand description.')`,
    [opts.organizationId ?? ORG_A, opts.scaleId, opts.drillId, opts.scaleLevel, opts.isStartingPoint ?? false],
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  // The shipped seed CSVs carry authoring_state='literature_grounded_draft'
  // and rule_kind='warmup_decay', which only the vocabulary-widening
  // migration permits. It is a genuine prerequisite for loading them, so the
  // seed tests below apply it -- reading it here keeps that explicit.
  vocabularyWideningSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_drill_vocabulary_widening_migration.sql'), 'utf8',
  );
  secondarySkillsSql = await fs.readFile(path.join(INFRA_DIR, SECONDARY_MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  // Applied through its OWN runner rather than as raw DDL, so the runner's
  // readiness query is exercised by every test below instead of being a file
  // nothing ever executes until a live dispatch.
  const secondaryRunnerModule = await nativeDynamicImport(
    pathToFileURL(SECONDARY_RUNNER_PATH).href,
  );
  applySecondarySkillsMigration = secondaryRunnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  const seedModule = await nativeDynamicImport(pathToFileURL(SEED_SCRIPT_PATH).href);
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

describe('drill library v3 migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_LIBRARY_V3_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.drill_library') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // The columns added beyond the literal uploaded spec -- if a readiness
  // check did not verify them, a database applying an older copy of this
  // migration file (missing the addition) would still report ready, and
  // grounding_claim_ids would be silently dropped at the schema boundary.
  test('the readiness check REFUSES a database missing grounding_claim_ids/field_provenance', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_readiness_provenance');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query('alter table pilot.drill_library drop column grounding_claim_ids');

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_LIBRARY_V3_NOT_READY/,
      );
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints or indexes', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-idem', name: 'Idempotent Drill' });

      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const drills = await client.query(`select drill_id from pilot.drill_library where organization_id = $1`, [ORG_A]);
      expect(drills.rows).toHaveLength(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('the two independent axes: difficulty and scale_level', () => {
  test('an advanced drill can carry a scale-A row', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_advanced_scale_a');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-adv', name: 'Advanced Drill', difficulty: 'advanced' });
      await insertScaleLevel(client, { scaleId: 'scale-adv-a', drillId: 'drill-adv', scaleLevel: 'A' });

      const { rows } = await client.query(
        `select d.difficulty, s.scale_level from pilot.drill_library d
         join pilot.drill_scale_levels s on s.organization_id = d.organization_id and s.drill_id = d.drill_id`,
      );
      expect(rows).toEqual([{ difficulty: 'advanced', scale_level: 'A' }]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a beginner drill can carry a scale-C row', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_beginner_scale_c');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-beg', name: 'Beginner Drill', difficulty: 'beginner' });
      await insertScaleLevel(client, { scaleId: 'scale-beg-c', drillId: 'drill-beg', scaleLevel: 'C' });

      const { rows } = await client.query(
        `select d.difficulty, s.scale_level from pilot.drill_library d
         join pilot.drill_scale_levels s on s.organization_id = d.organization_id and s.drill_id = d.drill_id`,
      );
      expect(rows).toEqual([{ difficulty: 'beginner', scale_level: 'C' }]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('B is the anchor: exactly one is_starting_point row, and it is B', () => {
  test('a second is_starting_point row is rejected by the partial unique index', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_one_start');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-start', name: 'Start Drill' });
      await insertScaleLevel(client, {
        scaleId: 'scale-start-b', drillId: 'drill-start', scaleLevel: 'B', isStartingPoint: true,
      });

      // A second B row on the same drill. In practice this trips
      // pilot_drill_scale_level_uq before it can ever reach
      // pilot_drill_scale_one_start -- combined with the is_starting_point
      // CHECK added above (which pins is_starting_point=true to scale_level
      // 'B' only), the two constraints together make a second starting
      // point on one drill structurally unreachable, which is the actual
      // guarantee this test is proving, however it is that Postgres phrases
      // the rejection.
      await expect(
        insertScaleLevel(client, {
          scaleId: 'scale-start-b2', drillId: 'drill-start', scaleLevel: 'B', isStartingPoint: true,
        }),
      ).rejects.toThrow(/pilot_drill_scale_one_start|pilot_drill_scale_level_uq|duplicate key/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('is_starting_point may only be true on scale_level B', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_start_must_be_b');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-start2', name: 'Start Drill Two' });

      await expect(
        client.query(
          `insert into pilot.drill_scale_levels
             (organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description)
           values ($1,'scale-bad-a','drill-start2','A',true,'Demand.')`,
          [ORG_A],
        ),
      ).rejects.toThrow();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('name uniqueness is scoped by discipline', () => {
  test('two active drills sharing a name within one discipline are refused', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_name_conflict');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-name-1', name: 'Shared Name', discipline: 'boxing' });

      await expect(
        insertDrill(client, { drillId: 'drill-name-2', name: 'Shared Name', discipline: 'boxing' }),
      ).rejects.toThrow(/pilot_drill_library_one_active_name|duplicate key/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('the same name across two disciplines is allowed', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_name_cross_discipline');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-cross-1', name: 'Shared Name', discipline: 'boxing' });
      await insertDrill(client, { drillId: 'drill-cross-2', name: 'Shared Name', discipline: 'wrestling' });

      const { rows } = await client.query(
        `select drill_id from pilot.drill_library where organization_id = $1 order by drill_id`,
        [ORG_A],
      );
      expect(rows).toEqual([{ drill_id: 'drill-cross-1' }, { drill_id: 'drill-cross-2' }]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('drillLibraryV3.ts against real Postgres', () => {
  test('getDrillWithDetail assembles scale levels, stop rules, and cues', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_detail');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applySecondarySkillsMigration(client, secondarySkillsSql);
      await insertDrill(client, { drillId: 'drill-detail', name: 'Detail Drill' });
      await insertScaleLevel(client, {
        scaleId: 'scale-detail-b', drillId: 'drill-detail', scaleLevel: 'B', isStartingPoint: true,
      });
      await client.query(
        `insert into pilot.drill_stop_rules (organization_id, stop_rule_id, drill_id, ordinal, condition_text, rule_kind)
         values ($1,'stop-1','drill-detail',1,'Stop on fatigue.','fatigue')`,
        [ORG_A],
      );
      await client.query(
        `insert into pilot.drill_cues (organization_id, cue_id, drill_id, cue_text)
         values ($1,'cue-1','drill-detail','Elbow tucked.')`,
        [ORG_A],
      );

      const detail = await getDrillWithDetail(ORG_A, 'drill-detail');
      expect(detail?.name).toBe('Detail Drill');
      expect(detail?.scale_levels).toHaveLength(1);
      expect(detail?.scale_levels[0].scale_level).toBe('B');
      expect(detail?.stop_rules).toHaveLength(1);
      expect(detail?.cues).toHaveLength(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('getDrillWithDetail returns null for a nonexistent drill', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_detail_missing');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const detail = await getDrillWithDetail(ORG_A, 'drill-does-not-exist');
      expect(detail).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('listDrillLibrary filters by discipline and excludes inactive drills', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_list_filter');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applySecondarySkillsMigration(client, secondarySkillsSql);
      await insertDrill(client, { drillId: 'drill-box', name: 'Boxing Drill', discipline: 'boxing' });
      await insertDrill(client, { drillId: 'drill-wr', name: 'Wrestling Drill', discipline: 'wrestling' });
      await insertDrill(client, { drillId: 'drill-inactive', name: 'Inactive Drill', discipline: 'boxing', active: false });

      const boxingDrills = await listDrillLibrary(ORG_A, { discipline: 'boxing' });
      expect(boxingDrills.map((row) => row.drill_id)).toEqual(['drill-box']);

      const all = await listDrillLibrary(ORG_A);
      expect(all.map((row) => row.drill_id).sort()).toEqual(['drill-box', 'drill-wr']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Secondary skill relationships (owner decision: ONE primary owner, ZERO-TO-MANY
// secondaries). The representation only -- no content mappings are asserted
// here, and none exist in the repository.
//
// The property every one of these guards is the same one: a secondary
// relationship ADDS to what a drill says about itself and never reassigns it.
// pilot.drill_library.skill_id is read back explicitly in the first case rather
// than being assumed, because "the primary owner did not move" is the claim the
// whole design rests on and it is the one a careless join would break silently.
// ---------------------------------------------------------------------------
describe('drill secondary skill relationships against real Postgres', () => {
  async function freshWithSecondaries(name: string): Promise<Client> {
    const client = await freshDatabase(name);
    await applyMigrationTransaction(client, migrationSql);
    await applySecondarySkillsMigration(client, secondarySkillsSql);
    return client;
  }

  /** insertDrill() leaves skill_id null; these cases are about skill_id, so they set it. */
  async function insertDrillWithPrimary(
    client: Client,
    opts: { organizationId?: string; drillId: string; name: string; primarySkillId: string | null },
  ): Promise<void> {
    await client.query(
      `insert into pilot.drill_library
         (organization_id, drill_id, lineage_id, name, discipline, category, difficulty, skill_id,
          target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like, active)
       values ($1,$2,$2,$3,'boxing','technical','advanced',$4,'T.','P.','S.','E.','G.','B.',true)`,
      [opts.organizationId ?? ORG_A, opts.drillId, opts.name, opts.primarySkillId],
    );
  }

  async function relate(
    client: Client,
    drillId: string,
    skillId: string,
    organizationId: string = ORG_A,
  ): Promise<void> {
    await client.query(
      `insert into pilot.drill_secondary_skills (organization_id, drill_id, skill_id)
       values ($1,$2,$3)`,
      [organizationId, drillId, skillId],
    );
  }

  test('a secondary skill does not move the primary owner', async () => {
    const client = await freshWithSecondaries('ppbf_test_drillsec_primary_intact');
    try {
      await insertDrillWithPrimary(client, {
        drillId: 'drill-primary', name: 'Primary Owner Drill', primarySkillId: 'SK-COMBO-03',
      });
      await relate(client, 'drill-primary', 'SK-STANCE-01');

      const detail = await getDrillWithDetail(ORG_A, 'drill-primary');
      expect(detail?.skill_id).toBe('SK-COMBO-03');
      expect(detail?.secondary_skills.map((row) => row.skill_id)).toEqual(['SK-STANCE-01']);

      // Read the stored column back directly: the assertion above goes through
      // the same function that assembles the collection, so on its own it could
      // not tell "primary unchanged" apart from "primary recomputed to the same
      // value".
      const stored = await client.query(
        `select skill_id from pilot.drill_library where organization_id = $1 and drill_id = $2`,
        [ORG_A, 'drill-primary'],
      );
      expect(stored.rows[0].skill_id).toBe('SK-COMBO-03');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a drill with no secondary relationships returns an empty collection', async () => {
    const client = await freshWithSecondaries('ppbf_test_drillsec_zero');
    try {
      await insertDrillWithPrimary(client, {
        drillId: 'drill-none', name: 'No Secondaries', primarySkillId: 'SK-JAB-01',
      });

      const detail = await getDrillWithDetail(ORG_A, 'drill-none');
      expect(detail?.secondary_skills).toEqual([]);
      expect(detail?.skill_id).toBe('SK-JAB-01');
      // Everything that was returned before is still returned.
      expect(detail?.scale_levels).toEqual([]);
      expect(detail?.stop_rules).toEqual([]);
      expect(detail?.cues).toEqual([]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('one drill carries several secondaries and still appears once in a list', async () => {
    const client = await freshWithSecondaries('ppbf_test_drillsec_multiple');
    try {
      await insertDrillWithPrimary(client, {
        drillId: 'drill-multi', name: 'Multi Secondary', primarySkillId: 'SK-COMBO-03',
      });
      await relate(client, 'drill-multi', 'SK-STANCE-01');
      await relate(client, 'drill-multi', 'SK-GUARD-01');

      const detail = await getDrillWithDetail(ORG_A, 'drill-multi');
      expect(detail?.secondary_skills.map((row) => row.skill_id)).toEqual(['SK-GUARD-01', 'SK-STANCE-01']);

      // The duplication trap. A join instead of EXISTS would return this drill
      // once per matching relation, so a two-secondary drill would appear twice
      // in a list OF DRILLS. Asserted on the unfiltered list too, because that
      // path must be unaffected entirely.
      const byRelated = await listDrillLibrary(ORG_A, { relatedSkillId: 'SK-STANCE-01' });
      expect(byRelated.map((row) => row.drill_id)).toEqual(['drill-multi']);

      const all = await listDrillLibrary(ORG_A);
      expect(all.map((row) => row.drill_id)).toEqual(['drill-multi']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('the same relation cannot be recorded twice', async () => {
    const client = await freshWithSecondaries('ppbf_test_drillsec_duplicate');
    try {
      await insertDrillWithPrimary(client, {
        drillId: 'drill-dup', name: 'Duplicate Relation', primarySkillId: 'SK-FW-01',
      });
      await relate(client, 'drill-dup', 'SK-STANCE-01');

      // The primary key IS the uniqueness guarantee -- there is no separate
      // unique constraint to drift away from it.
      await expect(relate(client, 'drill-dup', 'SK-STANCE-01')).rejects.toMatchObject({
        code: '23505',
      });

      const { rows } = await client.query(
        `select count(*)::int as n from pilot.drill_secondary_skills
         where organization_id = $1 and drill_id = $2`,
        [ORG_A, 'drill-dup'],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('secondary relationships are organization-scoped', async () => {
    const client = await freshWithSecondaries('ppbf_test_drillsec_org_isolation');
    try {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [ORG_B],
      );
      await insertDrillWithPrimary(client, {
        drillId: 'drill-shared-id', name: 'Org A Drill', primarySkillId: 'SK-COMBO-03',
      });
      await insertDrillWithPrimary(client, {
        organizationId: ORG_B,
        drillId: 'drill-shared-id',
        name: 'Org B Drill',
        primarySkillId: 'SK-COMBO-03',
      });
      await relate(client, 'drill-shared-id', 'SK-STANCE-01', ORG_A);
      await relate(client, 'drill-shared-id', 'SK-GUARD-01', ORG_B);

      // Same drill_id in both gyms on purpose: the key is composite, so a
      // relation that leaked would leak into a row that otherwise looks right.
      const detailA = await getDrillWithDetail(ORG_A, 'drill-shared-id');
      expect(detailA?.secondary_skills.map((row) => row.skill_id)).toEqual(['SK-STANCE-01']);

      const detailB = await getDrillWithDetail(ORG_B, 'drill-shared-id');
      expect(detailB?.secondary_skills.map((row) => row.skill_id)).toEqual(['SK-GUARD-01']);

      // Org A must not be discoverable through Org B's relation.
      const crossed = await listDrillLibrary(ORG_A, { relatedSkillId: 'SK-GUARD-01' });
      expect(crossed).toEqual([]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('deleting a drill removes its secondary relationships', async () => {
    const client = await freshWithSecondaries('ppbf_test_drillsec_cascade');
    try {
      await insertDrillWithPrimary(client, {
        drillId: 'drill-cascade', name: 'Cascade Drill', primarySkillId: 'SK-FW-05',
      });
      await relate(client, 'drill-cascade', 'SK-STANCE-01');
      await relate(client, 'drill-cascade', 'SK-GUARD-01');

      await client.query(
        `delete from pilot.drill_library where organization_id = $1 and drill_id = $2`,
        [ORG_A, 'drill-cascade'],
      );

      const { rows } = await client.query(
        `select count(*)::int as n from pilot.drill_secondary_skills where organization_id = $1`,
        [ORG_A],
      );
      expect(rows[0].n).toBe(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('relatedSkillId discovers a drill through a secondary relationship, and skillId does not', async () => {
    const client = await freshWithSecondaries('ppbf_test_drillsec_discovery');
    try {
      await insertDrillWithPrimary(client, {
        drillId: 'drill-owned', name: 'Owned By Stance', primarySkillId: 'SK-STANCE-01',
      });
      await insertDrillWithPrimary(client, {
        drillId: 'drill-related', name: 'Related To Stance', primarySkillId: 'SK-COMBO-03',
      });
      await relate(client, 'drill-related', 'SK-STANCE-01');

      // THE PRODUCT REQUIREMENT: a drill is discoverable through a secondary
      // relationship without that skill becoming its owner.
      const related = await listDrillLibrary(ORG_A, { relatedSkillId: 'SK-STANCE-01' });
      expect(related.map((row) => row.drill_id).sort()).toEqual(['drill-owned', 'drill-related']);
      expect(related.find((row) => row.drill_id === 'drill-related')?.skill_id).toBe('SK-COMBO-03');

      // BACKWARD COMPATIBILITY: the pre-existing filter still means PRIMARY
      // OWNER and nothing else. If this ever returns drill-related, every
      // existing caller asking who owns a drill has started receiving drills it
      // does not own.
      const owned = await listDrillLibrary(ORG_A, { skillId: 'SK-STANCE-01' });
      expect(owned.map((row) => row.drill_id)).toEqual(['drill-owned']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('familyId finds a family through primary AND secondary, across more than one member code, within one organization', async () => {
    const client = await freshWithSecondaries('ppbf_test_drillsec_family');
    try {
      // Three drills, three different routes into SKILL-01, so a partial
      // implementation cannot pass: one owned by a member code, one owned by a
      // DIFFERENT member code (a single-code expansion would miss it), and one
      // owned outside the family that only a secondary relationship connects.
      await insertDrillWithPrimary(client, {
        drillId: 'fam-stance', name: 'Owned By Stance Code', primarySkillId: 'SK-STANCE-01',
      });
      await insertDrillWithPrimary(client, {
        drillId: 'fam-guard', name: 'Owned By Guard Code', primarySkillId: 'SK-GUARD-02',
      });
      await insertDrillWithPrimary(client, {
        drillId: 'fam-secondary', name: 'Related By Secondary', primarySkillId: 'SK-CROSS-01',
      });
      await relate(client, 'fam-secondary', 'SK-GUARD-02');
      await insertDrillWithPrimary(client, {
        drillId: 'fam-outside', name: 'Outside The Family', primarySkillId: 'SK-RET-01',
      });

      // A second gym holding drills that match the family on BOTH routes --
      // one by primary member code, one only by a secondary relation. Family
      // expansion widens what a single query parameter matches, so it is
      // exactly the kind of change that can reach across organizations if the
      // new EXISTS loses a correlation. Neither of these may appear for ORG_A.
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [ORG_B],
      );
      await insertDrillWithPrimary(client, {
        organizationId: ORG_B,
        drillId: 'fam-stance',
        name: 'Org B Owned By Stance Code',
        primarySkillId: 'SK-STANCE-01',
      });
      await insertDrillWithPrimary(client, {
        organizationId: ORG_B,
        drillId: 'fam-b-secondary',
        name: 'Org B Related By Secondary',
        primarySkillId: 'SK-CROSS-01',
      });
      await relate(client, 'fam-b-secondary', 'SK-GUARD-02', ORG_B);

      const family = await listDrillLibrary(ORG_A, { familyId: 'SKILL-01' });
      expect(family.map((row) => row.drill_id).sort()).toEqual([
        'fam-guard', 'fam-secondary', 'fam-stance',
      ]);

      // 'fam-stance' exists in BOTH gyms on purpose -- drill_id alone cannot
      // distinguish them, so a leak would arrive looking like a legitimate row
      // rather than an obviously foreign one. Name is what separates them.
      expect(family.find((row) => row.drill_id === 'fam-stance')?.name)
        .toBe('Owned By Stance Code');
      expect(family.map((row) => row.drill_id)).not.toContain('fam-b-secondary');

      // And the isolation holds in the other direction: ORG_B sees its own two
      // and none of ORG_A's four. A query that returned nothing here would pass
      // the assertions above while proving only that the filter is broken.
      const familyB = await listDrillLibrary(ORG_B, { familyId: 'SKILL-01' });
      expect(familyB.map((row) => row.drill_id).sort()).toEqual([
        'fam-b-secondary', 'fam-stance',
      ]);
      expect(familyB.find((row) => row.drill_id === 'fam-stance')?.name)
        .toBe('Org B Owned By Stance Code');

      // SK-RET-01 carries the word "reset" and is deliberately NOT in SKILL-01.
      // If it ever appears here the crosswalk has been widened by accident.
      expect(family.map((row) => row.drill_id)).not.toContain('fam-outside');

      // The primary is untouched by family discovery -- fam-secondary is
      // reachable through SKILL-01 while still being owned by SK-CROSS-01.
      expect(family.find((row) => row.drill_id === 'fam-secondary')?.skill_id).toBe('SK-CROSS-01');

      // And the code-level filters still mean exactly what they meant: neither
      // widened to accept a family, and neither started matching the family's
      // other members.
      const byCode = await listDrillLibrary(ORG_A, { skillId: 'SK-STANCE-01' });
      expect(byCode.map((row) => row.drill_id)).toEqual(['fam-stance']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an unreconciled family refuses instead of returning a false empty result', async () => {
    const client = await freshWithSecondaries('ppbf_test_drillsec_family_refuse');
    try {
      await insertDrillWithPrimary(client, {
        drillId: 'fam-any', name: 'Any Drill', primarySkillId: 'SK-FW-03',
      });

      // SKILL-07 is a real promoted family with no approved crosswalk. The
      // wrong implementation returns [] here and the caller reads it as
      // "Footwork / Ringcraft has no drills".
      //
      // This case proves the REFUSAL, not its ordering relative to the query:
      // a client is connected here, so it cannot distinguish "refused before
      // touching the database" from "refused after". That ordering is proved
      // by skillFamilies.test.ts, which throws with no database in the process
      // at all.
      await expect(listDrillLibrary(ORG_A, { familyId: 'SKILL-07' }))
        .rejects.toThrow(/no approved code crosswalk yet/);

      await expect(listDrillLibrary(ORG_A, { familyId: 'SK-STANCE-01' }))
        .rejects.toThrow(/Unknown skill family/);

      // A family id must never be compared against a skill column. Passing one
      // through the code-level filter finds nothing, which is what proves the
      // two namespaces stayed apart.
      const asCode = await listDrillLibrary(ORG_A, { relatedSkillId: 'SKILL-01' });
      expect(asCode).toEqual([]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('seed-drill-library.mjs against real Postgres', () => {
  const SEED_ORG = 'ppbf-default-org';

  test('--dry-run inserts nothing', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_seed_dry_run');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(vocabularyWideningSql);
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [SEED_ORG],
      );

      await seedAll(
        client,
        SEED_DIR,
        { organizationId: SEED_ORG, seedAccountId: 'acct-seed-test' },
        { dryRun: true },
      );

      const { rows } = await client.query(`select count(*)::int as n from pilot.drill_library where organization_id = $1`, [SEED_ORG]);
      expect(rows[0].n).toBe(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a real run seeds all 119 drills from the supplied CSV, substituting placeholders', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_seed_real_run');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(vocabularyWideningSql);
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [SEED_ORG],
      );

      await seedAll(client, SEED_DIR, { organizationId: SEED_ORG, seedAccountId: 'acct-seed-test' });

      const { rows } = await client.query(
        `select count(*)::int as n, count(*) filter (where organization_id = $1)::int as n_for_org
         from pilot.drill_library`,
        [SEED_ORG],
      );
      expect(rows[0].n).toBe(119);
      expect(rows[0].n_for_org).toBe(119);

      // The child tables, pinned to the supplied CSVs' own row counts. Two of
      // these files were rejected outright until the vocabulary-widening
      // migration landed, so these numbers are the proof the widening actually
      // let the real data in -- not just that a synthetic row passes the CHECK.
      const children = await client.query(
        `select
           (select count(*)::int from pilot.drill_scale_levels where organization_id = $1) as scale_levels,
           (select count(*)::int from pilot.drill_stop_rules  where organization_id = $1) as stop_rules,
           (select count(*)::int from pilot.drill_cues        where organization_id = $1) as cues,
           (select count(*)::int from pilot.drill_scale_levels
              where organization_id = $1 and authoring_state = 'literature_grounded_draft') as lit_grounded,
           (select count(*)::int from pilot.drill_stop_rules
              where organization_id = $1 and rule_kind = 'warmup_decay') as warmup_decay`,
        [SEED_ORG],
      );
      expect(children.rows[0]).toEqual({
        scale_levels: 357,
        stop_rules: 674,
        cues: 258,
        lit_grounded: 228,
        warmup_decay: 63,
      });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is idempotent: no duplicates, no error', async () => {
    const client = await freshDatabase('ppbf_test_drilllib_seed_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(vocabularyWideningSql);
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [SEED_ORG],
      );

      await seedAll(client, SEED_DIR, { organizationId: SEED_ORG, seedAccountId: 'acct-seed-test' });
      await seedAll(client, SEED_DIR, { organizationId: SEED_ORG, seedAccountId: 'acct-seed-test' });

      const { rows } = await client.query(`select count(*)::int as n from pilot.drill_library where organization_id = $1`, [SEED_ORG]);
      expect(rows[0].n).toBe(119);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
