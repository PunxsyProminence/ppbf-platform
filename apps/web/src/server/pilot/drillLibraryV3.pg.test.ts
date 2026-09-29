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

import {
  getAthleteDrillDetail,
  getDrillWithDetail,
  listAthleteCueLibrary,
  listAthleteDrillLibrary,
  listCueLibrary,
  listDrillLibrary,
} from './drillLibraryV3';
import { memberCodesForFamily, SKILL_FAMILY_IDS } from './skillFamilies';
import {
  committedRows,
  committedText,
  createSeedingGym,
  loadReferenceContent,
  loadResearchClaimsIntoPlatformLibrary,
  openFullSchemaDatabase,
} from '../../testing/referenceContentFixture';

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

/**
 * W-D2 needs pilot.drills, not just pilot.drill_library, because the athlete
 * reads ask a question that spans both: "has this gym adopted this reference
 * drill, and is the adoption live?"
 *
 * These are EXISTING, ALREADY-SHIPPED migrations, applied here only to build
 * the disposable local fixture. W-D2 adds no migration of its own -- the
 * column, the composite foreign key and the partial unique index all arrived
 * with W-D1's drill-reference-provenance migration, which is already applied in
 * staging and production.
 *
 * All four are required and the order is the workflow's `all` order:
 *   progression       creates pilot.drill_assignments, which the drills
 *                     migration ALTERs
 *   drills            creates pilot.drills
 *   drill-versioning  adds supersedes_drill_id / lineage columns, which the
 *                     provenance index predicates on
 *   provenance        adds reference_drill_id and its composite FK to
 *                     pilot.drill_library
 */
const PROGRESSION_MIGRATION_FILE = 'pilot_slice_postgres_progression_migration.sql';
const DRILLS_MIGRATION_FILE = 'pilot_slice_postgres_drills_migration.sql';
const DRILL_VERSIONING_MIGRATION_FILE = 'pilot_slice_postgres_drill_versioning_migration.sql';
const PROVENANCE_MIGRATION_FILE = 'pilot_slice_postgres_drill_reference_provenance_migration.sql';

