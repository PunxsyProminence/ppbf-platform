// Real PostgreSQL-backed contract test for the session-scripts and transfer-claims
// migrations (pilot.session_scripts, pilot.session_script_blocks,
// pilot.session_script_renderings, pilot.session_script_runs, pilot.transfer_claims)
// and the committed files loaded through the content-import core against a real
// transaction.
//
// What needs proving, and cannot be proven by reading SQL or a mocked-query unit test:
//
// 1. pilot_ssb_content holds: a block with no what_to_* field and a block_kind outside
//    ('transition','arrival','close') is rejected.
// 2. pilot_ssb_window holds: end_offset_min <= start_offset_min is rejected.
// 3. pilot_transfer_public_gate holds: a public_facing claim naming a brain structure
//    without evidence_class='EVIDENCE-SUPPORTED' is rejected.
// 4. pilot_transfer_one_target holds: a claim attaching to zero or two of
//    drill_id/block_id/script_id is rejected.
// 5. The committed session scripts load whole through the content-import core (the path
//    the seed workflow runs) -- every script, block and rendering the files hold --
//    idempotently, and all or nothing.
// 6. The committed transfer claims against the REAL drill library, loaded through the
//    core. This migration adds a named FK from transfer_claims.drill_id to
//    pilot.drill_library(organization_id, drill_id). seed_transfer_claims.csv was authored
//    against a different generation of drill IDs than the shipped drill library, so its
//    rows do not resolve -- and the result must not be worked around. The core now refuses
//    them at plan, before any write, instead of at the foreign key half way through a load.
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

import {
  committedRows,
  createSeedingGym,
  loadReferenceContent,
  loadResearchClaimsIntoPlatformLibrary,
  openFullSchemaDatabase,
} from '../../testing/referenceContentFixture';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-scripts-transfer-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const SESSION_SCRIPTS_MIGRATION_FILE = 'pilot_slice_postgres_session_scripts_migration.sql';
const TRANSFER_CLAIMS_MIGRATION_FILE = 'pilot_slice_postgres_transfer_claims_migration.sql';
const SESSION_SCRIPTS_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-session-scripts-migration.mjs',
);
const TRANSFER_CLAIMS_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-transfer-claims-migration.mjs',
);
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
];

const ORG_A = 'org-session-scripts-a';
const COACH_A = 'acct-session-scripts-coach-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string[];
let sessionScriptsMigrationSql: string;
let transferClaimsMigrationSql: string;
let applySessionScriptsMigration: (client: Client, sql: string) => Promise<void>;
let applyTransferClaimsMigration: (client: Client, sql: string) => Promise<void>;
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
  sessionScriptsMigrationSql = await fs.readFile(path.join(INFRA_DIR, SESSION_SCRIPTS_MIGRATION_FILE), 'utf8');
  transferClaimsMigrationSql = await fs.readFile(path.join(INFRA_DIR, TRANSFER_CLAIMS_MIGRATION_FILE), 'utf8');

  const sessionScriptsRunner = await nativeDynamicImport(pathToFileURL(SESSION_SCRIPTS_RUNNER_PATH).href);
  applySessionScriptsMigration = sessionScriptsRunner.applyMigrationTransaction as typeof applySessionScriptsMigration;

  const transferClaimsRunner = await nativeDynamicImport(pathToFileURL(TRANSFER_CLAIMS_RUNNER_PATH).href);
  applyTransferClaimsMigration = transferClaimsRunner.applyMigrationTransaction as typeof applyTransferClaimsMigration;
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

describe('session scripts migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_session_scripts_readiness_negative');
    try {
      await expect(applySessionScriptsMigration(client, 'select 1')).rejects.toThrow(
        /SESSION_SCRIPTS_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.session_scripts') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_session_scripts_idempotent');
    try {
      await applySessionScriptsMigration(client, sessionScriptsMigrationSql);
      await applySessionScriptsMigration(client, sessionScriptsMigrationSql);
      await applySessionScriptsMigration(client, sessionScriptsMigrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_session_scripts_pkey', 'pilot_ssb_content', 'pilot_ssb_window')`,
      );
      expect(constraints.rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });
});

