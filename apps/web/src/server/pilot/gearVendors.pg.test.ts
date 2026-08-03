// Real PostgreSQL test for the vendor records slice.
//
// The property under test cannot be demonstrated with a mock. The boundary
// between the brand a shopper sees and the account the gym buys on is held by
// the SQL -- by which columns the public query names and by a composite
// foreign key -- and a mocked client returns whatever it is told. This applies
// the real migrations to a real database, writes a real account number, and
// reads it back through the real public query.
//
// It also runs the migration runner's own readiness assertions, twice, which
// is what proves the migration is idempotent rather than merely claiming so.
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
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-gear-vendors-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-gear-vendors-migration.mjs',
);
const VENDOR_MIGRATION = path.join(INFRA_DIR, 'pilot_slice_postgres_gear_vendors_migration.sql');
const TEST_DB_NAME = 'ppbf_test_gear_vendors';

// ts-jest downlevels a plain `await import(...)` into require(), which cannot
// load an ESM-only .mjs file. Building the import() call inside `new Function`
// hides it from that transform, so Node's own ESM loader executes it. Same
// shim, same reason, as boardSeats.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let vendors: typeof import('./gearVendors');
let gear: typeof import('./gearCatalog');
let db: typeof import('./db');
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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

/** A client against the test database, for statements the module layer cannot make. */
async function directClient(): Promise<Client> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  return client;
}

beforeAll(async () => {
  PG_PORT = await freePort();

  // Positional args: the server script takes <dataDir> <port>. It ignores
  // environment configuration entirely -- copying another suite's env-var
  // spawn block is how this cost an hour last time.
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

  const migrate = await directClient();
  await migrate.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  // gear first: this migration alters pilot.gear_products, which that one
  // creates. The `all` list in apply-migrations.yml orders them the same way.
  await migrate.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_gear_migration.sql'), 'utf8'));
  await migrate.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ('org-1', 'Punxsy Prominence', 'active'), ('org-2', 'Another Gym', 'active')
     on conflict do nothing`,
  );
  await migrate.end();

  const runnerModule = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  // Applied through the runner, not by raw query, so the readiness assertions
  // the operator relies on in CI are the ones this suite exercises.
  const first = await directClient();
  await applyMigrationTransaction(first, await fs.readFile(VENDOR_MIGRATION, 'utf8'));
  await first.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  gear = await import('./gearCatalog');
  vendors = await import('./gearVendors');
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

// A real-looking account number, chosen so it can be searched for as a string
// in a payload. This is the fact the whole slice exists to keep inside the gym.
const ACCOUNT_NUMBER = 'EVL-99887766';

const EVERLAST = {
  vendor_id: 'everlast',
  vendor_name: 'Everlast',
  account_number: ACCOUNT_NUMBER,
  discount_tier: 'Tier 2 -- 35% off list',
  net_terms_days: 30,
  portal_url: 'https://orders.everlast.example/signin',
  rep_name: 'Dana Reyes',
  rep_email: 'dana.reyes@everlast.example',
  rep_phone: '814-555-0142',
  notes: 'Free freight over $500.',
  active: true,
};

const GLOVES = {
  product_id: 'gloves-12oz',
  name: 'Training gloves 12oz',
  brand: 'Everlast',
  description: 'Club stock',
  category: 'gloves',
  vendor_id: 'everlast',
  wholesale_cost_cents: 2000,
  retail_price_cents: 4000,
  listed_publicly: true,
  availability: 'in_stock',
  checkout_url: 'https://checkout.example.test/gloves',
};

describe('the migration', () => {
  // Idempotency is the property the apply-migrations workflow depends on: `all`
  // re-runs every increment on every dispatch, and it is only a safe default
  // because a second application is a no-op. Asserted by applying twice through
  // the runner, whose readiness check must pass both times.
  it('applies twice with the same result', async () => {
    const second = await directClient();
    await expect(
      applyMigrationTransaction(second, await fs.readFile(VENDOR_MIGRATION, 'utf8')),
    ).resolves.toBeUndefined();
    await second.end();

    const constraints = await db.query<{ count: number }>(
      `select count(*)::int as count
         from pg_constraint
        where conname in ('pilot_gear_products_vendor_fk', 'pilot_gear_products_vendor_id_not_blank')`,
    );
    // The catalog-guarded DO blocks are what make this true. PostgreSQL has no
    // ADD CONSTRAINT IF NOT EXISTS, so a second run without the guard would
    // fail the whole transaction on a duplicate name.
    expect(constraints[0].count).toBe(2);
  });

  // The one that matters most. A supplier portal login stored here would be a
  // credential nobody rotates, readable by every organization admin, in a
  // database built to hold youth records.
  it('has no column that could hold a supplier credential', async () => {
    const columns = await db.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'pilot'
          and table_name = 'gear_vendors'`,
    );
    const names = columns.map((row) => row.column_name);

    expect(names).toContain('account_number');
    expect(names).toContain('portal_url');
    for (const name of names) {
      expect(name).not.toMatch(/pass|secret|credential|api_?key|token/i);
    }
  });
});