const ORG_A = 'org-drilllib-a';
const ORG_B = 'org-drilllib-b';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let secondarySkillsSql: string;
let baseSchemaSql: string;
let operationalDrillSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applySecondarySkillsMigration: (client: Client, sql: string) => Promise<void>;
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
  secondarySkillsSql = await fs.readFile(path.join(INFRA_DIR, SECONDARY_MIGRATION_FILE), 'utf8');

  // Concatenated in dependency order and applied as one unit, because no test
  // here cares about the seams between them -- they exist only so that
  // pilot.drills.reference_drill_id is a real column in the fixture.
  operationalDrillSql = (await Promise.all([
    PROGRESSION_MIGRATION_FILE,
    DRILLS_MIGRATION_FILE,
    DRILL_VERSIONING_MIGRATION_FILE,
    PROVENANCE_MIGRATION_FILE,
  ].map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')))).join('\n');

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

/*
  THE COMMITTED DRILL LIBRARY, LOADED THE WAY THE SEED WORKFLOW LOADS IT.

  Until IMP-10 these cases ran seed-drill-library.mjs and
  seed-drill-secondary-skills.mjs. Both are retired: every dataset loads
  through the content-import core, run as runApply (the `content:apply` the
  seed workflow calls), so these run that -- over the COMMITTED files, into a
  database holding the schema production runs (full-schema.mjs, which includes
  the vocabulary-widening migration two of these files need: 228 scale rows say
  literature_grounded_draft and 63 stop rows warmup_decay). Every count comes
  from the files, so a hand-off that grows the library does not break them.
*/
describe('the committed drill library, loaded through the content-import core', () => {
  let seedDb: Client;

  const LIBRARY = committedRows('drill-library/seed_drill_library.csv');
  const SCALES = committedRows('drill-library/seed_drill_scale_levels.csv');
  const STOPS = committedRows('drill-library/seed_drill_stop_rules.csv');
  const CUES = committedRows('drill-library/seed_drill_cues.csv');

  beforeAll(async () => {
    seedDb = await openFullSchemaDatabase(Client, connectionStringFor, 'ppbf_test_drilllib_core_seed');
    await loadResearchClaimsIntoPlatformLibrary(seedDb);
  });

  afterAll(async () => {
    activeClient = null;
    await seedDb?.end().catch(() => {});
  });

  async function drillCount(organizationId: string): Promise<number> {
    const { rows } = await seedDb.query('select count(*)::int as n from pilot.drill_library where organization_id = $1', [organizationId]);
    return rows[0].n;
  }

  test('--dry-run applies every row and rolls it back: nothing is written', async () => {
    const admin = await createSeedingGym(seedDb, 'gym_drills_dry_run');
    const loaded = await loadReferenceContent(seedDb, {
      organizationId: 'gym_drills_dry_run', actorAccountId: admin, datasets: 'disciplines,drill-library', dryRun: true,
    });
    expect(loaded.code).toBe(0);
    expect(loaded.lines).toContain(`  drill-library: ${LIBRARY.length} new, 0 new version, 0 unchanged, 0 absent, 0 reject`);
    expect(loaded.lines.some((line) => line.startsWith('RESULT: DRY RUN -- applied inside the transaction and ROLLED BACK'))).toBe(true);
    expect(await drillCount('gym_drills_dry_run')).toBe(0);
  });

  test('a real load writes every committed drill and child row, placeholders substituted, stamped with the seed account', async () => {
    const organizationId = 'gym_drills_real';
    const admin = await createSeedingGym(seedDb, organizationId);
    const loaded = await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: 'disciplines,drill-library' });
    expect(loaded.code).toBe(0);

    const { rows } = await seedDb.query(
      `select count(*)::int as n, count(*) filter (where organization_id = $1)::int as n_for_org
       from pilot.drill_library`,
      [organizationId],
    );
    expect(rows[0].n_for_org).toBe(LIBRARY.length);
    expect(LIBRARY.length).toBeGreaterThanOrEqual(119);

    // Every row carries the seed account and ITS role, read from
    // pilot.accounts after the core checked it -- not a value from the CSV.
    const provenance = await seedDb.query(
      `select created_by_account_id, created_by_role, count(*)::int as n
       from pilot.drill_library where organization_id = $1
       group by 1, 2`,
      [organizationId],
    );
    expect(provenance.rows).toEqual([{ created_by_account_id: admin, created_by_role: 'organization_admin', n: LIBRARY.length }]);

    // The child tables, pinned to the committed files' own row counts --
    // including the two vocabularies only the widening migration admits, the
    // proof the real data gets in rather than only a synthetic row.
    const children = await seedDb.query(
      `select
         (select count(*)::int from pilot.drill_scale_levels where organization_id = $1) as scale_levels,
         (select count(*)::int from pilot.drill_stop_rules  where organization_id = $1) as stop_rules,
         (select count(*)::int from pilot.drill_cues        where organization_id = $1) as cues,
         (select count(*)::int from pilot.drill_scale_levels
            where organization_id = $1 and authoring_state = 'literature_grounded_draft') as lit_grounded,
         (select count(*)::int from pilot.drill_stop_rules
            where organization_id = $1 and rule_kind = 'warmup_decay') as warmup_decay`,
      [organizationId],
    );
    const litGrounded = SCALES.filter((row) => row.authoring_state === 'literature_grounded_draft').length;
    const warmupDecay = STOPS.filter((row) => row.rule_kind === 'warmup_decay').length;
    expect(children.rows[0]).toEqual({
      scale_levels: SCALES.length,
      stop_rules: STOPS.length,
      cues: CUES.length,
      lit_grounded: litGrounded,
      warmup_decay: warmupDecay,
    });
    expect([litGrounded, warmupDecay].every((count) => count > 0)).toBe(true);
  });

  test('loading it again writes nothing: every drill unchanged, no duplicate, no new version', async () => {
    const organizationId = 'gym_drills_again';
    const admin = await createSeedingGym(seedDb, organizationId);
    expect((await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: 'disciplines,drill-library' })).code).toBe(0);

    const again = await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: 'disciplines,drill-library' });
    expect(again.code).toBe(0);
    expect(again.lines).toContain(`  drill-library: 0 new, 0 new version, ${LIBRARY.length} unchanged, 0 absent, 0 reject`);
    expect(again.lines).toContain('RESULT: NOTHING TO APPLY -- every item is unchanged or absent; nothing was written.');
    expect(await drillCount(organizationId)).toBe(LIBRARY.length);
    const heads = await seedDb.query('select count(*)::int as n from pilot.drill_library where organization_id = $1 and version = 1', [organizationId]);
    expect(heads.rows[0].n).toBe(LIBRARY.length);
  });

  test('refuses a seed account id that matches no account, writing nothing', async () => {
    // account_id is case-sensitive, and a wrong casing is the likeliest way an
    // operator types an id that resolves to nobody.
    const organizationId = 'gym_drills_no_account';
    const admin = await createSeedingGym(seedDb, organizationId);
    const loaded = await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin.toUpperCase(), datasets: 'disciplines,drill-library' });
    expect(loaded.code).toBe(1);
    expect(loaded.lines.find((line) => line.startsWith('RESULT:'))).toMatch(/^RESULT: REFUSED -- CONTENT_IMPORT_ACTOR_NOT_FOUND: /);
    expect(await drillCount(organizationId)).toBe(0);
  });
});

