// Real PostgreSQL-backed contract test for the content-import migration
// (owner rulings R2 and R3, 2026-09-29).
//
// What needs proving, and none of it can be read off the SQL:
//
// 1. A superseded drill version that stays ACTIVE (for the gyms that adopted
//    it) no longer holds its name, so the successor can keep that name --
//    and two CURRENT drills still cannot share one. Each has a control that
//    runs the same writes against the unmigrated v3 schema and gets the old
//    answer, so the assertion is shown to discriminate.
// 2. A lineage holds one unsuperseded version, in pilot.drill_library and in
//    pilot.workout_templates, and the supersede-then-insert order a version
//    write uses is accepted.
// 3. pilot.universal_stop_rules refuses what its CHECKs promise to refuse
//    (rule_kind outside the six, a blank condition, a contact level outside
//    the drill vocabulary) and holds one current rule per position.
// 4. pilot.reference_content_revisions is append-only in fact: UPDATE and
//    DELETE are refused by the trigger, a duplicate version by the key -- yet
//    deleting the organization still removes its history.
// 5. The seed loaders still load the shipped CSVs onto the migrated schema.
//    seed-drill-library.mjs only does because its ON CONFLICT predicate was
//    changed with this migration; the old predicate is shown to fail here.
// 6. The migration is idempotent in the strict sense -- the guarded
//    drop-and-recreate does NOT fire again on a second run -- and survives
//    the `all` loop re-running drill-library-v3 ahead of it.
// 7. The runner's readiness query passes on a migrated database and refuses
//    one where the migration did not run.
//
// Behaviour tests apply the migration SQL directly, so a mutant of one
// section fails only the tests about that section; the runner is driven in
// its own tests and in the seed tests.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-import-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');
const MIGRATION_FILE = 'pilot_slice_postgres_content_import_migration.sql';
const DRILL_SEED_DIR = path.resolve(__dirname, '../../../seed-data/drill-library');
const TEMPLATE_SEED_DIR = path.resolve(__dirname, '../../../seed-data/workout-templates');

// The prerequisites, in the workflow's `all` order. Raw SQL, not their
// runners: their readiness is their own suites' business.
const PREREQUISITE_FILES = [
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_drill_vocabulary_widening_migration.sql',
  'pilot_slice_postgres_workout_templates_v2_migration.sql',
];

const ORG = 'org-content-import';
const ORG_B = 'org-content-import-b';

// Gym content is seeded into punxsy_prominence by an organization_admin
// (OD-2026-09-28-007; seeded as organization_admin, never platform_owner).
const SEED_ORG = 'punxsy_prominence';
const SEED_ACCOUNT = 'acct-content-import-seed';

type Placeholders = { organizationId: string; seedAccountId: string };
type SeedAll = (
  client: Client,
  seedDir: string,
  placeholders: Placeholders,
  options?: { dryRun?: boolean },
) => Promise<unknown>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSql: string;
let prerequisiteSql: string[];
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let seedDrillLibraryAll: SeedAll;
let seedWorkoutTemplatesAll: SeedAll;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function emptyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/**
 * Base schema plus the three prerequisites, two organizations, and -- unless
 * `migrated: false` -- this migration applied as raw SQL.
 */
async function freshDatabase(name: string, { migrated = true } = {}): Promise<Client> {
  const client = await emptyDatabase(name);
  try {
    await client.query(baseSql);
    for (const sql of prerequisiteSql) {
      await client.query(sql);
    }
    for (const organizationId of [ORG, ORG_B]) {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active')`,
        [organizationId],
      );
    }
    if (migrated) {
      await client.query(migrationSql);
    }
  } catch (error) {
    // A setup failure would otherwise leave this connection open until the
    // server is killed, and the resulting error event fails the whole suite
    // instead of the one test whose setup failed.
    await closeQuietly(client);
    throw error;
  }
  return client;
}

