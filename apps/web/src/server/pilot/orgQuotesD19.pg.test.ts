// Real PostgreSQL-backed test for the org-quotes D19 migration (owner ruling
// D19, OD-2026-10-08-009: Steel Town off the wall, AMPLECTERE MISERIAM on).
//
// Applies base schema + org-quotes + org-quotes-d19 through the real runners
// and proves: Steel Town is switched off (never deleted) and AMPLECTERE
// MISERIAM is added, for the club organization only; re-runs change nothing,
// and never override a choice the gym made afterwards through orgQuotes.ts; a
// Steel Town row the gym had already edited is left as the gym left it; an
// environment without the organization is untouched. Spins up the same
// disposable, local-only embedded Postgres the other migration suites use. It
// NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-quotes-d19-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_org_quotes_migration.sql';
const D19_FILE = 'pilot_slice_postgres_org_quotes_d19_migration.sql';
const TEST_DB_NAME = 'ppbf_test_quotes_d19';

const SEEDED_ORG = 'punxsy_prominence';
const ORG_A = 'org-quotes-a';
const ORG_B = 'org-quotes-b';

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-org-quotes-migration.mjs',
);
const D19_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-org-quotes-d19-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules. Same pattern as announcementsPersistence.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let quotes: typeof import('./orgQuotes');
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
type D19Outcome = { steelTownSwitchedOff: number; amplectereAdded: number };
let applyD19Transaction: (client: Client, sql: string) => Promise<D19Outcome>;
let baseSchemaSql: string;
let migrationSql: string;
let d19Sql: string;

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

async function freshDatabase(name: string, orgs: string[]): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  for (const org of orgs) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
  d19Sql = await fs.readFile(path.join(INFRA_DIR, D19_FILE), 'utf8');
  const d19Module = await nativeDynamicImport(pathToFileURL(D19_RUNNER_PATH).href);
  applyD19Transaction = d19Module.applyMigrationTransaction as (client: Client, sql: string) => Promise<D19Outcome>;
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


const STEEL = 'STEEL TOWN. STEADY HANDS.';
const AMPLECTERE = 'AMPLECTERE MISERIAM';

describe('org-quotes D19 migration against the real schema', () => {
  let main: Client;
  let firstOutcome: D19Outcome;

  beforeAll(async () => {
    main = await freshDatabase(TEST_DB_NAME, [SEEDED_ORG, ORG_A, ORG_B]);
    await applyMigrationTransaction(main, migrationSql);
    // Another gym carrying the same Steel Town words under the very same seed id
    // (the id is md5 of the text, not of the gym), untouched since written: only
    // the organization filter keeps D19 off it.
    await main.query(
      `insert into pilot.org_quotes (organization_id, quote_id, quote_text, speaker, quote_type, shown, active)
       values ($1, md5('org-quotes-seed:' || $2)::uuid, $2, 'their wall', 'gym_saying', array['anywhere'], true)`,
      [ORG_A, STEEL],
    );
    firstOutcome = await applyD19Transaction(main, d19Sql);

    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
    // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
    // production and staging can never take this path.
    process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
    quotes = await import('./orgQuotes');
  });

  afterAll(async () => {
    await main.end();
    const { closePool } = await import('./db');
    await closePool();
  });

  test('Steel Town is switched off, not deleted, and AMPLECTERE MISERIAM is on, for the club', async () => {
    const all = await quotes.listQuotes(SEEDED_ORG);
    expect(all).toHaveLength(13);
    const steel = all.find((q) => q.quote_text === STEEL);
    expect(steel?.active).toBe(false);
    const amplectere = all.find((q) => q.quote_text === AMPLECTERE);
    expect(amplectere).toMatchObject({
      speaker: 'the wall',
      quote_type: 'gym_saying',
      source: '',
      shown: ['anywhere'],
      active: true,
    });

    const live = await quotes.listLiveQuotes(SEEDED_ORG);
    expect(live).toHaveLength(12);
    expect(live.map((q) => q.quote_text)).not.toContain(STEEL);
    expect(live.map((q) => q.quote_text)).toContain(AMPLECTERE);
  });

  test('no other organization is touched', async () => {
    const other = await quotes.listQuotes(ORG_A);
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({ quote_text: STEEL, active: true });
    expect(await quotes.listQuotes(ORG_B)).toEqual([]);
  });

  test('the runner reports what it changed: one row off, one row added; a re-run reports nothing', async () => {
    expect(firstOutcome).toEqual({ steelTownSwitchedOff: 1, amplectereAdded: 1 });
  });

  test('re-running changes nothing, and says so', async () => {
    const before = await quotes.listQuotes(SEEDED_ORG);
    expect(await applyD19Transaction(main, d19Sql)).toEqual({ steelTownSwitchedOff: 0, amplectereAdded: 0 });
    expect(await quotes.listQuotes(SEEDED_ORG)).toEqual(before);
  });

  test('a later choice by the gym is never overridden by a re-run', async () => {
    const all = await quotes.listQuotes(SEEDED_ORG);
    const steel = all.find((q) => q.quote_text === STEEL)!;
    const amplectere = all.find((q) => q.quote_text === AMPLECTERE)!;
    await quotes.updateQuote(SEEDED_ORG, steel.quote_id, { active: true });
    await quotes.updateQuote(SEEDED_ORG, amplectere.quote_id, { active: false });

    await applyD19Transaction(main, d19Sql);
    await applyMigrationTransaction(main, migrationSql);

    const after = await quotes.listQuotes(SEEDED_ORG);
    expect(after.find((q) => q.quote_id === steel.quote_id)?.active).toBe(true);
    expect(after.find((q) => q.quote_id === amplectere.quote_id)?.active).toBe(false);
    expect(after).toHaveLength(13);
  });
});

