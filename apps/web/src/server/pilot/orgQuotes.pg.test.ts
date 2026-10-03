// Real PostgreSQL-backed test for orgQuotes.ts and its migration.
//
// Proves the module's real INSERT/SELECT/UPDATE against base schema + the
// org-quotes migration: organization scoping on every read and write, the
// seed (exactly the twelve gymSayings.ts lines, for the club organization
// only), idempotent re-runs, the duplicate-text guard and the check
// constraints. Spins up the same disposable, local-only embedded Postgres the
// other migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { GYM_SAYINGS } from '../../../components/gymSayings';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-quotes-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_org_quotes_migration.sql';
const TEST_DB_NAME = 'ppbf_test_quotes';

const SEEDED_ORG = 'punxsy_prominence';
const ORG_A = 'org-quotes-a';
const ORG_B = 'org-quotes-b';

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-org-quotes-migration.mjs',
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
let baseSchemaSql: string;
let migrationSql: string;

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

describe('org_quotes migration and orgQuotes.ts against the real schema', () => {
  let main: Client;

  beforeAll(async () => {
    main = await freshDatabase(TEST_DB_NAME, [SEEDED_ORG, ORG_A, ORG_B]);
    await applyMigrationTransaction(main, migrationSql);

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

  test('the club organization is seeded with exactly the existing gymSayings, active, as gym sayings', async () => {
    const rows = await quotes.listLiveQuotes(SEEDED_ORG);
    expect(rows).toHaveLength(GYM_SAYINGS.length);
    for (const saying of GYM_SAYINGS) {
      const row = rows.find((r) => r.quote_text === saying.line);
      expect(row).toBeDefined();
      expect(row?.speaker).toBe(saying.said_by);
      expect(row?.quote_type).toBe('gym_saying');
      expect([...(row?.shown ?? [])].sort()).toEqual([...saying.shown].sort());
      expect(row?.active).toBe(true);
    }
  });

  test('no other organization is seeded', async () => {
    expect(await quotes.listQuotes(ORG_A)).toEqual([]);
    expect(await quotes.listQuotes(ORG_B)).toEqual([]);
  });

  test('re-running the migration does not resurrect an edited or switched-off seed line', async () => {
    const [first] = await quotes.listQuotes(SEEDED_ORG);
    await quotes.updateQuote(SEEDED_ORG, first.quote_id, { quoteText: 'EDITED BY THE GYM', active: false });
    await applyMigrationTransaction(main, migrationSql);

    const rows = await quotes.listQuotes(SEEDED_ORG);
    expect(rows).toHaveLength(GYM_SAYINGS.length);
    const edited = rows.find((r) => r.quote_id === first.quote_id);
    expect(edited?.quote_text).toBe('EDITED BY THE GYM');
    expect(edited?.active).toBe(false);
  });

  test('createQuote persists and is visible only inside its own organization', async () => {
    const made = await quotes.createQuote({
      organizationId: ORG_A,
      quoteText: 'Boxing is a thinking sport.',
      speaker: 'Coach A',
      quoteType: 'boxing_quote',
      source: 'Gym wall, 2026',
      shown: ['anywhere'],
      active: true,
    });
    expect(made.quote_id).toMatch(/^[0-9a-f-]{36}$/);

    expect((await quotes.listQuotes(ORG_A)).map((q) => q.quote_id)).toEqual([made.quote_id]);
    expect(await quotes.listQuotes(ORG_B)).toEqual([]);
    expect(await quotes.listLiveQuotes(ORG_B)).toEqual([]);
  });

  test('listLiveQuotes returns only active quotes; listQuotes returns all', async () => {
    await quotes.createQuote({
      organizationId: ORG_B, quoteText: 'On line', speaker: '', quoteType: 'motivational',
      source: '', shown: ['anywhere'], active: true,
    });
    await quotes.createQuote({
      organizationId: ORG_B, quoteText: 'Off line', speaker: '', quoteType: 'motivational',
      source: '', shown: ['at-a-milestone'], active: false,
    });
    expect((await quotes.listLiveQuotes(ORG_B)).map((q) => q.quote_text)).toEqual(['On line']);
    expect(await quotes.listQuotes(ORG_B)).toHaveLength(2);
  });

  test("updateQuote cannot reach another organization's quote", async () => {
    const [target] = await quotes.listQuotes(ORG_A);
    const crossOrg = await quotes.updateQuote(ORG_B, target.quote_id, { active: false, quoteText: 'HIJACKED' });
    expect(crossOrg).toBeNull();

    const [after] = await quotes.listQuotes(ORG_A);
    expect(after.quote_text).toBe(target.quote_text);
    expect(after.active).toBe(true);
  });

  test('updateQuote changes only the fields given', async () => {
    const [target] = await quotes.listQuotes(ORG_A);
    const updated = await quotes.updateQuote(ORG_A, target.quote_id, { active: false });
    expect(updated?.active).toBe(false);
    expect(updated?.quote_text).toBe(target.quote_text);
    expect(updated?.speaker).toBe(target.speaker);
    expect(updated?.source).toBe(target.source);
  });

  test('the same words twice in one organization are refused, in another organization they are fine', async () => {
    const base = {
      quoteText: 'Hands up.', speaker: '', quoteType: 'gym_saying' as const,
      source: '', shown: ['anywhere' as const], active: true,
    };
    await quotes.createQuote({ organizationId: ORG_A, ...base });
    await expect(quotes.createQuote({ organizationId: ORG_A, ...base, quoteText: '  HANDS UP. ' }))
      .rejects.toThrow('already in the library');
    await expect(quotes.createQuote({ organizationId: ORG_B, ...base })).resolves.toBeDefined();
  });

  test('updateQuote can clear speaker and source to empty and change text, type and moments', async () => {
    const made = await quotes.createQuote({
      organizationId: ORG_A, quoteText: 'Edit me', speaker: 'Someone', quoteType: 'motivational',
      source: 'Somewhere', shown: ['anywhere'], active: true,
    });
    const updated = await quotes.updateQuote(ORG_A, made.quote_id, {
      quoteText: 'Edited', speaker: '', source: '', quoteType: 'boxing_quote',
      shown: ['after-hard-session', 'after-hard-session'],
    });
    expect(updated).toMatchObject({
      quote_text: 'Edited', speaker: '', source: '', quote_type: 'boxing_quote',
      shown: ['after-hard-session'], active: true,
    });
  });

  test('an edit that collides with another quote in the same organization is refused', async () => {
    const [a, b] = (await quotes.listQuotes(SEEDED_ORG)).slice(0, 2);
    await expect(quotes.updateQuote(SEEDED_ORG, a.quote_id, { quoteText: b.quote_text.toLowerCase() }))
      .rejects.toThrow('already in the library');
  });

  test('over-length text, speaker and source are refused as validation errors', async () => {
    const base = {
      organizationId: ORG_A, quoteText: 'Length probe', speaker: '', quoteType: 'gym_saying' as const,
      source: '', shown: ['anywhere' as const], active: true,
    };
    await expect(quotes.createQuote({ ...base, quoteText: 'x'.repeat(281) })).rejects.toThrow('limits');
    await expect(quotes.createQuote({ ...base, speaker: 'x'.repeat(121) })).rejects.toThrow('limits');
    await expect(quotes.createQuote({ ...base, source: 'x'.repeat(501) })).rejects.toThrow('limits');
  });

  test('re-running the migration skips a seed line whose words the gym now holds under another id', async () => {
    const bare = await freshDatabase('ppbf_test_quotes_conflict', [SEEDED_ORG]);
    try {
      await applyMigrationTransaction(bare, migrationSql);
      await bare.query(`delete from pilot.org_quotes where quote_text = 'NO HYPE. JUST WORK.'`);
      await bare.query(
        `insert into pilot.org_quotes (organization_id, quote_id, quote_text, quote_type, shown, active)
         values ($1, gen_random_uuid(), 'NO HYPE. JUST WORK.', 'motivational', array['anywhere'], false)`,
        [SEEDED_ORG],
      );
      await applyMigrationTransaction(bare, migrationSql);
      const { rows } = await bare.query(
        `select quote_type, active from pilot.org_quotes where quote_text = 'NO HYPE. JUST WORK.'`,
      );
      expect(rows).toEqual([{ quote_type: 'motivational', active: false }]);
    } finally {
      await bare.end();
    }
  });

  test('the table refuses a bad type, an empty moment list and blank text', async () => {
    const insert = (type: string, shown: string[], text: string) =>
      main.query(
        `insert into pilot.org_quotes (organization_id, quote_id, quote_text, quote_type, shown)
         values ($1, gen_random_uuid(), $2, $3, $4::text[])`,
        [ORG_A, text, type, shown],
      );
    await expect(insert('slogan', ['anywhere'], 'x1')).rejects.toThrow(/pilot_org_quotes_type_check/);
    await expect(insert('gym_saying', [], 'x2')).rejects.toThrow(/pilot_org_quotes_shown_check/);
    await expect(insert('gym_saying', ['always'], 'x3')).rejects.toThrow(/pilot_org_quotes_shown_check/);
    await expect(insert('gym_saying', ['anywhere'], '   ')).rejects.toThrow(/pilot_org_quotes_text_check/);
  });

  test('a database without the club organization seeds nothing', async () => {
    const bare = await freshDatabase('ppbf_test_quotes_bare', [ORG_A]);
    try {
      await applyMigrationTransaction(bare, migrationSql);
      const { rows } = await bare.query('select count(*)::int as n from pilot.org_quotes');
      expect(rows[0].n).toBe(0);
    } finally {
      await bare.end();
    }
  });
});