async function closeQuietly(client: Client): Promise<void> {
  await client.end().catch(() => {});
}

async function insertDrill(
  client: Client,
  opts: {
    organizationId?: string;
    drillId: string;
    name: string;
    lineageId?: string;
    version?: number;
    supersedesDrillId?: string | null;
    superseded?: boolean;
    active?: boolean;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, supersedes_drill_id, superseded_at, name,
        category, target_behavior, purpose, standard_setup, execution, what_good_looks_like,
        what_bad_looks_like, active)
     values ($1,$2,$3,$4,$5,case when $6::boolean then now() else null end,$7,
             'footwork','t','p','s','e','g','b',$8)`,
    [
      opts.organizationId ?? ORG,
      opts.drillId,
      opts.lineageId ?? opts.drillId,
      opts.version ?? 1,
      opts.supersedesDrillId ?? null,
      opts.superseded ?? false,
      opts.name,
      opts.active ?? true,
    ],
  );
}

async function supersedeDrill(client: Client, drillId: string, organizationId = ORG): Promise<void> {
  await client.query(
    `update pilot.drill_library set superseded_at = now()
     where organization_id = $1 and drill_id = $2`,
    [organizationId, drillId],
  );
}

async function insertTemplate(
  client: Client,
  opts: {
    organizationId?: string;
    templateId: string;
    name: string;
    lineageId?: string;
    version?: number;
    superseded?: boolean;
    active?: boolean;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.workout_templates
       (organization_id, template_id, lineage_id, version, superseded_at, name, session_type,
        duration_minutes, intent, active)
     values ($1,$2,$3,$4,case when $5::boolean then now() else null end,$6,'technical',45,'Intent.',$7)`,
    [
      opts.organizationId ?? ORG,
      opts.templateId,
      opts.lineageId ?? opts.templateId,
      opts.version ?? 1,
      opts.superseded ?? false,
      opts.name,
      opts.active ?? true,
    ],
  );
}

interface UniversalRule {
  organizationId?: string;
  universalRuleId: string;
  lineageId?: string;
  version?: number;
  supersedesRuleId?: string | null;
  superseded?: boolean;
  active?: boolean;
  ordinal?: number;
  conditionText?: string;
  ruleKind?: string;
  appliesToContactLevels?: (string | null)[] | null;
}

async function insertUniversalRule(client: Client, rule: UniversalRule): Promise<void> {
  await client.query(
    `insert into pilot.universal_stop_rules
       (organization_id, universal_rule_id, lineage_id, version, supersedes_rule_id, superseded_at,
        active, ordinal, condition_text, rule_kind, applies_to_contact_levels,
        created_by_account_id, created_by_role)
     values ($1,$2,$3,$4,$5,case when $6::boolean then now() else null end,
             $7,$8,$9,$10,$11::text[],'acct-author','organization_admin')`,
    [
      rule.organizationId ?? ORG,
      rule.universalRuleId,
      rule.lineageId ?? rule.universalRuleId,
      rule.version ?? 1,
      rule.supersedesRuleId ?? null,
      rule.superseded ?? false,
      rule.active ?? true,
      rule.ordinal ?? 1,
      rule.conditionText ?? 'Stop on any sign of injury.',
      rule.ruleKind ?? 'safety',
      rule.appliesToContactLevels === undefined ? null : rule.appliesToContactLevels,
    ],
  );
}

const SHA = 'a'.repeat(64);

async function insertRevision(
  client: Client,
  opts: { organizationId?: string; dataset?: string; itemKey?: string; version?: number } = {},
): Promise<void> {
  await client.query(
    `insert into pilot.reference_content_revisions
       (organization_id, dataset, item_key, version, content, content_sha256, import_id,
        recorded_by_account_id, recorded_by_role)
     values ($1,$2,$3,$4,$5::jsonb,$6,'imp-test','acct-author','organization_admin')`,
    [
      opts.organizationId ?? ORG,
      opts.dataset ?? 'disciplines',
      opts.itemKey ?? 'boxing',
      opts.version ?? 1,
      JSON.stringify({ display_name: 'Boxing' }),
      SHA,
    ],
  );
}