describe('org-quotes D19 when the gym had already changed things', () => {
  test('a Steel Town row the gym already edited, and an AMPLECTERE line it already typed, are left as the gym left them', async () => {
    const db = await freshDatabase('ppbf_test_quotes_d19_edited', [SEEDED_ORG]);
    try {
      await applyMigrationTransaction(db, migrationSql);
      await db.query(
        `update pilot.org_quotes set speaker = 'Coach J', updated_at = now() + interval '1 second'
         where organization_id = $1 and quote_text = $2`,
        [SEEDED_ORG, STEEL],
      );
      await db.query(
        `insert into pilot.org_quotes (organization_id, quote_id, quote_text, speaker, quote_type, shown, active)
         values ($1, md5('typed-by-gym')::uuid, 'amplectere miseriam', 'Jason', 'motivational', array['at-a-milestone'], false)`,
        [SEEDED_ORG],
      );
      await applyD19Transaction(db, d19Sql);

      const steel = await db.query(
        'select speaker, active from pilot.org_quotes where organization_id = $1 and quote_text = $2',
        [SEEDED_ORG, STEEL],
      );
      expect(steel.rows).toEqual([{ speaker: 'Coach J', active: true }]);
      const amplectere = await db.query(
        `select quote_text, speaker, active from pilot.org_quotes
         where organization_id = $1 and lower(quote_text) = lower($2)`,
        [SEEDED_ORG, AMPLECTERE],
      );
      expect(amplectere.rows).toEqual([{ quote_text: 'amplectere miseriam', speaker: 'Jason', active: false }]);
    } finally {
      await db.end();
    }
  });

  test('a Steel Town line the gym typed in again after renaming the seed row is never switched off', async () => {
    const db = await freshDatabase('ppbf_test_quotes_d19_retyped', [SEEDED_ORG]);
    try {
      await applyMigrationTransaction(db, migrationSql);
      await db.query(
        `update pilot.org_quotes set quote_text = 'STEEL CITY. STEADY HANDS.', updated_at = now() + interval '1 second'
         where organization_id = $1 and quote_text = $2`,
        [SEEDED_ORG, STEEL],
      );
      await db.query(
        `insert into pilot.org_quotes (organization_id, quote_id, quote_text, speaker, quote_type, shown, active)
         values ($1, md5('retyped-by-gym')::uuid, $2, 'the wall', 'gym_saying', array['anywhere'], true)`,
        [SEEDED_ORG, STEEL],
      );
      await applyD19Transaction(db, d19Sql);
      await applyD19Transaction(db, d19Sql);
      const rows = await db.query(
        'select quote_text, active from pilot.org_quotes where organization_id = $1 and quote_text like $2 order by quote_text',
        [SEEDED_ORG, 'STEEL%'],
      );
      expect(rows.rows).toEqual([
        { quote_text: 'STEEL CITY. STEADY HANDS.', active: true },
        { quote_text: STEEL, active: true },
      ]);
    } finally {
      await db.end();
    }
  });

  test('AMPLECTERE MISERIAM edited by the gym is not resurrected beside its edit by a re-run', async () => {
    const db = await freshDatabase('ppbf_test_quotes_d19_reedit', [SEEDED_ORG]);
    try {
      await applyMigrationTransaction(db, migrationSql);
      await applyD19Transaction(db, d19Sql);
      await db.query(
        `update pilot.org_quotes set quote_text = 'AMPLECTERE MISERIAM.', updated_at = now()
         where organization_id = $1 and quote_text = $2`,
        [SEEDED_ORG, AMPLECTERE],
      );
      expect(await applyD19Transaction(db, d19Sql)).toEqual({ steelTownSwitchedOff: 0, amplectereAdded: 0 });
      const rows = await db.query(
        `select quote_text from pilot.org_quotes where organization_id = $1 and quote_text like 'AMPLECTERE%'`,
        [SEEDED_ORG],
      );
      expect(rows.rows).toEqual([{ quote_text: 'AMPLECTERE MISERIAM.' }]);
    } finally {
      await db.end();
    }
  });

  test('an environment without the club organization is untouched', async () => {
    const db = await freshDatabase('ppbf_test_quotes_d19_noorg', [ORG_A]);
    try {
      await applyMigrationTransaction(db, migrationSql);
      await applyD19Transaction(db, d19Sql);
      const rows = await db.query('select count(*)::int as n from pilot.org_quotes');
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });

  test('the runner refuses a database without the quotes table and rolls back', async () => {
    const db = await freshDatabase('ppbf_test_quotes_d19_notable', [SEEDED_ORG]);
    try {
      await expect(applyD19Transaction(db, d19Sql)).rejects.toThrow();
      const exists = await db.query("select to_regclass('pilot.org_quotes') is not null as present");
      expect(exists.rows[0].present).toBe(false);
    } finally {
      await db.end();
    }
  });
});