describe('pilot_ssb_content and pilot_ssb_window', () => {
  let client: Client;
  const SCRIPT_ID = 'scr-test-1';

  beforeEach(async () => {
    client = await freshDatabase('ppbf_test_ssb_constraints');
    await applySessionScriptsMigration(client, sessionScriptsMigrationSql);
    await client.query(
      `insert into pilot.session_scripts (organization_id, script_id, lineage_id, name, created_by_account_id)
       values ($1, $2, $2, 'Test Script', $3)`,
      [ORG_A, SCRIPT_ID, COACH_A],
    );
  });

  afterEach(async () => {
    await client.end();
  });

  test('a content-less instruction block is rejected', async () => {
    await expect(
      client.query(
        `insert into pilot.session_script_blocks
           (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min,
            block_label, block_kind)
         values ($1, 'blk-1', $2, 1, 0, 2, 'Empty block', 'instruction')`,
        [ORG_A, SCRIPT_ID],
      ),
    ).rejects.toThrow(/pilot_ssb_content/);
  });

  test('a content-less transition block is accepted', async () => {
    const result = await client.query(
      `insert into pilot.session_script_blocks
         (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min,
          block_label, block_kind)
       values ($1, 'blk-2', $2, 1, 0, 2, 'Transition', 'transition')
       returning block_id`,
      [ORG_A, SCRIPT_ID],
    );
    expect(result.rows[0].block_id).toBe('blk-2');
  });

  test('end_offset_min <= start_offset_min is rejected', async () => {
    await expect(
      client.query(
        `insert into pilot.session_script_blocks
           (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min,
            block_label, block_kind, what_to_say)
         values ($1, 'blk-3', $2, 1, 5, 5, 'Bad window', 'instruction', 'say something')`,
        [ORG_A, SCRIPT_ID],
      ),
    ).rejects.toThrow(/pilot_ssb_window/);
  });
});

describe('transfer claims constraints against real Postgres', () => {
  let client: Client;
  const SCRIPT_ID = 'scr-test-transfer';

  beforeEach(async () => {
    client = await freshDatabase('ppbf_test_transfer_claims_constraints');
    await applySessionScriptsMigration(client, sessionScriptsMigrationSql);
    await applyTransferClaimsMigration(client, transferClaimsMigrationSql);
    await client.query(
      `insert into pilot.session_scripts (organization_id, script_id, lineage_id, name, created_by_account_id)
       values ($1, $2, $2, 'Test Script', $3)`,
      [ORG_A, SCRIPT_ID, COACH_A],
    );
  });

  afterEach(async () => {
    await client.end();
  });

  test('pilot_transfer_one_target rejects a claim with zero targets', async () => {
    await expect(
      client.query(
        `insert into pilot.transfer_claims
           (organization_id, transfer_id, claim_kind, statement)
         values ($1, 'txf-none', 'life_skill_transfer', 'no target')`,
        [ORG_A],
      ),
    ).rejects.toThrow(/pilot_transfer_one_target/);
  });

  test('pilot_transfer_one_target rejects a claim with two targets', async () => {
    await expect(
      client.query(
        `insert into pilot.transfer_claims
           (organization_id, transfer_id, script_id, block_id, claim_kind, statement)
         values ($1, 'txf-two', $2, 'not-a-real-block', 'life_skill_transfer', 'two targets')`,
        [ORG_A, SCRIPT_ID],
      ),
    ).rejects.toThrow(/pilot_transfer_one_target|pilot_transfer_block_fk/);
  });

  test('pilot_transfer_public_gate rejects a public, structure-naming, non-evidence-supported claim', async () => {
    await expect(
      client.query(
        `insert into pilot.transfer_claims
           (organization_id, transfer_id, script_id, claim_kind, statement, named_structure,
            evidence_class, public_facing)
         values ($1, 'txf-gate-reject', $2, 'neuro_mechanism', 'basal ganglia patterning',
                 'basal ganglia', 'MECHANISM-THEORISED', true)`,
        [ORG_A, SCRIPT_ID],
      ),
    ).rejects.toThrow(/pilot_transfer_public_gate/);
  });

  test('pilot_transfer_public_gate accepts the same claim once evidence-supported with a registry id', async () => {
    const result = await client.query(
      `insert into pilot.transfer_claims
         (organization_id, transfer_id, script_id, claim_kind, statement, named_structure,
          evidence_class, registry_claim_id, public_facing)
       values ($1, 'txf-gate-accept', $2, 'neuro_mechanism', 'basal ganglia patterning',
               'basal ganglia', 'EVIDENCE-SUPPORTED', 'A1-034', true)
       returning transfer_id`,
      [ORG_A, SCRIPT_ID],
    );
    expect(result.rows[0].transfer_id).toBe('txf-gate-accept');
  });

  test('pilot_transfer_public_gate accepts a non-public structure-naming claim without a registry id', async () => {
    const result = await client.query(
      `insert into pilot.transfer_claims
         (organization_id, transfer_id, script_id, claim_kind, statement, named_structure,
          evidence_class, public_facing)
       values ($1, 'txf-gate-not-public', $2, 'neuro_mechanism', 'basal ganglia patterning',
               'basal ganglia', 'MECHANISM-THEORISED', false)
       returning transfer_id`,
      [ORG_A, SCRIPT_ID],
    );
    expect(result.rows[0].transfer_id).toBe('txf-gate-not-public');
  });
});

