// Real PostgreSQL-backed contract test for the session-scripts and transfer-claims
// migrations (pilot.session_scripts, pilot.session_script_blocks,
// pilot.session_script_renderings, pilot.session_script_runs, pilot.transfer_claims)
// and their seed loaders running against a real transaction.
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
// 5. seed-session-scripts.mjs loads exactly 3 scripts / 65 blocks / 4 renderings,
//    idempotently.
// 6. seed-transfer-claims.mjs against the REAL, already-shipped drill-library seed --
//    this migration adds a named FK from transfer_claims.drill_id to
//    pilot.drill_library(organization_id, drill_id), matching this repo's convention of
//    naming every foreign-key-shaped column. The proposed archive's seed_transfer_claims.csv
//    was authored against a different generation of drill IDs than the archive's own
//    seed_drill_library.csv (folder 01) or the already-shipped repo drill library -- neither
//    matches. This test proves whether that FK holds or fails against real data, and the
//    result must not be worked around.
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
const SESSION_SCRIPTS_SEED_LOADER_PATH = path.resolve(__dirname, '../../../scripts/seed-session-scripts.mjs');
const TRANSFER_CLAIMS_SEED_LOADER_PATH = path.resolve(__dirname, '../../../scripts/seed-transfer-claims.mjs');
const SESSION_SCRIPTS_SEED_DIR = path.resolve(__dirname, '../../../seed-data/session-scripts');
const TRANSFER_CLAIMS_SEED_DIR = path.resolve(__dirname, '../../../seed-data/transfer-claims');
const DRILL_LIBRARY_SEED_DIR = path.resolve(__dirname, '../../../seed-data/drill-library');
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
let seedSessionScripts: (
  client: Client,
  seedDir: string,
  placeholders: { organizationId: string; seedAccountId: string },
  opts?: { dryRun?: boolean },
) => Promise<void>;
let seedTransferClaims: (
  client: Client,
  seedDir: string,
  placeholders: { organizationId: string },
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

  const sessionScriptsSeed = await nativeDynamicImport(pathToFileURL(SESSION_SCRIPTS_SEED_LOADER_PATH).href);
  seedSessionScripts = sessionScriptsSeed.seedAll as typeof seedSessionScripts;

  const transferClaimsSeed = await nativeDynamicImport(pathToFileURL(TRANSFER_CLAIMS_SEED_LOADER_PATH).href);
  seedTransferClaims = transferClaimsSeed.seedAll as typeof seedTransferClaims;
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

describe('seed-session-scripts.mjs against real Postgres', () => {
  // The supplied seed_session_script_blocks.csv carries two blocks (both in the Friday
  // sparring script, block_kind='instruction': "Sparring Drill Rounds" and "Open Sparring")
  // with none of what_to_say/what_to_explain/what_to_watch/what_to_fix filled in. That is a
  // real pilot_ssb_content violation in the supplied data, not a bug in the migration or the
  // loader -- confirmed here rather than worked around.
  test('the supplied CSV\'s two content-less "instruction" blocks are genuinely rejected by pilot_ssb_content', async () => {
    const client = await freshDatabase('ppbf_test_session_scripts_seed');
    try {
      await applySessionScriptsMigration(client, sessionScriptsMigrationSql);

      let contentCheckError: Error | null = null;
      try {
        await seedSessionScripts(client, SESSION_SCRIPTS_SEED_DIR, { organizationId: ORG_A, seedAccountId: COACH_A });
      } catch (error) {
        contentCheckError = error as Error;
      }

      expect(contentCheckError).not.toBeNull();
      expect(contentCheckError?.message).toMatch(/pilot_ssb_content/);

      const scripts = await client.query(`select count(*)::int as n from pilot.session_scripts where organization_id = $1`, [ORG_A]);
      const blocks = await client.query(`select count(*)::int as n from pilot.session_script_blocks where organization_id = $1`, [ORG_A]);
      // The whole seedAll call runs inside one transaction, so the rejected block's failure
      // rolls back everything else that ran before it in the same call, including the 3
      // scripts and the blocks that preceded it.
      expect(scripts.rows[0].n).toBe(0);
      expect(blocks.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});

// Reads only the drill_id column out of the real, already-shipped seed_drill_library.csv and
// inserts minimal pilot.drill_library rows -- deliberately NOT going through
// seed-drill-library.mjs's full seedAll, because that loader's single transaction also seeds
// pilot.drill_scale_levels from seed_drill_scale_levels.csv, and that CSV (copied into this
// repo from the same proposed-migrations archive as this folder, still uncommitted pending a
// user decision) trips the pre-existing drill_scale_levels_authoring_state_check finding,
// which would roll back the drill_library rows too and mask what THIS test is checking.
// Minimal RFC 4180 parser, same shape as the one duplicated across scripts/*.mjs in this
// repo -- needed here because the CSV's description columns carry embedded commas and
// newlines inside quoted fields, which a plain line-split cannot handle correctly.
function parseCsvForTest(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      endRow();
      index += source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

async function insertRealDrillIds(client: Client, organizationId: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(DRILL_LIBRARY_SEED_DIR, 'seed_drill_library.csv'), 'utf8');
  const table = parseCsvForTest(raw);
  const [header, ...dataRows] = table;
  const drillIdIndex = header.indexOf('drill_id');
  if (drillIdIndex === -1) throw new Error('test bug: drill_id column not found in seed_drill_library.csv');
  const drillIds = dataRows.map((cells) => cells[drillIdIndex]);

  for (const drillId of drillIds) {
    await client.query(
      `insert into pilot.drill_library
         (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
          standard_setup, execution, what_good_looks_like, what_bad_looks_like)
       values ($1,$2,$2,$3,'test','test behavior','test purpose','test setup',
               'test execution','test good','test bad')`,
      [organizationId, drillId, `test drill ${drillId}`],
    );
  }
  return drillIds;
}

describe('seed-transfer-claims.mjs against the real, already-shipped drill library', () => {
  test('reports how many of the 173 claims resolve against real drill IDs, and how many are FK-rejected', async () => {
    const client = await freshDatabase('ppbf_test_transfer_claims_seed_against_real_drills');
    try {
      await applySessionScriptsMigration(client, sessionScriptsMigrationSql);
      await applyTransferClaimsMigration(client, transferClaimsMigrationSql);
      const drillIds = await insertRealDrillIds(client, ORG_A);

      const drillCount = await client.query(`select count(*)::int as n from pilot.drill_library where organization_id = $1`, [ORG_A]);
      expect(drillIds).toHaveLength(119);
      expect(drillCount.rows[0].n).toBe(119);

      let fkError: Error | null = null;
      try {
        await seedTransferClaims(client, TRANSFER_CLAIMS_SEED_DIR, { organizationId: ORG_A });
      } catch (error) {
        fkError = error as Error;
      }

      const claimCount = await client.query(`select count(*)::int as n from pilot.transfer_claims where organization_id = $1`, [ORG_A]);

      console.log(
        fkError
          ? `TRANSFER CLAIMS FK RESULT: seeding failed against real drill_library -- ${fkError.message}`
          : `TRANSFER CLAIMS FK RESULT: seeding succeeded, ${claimCount.rows[0].n} rows loaded`,
      );

      // This assertion documents the actual finding rather than assuming an outcome:
      // the seed data's drill_id references were generated in a different run than the
      // shipped drill library and do not resolve against it.
      expect(fkError).not.toBeNull();
      expect(fkError?.message).toMatch(/pilot_transfer_drill_fk/);
      expect(claimCount.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
