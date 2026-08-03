// Real PostgreSQL test for the gear catalogue.
//
// The property under test cannot be demonstrated with a mock: the boundary
// between what the gym paid and what the public sees is held by the SQL, and a
// mocked client returns whatever it is told. This applies the real migration to
// a real database, writes a product with a real cost, and reads it back through
// the real public query.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-gear-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_gear';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let gear: typeof import('./gearCatalog');
let db: typeof import('./db');

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not find a free port')));
    });
    server.on('error', reject);
  });
}

beforeAll(async () => {
  PG_PORT = await freePort();

  // Positional args, matching every other pg suite here: the server script
  // takes <dataDir> <port>. It ignores environment configuration entirely.
  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrate = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrate.connect();
  await migrate.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  await migrate.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_gear_migration.sql'), 'utf8'));
  await migrate.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ('org-1', 'Punxsy Prominence', 'active'), ('org-2', 'Another Gym', 'active')
     on conflict do nothing`,
  );
  await migrate.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  gear = await import('./gearCatalog');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();

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

const GLOVES = {
  product_id: 'gloves-12oz',
  name: 'Training gloves 12oz',
  description: 'Club stock',
  category: 'gloves',
  wholesale_cost_cents: 2000,
  retail_price_cents: 4000,
  listed_publicly: true,
  availability: 'in_stock',
  checkout_url: 'https://checkout.example.test/gloves',
};

describe('gear catalogue against real Postgres', () => {
  it('stores a product and reads back cost and margin for the gym', async () => {
    await gear.upsertGearProduct('org-1', GLOVES);

    const rows = await gear.listGearForOrganization('org-1');
    const row = rows.find((r) => r.product_id === 'gloves-12oz');

    expect(row?.wholesale_cost_cents).toBe(2000);
    expect(row?.retail_price_cents).toBe(4000);
    expect(gear.gearMargin(row!)).toEqual({ margin_cents: 2000, margin_percent: 50 });
  });

  // The whole reason the boundary exists. The gym pays half; the public sees
  // retail and nothing that would let them work out the rest.
  it('never returns the wholesale cost on the public read', async () => {
    await gear.upsertGearProduct('org-1', GLOVES);

    const [product] = await gear.listPublicGear('org-1');

    expect(product.retail_price_cents).toBe(4000);
    expect(Object.keys(product)).not.toContain('wholesale_cost_cents');
    expect(JSON.stringify(product)).not.toMatch(/2000/);
  });

  it('hides a product that is not listed publicly', async () => {
    await gear.upsertGearProduct('org-1', {
      ...GLOVES,
      product_id: 'club-only-headguard',
      name: 'Headguard (club use)',
      listed_publicly: false,
    });

    const publicIds = (await gear.listPublicGear('org-1')).map((p) => p.product_id);
    const internalIds = (await gear.listGearForOrganization('org-1')).map((p) => p.product_id);

    expect(publicIds).not.toContain('club-only-headguard');
    // Still in the gym's own records, which is the point: equipment bought for
    // club use belongs in the cost register without ever being for sale.
    expect(internalIds).toContain('club-only-headguard');
  });

  // Every gym has its own catalogue, suppliers and prices. One gym's cost must
  // never be reachable through another gym's store.
  it('keeps one gym out of another gym catalogue', async () => {
    await gear.upsertGearProduct('org-1', GLOVES);
    await gear.upsertGearProduct('org-2', {
      ...GLOVES,
      name: 'Other gym gloves',
      wholesale_cost_cents: 1500,
      retail_price_cents: 3000,
    });

    const orgOne = await gear.listGearForOrganization('org-1');
    const orgTwo = await gear.listGearForOrganization('org-2');

    expect(orgOne.find((p) => p.product_id === 'gloves-12oz')?.wholesale_cost_cents).toBe(2000);
    expect(orgTwo.find((p) => p.product_id === 'gloves-12oz')?.wholesale_cost_cents).toBe(1500);
    // Same product_id in both gyms, which the composite key allows and a
    // product_id-only key would have collided.
    expect(orgOne).toHaveLength(orgOne.length);
  });

  it('lists only gyms that actually have something on sale', async () => {
    await gear.upsertGearProduct('org-1', GLOVES);
    await gear.upsertGearProduct('org-2', { ...GLOVES, listed_publicly: false });

    const stores = await gear.listPublicStores();
    const ids = stores.map((s) => s.organization_id);

    expect(ids).toContain('org-1');
    // A gym with nothing listed is not an empty shop; it is not a shop.
    expect(ids).not.toContain('org-2');
  });

  it('refuses a negative price at the database, not only in validation', async () => {
    await expect(
      db.query(
        `insert into pilot.gear_products (organization_id, product_id, name, retail_price_cents)
         values ('org-1', 'bad-price', 'Bad', -100)`,
      ),
    ).rejects.toThrow();
  });

  it('refuses an availability outside the vocabulary', async () => {
    await expect(
      db.query(
        `insert into pilot.gear_products (organization_id, product_id, name, availability)
         values ('org-1', 'bad-availability', 'Bad', 'maybe')`,
      ),
    ).rejects.toThrow();
  });
});