/*
  pilot.drill_secondary_skills through the core.

  A row here says "this drill also trains that skill". Getting one wrong does
  not crash anything: it silently widens what a coach's related-skill search
  returns, and the drill still looks correct in every other view. So the
  refusals matter more than the insert, and most of what follows exercises
  them against a real database.

  seed-drill-secondary-skills.mjs was the one write path into this table and
  kept its refusals in code. Now secondary skills are part of a drill's
  version unit (Jason's default: a drill's version includes its secondary
  skills), loaded with the drill library, and the refusals are the validator's
  relationship rules (specs/drills.ts) applied at plan against what this gym
  holds: a refused package writes NOTHING, the valid rows beside the bad one
  included. The committed relationship rows are used wherever they are the
  subject; a synthetic CSV would prove the path works on input nobody ships.
*/
describe('drill secondary skills, loaded through the content-import core', () => {
  let seedDb: Client;
  const SECONDARY_CSV = 'drill-library/seed_drill_secondary_skills.csv';
  const LIBRARY = committedRows('drill-library/seed_drill_library.csv');
  const LINKS = committedRows(SECONDARY_CSV);
  const [APPROVED] = LINKS;
  const primaryOf = (drillId: string) => LIBRARY.find((row) => row.drill_id === drillId)?.skill_id ?? '';
  const NO_PRIMARY = LIBRARY.find((row) => !row.skill_id) as Record<string, string>;

  beforeAll(async () => {
    seedDb = await openFullSchemaDatabase(Client, connectionStringFor, 'ppbf_test_secskill_core_seed');
    await loadResearchClaimsIntoPlatformLibrary(seedDb);
  });

  afterAll(async () => {
    activeClient = null;
    await seedDb?.end().catch(() => {});
  });

  async function relationRows(organizationId: string): Promise<{ drill_id: string; skill_id: string }[]> {
    const { rows } = await seedDb.query(
      'select drill_id, skill_id from pilot.drill_secondary_skills where organization_id = $1 order by drill_id, skill_id',
      [organizationId],
    );
    return rows;
  }

  async function gymWithLibrary(organizationId: string): Promise<string> {
    const admin = await createSeedingGym(seedDb, organizationId);
    expect((await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: 'disciplines,drill-library' })).code).toBe(0);
    return admin;
  }

  /** The secondary-skills file alone, with these rows: a package that revises only its drills' links. */
  function secondaryPackage(rows: string[], header = 'organization_id,drill_id,skill_id'): Record<string, string> {
    return { [SECONDARY_CSV]: `${[header, ...rows].join('\n')}\n` };
  }

  test('reads a committed relationship and a drill with no primary, so nothing below passes vacuously', () => {
    expect(LINKS.length).toBeGreaterThanOrEqual(1);
    expect(primaryOf(APPROVED.drill_id)).toMatch(/^SK-/);
    expect(primaryOf(APPROVED.drill_id)).not.toBe(APPROVED.skill_id);
    expect(NO_PRIMARY).toBeDefined();
  });

  test('--dry-run applies the committed relationships and rolls them back', async () => {
    const organizationId = 'gym_secskill_dry_run';
    const admin = await createSeedingGym(seedDb, organizationId);
    const loaded = await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: 'disciplines,drill-library', dryRun: true });
    expect(loaded.code).toBe(0);
    expect(loaded.lines.some((line) => line.startsWith('RESULT: DRY RUN'))).toBe(true);
    expect(await relationRows(organizationId)).toEqual([]);
  });

  test('the committed relationships insert exactly once, and a second load writes nothing', async () => {
    const organizationId = 'gym_secskill_idempotent';
    const admin = await gymWithLibrary(organizationId);
    const expected = LINKS.map((row) => ({ drill_id: row.drill_id, skill_id: row.skill_id })).sort((a, b) =>
      a.drill_id === b.drill_id ? a.skill_id.localeCompare(b.skill_id) : a.drill_id.localeCompare(b.drill_id));
    expect(await relationRows(organizationId)).toEqual(expected);

    const again = await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: 'disciplines,drill-library' });
    expect(again.lines).toContain('RESULT: NOTHING TO APPLY -- every item is unchanged or absent; nothing was written.');
    expect(await relationRows(organizationId)).toEqual(expected);
  });

  test('the primary owner is untouched, and the three filters then behave as designed', async () => {
    const organizationId = 'gym_secskill_discovery';
    await gymWithLibrary(organizationId);
    activeClient = seedDb;
    const secondary = APPROVED.skill_id;

    // C. The primary is read straight out of the column: loading a secondary
    // must not move it.
    const stored = await seedDb.query('select skill_id from pilot.drill_library where organization_id = $1 and drill_id = $2', [
      organizationId,
      APPROVED.drill_id,
    ]);
    expect(stored.rows[0].skill_id).toBe(primaryOf(APPROVED.drill_id));

    // D. skillId means PRIMARY OWNER and still does: the linked drill is not
    // among the owners of its secondary code.
    const owners = LIBRARY.filter((row) => row.skill_id === secondary).map((row) => row.drill_id).sort();
    const owned = await listDrillLibrary(organizationId, { skillId: secondary });
    expect(owned.map((row) => row.drill_id).sort()).toEqual(owners);
    expect(owners).not.toContain(APPROVED.drill_id);

    // E. relatedSkillId finds it THROUGH the relationship, beside the owners.
    const linkedTo = (code: string) => LINKS.filter((row) => row.skill_id === code).map((row) => row.drill_id);
    const related = await listDrillLibrary(organizationId, { relatedSkillId: secondary });
    expect(related.map((row) => row.drill_id).sort()).toEqual([...new Set([...owners, ...linkedTo(secondary)])].sort());

    // F. Family discovery reaches the drill through the secondary relation even
    // when its primary sits outside that family.
    const family = SKILL_FAMILY_IDS.find((id) => memberCodesForFamily(id).includes(secondary)) as string;
    const members = memberCodesForFamily(family);
    const inFamily = LIBRARY.filter((row) => members.includes(row.skill_id) || LINKS.some((link) => link.drill_id === row.drill_id && members.includes(link.skill_id)))
      .map((row) => row.drill_id)
      .sort();
    const byFamily = await listDrillLibrary(organizationId, { familyId: family });
    expect(byFamily.map((row) => row.drill_id).sort()).toEqual(inFamily);
    expect(inFamily).toContain(APPROVED.drill_id);
    activeClient = null;
  });

  test.each([
    ['a SKILL-* family id', 'family', () => `{{PPBF_ORG_ID}},${APPROVED.drill_id},SKILL-01`, 'skill_family_in_skill_column'],
    ['a secondary equal to the primary', 'same', () => `{{PPBF_ORG_ID}},${APPROVED.drill_id},${primaryOf(APPROVED.drill_id)}`, 'row_rule'],
    ['a drill with no primary owner', 'no_primary', () => `{{PPBF_ORG_ID}},${NO_PRIMARY.drill_id},${APPROVED.skill_id}`, 'row_rule'],
  ])('%s is refused, and nothing is written', async (_label, suffix, row, code) => {
    const organizationId = `gym_secskill_${suffix}`;
    const admin = await gymWithLibrary(organizationId);
    const before = await relationRows(organizationId);
    const loaded = await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: 'drill-library', files: secondaryPackage([row()]) });
    expect(loaded.code).toBe(1);
    expect(loaded.lines.some((line) => line.startsWith(`  [${code}]`))).toBe(true);
    expect(await relationRows(organizationId)).toEqual(before);
  });

  test('a drill whose stored primary differs from the expected one stops the load', async () => {
    // The approval of a relationship can say which primary it assumed
    // (expected_primary_skill_id). If the drill says otherwise, the decision
    // no longer applies -- refuse rather than reinterpret it.
    const organizationId = 'gym_secskill_primary_mismatch';
    const admin = await gymWithLibrary(organizationId);
    const other = [...new Set(LIBRARY.map((row) => row.skill_id).filter(Boolean))].find((code) => code !== primaryOf(APPROVED.drill_id)) as string;
    const loaded = await loadReferenceContent(seedDb, {
      organizationId,
      actorAccountId: admin,
      datasets: 'drill-library',
      files: secondaryPackage([`{{PPBF_ORG_ID}},${APPROVED.drill_id},${APPROVED.skill_id},${other}`], 'organization_id,drill_id,skill_id,expected_primary_skill_id'),
    });
    expect(loaded.code).toBe(1);
    expect(loaded.lines.some((line) => line.startsWith('  [row_rule]') && line.includes(`expected primary ${other}`))).toBe(true);
  });

  test('a refused row stops the whole package: the valid row beside it is not written either', async () => {
    // TWO ROWS, AND THE ORDER IS THE WHOLE TEST: the first is a legitimate new
    // link, the second is refused. All or nothing -- not "the bad row was
    // skipped".
    const organizationId = 'gym_secskill_atomicity';
    const admin = await gymWithLibrary(organizationId);
    const before = await relationRows(organizationId);
    const target = LIBRARY.find((row) => row.skill_id && row.skill_id !== APPROVED.skill_id && row.drill_id !== APPROVED.drill_id) as Record<string, string>;
    const loaded = await loadReferenceContent(seedDb, {
      organizationId,
      actorAccountId: admin,
      datasets: 'drill-library',
      files: secondaryPackage([`{{PPBF_ORG_ID}},${target.drill_id},${APPROVED.skill_id}`, `{{PPBF_ORG_ID}},${APPROVED.drill_id},SKILL-01`]),
    });
    expect(loaded.code).toBe(1);
    expect(await relationRows(organizationId)).toEqual(before);
    const versions = await seedDb.query('select count(*)::int as n from pilot.drill_library where organization_id = $1 and version > 1', [organizationId]);
    expect(versions.rows[0].n).toBe(0);
  });

  test('organization isolation: a drill in another gym is not a match', async () => {
    // The drills exist -- but in the first gym only. The relationships loaded
    // for the second gym must not reach across; they are refused as orphans,
    // and neither gym gains a row.
    const withLibrary = 'gym_secskill_isolation_a';
    await gymWithLibrary(withLibrary);
    const withLibraryBefore = await relationRows(withLibrary);
    const other = 'gym_secskill_isolation_b';
    const otherAdmin = await createSeedingGym(seedDb, other);

    const loaded = await loadReferenceContent(seedDb, {
      organizationId: other,
      actorAccountId: otherAdmin,
      datasets: 'drill-library',
      files: { [SECONDARY_CSV]: committedText(SECONDARY_CSV) },
    });
    expect(loaded.code).toBe(1);
    expect(loaded.lines.some((line) => line.startsWith('  [orphan_reference]'))).toBe(true);
    expect(await relationRows(other)).toEqual([]);
    expect(await relationRows(withLibrary)).toEqual(withLibraryBefore);

    activeClient = seedDb;
    expect(await listDrillLibrary(other, { relatedSkillId: APPROVED.skill_id })).toEqual([]);
    activeClient = null;
  });
});