/*
  THE COMMITTED SESSION SCRIPTS AND TRANSFER CLAIMS, LOADED THE WAY THE SEED
  WORKFLOW LOADS THEM.

  Until IMP-10 these ran seed-session-scripts.mjs and seed-transfer-claims.mjs.
  Both are retired; the content-import core loads every dataset, run as
  runApply (the `content:apply` the seed workflow calls), into a database
  holding the schema production runs. Scripts name a discipline, so the
  registry loads in the same transaction. Every count comes from the files.
*/
describe('the committed session scripts, loaded through the content-import core', () => {
  let seedDb: Client;
  const SCRIPTS = committedRows('session-scripts/seed_session_scripts.csv');
  const BLOCKS = committedRows('session-scripts/seed_session_script_blocks.csv');
  const RENDERINGS = committedRows('session-scripts/seed_session_script_renderings.csv');
  const DATASETS = 'disciplines,session-scripts';
  const INDUCED = 'INDUCED_NON_DATABASE_FAILURE';

  beforeAll(async () => {
    seedDb = await openFullSchemaDatabase(Client, connectionStringFor, 'ppbf_test_session_scripts_core_seed');
  });

  afterAll(async () => {
    await seedDb?.end().catch(() => {});
  });

  async function count(table: string, organizationId: string, where = ''): Promise<number> {
    const { rows } = await seedDb.query(`select count(*)::int as n from pilot.${table} where organization_id = $1 ${where}`, [organizationId]);
    return rows[0].n;
  }

  // seed_session_script_blocks.csv used to carry two blocks (both in the Friday sparring
  // script, block_kind='instruction': "Sparring Drill Rounds" blk_df4fb688e5b181 and
  // "Open Sparring" blk_01b502a7e7336d) with none of what_to_say/what_to_explain/
  // what_to_watch/what_to_fix filled in. pilot_ssb_content rejected them, and because the
  // load runs in one transaction, 0 of the blocks loaded. Those two cells are now filled
  // from the drill library's own sparring rows, so the package must load whole -- and stay
  // stable on a re-run.
  test('loads every committed script, block and rendering, and a second load writes nothing', async () => {
    const organizationId = 'gym_scripts_real';
    const admin = await createSeedingGym(seedDb, organizationId);
    const first = await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: DATASETS });
    expect(first.code).toBe(0);
    const again = await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: DATASETS });
    expect(again.lines).toContain(`  session-scripts: 0 new, 0 new version, ${SCRIPTS.length} unchanged, 0 absent, 0 reject`);
    expect(again.lines).toContain('RESULT: NOTHING TO APPLY -- every item is unchanged or absent; nothing was written.');

    expect(SCRIPTS.length).toBeGreaterThanOrEqual(3);
    expect(await count('session_scripts', organizationId)).toBe(SCRIPTS.length);
    expect(await count('session_script_blocks', organizationId)).toBe(BLOCKS.length);
    expect(await count('session_script_renderings', organizationId)).toBe(RENDERINGS.length);

    // The two repaired sparring blocks carry supervision content -- the exact cells
    // whose emptiness used to void the whole load under pilot_ssb_content.
    const repaired = await seedDb.query(
      `select block_id, what_to_say, what_to_watch from pilot.session_script_blocks
       where organization_id = $1 and block_id in ('blk_df4fb688e5b181', 'blk_01b502a7e7336d')
       order by block_id`,
      [organizationId],
    );
    expect(repaired.rows).toHaveLength(2);
    for (const row of repaired.rows) {
      expect((row.what_to_say ?? '').trim()).not.toBe('');
      expect((row.what_to_watch ?? '').trim()).not.toBe('');
    }

    // KNOWN CONTENT GAP, not a defect: a script the files ship with zero blocks
    // ("Week 2 Monday", scr_e2ed38b1a19670, today) loads fine; sessionScriptRuns.ts
    // refuses to start a run of it (SESSION_SCRIPT_HAS_NO_BLOCKS, 422) and the coach UI
    // hides Start. Pinned from the files so a 0-block count reads as the shipped state,
    // not as data loss.
    const withoutBlocks = SCRIPTS.map((row) => row.script_id).filter((id) => !BLOCKS.some((block) => block.script_id === id));
    for (const scriptId of withoutBlocks) {
      expect({ scriptId, blocks: await count('session_script_blocks', organizationId, `and script_id = '${scriptId}'`) }).toEqual({ scriptId, blocks: 0 });
    }
  });

  // THE ORDER IS THE WHOLE TEST. The scripts are inserted, THEN the first block insert
  // throws a plain JavaScript error -- no SQLSTATE, so the transaction stays valid and
  // committable, and a COMMIT reached anyway (the old loaders' `finally`) would keep the
  // scripts. APPLY mode: a dry run rolls back on success too and would pass against it.
  test('a failure after scripts are inserted rolls back the rows already written', async () => {
    const organizationId = 'gym_scripts_atomicity';
    const admin = await createSeedingGym(seedDb, organizationId);
    let scriptInserts = 0;
    const failing = {
      query: (sql: string, params?: unknown[]) => {
        if (/insert into pilot\.session_scripts\b/i.test(sql)) scriptInserts += 1;
        if (/insert into pilot\.session_script_blocks/i.test(sql)) throw new TypeError(INDUCED);
        return seedDb.query(sql, params);
      },
    };
    await expect(
      loadReferenceContent(failing as unknown as Client, { organizationId, actorAccountId: admin, datasets: DATASETS }),
    ).rejects.toThrow(INDUCED);

    expect(scriptInserts).toBeGreaterThan(0);
    // All three write targets, because the load writes all three and a repair must not
    // leave any of them behind.
    expect(await count('session_scripts', organizationId)).toBe(0);
    expect(await count('session_script_blocks', organizationId)).toBe(0);
    expect(await count('session_script_renderings', organizationId)).toBe(0);
  });
});