describe('the public boundary', () => {
  // THE TEST THIS SLICE EXISTS FOR. A real account number goes into the
  // database; the public store payload is searched for it as a raw string.
  it('never lets a vendor account reach the public store', async () => {
    await vendors.upsertGearVendor('org-1', EVERLAST);
    await gear.upsertGearProduct('org-1', GLOVES);

    const products = await gear.listPublicGear('org-1');
    const payload = JSON.stringify(products);

    // The brand is public and present -- that is the other half of the
    // decision, and a test that only checked for absence would pass just as
    // well if the store had lost the brand entirely.
    expect(payload).toContain('Everlast');
    expect(products[0].brand).toBe('Everlast');

    // Nothing about the account is. Searched as strings rather than as keys,
    // because a leak that arrives inside a concatenated description would pass
    // a key check.
    expect(payload).not.toContain(ACCOUNT_NUMBER);
    expect(payload).not.toContain('Tier 2');
    expect(payload).not.toContain('orders.everlast.example');
    expect(payload).not.toContain('Dana Reyes');
    expect(payload).not.toContain('dana.reyes@everlast.example');
    expect(payload).not.toContain('814-555-0142');
    expect(payload).not.toMatch(/vendor/i);
    expect(payload).not.toMatch(/2000/); // and the wholesale cost still does not either
  });

  it('gives the gym the vendor id, and the account only through the vendor read', async () => {
    await vendors.upsertGearVendor('org-1', EVERLAST);
    await gear.upsertGearProduct('org-1', GLOVES);

    const [product] = (await gear.listGearForOrganization('org-1'))
      .filter((row) => row.product_id === 'gloves-12oz');

    // An id, not the account. Even an organization admin reads the account
    // number through gearVendors.ts and its own route.
    expect(product.vendor_id).toBe('everlast');
    expect(JSON.stringify(product)).not.toContain(ACCOUNT_NUMBER);

    const vendor = await vendors.getVendorForOrganization('org-1', 'everlast');
    expect(vendor?.account_number).toBe(ACCOUNT_NUMBER);
    expect(vendor?.net_terms_days).toBe(30);
  });

  it('does not name a vendor table in the query behind the public store', async () => {
    // A belt-and-braces read of the SQL itself: the public path must not
    // acquire a join to the vendor table later. gearCatalog.ts holds two
    // explicit column lists rather than one list minus a field for exactly
    // this reason.
    const source = await fs.readFile(path.join(__dirname, 'gearCatalog.ts'), 'utf8');
    const publicFields = /const PUBLIC_FIELDS =[\s\S]*?;/.exec(source)?.[0] ?? '';

    expect(publicFields).toContain('brand');
    expect(publicFields).not.toMatch(/vendor/i);
    expect(publicFields).not.toMatch(/wholesale/i);
  });
});

describe('one gym cannot reach another gym vendor records', () => {
  it('scopes the vendor list to the gym that asked', async () => {
    await vendors.upsertGearVendor('org-1', EVERLAST);
    await vendors.upsertGearVendor('org-2', {
      ...EVERLAST,
      // Same supplier, different gym, different negotiated account. This is
      // why the key is composite: a vendor_id-only key would collide them and
      // make one gym's terms the other's.
      account_number: 'EVL-11223344',
      discount_tier: 'Tier 4 -- 15% off list',
      net_terms_days: 15,
    });

    const one = await vendors.listVendorsForOrganization('org-1');
    const two = await vendors.listVendorsForOrganization('org-2');

    expect(one.find((v) => v.vendor_id === 'everlast')?.account_number).toBe(ACCOUNT_NUMBER);
    expect(two.find((v) => v.vendor_id === 'everlast')?.account_number).toBe('EVL-11223344');
    expect(JSON.stringify(one)).not.toContain('EVL-11223344');
    expect(JSON.stringify(two)).not.toContain(ACCOUNT_NUMBER);
  });

  it('answers for a vendor belonging to another gym exactly as for one that does not exist', async () => {
    await vendors.upsertGearVendor('org-1', { ...EVERLAST, vendor_id: 'sting', vendor_name: 'Sting' });

    const otherGym = await vendors.getVendorForOrganization('org-2', 'sting');
    const nobody = await vendors.getVendorForOrganization('org-2', 'no-such-supplier');

    expect(otherGym).toBeNull();
    expect(nobody).toBeNull();
  });

  // The database refuses it, not only the route. A product in org-2 cannot
  // name a supplier account that belongs to org-1.
  //
  // The id has to be one only org-1 holds. Both gyms have an 'everlast' row --
  // that is the point of the composite key, and referencing it from org-2 is
  // legitimately allowed because org-2 has its own. An earlier draft of this
  // test used 'everlast' and passed the insert, which is the foreign key
  // working rather than failing.
  it('refuses a product pointing at another gym supplier account', async () => {
    await vendors.upsertGearVendor('org-1', {
      ...EVERLAST,
      vendor_id: 'ringside-org-1-only',
      vendor_name: 'Ringside',
    });

    await expect(
      db.query(
        `insert into pilot.gear_products (organization_id, product_id, name, vendor_id)
         values ('org-2', 'borrowed-account', 'Gloves', 'ringside-org-1-only')`,
      ),
    ).rejects.toThrow();

    // And the same reference from the gym that owns the account is accepted,
    // so the assertion above is about the organization and not about the id
    // being unusable.
    await expect(
      db.query(
        `insert into pilot.gear_products (organization_id, product_id, name, vendor_id)
         values ('org-1', 'own-account', 'Gloves', 'ringside-org-1-only')`,
      ),
    ).resolves.toBeDefined();
  });
});