async function countRevisions(client: Client, organizationId = ORG): Promise<number> {
  const { rows } = await client.query(
    `select count(*)::int as n from pilot.reference_content_revisions where organization_id = $1`,
    [organizationId],
  );
  return rows[0].n;
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

  baseSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  prerequisiteSql = await Promise.all(
    PREREQUISITE_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(
    pathToFileURL(path.join(SCRIPTS_DIR, 'pilot-apply-content-import-migration.mjs')).href,
  );
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as typeof applyMigrationTransaction;

  const drillSeedModule = await nativeDynamicImport(
    pathToFileURL(path.join(SCRIPTS_DIR, 'seed-drill-library.mjs')).href,
  );
  seedDrillLibraryAll = drillSeedModule.seedAll as SeedAll;
  const templateSeedModule = await nativeDynamicImport(
    pathToFileURL(path.join(SCRIPTS_DIR, 'seed-workout-templates.mjs')).href,
  );
  seedWorkoutTemplatesAll = templateSeedModule.seedAll as SeedAll;
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
  // Tolerant, as in captureParticipants.pg.test.ts: on Windows the kill is a
  // hard TerminateProcess, postgres can still hold the folder for a moment
  // (EBUSY observed on this suite's first run), and the server's own janitor
  // removes it once postgres has exited.
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('drill names: one CURRENT drill per name, not one active row per name', () => {
  test('CONTROL: before this migration, the v3 index refuses a same-name v2 while the superseded v1 stays active', async () => {
    const client = await freshDatabase('ppbf_ci_name_before', { migrated: false });
    try {
      await insertDrill(client, { drillId: 'drl-v1', name: 'Jab Return', superseded: true });
      await expect(
        insertDrill(client, {
          drillId: 'drl-v2', name: 'Jab Return', lineageId: 'drl-v1', version: 2, supersedesDrillId: 'drl-v1',
        }),
      ).rejects.toThrow(/pilot_drill_library_one_active_name/);
    } finally {
      await client.end();
    }
  });

  test('a superseded v1 (active, superseded_at set) and an unsuperseded v2 with the same name coexist', async () => {
    const client = await freshDatabase('ppbf_ci_name_coexist');
    try {
      await insertDrill(client, { drillId: 'drl-v1', name: 'Jab Return', superseded: true });
      await insertDrill(client, {
        drillId: 'drl-v2', name: 'Jab Return', lineageId: 'drl-v1', version: 2, supersedesDrillId: 'drl-v1',
      });

      const { rows } = await client.query(
        `select drill_id, active, superseded_at is not null as superseded
         from pilot.drill_library where organization_id = $1 and name = 'Jab Return' order by version`,
        [ORG],
      );
      // v1 stays ACTIVE: adopters still read it. That is the whole point.
      expect(rows).toEqual([
        { drill_id: 'drl-v1', active: true, superseded: true },
        { drill_id: 'drl-v2', active: true, superseded: false },
      ]);
    } finally {
      await client.end();
    }
  });

  test('two unsuperseded active drills with the same name in one discipline are still refused', async () => {
    const client = await freshDatabase('ppbf_ci_name_still_unique');
    try {
      await insertDrill(client, { drillId: 'drl-a', name: 'Slip Line' });
      await expect(insertDrill(client, { drillId: 'drl-b', name: 'Slip Line' })).rejects.toThrow(
        /pilot_drill_library_one_active_name/,
      );
    } finally {
      await client.end();
    }
  });
});

describe('one head per lineage', () => {
  test('CONTROL: before this migration, a lineage could hold two unsuperseded versions in both tables', async () => {
    const client = await freshDatabase('ppbf_ci_heads_before', { migrated: false });
    try {
      await insertDrill(client, { drillId: 'drl-h1', name: 'Pivot Out' });
      await insertDrill(client, {
        drillId: 'drl-h2', name: 'Pivot Out, revised', lineageId: 'drl-h1', version: 2, supersedesDrillId: 'drl-h1',
      });
      await insertTemplate(client, { templateId: 'wtp-h1', name: 'Footwork 45' });
      await insertTemplate(client, {
        templateId: 'wtp-h2', name: 'Footwork 45, revised', lineageId: 'wtp-h1', version: 2,
      });
      const { rows } = await client.query(
        `select (select count(*)::int from pilot.drill_library where lineage_id = 'drl-h1' and superseded_at is null) as drills,
                (select count(*)::int from pilot.workout_templates where lineage_id = 'wtp-h1' and superseded_at is null) as templates`,
      );
      expect(rows[0]).toEqual({ drills: 2, templates: 2 });
    } finally {
      await client.end();
    }
  });

  test('a second unsuperseded version in one drill lineage is refused', async () => {
    const client = await freshDatabase('ppbf_ci_heads_drill');
    try {
      await insertDrill(client, { drillId: 'drl-h1', name: 'Pivot Out' });
      // A different name, so only the lineage index can be what refuses it.
      await expect(
        insertDrill(client, {
          drillId: 'drl-h2', name: 'Pivot Out, revised', lineageId: 'drl-h1', version: 2, supersedesDrillId: 'drl-h1',
        }),
      ).rejects.toThrow(/pilot_drill_library_one_head_per_lineage/);
    } finally {
      await client.end();
    }
  });

  test('a second unsuperseded version in one template lineage is refused', async () => {
    const client = await freshDatabase('ppbf_ci_heads_template');
    try {
      await insertTemplate(client, { templateId: 'wtp-h1', name: 'Footwork 45' });
      await expect(
        insertTemplate(client, { templateId: 'wtp-h2', name: 'Footwork 45, revised', lineageId: 'wtp-h1', version: 2 }),
      ).rejects.toThrow(/pilot_workout_templates_one_head_per_lineage/);
    } finally {
      await client.end();
    }
  });

  test('supersede first, then insert, is accepted; and the rule is per organization', async () => {
    const client = await freshDatabase('ppbf_ci_heads_order');
    try {
      await insertDrill(client, { drillId: 'drl-h1', name: 'Pivot Out' });
      await supersedeDrill(client, 'drl-h1');
      await insertDrill(client, {
        drillId: 'drl-h2', name: 'Pivot Out', lineageId: 'drl-h1', version: 2, supersedesDrillId: 'drl-h1',
      });
      // Another gym's lineage with the same id is not this lineage.
      await insertDrill(client, { organizationId: ORG_B, drillId: 'drl-h1', name: 'Pivot Out' });

      await insertTemplate(client, { templateId: 'wtp-h1', name: 'Footwork 45', superseded: true, active: false });
      await insertTemplate(client, { templateId: 'wtp-h2', name: 'Footwork 45', lineageId: 'wtp-h1', version: 2 });

      const { rows } = await client.query(
        `select organization_id, drill_id from pilot.drill_library
         where lineage_id = 'drl-h1' and superseded_at is null order by organization_id`,
      );
      expect(rows).toEqual([
        { organization_id: ORG, drill_id: 'drl-h2' },
        { organization_id: ORG_B, drill_id: 'drl-h1' },
      ]);
    } finally {
      await client.end();
    }
  });
});

describe('pilot.universal_stop_rules', () => {
  let client: Client;

  beforeAll(async () => {
    client = await freshDatabase('ppbf_ci_universal');
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  test('stores a rule for every drill (no contact list) and one narrowed to contact levels', async () => {
    await insertUniversalRule(client, { universalRuleId: 'ust_injury', ordinal: 1 });
    await insertUniversalRule(client, {
      universalRuleId: 'ust_warmup',
      ordinal: 2,
      ruleKind: 'warmup_decay',
      conditionText: 'Re-warm before contact after an inactive gap.',
      appliesToContactLevels: ['controlled_sparring', 'open_sparring'],
    });

    const { rows } = await client.query(
      `select universal_rule_id, applies_to_contact_levels, version, active
       from pilot.universal_stop_rules where organization_id = $1 order by ordinal`,
      [ORG],
    );
    expect(rows).toEqual([
      { universal_rule_id: 'ust_injury', applies_to_contact_levels: null, version: 1, active: true },
      {
        universal_rule_id: 'ust_warmup',
        applies_to_contact_levels: ['controlled_sparring', 'open_sparring'],
        version: 1,
        active: true,
      },
    ]);
  });

  test('refuses a rule_kind outside the six values, and accepts each of the six', async () => {
    await expect(
      insertUniversalRule(client, { universalRuleId: 'ust_kind_bad', ordinal: 10, ruleKind: 'injury' }),
    ).rejects.toThrow(/pilot_universal_stop_rules_rule_kind_check/);

    const kinds = ['technique_degradation', 'fatigue', 'safety', 'intent_drift', 'coach_judgment', 'warmup_decay'];
    for (const [index, ruleKind] of kinds.entries()) {
      await insertUniversalRule(client, {
        organizationId: ORG_B, universalRuleId: `ust_kind_${index}`, ordinal: index + 1, ruleKind,
      });
    }
  });

  test('its rule_kind vocabulary is exactly the one drill_stop_rules uses', async () => {
    const { rows } = await client.query(
      `select pg_get_constraintdef(u.oid) = pg_get_constraintdef(d.oid) as same
       from pg_constraint u, pg_constraint d
       where u.conname = 'pilot_universal_stop_rules_rule_kind_check'
         and d.conname = 'pilot_drill_stop_rule_kind_check'`,
    );
    expect(rows).toEqual([{ same: true }]);
  });

  test('refuses a blank condition', async () => {
    for (const conditionText of ['', '   ', ' \n\t ']) {
      await expect(
        insertUniversalRule(client, { universalRuleId: 'ust_blank', ordinal: 20, conditionText }),
      ).rejects.toThrow(/pilot_universal_stop_rules_condition_check/);
    }
  });

  test('refuses an unknown contact level, an empty list and a NULL element', async () => {
    for (const appliesToContactLevels of [['full_contact'], ['open_sparring', 'sparring'], [], ['none', null]]) {
      await expect(
        insertUniversalRule(client, { universalRuleId: 'ust_contact_bad', ordinal: 21, appliesToContactLevels }),
      ).rejects.toThrow(/pilot_universal_stop_rules_contact_levels_check/);
    }
  });

  test('refuses an id without the ust_ prefix', async () => {
    for (const universalRuleId of ['stp_injury', 'injury', 'ust_', 'ust_ injury']) {
      await expect(insertUniversalRule(client, { universalRuleId, ordinal: 22 })).rejects.toThrow(
        /pilot_universal_stop_rules_id_check/,
      );
    }
  });

  test('one current rule per position; a superseded or withdrawn rule frees it', async () => {
    await insertUniversalRule(client, { universalRuleId: 'ust_pos_a', ordinal: 30 });
    await expect(insertUniversalRule(client, { universalRuleId: 'ust_pos_b', ordinal: 30 })).rejects.toThrow(
      /pilot_universal_stop_rules_one_current_per_ordinal/,
    );

    await client.query(
      `update pilot.universal_stop_rules set superseded_at = now()
       where organization_id = $1 and universal_rule_id = 'ust_pos_a'`,
      [ORG],
    );
    await insertUniversalRule(client, {
      universalRuleId: 'ust_pos_a2', lineageId: 'ust_pos_a', version: 2, supersedesRuleId: 'ust_pos_a', ordinal: 30,
    });

    await insertUniversalRule(client, { universalRuleId: 'ust_pos_withdrawn', ordinal: 31, active: false });
    await insertUniversalRule(client, { universalRuleId: 'ust_pos_live', ordinal: 31 });
  });

  test('one head per lineage, and a version chain cannot reach another gym', async () => {
    await insertUniversalRule(client, { universalRuleId: 'ust_chain', ordinal: 40 });
    await expect(
      insertUniversalRule(client, {
        universalRuleId: 'ust_chain_v2', lineageId: 'ust_chain', version: 2, supersedesRuleId: 'ust_chain', ordinal: 41,
      }),
    ).rejects.toThrow(/pilot_universal_stop_rules_one_head_per_lineage/);

    await expect(
      insertUniversalRule(client, {
        organizationId: ORG_B, universalRuleId: 'ust_cross_gym', supersedesRuleId: 'ust_chain', ordinal: 40,
      }),
    ).rejects.toThrow(/pilot_universal_stop_rules_supersedes_fk/);
  });
});

describe('pilot.reference_content_revisions', () => {
  test('records one row per item per version, and refuses a duplicate version', async () => {
    const client = await freshDatabase('ppbf_ci_ledger_insert');
    try {
      await insertRevision(client, { version: 1 });
      await insertRevision(client, { version: 2 });
      await insertRevision(client, { dataset: 'competence_levels', itemKey: 'boxing', version: 1 });
      expect(await countRevisions(client)).toBe(3);

      await expect(insertRevision(client, { version: 2 })).rejects.toThrow(
        /pilot_reference_content_revisions_pkey/,
      );
    } finally {
      await client.end();
    }
  });

  test('refuses UPDATE', async () => {
    const client = await freshDatabase('ppbf_ci_ledger_update');
    try {
      await insertRevision(client);
      await expect(
        client.query(
          `update pilot.reference_content_revisions set content = '{"display_name":"Changed"}'::jsonb
           where organization_id = $1`,
          [ORG],
        ),
      ).rejects.toThrow(/REFERENCE_CONTENT_REVISION_IMMUTABLE/);

      const { rows } = await client.query(
        `select content from pilot.reference_content_revisions where organization_id = $1`,
        [ORG],
      );
      expect(rows).toEqual([{ content: { display_name: 'Boxing' } }]);
    } finally {
      await client.end();
    }
  });

  test('refuses DELETE while the organization exists', async () => {
    const client = await freshDatabase('ppbf_ci_ledger_delete');
    try {
      await insertRevision(client);
      await expect(
        client.query(`delete from pilot.reference_content_revisions where organization_id = $1`, [ORG]),
      ).rejects.toThrow(/REFERENCE_CONTENT_REVISION_IMMUTABLE/);
      expect(await countRevisions(client)).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('deleting the organization still removes its history, and only its history', async () => {
    // The trigger must not be able to block an organization's own removal.
    const client = await freshDatabase('ppbf_ci_ledger_org_delete');
    try {
      await insertRevision(client);
      await insertRevision(client, { organizationId: ORG_B });
      await client.query(`delete from pilot.organizations where organization_id = $1`, [ORG_B]);

      expect(await countRevisions(client, ORG_B)).toBe(0);
      expect(await countRevisions(client, ORG)).toBe(1);
    } finally {
      await client.end();
    }
  });
});

describe('the drill_stop_rules table comment', () => {
  test('no longer calls the per-drill rows the five universal stop rules', async () => {
    const client = await freshDatabase('ppbf_ci_comment');
    try {
      const { rows } = await client.query(
        `select obj_description('pilot.drill_stop_rules'::regclass, 'pg_class') as comment`,
      );
      expect(rows[0].comment).not.toMatch(/five Universal Stop Rules/);
      expect(rows[0].comment).toMatch(/NOT universal rules/);
      expect(rows[0].comment).toMatch(/pilot\.universal_stop_rules/);
    } finally {
      await client.end();
    }
  });
});

describe('the seed loaders against the migrated schema', () => {
  async function seededDatabase(name: string): Promise<Client> {
    const client = await freshDatabase(name, { migrated: false });
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active')`,
        [SEED_ORG],
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id)
         values ($1, 'organization_admin', $2)`,
        [SEED_ACCOUNT, SEED_ORG],
      );
    } catch (error) {
      await closeQuietly(client);
      throw error;
    }
    return client;
  }

  test('seed-drill-library.mjs loads all 119 drills and their children, and a second run writes nothing', async () => {
    const client = await seededDatabase('ppbf_ci_seed_drills');
    try {
      const placeholders = { organizationId: SEED_ORG, seedAccountId: SEED_ACCOUNT };
      await seedDrillLibraryAll(client, DRILL_SEED_DIR, placeholders);
      await seedDrillLibraryAll(client, DRILL_SEED_DIR, placeholders);

      const { rows } = await client.query(
        `select
           (select count(*)::int from pilot.drill_library      where organization_id = $1) as drills,
           (select count(*)::int from pilot.drill_scale_levels where organization_id = $1) as scale_levels,
           (select count(*)::int from pilot.drill_stop_rules   where organization_id = $1) as stop_rules,
           (select count(*)::int from pilot.drill_cues         where organization_id = $1) as cues`,
        [SEED_ORG],
      );
      expect(rows[0]).toEqual({ drills: 119, scale_levels: 357, stop_rules: 674, cues: 258 });
    } finally {
      await client.end();
    }
  });

  test('the OLD ON CONFLICT predicate matches no arbiter once the index is redefined', async () => {
    // Why seed-drill-library.mjs had to change in the same commit. Postgres
    // infers an arbiter only when the statement's predicate implies the
    // index's; `where active` does not imply `active and superseded_at is
    // null`, so the loader's old statement fails outright rather than skipping.
    const client = await seededDatabase('ppbf_ci_seed_old_predicate');
    try {
      await expect(
        client.query(
          `insert into pilot.drill_library
             (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
              standard_setup, execution, what_good_looks_like, what_bad_looks_like)
           values ($1,'drl-old','drl-old','Old Predicate','footwork','t','p','s','e','g','b')
           on conflict (organization_id, discipline, name) where active do nothing`,
          [SEED_ORG],
        ),
      ).rejects.toThrow(/no unique or exclusion constraint matching the ON CONFLICT specification/);
    } finally {
      await client.end();
    }
  });

  test('seed-workout-templates.mjs loads all 12 templates and 82 items', async () => {
    const client = await seededDatabase('ppbf_ci_seed_templates');
    try {
      const placeholders = { organizationId: SEED_ORG, seedAccountId: SEED_ACCOUNT };
      await seedDrillLibraryAll(client, DRILL_SEED_DIR, placeholders);
      await seedWorkoutTemplatesAll(client, TEMPLATE_SEED_DIR, placeholders);

      const { rows } = await client.query(
        `select
           (select count(*)::int from pilot.workout_templates      where organization_id = $1) as templates,
           (select count(*)::int from pilot.workout_template_items where organization_id = $1) as items`,
        [SEED_ORG],
      );
      expect(rows[0]).toEqual({ templates: 12, items: 82 });
    } finally {
      await client.end();
    }
  });
});

describe('migration mechanics', () => {
  const INDEX_NAMES = [
    'pilot_drill_library_one_active_name',
    'pilot_drill_library_one_head_per_lineage',
    'pilot_workout_templates_one_head_per_lineage',
    'pilot_universal_stop_rules_one_current_per_ordinal',
    'pilot_universal_stop_rules_one_head_per_lineage',
  ];

  async function indexIdentities(client: Client): Promise<Record<string, string>> {
    const { rows } = await client.query(
      `select c.relname, c.oid::text as oid, pg_get_indexdef(c.oid) as def
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'pilot' and c.relname = any($1::text[])`,
      [INDEX_NAMES],
    );
    return Object.fromEntries(rows.map((row) => [row.relname, `${row.oid} ${row.def}`]));
  }

  test('applied twice through the runner is a no-op: the same index objects, one trigger, rows kept', async () => {
    const client = await freshDatabase('ppbf_ci_idempotent', { migrated: false });
    try {
      await applyMigrationTransaction(client, migrationSql);
      const first = await indexIdentities(client);
      expect(Object.keys(first).sort()).toEqual([...INDEX_NAMES].sort());

      await insertUniversalRule(client, { universalRuleId: 'ust_injury' });
      await insertRevision(client);

      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      // Same OID means the guarded drop did NOT fire again: an unconditional
      // drop-and-recreate would pass every other assertion here.
      expect(await indexIdentities(client)).toEqual(first);

      const { rows } = await client.query(
        `select
           (select count(*)::int from pg_trigger
             where tgrelid = 'pilot.reference_content_revisions'::regclass and not tgisinternal) as triggers,
           (select count(*)::int from pilot.universal_stop_rules) as rules,
           (select count(*)::int from pilot.reference_content_revisions) as revisions`,
      );
      expect(rows[0]).toEqual({ triggers: 1, rules: 1, revisions: 1 });
    } finally {
      await client.end();
    }
  });

  test('an `all`-style re-run -- drill-library-v3 again, then this -- keeps the new index and the corrected comment', async () => {
    const client = await freshDatabase('ppbf_ci_all_rerun', { migrated: false });
    try {
      await applyMigrationTransaction(client, migrationSql);
      const before = await indexIdentities(client);

      // The `all` loop re-runs every migration in order on every dispatch.
      for (const sql of prerequisiteSql) {
        await client.query(sql);
      }
      // v3's `create unique index if not exists` finds the name and leaves the
      // redefined index alone ...
      expect((await indexIdentities(client)).pilot_drill_library_one_active_name).toBe(
        before.pilot_drill_library_one_active_name,
      );
      // ... but it does put its own comment back, which is why this migration
      // must run after it.
      const midway = await client.query(
        `select obj_description('pilot.drill_stop_rules'::regclass, 'pg_class') as comment`,
      );
      expect(midway.rows[0].comment).toMatch(/five Universal Stop Rules/);

      await applyMigrationTransaction(client, migrationSql);
      const after = await client.query(
        `select obj_description('pilot.drill_stop_rules'::regclass, 'pg_class') as comment`,
      );
      expect(after.rows[0].comment).not.toMatch(/five Universal Stop Rules/);
      expect(await indexIdentities(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('the runner REFUSES a database where the migration did not run, naming what is missing', async () => {
    const client = await freshDatabase('ppbf_ci_runner_noop', { migrated: false });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /^CONTENT_IMPORT_NOT_READY: .*drill_name_index_current_only/,
      );
    } finally {
      await client.end();
    }
  });

  test('the migration REFUSES to run before the vocabulary widening', async () => {
    const client = await emptyDatabase('ppbf_ci_no_widening');
    try {
      await client.query(baseSql);
      await client.query(prerequisiteSql[0]);
      await client.query(prerequisiteSql[2]);
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        /CONTENT_IMPORT_NOT_READY: pilot_drill_stop_rule_kind_check is missing/,
      );
      const { rows } = await client.query(`select to_regclass('pilot.universal_stop_rules') is null as absent`);
      expect(rows[0].absent).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('the migration REFUSES a database without the drill library', async () => {
    const client = await emptyDatabase('ppbf_ci_bare');
    try {
      await client.query(baseSql);
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        /CONTENT_IMPORT_NOT_READY: pilot\.drill_library does not exist/,
      );
    } finally {
      await client.end();
    }
  });
});
