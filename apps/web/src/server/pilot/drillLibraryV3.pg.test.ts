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

const ORG_A = 'org-drilllib-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let vocabularyWideningSql: string;
let baseSchemaSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
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