describe('the database refuses what the form would have refused', () => {
  it('allows a product with no supplier recorded', async () => {
    // A normal state, not a gap to be filled with a placeholder: most of the
    // catalogue predates this table. MATCH SIMPLE is what makes the composite
    // key skip the check when vendor_id is null.
    await gear.upsertGearProduct('org-1', {
      ...GLOVES,
      product_id: 'unattributed-wraps',
      name: 'Hand wraps',
      brand: '',
      vendor_id: null,
    });

    const rows = await gear.listGearForOrganization('org-1');
    expect(rows.find((r) => r.product_id === 'unattributed-wraps')?.vendor_id).toBeNull();
  });

  it('refuses a blank vendor id rather than checking it as a foreign key', async () => {
    await expect(
      db.query(
        `insert into pilot.gear_products (organization_id, product_id, name, vendor_id)
         values ('org-1', 'blank-vendor', 'Gloves', '   ')`,
      ),
    ).rejects.toThrow();
  });

  it('refuses a vendor with no name', async () => {
    await expect(
      db.query(
        `insert into pilot.gear_vendors (organization_id, vendor_id, vendor_name)
         values ('org-1', 'nameless', '  ')`,
      ),
    ).rejects.toThrow();
  });

  it('refuses net terms outside a sane range', async () => {
    await expect(
      db.query(
        `insert into pilot.gear_vendors (organization_id, vendor_id, vendor_name, net_terms_days)
         values ('org-1', 'bad-terms', 'Supplier', -1)`,
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `insert into pilot.gear_vendors (organization_id, vendor_id, vendor_name, net_terms_days)
         values ('org-1', 'slipped-keystroke', 'Supplier', 3650)`,
      ),
    ).rejects.toThrow();
  });

  it('keeps null net terms distinct from zero', async () => {
    await vendors.upsertGearVendor('org-1', {
      ...EVERLAST,
      vendor_id: 'terms-unknown',
      vendor_name: 'Terms not recorded',
      net_terms_days: null,
    });
    await vendors.upsertGearVendor('org-1', {
      ...EVERLAST,
      vendor_id: 'due-on-receipt',
      vendor_name: 'Due on receipt',
      net_terms_days: 0,
    });

    expect((await vendors.getVendorForOrganization('org-1', 'terms-unknown'))?.net_terms_days).toBeNull();
    expect((await vendors.getVendorForOrganization('org-1', 'due-on-receipt'))?.net_terms_days).toBe(0);
  });
});

describe('what the gym has bought from whom', () => {
  it('counts products by supplier, within the gym', async () => {
    await vendors.upsertGearVendor('org-1', EVERLAST);
    await gear.upsertGearProduct('org-1', GLOVES);
    await gear.upsertGearProduct('org-1', {
      ...GLOVES,
      product_id: 'headguard',
      name: 'Headguard',
    });

    const counts = await vendors.countProductsByVendor('org-1');
    expect(counts.find((row) => row.vendor_id === 'everlast')?.product_count).toBe(2);

    // org-2 holds its own 'everlast' account, and nothing has been bought on
    // it. One gym's purchasing history is not visible through the other's.
    const otherGym = await vendors.countProductsByVendor('org-2');
    expect(otherGym.find((row) => row.vendor_id === 'everlast')).toBeUndefined();
  });
});