describe('the committed transfer claims against the real drill library, through the content-import core', () => {
  let seedDb: Client;
  const CLAIMS = committedRows('transfer-claims/seed_transfer_claims.csv');
  const LIBRARY = committedRows('drill-library/seed_drill_library.csv');

  beforeAll(async () => {
    seedDb = await openFullSchemaDatabase(Client, connectionStringFor, 'ppbf_test_transfer_claims_core_seed');
    await loadResearchClaimsIntoPlatformLibrary(seedDb);
  });

  afterAll(async () => {
    await seedDb?.end().catch(() => {});
  });

  test('reports how many committed claims resolve against real drill IDs, and refuses the rest before writing anything', async () => {
    const organizationId = 'gym_transfer_claims';
    const admin = await createSeedingGym(seedDb, organizationId);
    expect((await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: 'disciplines,drill-library' })).code).toBe(0);
    const drillCount = await seedDb.query('select count(*)::int as n from pilot.drill_library where organization_id = $1', [organizationId]);
    expect(drillCount.rows[0].n).toBe(LIBRARY.length);

    // The dataset the seed workflow leaves out, handed to the same apply anyway.
    const loaded = await loadReferenceContent(seedDb, { organizationId, actorAccountId: admin, datasets: ['transfer-claims'] });
    const orphans = loaded.lines.filter((line) => line.startsWith('  [orphan_reference] transfer-claims/seed_transfer_claims.csv:') && line.includes(' drill_id '));
    const libraryIds = new Set(LIBRARY.map((row) => row.drill_id));
    const unresolved = CLAIMS.filter((row) => row.drill_id && !libraryIds.has(row.drill_id));

    console.log(
      `TRANSFER CLAIMS RESULT: ${CLAIMS.length - unresolved.length} of ${CLAIMS.length} claims resolve against the real drill library; `
      + `${orphans.length} refused at plan over ${new Set(unresolved.map((row) => row.drill_id)).size} drill ids`,
    );

    // This documents the actual finding rather than assuming an outcome: the claims'
    // drill_id references were generated in a different run than the shipped drill
    // library and do not resolve against it. Every unresolved row is refused by name,
    // and nothing is written.
    expect(unresolved.length).toBeGreaterThan(0);
    expect(orphans).toHaveLength(unresolved.length);
    expect(loaded.code).toBe(1);
    expect(loaded.lines.some((line) => line.startsWith('  [dataset_not_loadable]'))).toBe(true);
    const claimCount = await seedDb.query('select count(*)::int as n from pilot.transfer_claims where organization_id = $1', [organizationId]);
    expect(claimCount.rows[0].n).toBe(0);
  });
});