/**
 * W-D2 -- ATHLETE REFERENCE / LEARNING, against a real database.
 *
 * The owner rule of 2026-09-17 is a two-sided AND: an athlete may read a
 * reference drill only while the reference itself is active AND this gym holds
 * an active operational promotion pointing at that exact reference row.
 *
 * It is proven HERE rather than with mocks because every way it can go wrong is
 * a SQL fact:
 *   * a missing organization term in the EXISTS subquery leaks across gyms, and
 *     there is no row-level security underneath to catch it -- a grep for
 *     `create policy` across infra/azure returns nothing, so this predicate IS
 *     the tenant boundary;
 *   * a root-scoped predicate (`supersedes_drill_id is null`) silently hides a
 *     drill the moment a coach refines it, because adopting a change proposal
 *     deactivates the root and the live row becomes a successor;
 *   * `active` on either side is one word, and dropping either one widens
 *     access without changing a single line of application logic.
 * A mocked query would assert the shape of a string. These assert the answer.
 */
describe('the athlete reference library against real Postgres', () => {
  const REFERENCE_ID = 'drl-ref-1';
  const OTHER_REFERENCE_ID = 'drl-ref-2';

  /**
   * The v3 library, its secondary-skill sibling, and the four already-shipped
   * migrations that put pilot.drills.reference_drill_id in the fixture.
   * ORG_B exists so cross-org isolation can be asked as a question rather than
   * assumed from a single-tenant database.
   */
  async function athleteFixture(name: string): Promise<Client> {
    const client = await freshDatabase(name);
    await applyMigrationTransaction(client, migrationSql);
    await applySecondarySkillsMigration(client, secondarySkillsSql);
    await client.query(operationalDrillSql);
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [ORG_B],
    );
    return client;
  }

  /** An operational drill, optionally pointing at a reference -- i.e. a promotion. */
  async function insertOperationalDrill(
    client: Client,
    opts: {
      organizationId?: string;
      drillId: string;
      name: string;
      referenceDrillId?: string | null;
      active?: boolean;
      supersedesDrillId?: string | null;
      lineageId?: string;
      version?: number;
    },
  ): Promise<void> {
    // `version` is explicit because pilot_drills_lineage_version_uq keys on
    // (lineage_id, version): two rows in one lineage both defaulting to version
    // 1 are refused, which is exactly the shape the successor case below builds.
    await client.query(
      `insert into pilot.drills
         (organization_id, drill_id, name, category, focus, active, lineage_id,
          supersedes_drill_id, reference_drill_id, version)
       values ($1,$2,$3,'bagwork','Focus.',$4,$5,$6,$7,$8)`,
      [
        opts.organizationId ?? ORG_A,
        opts.drillId,
        opts.name,
        opts.active ?? true,
        opts.lineageId ?? opts.drillId,
        opts.supersedesDrillId ?? null,
        opts.referenceDrillId ?? null,
        opts.version ?? 1,
      ],
    );
  }

  async function insertCue(client: Client, drillId: string, cueId: string, text: string): Promise<void> {
    await client.query(
      `insert into pilot.drill_cues
         (organization_id, cue_id, drill_id, cue_text, cue_family, focus_type, evidence_note, source_ref)
       values ($1,$2,$3,$4,'guard','external','Believed because of X.','batch-7')`,
      [ORG_A, cueId, drillId, text],
    );
  }

  test('a promoted, active reference is visible; an unpromoted one is not', async () => {
    const client = await athleteFixture('ppbf_test_drilllib_athlete_promoted');
    try {
      await insertDrill(client, { drillId: REFERENCE_ID, name: 'Adopted Drill' });
      await insertDrill(client, { drillId: OTHER_REFERENCE_ID, name: 'Never Adopted' });
      await insertOperationalDrill(client, {
        drillId: 'op-1',
        name: 'Adopted Drill',
        referenceDrillId: REFERENCE_ID,
      });

      const visible = await listAthleteDrillLibrary(ORG_A);

      expect(visible.map((drill) => drill.drill_id)).toEqual([REFERENCE_ID]);
      expect(await getAthleteDrillDetail(ORG_A, REFERENCE_ID)).not.toBeNull();
      // The unpromoted reference is not merely absent from the list -- it is
      // unreachable by id, which is the half a list assertion cannot prove.
      expect(await getAthleteDrillDetail(ORG_A, OTHER_REFERENCE_ID)).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('retiring the operational promotion withdraws current access', async () => {
    const client = await athleteFixture('ppbf_test_drilllib_athlete_retired_promo');
    try {
      await insertDrill(client, { drillId: REFERENCE_ID, name: 'Adopted Drill' });
      await insertOperationalDrill(client, {
        drillId: 'op-1',
        name: 'Adopted Drill',
        referenceDrillId: REFERENCE_ID,
        active: false,
      });

      expect(await listAthleteDrillLibrary(ORG_A)).toEqual([]);
      expect(await getAthleteDrillDetail(ORG_A, REFERENCE_ID)).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an inactive/retracted reference is hidden even while the promotion is live', async () => {
    const client = await athleteFixture('ppbf_test_drilllib_athlete_retracted_ref');
    try {
      await insertDrill(client, { drillId: REFERENCE_ID, name: 'Withdrawn Drill', active: false });
      await insertOperationalDrill(client, {
        drillId: 'op-1',
        name: 'Withdrawn Drill',
        referenceDrillId: REFERENCE_ID,
      });

      expect(await listAthleteDrillLibrary(ORG_A)).toEqual([]);
      // The coach detail read deliberately has no active filter, so this is the
      // case that proves the athlete path does not inherit it.
      expect(await getAthleteDrillDetail(ORG_A, REFERENCE_ID)).toBeNull();
      expect(await getDrillWithDetail(ORG_A, REFERENCE_ID)).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an active NON-ROOT successor keeps the reference visible, and yields one row not two', async () => {
    // The case a root-scoped predicate would fail. Adopting a change proposal
    // deactivates v1 (the lineage root) and inserts an active v2 carrying
    // supersedes_drill_id and the same reference pointer. The gym still runs the
    // drill, so the athlete must still be able to read it.
    const client = await athleteFixture('ppbf_test_drilllib_athlete_successor');
    try {
      await insertDrill(client, { drillId: REFERENCE_ID, name: 'Adopted Drill' });
      await insertOperationalDrill(client, {
        drillId: 'op-v1',
        name: 'Adopted Drill v1',
        referenceDrillId: REFERENCE_ID,
        active: false,
      });
      await insertOperationalDrill(client, {
        drillId: 'op-v2',
        name: 'Adopted Drill v2',
        referenceDrillId: REFERENCE_ID,
        active: true,
        supersedesDrillId: 'op-v1',
        lineageId: 'op-v1',
        version: 2,
      });

      const visible = await listAthleteDrillLibrary(ORG_A);

      // EXACTLY ONE. Two operational rows carry the same pointer; an EXISTS
      // answers once, where a join would have returned the reference twice.
      expect(visible.map((drill) => drill.drill_id)).toEqual([REFERENCE_ID]);
      expect(await getAthleteDrillDetail(ORG_A, REFERENCE_ID)).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('another gym promoting the same drill_id grants this gym nothing', async () => {
    const client = await athleteFixture('ppbf_test_drilllib_athlete_cross_org');
    try {
      // The same drill_id in both gyms -- the key is (organization_id, drill_id),
      // so this is legal and is exactly the shape that catches a missing
      // organization term in the EXISTS subquery.
      await insertDrill(client, { drillId: REFERENCE_ID, name: 'Shared Name A' });
      await insertDrill(client, { organizationId: ORG_B, drillId: REFERENCE_ID, name: 'Shared Name B' });
      await insertOperationalDrill(client, {
        organizationId: ORG_B,
        drillId: 'op-b',
        name: 'Adopted By B',
        referenceDrillId: REFERENCE_ID,
      });

      // ORG_B adopted it; ORG_A did not.
      expect(await listAthleteDrillLibrary(ORG_A)).toEqual([]);
      expect(await getAthleteDrillDetail(ORG_A, REFERENCE_ID)).toBeNull();

      expect((await listAthleteDrillLibrary(ORG_B)).map((drill) => drill.drill_id)).toEqual([REFERENCE_ID]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('the athlete list and detail carry instructional content and no authoring metadata', async () => {
    const client = await athleteFixture('ppbf_test_drilllib_athlete_projection');
    try {
      await insertDrill(client, { drillId: REFERENCE_ID, name: 'Adopted Drill' });
      await insertScaleLevel(client, {
        scaleId: 'scale-1',
        drillId: REFERENCE_ID,
        scaleLevel: 'B',
        isStartingPoint: true,
      });
      await client.query(
        `insert into pilot.drill_stop_rules
           (organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind)
         values ($1,'stop-1',$2,1,'Stop if the guard drops.','universal','safety')`,
        [ORG_A, REFERENCE_ID],
      );
      await insertCue(client, REFERENCE_ID, 'cue-1', 'Hand home first');
      await insertOperationalDrill(client, {
        drillId: 'op-1',
        name: 'Adopted Drill',
        referenceDrillId: REFERENCE_ID,
      });
      // OD-2026-09-19-001: the detail carries practical instruction, which in
      // the seeded corpus holds inline grounding-claim tags. Written here the
      // way the seed writes them, so the stripping is proven against a real row.
      await client.query(
        `update pilot.drill_library
            set what_good_looks_like = 'Hand back first [A2-070]',
                what_bad_looks_like = 'Hand drops [B3-047][A5-149]',
                common_errors = 'Pawing the jab',
                corrections = 'Coach calls home [A6-037]',
                transfer = 'Keeps the chin safe [A3-021]',
                equipment_needed = 'focus mitts'
          where organization_id = $1 and drill_id = $2`,
        [ORG_A, REFERENCE_ID],
      );

      const [summary] = await listAthleteDrillLibrary(ORG_A);
      const detail = await getAthleteDrillDetail(ORG_A, REFERENCE_ID);
      if (!detail) throw new Error('test bug: the promoted drill should be readable');

      expect(detail.what_good_looks_like).toBe('Hand back first');
      expect(detail.what_bad_looks_like).toBe('Hand drops');
      expect(detail.common_errors).toBe('Pawing the jab');
      expect(detail.corrections).toBe('Coach calls home');
      expect(detail.equipment_needed).toBe('focus mitts');
      expect(JSON.stringify(detail)).not.toMatch(/\[[A-Z]\d+-\d+\]/);
      // Transfer is not athlete content: neither its key nor its words arrive.
      expect(JSON.stringify(detail)).not.toContain('Keeps the chin safe');

      // AN EXACT ALLOW-LIST, not only the deny-list below. A deny-list catches
      // the names on it; a column added to the detail tomorrow under any other
      // name fails here instead.
      expect(Object.keys(detail).sort()).toEqual([
        'common_errors', 'contact_level', 'corrections', 'cues', 'drill_id', 'equipment_needed',
        'execution', 'name', 'purpose', 'requires_coach_authorization', 'scale_levels', 'setup',
        'stop_rules', 'what_bad_looks_like', 'what_good_looks_like',
      ]);
      expect(Object.keys(detail.scale_levels[0]).sort()).toEqual([
        'coach_watch_point', 'constraint_applied', 'contact_level', 'demand_description',
        'is_starting_point', 'scale_level',
      ]);
      expect(Object.keys(detail.stop_rules[0]).sort()).toEqual(['condition_text', 'ordinal', 'rule_kind', 'scope']);

      // The instructional content IS there -- a projection that dropped
      // everything would pass a deny-list check and be useless.
      expect(summary).toEqual({
        drill_id: REFERENCE_ID,
        name: 'Adopted Drill',
        purpose: 'Purpose.',
        setup: 'Setup.',
        execution: 'Execution.',
        contact_level: expect.any(String),
        requires_coach_authorization: expect.any(Boolean),
        cues: ['Hand home first'],
      });
      expect(detail.stop_rules).toEqual([
        { ordinal: 1, condition_text: 'Stop if the guard drops.', scope: 'universal', rule_kind: 'safety' },
      ]);
      expect(detail.scale_levels).toHaveLength(1);

      // RECURSIVE deny. Serialising and walking every key at every depth is what
      // makes a column added to pilot.drill_library tomorrow fail this test
      // rather than ship to a minor's screen.
      const FORBIDDEN = [
        'source_ref', 'evidence_note', 'field_provenance', 'grounding_claim_ids', 'content_class',
        'created_by_account_id', 'created_by_role', 'authoring_state', 'active', 'lineage_id',
        'version', 'supersedes_drill_id', 'superseded_at', 'skill_id', 'target_behavior',
        'secondary_skills', 'organization_id',
        // Not an athlete field under OD-2026-09-19-001 either: transfer carries
        // grounding tags by design and is coaching context.
        'transfer',
      ];
      const keysAtEveryDepth = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.flatMap(keysAtEveryDepth);
        if (value && typeof value === 'object') {
          return Object.entries(value as Record<string, unknown>)
            .flatMap(([key, nested]) => [key, ...keysAtEveryDepth(nested)]);
        }
        return [];
      };

      for (const payload of [summary, detail]) {
        const keys = keysAtEveryDepth(JSON.parse(JSON.stringify(payload)));
        expect(keys.length).toBeGreaterThan(0);
        for (const forbidden of FORBIDDEN) {
          expect(keys).not.toContain(forbidden);
        }
      }
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('athlete cues come only from adopted drills and carry no evidence or lineage', async () => {
    const client = await athleteFixture('ppbf_test_drilllib_athlete_cues');
    try {
      await insertDrill(client, { drillId: REFERENCE_ID, name: 'Adopted Drill' });
      await insertDrill(client, { drillId: OTHER_REFERENCE_ID, name: 'Never Adopted' });
      await insertCue(client, REFERENCE_ID, 'cue-adopted', 'Hand home first');
      await insertCue(client, OTHER_REFERENCE_ID, 'cue-unadopted', 'Never visible');
      await insertOperationalDrill(client, {
        drillId: 'op-1',
        name: 'Adopted Drill',
        referenceDrillId: REFERENCE_ID,
      });

      const athleteCues = await listAthleteCueLibrary(ORG_A);

      expect(athleteCues.map((cue) => cue.cue_text)).toEqual(['Hand home first']);

      /* AN EXACT ALLOW-LIST, NOT A DENY-LIST, AND THE DIFFERENCE IS THE WHOLE
         POINT OF THIS ASSERTION.

         This case previously named two forbidden fields -- evidence_note and
         source_ref -- and a deny-list only ever catches what somebody thought
         of. The cue path is the one athlete read with NO constructive
         projection: listAthleteCueLibrary returns the query rows straight
         through, so its entire athlete-safety guarantee is the SQL select list.
         Adding d.content_class, created_by_role, organization_id or any other
         column to that select list would have reached an athlete while both of
         those deny assertions still passed.

         The route test cannot cover this either: it asserts Object.keys against
         MOCKED data, so it proves only that the route adds no key -- it can
         never observe what the query actually SELECTS. This assertion runs
         against real Postgres, so it is the only place the real column set is
         ever checked. Widen the select list and this fails. */
      const ATHLETE_CUE_KEYS = [
        'cue_family',
        'cue_id',
        'cue_text',
        'drill_id',
        'drill_name',
        'focus_type',
      ];
      expect(athleteCues).toHaveLength(1);
      for (const cue of athleteCues) {
        expect(Object.keys(cue).sort()).toEqual(ATHLETE_CUE_KEYS);
      }

      // The coach cue library is unchanged and still sees both, with the
      // evidence note attached -- the narrowing is the athlete's, not the table's.
      const coachCues = await listCueLibrary(ORG_A);
      expect(coachCues.map((cue) => cue.cue_text).sort()).toEqual(['Hand home first', 'Never visible']);
      expect(coachCues[0]).toHaveProperty('evidence_note');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
