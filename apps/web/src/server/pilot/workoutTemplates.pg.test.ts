// Real PostgreSQL-backed contract test for the workout templates v2
// migration (pilot.workout_templates, pilot.workout_template_items) and
// for workoutTemplates.ts's read functions running against a real
// transaction.
//
// Five things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. pilot_wti_no_contact_volume actually holds: an item with
//    contact_level='controlled_sparring' and a duration_minutes value is
//    rejected.
// 2. pilot_wti_one_source holds: an item naming both a drill_id and
//    free_text_drill is rejected, and an item naming neither is rejected.
// 3. scale_level is genuinely nullable and defaults to null -- a template
//    item never forces a level.
// 4. pilot_wti_drill_fk is real: an item referencing a nonexistent
//    drill_id is rejected.
// 5. The readiness check actually fails when the migration did not land.
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

import { getWorkoutTemplateWithItems, listWorkoutTemplates } from './workoutTemplates';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-workout-templates-v2-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DRILL_LIBRARY_MIGRATION_FILE = 'pilot_slice_postgres_drill_library_v3_migration.sql';
const MIGRATION_FILE = 'pilot_slice_postgres_workout_templates_v2_migration.sql';
const DRILL_LIBRARY_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-library-v3-migration.mjs',
);
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-workout-templates-v2-migration.mjs',
);
const DRILL_SEED_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/seed-drill-library.mjs');
const DRILL_SEED_DIR = path.resolve(__dirname, '../../../seed-data/drill-library');
const TEMPLATE_SEED_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/seed-workout-templates.mjs');
const TEMPLATE_SEED_DIR = path.resolve(__dirname, '../../../seed-data/workout-templates');

const ORG_A = 'org-workouttemplates-a';
// A second gym, so the organization_id predicate on every read in this module
// is proven rather than assumed. Nothing in this suite had one before.
const ORG_B = 'org-workouttemplates-b';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let drillLibraryMigrationSql: string;
let vocabularyWideningSql: string;
let migrationSql: string;
let baseSchemaSql: string;
let applyDrillLibraryMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let seedDrillLibraryAll: (
  client: Client,
  seedDir: string,
  placeholders: { organizationId: string; seedAccountId: string },
  opts?: { dryRun?: boolean },
) => Promise<void>;
let seedWorkoutTemplatesAll: (
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
  await applyDrillLibraryMigrationTransaction(client, drillLibraryMigrationSql);
  // seed-drill-library.mjs loads the real CSVs, which carry
  // authoring_state='literature_grounded_draft' and rule_kind='warmup_decay'.
  // Only the vocabulary-widening migration permits those, so it is a genuine
  // prerequisite for any test in this file that seeds the real library.
  await client.query(vocabularyWideningSql);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_A],
  );

  activeClient = client;
  return client;
}

async function insertDrill(
  client: Client,
  drillId: string,
  name: string,
  organizationId: string = ORG_A,
): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, name, discipline, category, difficulty, target_behavior,
        purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like)
     values ($1,$2,$2,1,$3,'boxing','technical','beginner','x','x','x','x','x','x')`,
    [organizationId, drillId, name],
  );
}

// The organization row a second-gym fixture needs. freshDatabase creates ORG_A
// only, so a cross-organization test has to create its own counterpart -- the
// foreign key on workout_templates.organization_id refuses a template for a
// gym that does not exist.
async function insertOrganization(client: Client, organizationId: string): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [organizationId],
  );
}

async function insertTemplate(
  client: Client,
  templateId: string,
  name: string,
  overrides: {
    organizationId?: string;
    sessionType?: string;
    difficulty?: string;
    ageBand?: string;
    active?: boolean;
  } = {},
): Promise<void> {
  await client.query(
    `insert into pilot.workout_templates
       (organization_id, template_id, lineage_id, name, session_type, difficulty, age_band, active,
        duration_minutes, intent)
     values ($1,$2,$2,$3,$4,$5,$6,$7,45,'Test intent')`,
    [
      overrides.organizationId ?? ORG_A,
      templateId,
      name,
      overrides.sessionType ?? 'technical',
      overrides.difficulty ?? 'intermediate',
      overrides.ageBand ?? 'any',
      overrides.active ?? true,
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  drillLibraryMigrationSql = await fs.readFile(path.join(INFRA_DIR, DRILL_LIBRARY_MIGRATION_FILE), 'utf8');
  vocabularyWideningSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_drill_vocabulary_widening_migration.sql'), 'utf8',
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const drillLibraryRunnerModule = await nativeDynamicImport(pathToFileURL(DRILL_LIBRARY_RUNNER_PATH).href);
  applyDrillLibraryMigrationTransaction = drillLibraryRunnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  const drillSeedModule = await nativeDynamicImport(pathToFileURL(DRILL_SEED_SCRIPT_PATH).href);
  seedDrillLibraryAll = drillSeedModule.seedAll as typeof seedDrillLibraryAll;

  const templateSeedModule = await nativeDynamicImport(pathToFileURL(TEMPLATE_SEED_SCRIPT_PATH).href);
  seedWorkoutTemplatesAll = templateSeedModule.seedAll as typeof seedWorkoutTemplatesAll;
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

describe('workout templates v2 migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /WORKOUT_TEMPLATES_V2_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.workout_templates') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_wti_no_contact_volume', 'pilot_wti_one_source', 'pilot_wti_drill_fk')`,
      );
      expect(constraints.rows[0].n).toBe(3);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_wti_no_contact_volume', () => {
  test('an item with contact_level=controlled_sparring and a duration_minutes value is rejected', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_contact_volume_rejected');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertTemplate(client, 'tpl-1', 'Sparring Session');

      await expect(
        client.query(
          `insert into pilot.workout_template_items
             (organization_id, item_id, template_id, ordinal, block, free_text_drill, duration_minutes, contact_level)
           values ($1,'item-1','tpl-1',1,'sparring','Live sparring',6,'controlled_sparring')`,
          [ORG_A],
        ),
      ).rejects.toThrow(/pilot_wti_no_contact_volume/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an item with contact_level=controlled_sparring and NO duration or rep count is accepted', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_contact_volume_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertTemplate(client, 'tpl-1', 'Sparring Session');

      await client.query(
        `insert into pilot.workout_template_items
           (organization_id, item_id, template_id, ordinal, block, free_text_drill, contact_level, coach_note)
         values ($1,'item-1','tpl-1',1,'sparring','Live sparring','controlled_sparring','Coach sets volume in person.')`,
        [ORG_A],
      );
      const { rows } = await client.query(
        `select contact_level, duration_minutes, rep_count from pilot.workout_template_items where item_id = 'item-1'`,
      );
      expect(rows[0]).toEqual({ contact_level: 'controlled_sparring', duration_minutes: null, rep_count: null });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a light_technical item MAY carry a duration', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_light_technical_duration_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertTemplate(client, 'tpl-1', 'Technical Session');

      await client.query(
        `insert into pilot.workout_template_items
           (organization_id, item_id, template_id, ordinal, block, free_text_drill, duration_minutes, contact_level)
         values ($1,'item-1','tpl-1',1,'technical','Jab drill',10,'light_technical')`,
        [ORG_A],
      );
      const { rows } = await client.query(
        `select duration_minutes from pilot.workout_template_items where item_id = 'item-1'`,
      );
      expect(rows[0].duration_minutes).toBe(10);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_wti_one_source', () => {
  test('an item naming both a drill_id and free_text_drill is rejected', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_one_source_both');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, 'drl-1', 'Jab Drill');
      await insertTemplate(client, 'tpl-1', 'Session');

      await expect(
        client.query(
          `insert into pilot.workout_template_items
             (organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill)
           values ($1,'item-1','tpl-1',1,'technical','drl-1','Also free text')`,
          [ORG_A],
        ),
      ).rejects.toThrow(/pilot_wti_one_source/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an item naming neither a drill_id nor free_text_drill is rejected', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_one_source_neither');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertTemplate(client, 'tpl-1', 'Session');

      await expect(
        client.query(
          `insert into pilot.workout_template_items
             (organization_id, item_id, template_id, ordinal, block)
           values ($1,'item-1','tpl-1',1,'technical')`,
          [ORG_A],
        ),
      ).rejects.toThrow(/pilot_wti_one_source/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_wti_drill_fk', () => {
  test('an item referencing a nonexistent drill_id is rejected', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_drill_fk');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertTemplate(client, 'tpl-1', 'Session');

      await expect(
        client.query(
          `insert into pilot.workout_template_items
             (organization_id, item_id, template_id, ordinal, block, drill_id)
           values ($1,'item-1','tpl-1',1,'technical','drill-does-not-exist')`,
          [ORG_A],
        ),
      ).rejects.toThrow(/pilot_wti_drill_fk|foreign key/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('scale_level is genuinely nullable', () => {
  test('an item with no scale_level defaults to null, never a forced level', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_scale_level_null');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, 'drl-1', 'Jab Drill');
      await insertTemplate(client, 'tpl-1', 'Session');

      await client.query(
        `insert into pilot.workout_template_items
           (organization_id, item_id, template_id, ordinal, block, drill_id)
         values ($1,'item-1','tpl-1',1,'technical','drl-1')`,
        [ORG_A],
      );
      const { rows } = await client.query(
        `select scale_level from pilot.workout_template_items where item_id = 'item-1'`,
      );
      expect(rows[0].scale_level).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('workoutTemplates.ts read functions', () => {
  test('listWorkoutTemplates and getWorkoutTemplateWithItems return ordered items', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_read_functions');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, 'drl-1', 'Jab Drill');
      await insertDrill(client, 'drl-2', 'Footwork Drill');
      await insertTemplate(client, 'tpl-1', 'Beginner Footwork');

      await client.query(
        `insert into pilot.workout_template_items
           (organization_id, item_id, template_id, ordinal, block, drill_id)
         values ($1,'item-2','tpl-1',2,'technical','drl-2'), ($1,'item-1','tpl-1',1,'warmup','drl-1')`,
        [ORG_A],
      );

      const templates = await listWorkoutTemplates(ORG_A);
      expect(templates.map((t) => t.template_id)).toEqual(['tpl-1']);

      const detail = await getWorkoutTemplateWithItems(ORG_A, 'tpl-1');
      expect(detail).not.toBeNull();
      expect(detail?.items.map((i) => i.item_id)).toEqual(['item-1', 'item-2']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // ORGANIZATION ISOLATION.
  //
  // Every gym's templates live in one table, separated only by
  // organization_id, so that predicate IS the tenancy boundary for this
  // module. Until now nothing in this file proved it: there was no second
  // organization anywhere in the suite, so `where organization_id = $1`
  // could have been dropped from either read and all thirteen tests would
  // still have passed. sessionScripts.pg.test.ts proves exactly this for its
  // own module; these are the counterparts it has and this suite lacked.
  test('listWorkoutTemplates returns only the caller organization templates', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_list_org_scope');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertOrganization(client, ORG_B);
      await insertTemplate(client, 'tpl-a', 'A gym template');
      await insertTemplate(client, 'tpl-b', 'B gym template', { organizationId: ORG_B });

      expect((await listWorkoutTemplates(ORG_A)).map((t) => t.template_id)).toEqual(['tpl-a']);
      expect((await listWorkoutTemplates(ORG_B)).map((t) => t.template_id)).toEqual(['tpl-b']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('getWorkoutTemplateWithItems reads another organization template as absent', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_detail_org_scope');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertOrganization(client, ORG_B);
      await insertTemplate(client, 'tpl-b', 'B gym template', { organizationId: ORG_B });

      // Null, not the other gym's row: a template_id from another gym must
      // read as "no such template here", never as someone else's template.
      expect(await getWorkoutTemplateWithItems(ORG_A, 'tpl-b')).toBeNull();
      expect(await getWorkoutTemplateWithItems(ORG_B, 'tpl-b')).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // The sharp case: the same template_id existing in BOTH gyms. The template
  // read is keyed on (organization_id, template_id), but the ITEMS are a
  // second query -- so an items read scoped on template_id alone would return
  // one gym's plan attached to the other gym's template, and the composite
  // primary key would not catch it.
  test('getWorkoutTemplateWithItems never mixes in another organization items', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_items_org_scope');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertOrganization(client, ORG_B);
      await insertDrill(client, 'drl-a', 'A gym drill');
      await insertDrill(client, 'drl-b', 'B gym drill', ORG_B);
      await insertTemplate(client, 'shared-id', 'A gym template');
      await insertTemplate(client, 'shared-id', 'B gym template', { organizationId: ORG_B });

      await client.query(
        `insert into pilot.workout_template_items
           (organization_id, item_id, template_id, ordinal, block, drill_id)
         values ($1,'item-a','shared-id',1,'warmup','drl-a')`,
        [ORG_A],
      );
      await client.query(
        `insert into pilot.workout_template_items
           (organization_id, item_id, template_id, ordinal, block, drill_id)
         values ($1,'item-b','shared-id',1,'warmup','drl-b')`,
        [ORG_B],
      );

      const detailA = await getWorkoutTemplateWithItems(ORG_A, 'shared-id');
      expect(detailA?.template.name).toBe('A gym template');
      expect(detailA?.items.map((i) => i.item_id)).toEqual(['item-a']);

      const detailB = await getWorkoutTemplateWithItems(ORG_B, 'shared-id');
      expect(detailB?.template.name).toBe('B gym template');
      expect(detailB?.items.map((i) => i.item_id)).toEqual(['item-b']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // listWorkoutTemplates hard-codes `and active` with no includeRetired escape
  // hatch (unlike listSessionScripts). Nothing exercised that predicate, so a
  // retired template appearing in the library was untested either way.
  test('a retired template is left out of the library list', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_active_predicate');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertTemplate(client, 'tpl-live', 'Still taught');
      await insertTemplate(client, 'tpl-retired', 'No longer taught', { active: false });

      expect((await listWorkoutTemplates(ORG_A)).map((t) => t.template_id)).toEqual(['tpl-live']);

      // Retired is hidden, not deleted -- the row is still there to be read
      // directly, which is what makes this a list predicate rather than a
      // destructive operation.
      expect(await getWorkoutTemplateWithItems(ORG_A, 'tpl-retired')).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // Each filter is a `($n::text is null or col = $n)` pair. sessionScripts.pg
  // .test.ts records why that idiom needs proving in both directions: a wrong
  // cast makes it silently match NOTHING, which reads as an empty library
  // rather than a broken filter. So each case asserts the filter narrows to
  // the right row AND that leaving it unset does not narrow at all.
  test('each filter narrows to its own axis, and an unset filter does not narrow', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_filters');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertTemplate(client, 'tpl-cond', 'Conditioning', { sessionType: 'conditioning' });
      await insertTemplate(client, 'tpl-elite', 'Elite technical', { difficulty: 'elite' });
      await insertTemplate(client, 'tpl-youth', 'Youth technical', { ageBand: 'youth' });

      const all = await listWorkoutTemplates(ORG_A);
      expect(all.map((t) => t.template_id).sort()).toEqual(['tpl-cond', 'tpl-elite', 'tpl-youth']);

      expect((await listWorkoutTemplates(ORG_A, { sessionType: 'conditioning' })).map((t) => t.template_id))
        .toEqual(['tpl-cond']);
      expect((await listWorkoutTemplates(ORG_A, { difficulty: 'elite' })).map((t) => t.template_id))
        .toEqual(['tpl-elite']);
      expect((await listWorkoutTemplates(ORG_A, { ageBand: 'youth' })).map((t) => t.template_id))
        .toEqual(['tpl-youth']);

      // A filter naming something no template carries returns nothing --
      // distinguishing "this filter works" from "this filter matches
      // everything", which the positive cases alone cannot.
      expect(await listWorkoutTemplates(ORG_A, { sessionType: 'sparring' })).toEqual([]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('seed-workout-templates.mjs against real Postgres', () => {
  const SEED_ORG = 'ppbf-default-org';

  async function seedRealDrillLibrary(client: Client): Promise<void> {
    await seedDrillLibraryAll(client, DRILL_SEED_DIR, { organizationId: SEED_ORG, seedAccountId: 'acct-seed-test' });
  }

  test('--dry-run inserts nothing', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_seed_dry_run');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [SEED_ORG],
      );
      await seedRealDrillLibrary(client);

      await seedWorkoutTemplatesAll(
        client,
        TEMPLATE_SEED_DIR,
        { organizationId: SEED_ORG, seedAccountId: 'acct-seed-test' },
        { dryRun: true },
      );

      const { rows } = await client.query(
        `select count(*)::int as n from pilot.workout_templates where organization_id = $1`,
        [SEED_ORG],
      );
      expect(rows[0].n).toBe(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a real run seeds all 12 templates and 82 items, every item resolving a real drill_id', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_seed_real_run');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [SEED_ORG],
      );
      await seedRealDrillLibrary(client);

      await seedWorkoutTemplatesAll(client, TEMPLATE_SEED_DIR, { organizationId: SEED_ORG, seedAccountId: 'acct-seed-test' });

      const templates = await client.query(
        `select count(*)::int as n from pilot.workout_templates where organization_id = $1`,
        [SEED_ORG],
      );
      expect(templates.rows[0].n).toBe(12);

      const items = await client.query(
        `select count(*)::int as n from pilot.workout_template_items where organization_id = $1`,
        [SEED_ORG],
      );
      expect(items.rows[0].n).toBe(82);

      const orphanDrillRefs = await client.query(
        `select count(*)::int as n from pilot.workout_template_items wti
         where wti.organization_id = $1 and wti.drill_id is not null
           and not exists (
             select 1 from pilot.drill_library dl
             where dl.organization_id = wti.organization_id and dl.drill_id = wti.drill_id
           )`,
        [SEED_ORG],
      );
      expect(orphanDrillRefs.rows[0].n).toBe(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is idempotent: no duplicates, no error', async () => {
    const client = await freshDatabase('ppbf_test_wtpl_seed_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [SEED_ORG],
      );
      await seedRealDrillLibrary(client);

      await seedWorkoutTemplatesAll(client, TEMPLATE_SEED_DIR, { organizationId: SEED_ORG, seedAccountId: 'acct-seed-test' });
      await seedWorkoutTemplatesAll(client, TEMPLATE_SEED_DIR, { organizationId: SEED_ORG, seedAccountId: 'acct-seed-test' });

      const templates = await client.query(
        `select count(*)::int as n from pilot.workout_templates where organization_id = $1`,
        [SEED_ORG],
      );
      expect(templates.rows[0].n).toBe(12);

      const items = await client.query(
        `select count(*)::int as n from pilot.workout_template_items where organization_id = $1`,
        [SEED_ORG],
      );
      expect(items.rows[0].n).toBe(82);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
