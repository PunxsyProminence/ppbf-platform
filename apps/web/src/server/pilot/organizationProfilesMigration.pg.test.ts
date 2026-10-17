// Real PostgreSQL contract test for pilot_slice_postgres_organization_profiles_migration.sql
// (lane L31, issue #1469: the gym's profile stored once).
//
// What needs a real database to prove: that the seed writes the operating organization's
// profile with exactly today's code constant, and only where that organization exists; that a
// re-run never overwrites what the gym has since edited; that a profile belongs to one real
// organization, goes with it, and never belongs to the reserved platform organization; that the
// names and lengths are enforced; that nothing else in the schema changes; that the file holds
// nothing destructive; and that the runner's readiness assertion refuses a result it did not
// produce. Spins up the disposable local embedded Postgres the other migration suites use. It
// never connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { PPBF_PROFILE } from '@/src/testing/organizationProfileFixtures';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-organization-profiles-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-organization-profiles-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_organization_profiles_migration.sql';

const OPERATING_ORG = 'punxsy_prominence';
const OTHER_ORG = 'org-profiles-other';

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let listMigrationFiles: (infraDir?: string) => Promise<string[]>;
let applyRunner: Apply;
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
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** The whole schema in the `all` order, which includes this migration (run before any gym exists). */
async function freshDatabase(name: string): Promise<Client> {
  const client = await emptyDatabase(name);
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  return client;
}

/** The schema exactly as it stands just before this migration: the base and every migration ahead of it. */
async function databaseBeforeThisMigration(name: string): Promise<Client> {
  const client = await emptyDatabase(name);
  await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  const files = await listMigrationFiles(INFRA_DIR);
  expect(files).toContain(MIGRATION_FILE);
  for (const file of files.filter((candidate) => candidate !== MIGRATION_FILE)) {
    await client.query('BEGIN');
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
    await client.query('COMMIT');
  }
  return client;
}

async function addOrganization(client: Client, organizationId: string, name = organizationId): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $2, 'active')`,
    [organizationId, name],
  );
}

function insertProfile(client: Client, organizationId: string, values: Record<string, string> = {}) {
  const row = {
    brand: 'Other Gym & Co',
    short_name: 'OG',
    common_name: 'Other Gym',
    website_url: 'https://other-gym.example.org',
    domain: 'other-gym.example.org',
    ...values,
  };
  const columns = Object.keys(row);
  return client.query(
    `insert into pilot.organization_profiles (organization_id, ${columns.join(', ')})
     values ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})`,
    [organizationId, ...Object.values(row)],
  );
}

/** Every column, constraint and index of the schema, except this migration's own table. */
async function schemaSnapshot(client: Client) {
  const columns = await client.query(
    `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'pilot' and table_name <> 'organization_profiles'
      order by table_name, column_name`,
  );
  const constraints = await client.query(
    `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def
       from pg_constraint
      where connamespace = 'pilot'::regnamespace
        -- coalesce: before the migration the table does not exist, and "<> null" would drop every row.
        and conrelid <> coalesce(to_regclass('pilot.organization_profiles')::oid, 0)
      order by 1, 2`,
  );
  const indexes = await client.query(
    `select tablename, indexname, indexdef from pg_indexes
      where schemaname = 'pilot' and tablename <> 'organization_profiles' order by 1, 2`,
  );
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  listMigrationFiles = fullSchema.listMigrationFiles as typeof listMigrationFiles;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
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

describe('organization profiles migration (#1469)', () => {
  test('the seed writes the operating gym exactly as the code constant has it', async () => {
    const client = await freshDatabase('orgprof_seed');
    try {
      await addOrganization(client, OPERATING_ORG, 'Punxsy Prominence Boxing and Fitness');
      await addOrganization(client, OTHER_ORG);
      await applyRunner(client, migrationSql);

      const rows = await client.query('select * from pilot.organization_profiles order by organization_id');
      // Only the operating organization is seeded; another gym gets no invented profile.
      expect(rows.rows.map((row) => row.organization_id)).toEqual([OPERATING_ORG]);
      const row = rows.rows[0];
      // The fixture every PPBF parity test renders from (src/testing/organizationProfileFixtures.ts).
      const constant = PPBF_PROFILE;
      expect({
        brand: row.brand,
        shortName: row.short_name,
        commonName: row.common_name,
        ein: row.ein,
        url: row.website_url,
        domain: row.domain,
        email: row.contact_email,
        donationsEmail: row.donations_email,
        grantsEmail: row.grants_email,
        established: row.established,
        town: row.town,
        serviceArea: row.service_area,
        serviceAreaShort: row.service_area_short,
        physical: {
          street: row.physical_street,
          city: row.physical_city,
          region: row.physical_region,
          postalCode: row.physical_postal_code,
        },
        mailing: row.mailing_address,
      }).toEqual({
        brand: constant.brand,
        shortName: constant.shortName,
        commonName: constant.commonName,
        ein: constant.ein,
        url: constant.url,
        domain: constant.domain,
        email: constant.email,
        donationsEmail: constant.donationsEmail,
        grantsEmail: constant.grantsEmail,
        established: constant.established,
        town: constant.town,
        serviceArea: constant.serviceArea,
        serviceAreaShort: constant.serviceAreaShort,
        physical: constant.physical,
        mailing: constant.mailing,
      });
      // The head coach as the homepage names him today (app/page.tsx).
      expect(row.head_coach_name).toBe(constant.headCoachName);
      // The legal name is not repeated: it stays the organization's name of record.
      expect(Object.keys(row)).not.toContain('legal_name');
    } finally {
      await client.end();
    }
  });

  test('the store reads the seeded row back, through its real query, as the fixture every parity test uses', async () => {
    const client = await freshDatabase('orgprof_store');
    const saved = {
      url: process.env.AZURE_POSTGRES_CONNECTION_STRING,
      ssl: process.env.PPBF_POSTGRES_DISABLE_SSL,
    };
    try {
      await addOrganization(client, OPERATING_ORG, PPBF_PROFILE.legalName);
      await applyRunner(client, migrationSql);

      process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor('orgprof_store');
      // db.ts honors this only when NODE_ENV is exactly 'test', which Jest sets.
      process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
      const store = await import('./organizationProfileStore');
      store.clearOrganizationProfileCache();
      await expect(store.getOrganizationProfile(OPERATING_ORG, { production: true })).resolves.toEqual(PPBF_PROFILE);
      // The legal name is the organization's name of record, not a column of the profile.
      await client.query(`update pilot.organizations set organization_name = 'Renamed Of Record' where organization_id = $1`, [OPERATING_ORG]);
      store.clearOrganizationProfileCache();
      expect((await store.getOrganizationProfile(OPERATING_ORG, { production: true })).legalName).toBe('Renamed Of Record');
      // Production with no row refuses by name.
      store.clearOrganizationProfileCache();
      await expect(store.getOrganizationProfile(OTHER_ORG, { production: true })).rejects.toThrow(/ORGANIZATION_PROFILE_UNAVAILABLE/);
    } finally {
      const { closePool } = await import('./db');
      await closePool();
      for (const [name, value] of [['AZURE_POSTGRES_CONNECTION_STRING', saved.url], ['PPBF_POSTGRES_DISABLE_SSL', saved.ssl]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await client.end();
    }
  });

  test('the gym admin save writes the row and its audit row together, and the next read shows it (lane L31 P3)', async () => {
    const client = await freshDatabase('orgprof_save');
    const saved = {
      url: process.env.AZURE_POSTGRES_CONNECTION_STRING,
      ssl: process.env.PPBF_POSTGRES_DISABLE_SSL,
    };
    try {
      await addOrganization(client, OPERATING_ORG, PPBF_PROFILE.legalName);
      await applyRunner(client, migrationSql);
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ('acct-admin', 'organization_admin', $1, 'microsoft')`,
        [OPERATING_ORG],
      );

      process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor('orgprof_save');
      process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
      const store = await import('./organizationProfileStore');
      const write = await import('./organizationProfileWrite');
      store.clearOrganizationProfileCache();
      expect((await store.getOrganizationProfile(OPERATING_ORG, { production: true })).email).toBe('admin@punxsyprominence.org');

      const before = await write.readStoredProfileInput(OPERATING_ORG);
      await write.saveOrganizationProfile(
        OPERATING_ORG,
        { ...before, contact_email: 'office@example.org', mailing_address: '' },
        { accountId: 'acct-admin', role: 'organization_admin' },
      );

      // The cached row was dropped, so the very next read is the saved one.
      const after = await store.getOrganizationProfile(OPERATING_ORG, { production: true });
      expect(after.email).toBe('office@example.org');
      expect(after.mailing).toBe('');
      expect(after.legalName).toBe(PPBF_PROFILE.legalName);
      const audit = await client.query(
        `select actor_account_id, entity_type, entity_id from pilot.audit_events where entity_type = 'organization_profile'`,
      );
      expect(audit.rows).toEqual([{ actor_account_id: 'acct-admin', entity_type: 'organization_profile', entity_id: OPERATING_ORG }]);

      // Whatever the module's rules admit, the table's rules admit too: the longest of every field saves.
      const longest = Object.fromEntries(write.PROFILE_FIELDS.map(([field, limit]) => [field, 'x'.repeat(limit)]));
      await write.saveOrganizationProfile(
        OPERATING_ORG,
        { ...longest, website_url: `https://${'a'.repeat(185)}.org`, domain: `${'a'.repeat(196)}.org` },
        { accountId: 'acct-admin', role: 'organization_admin' },
      );
      // And a save the module refuses writes nothing.
      await expect(write.saveOrganizationProfile(OPERATING_ORG, { ...longest, brand: '' }, { accountId: 'acct-admin', role: 'organization_admin' }))
        .rejects.toThrow('brand is required');
      expect((await client.query(`select count(*)::int as n from pilot.audit_events where entity_type = 'organization_profile'`)).rows[0].n).toBe(2);
    } finally {
      const { closePool } = await import('./db');
      await closePool();
      for (const [name, value] of [['AZURE_POSTGRES_CONNECTION_STRING', saved.url], ['PPBF_POSTGRES_DISABLE_SSL', saved.ssl]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await client.end();
    }
  });

  test('where the operating gym does not exist, nothing is seeded and the runner still passes', async () => {
    const client = await freshDatabase('orgprof_noorg');
    try {
      await addOrganization(client, OTHER_ORG);
      await applyRunner(client, migrationSql);
      const rows = await client.query('select organization_id from pilot.organization_profiles');
      expect(rows.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a re-run is a no-op and never overwrites what the gym has edited', async () => {
    const client = await freshDatabase('orgprof_rerun');
    try {
      await addOrganization(client, OPERATING_ORG);
      await applyRunner(client, migrationSql);
      await client.query(
        `update pilot.organization_profiles
            set contact_email = 'office@example.org', mailing_address = '', updated_at = now()
          where organization_id = $1`,
        [OPERATING_ORG],
      );
      const before = await client.query('select * from pilot.organization_profiles');
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);
      const after = await client.query('select * from pilot.organization_profiles');
      expect(after.rows).toEqual(before.rows);
      expect(after.rows[0].contact_email).toBe('office@example.org');
      expect(after.rows[0].mailing_address).toBe('');
    } finally {
      await client.end();
    }
  });

  test('a profile belongs to one real gym, goes with it, and never to the platform organization', async () => {
    const client = await freshDatabase('orgprof_binds');
    try {
      await addOrganization(client, OTHER_ORG);
      await expect(insertProfile(client, 'org-does-not-exist')).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_organization_profiles_org_fk',
      });
      // The reserved organization exists in every schema (platform library scope), and is refused.
      const platform = await client.query(`select 1 from pilot.organizations where organization_id = '__platform__'`);
      expect(platform.rowCount).toBe(1);
      await expect(insertProfile(client, '__platform__')).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_organization_profiles_not_platform_check',
      });

      await insertProfile(client, OTHER_ORG);
      await expect(insertProfile(client, OTHER_ORG)).rejects.toMatchObject({
        code: '23505',
        constraint: 'pilot_organization_profiles_pkey',
      });
      await client.query('delete from pilot.organizations where organization_id = $1', [OTHER_ORG]);
      const rows = await client.query('select 1 from pilot.organization_profiles');
      expect(rows.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the display names, website and domain are required; every field has a length limit; optional fields start empty', async () => {
    const client = await freshDatabase('orgprof_rules');
    try {
      await addOrganization(client, OTHER_ORG);
      for (const column of ['brand', 'short_name', 'common_name']) {
        await expect(insertProfile(client, OTHER_ORG, { [column]: '   ' })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_organization_profiles_names_check',
        });
      }
      await expect(insertProfile(client, OTHER_ORG, { short_name: 'x'.repeat(41) })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_organization_profiles_names_check',
      });
      // The website is an https origin (it is fed to `new URL` for every page's metadata), and the
      // domain a bare host name.
      for (const website of ['', 'punxsyprominence.org', 'http://www.example.org', 'https://www.example.org/', 'https://', 'https://exa mple.org']) {
        await expect(insertProfile(client, OTHER_ORG, { website_url: website })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_organization_profiles_web_check',
        });
      }
      for (const domain of ['', 'localhost', 'https://example.org', 'example.org/x']) {
        await expect(insertProfile(client, OTHER_ORG, { domain })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_organization_profiles_web_check',
        });
      }
      await expect(insertProfile(client, OTHER_ORG, { website_url: `https://${'a'.repeat(190)}.org` })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_organization_profiles_web_check',
      });
      // A required field left out is refused, not defaulted.
      await expect(
        client.query(
          `insert into pilot.organization_profiles (organization_id, brand, short_name, common_name, domain)
           values ($1, 'B', 'S', 'C', 'example.org')`,
          [OTHER_ORG],
        ),
      ).rejects.toMatchObject({ code: '23502' });
      for (const [column, limit] of [
        ['ein', 20], ['contact_email', 254],
        ['donations_email', 254], ['grants_email', 254], ['established', 20], ['town', 100],
        ['service_area', 300], ['service_area_short', 300], ['physical_street', 200],
        ['physical_city', 100], ['physical_region', 50], ['physical_postal_code', 20],
        ['mailing_address', 300], ['head_coach_name', 200],
      ] as const) {
        await expect(insertProfile(client, OTHER_ORG, { [column]: 'x'.repeat(limit + 1) })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_organization_profiles_lengths_check',
        });
      }

      await insertProfile(client, OTHER_ORG);
      const row = (await client.query('select * from pilot.organization_profiles')).rows[0];
      for (const column of ['ein', 'contact_email', 'mailing_address', 'head_coach_name']) {
        expect(row[column]).toBe('');
      }
    } finally {
      await client.end();
    }
  });

  test('the migration is additive: nothing else in the schema or the gym rows changes', async () => {
    // Built WITHOUT this migration (not built with it and the table dropped), so a side effect on
    // another object -- an index, a trigger, a comment -- would show in the comparison.
    const client = await databaseBeforeThisMigration('orgprof_additive');
    try {
      await addOrganization(client, OPERATING_ORG, 'Punxsy Prominence Boxing and Fitness');
      expect((await client.query(`select to_regclass('pilot.organization_profiles') as rel`)).rows[0].rel).toBeNull();
      const schemaBefore = await schemaSnapshot(client);
      const organizationsBefore = await client.query('select * from pilot.organizations order by organization_id');

      await applyRunner(client, migrationSql);

      expect(await schemaSnapshot(client)).toEqual(schemaBefore);
      const organizationsAfter = await client.query('select * from pilot.organizations order by organization_id');
      expect(organizationsAfter.rows).toEqual(organizationsBefore.rows);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive', () => {
    const executable = migrationSql.replace(/--[^\n]*/g, '');
    // `on delete cascade` is the foreign key's rule, not a statement.
    expect(executable.replace(/\bon delete cascade\b/gi, '')).not.toMatch(/\b(drop|delete|truncate|alter|update|grant|revoke)\b/i);
    expect(executable).not.toMatch(/\b(begin|commit|rollback)\s*;/i);
  });
});

describe('the runner refuses a database that does not hold every rule', () => {
  // Each mutant is the migration with one rule removed or loosened. Applied in place of the real
  // file (after dropping the table the full schema built), the runner must roll back and name the
  // readiness key for that rule.
  const replaceOnce = (from: string | RegExp, to: string) => (sql: string) => {
    const next = sql.replace(from, to);
    if (next === sql) throw new Error(`mutant did not change the SQL: ${String(from)}`);
    return next;
  };

  const mutants: Array<{ name: string; key: string; mutate: (sql: string) => string }> = [
    { name: 'a short name limit raised', key: 'names_check_ready', mutate: replaceOnce('char_length(short_name) <= 40', 'char_length(short_name) <= 41') },
    { name: 'a name allowed blank', key: 'names_check_ready', mutate: replaceOnce("btrim(brand) <> '' and ", '') },
    { name: 'a field length limit raised', key: 'lengths_check_ready', mutate: replaceOnce('char_length(ein) <= 20', 'char_length(ein) <= 21') },
    { name: 'the platform organization allowed', key: 'not_platform_ready', mutate: replaceOnce("check (organization_id <> '__platform__')", 'check (true)') },
    { name: 'the gym key without its cascade', key: 'organization_fk_ready', mutate: replaceOnce('on delete cascade', '') },
    { name: 'an empty default dropped', key: 'defaults_ready', mutate: replaceOnce("ein text not null default ''", 'ein text not null') },
    { name: 'a column made nullable', key: 'columns_ready', mutate: replaceOnce("town text not null default ''", "town text default ''") },
    {
      name: 'an account column added',
      key: 'only_fk_ready',
      mutate: replaceOnce(
        'created_at timestamptz not null default now(),',
        'created_at timestamptz not null default now(), updated_by_account_id text references pilot.accounts (account_id),',
      ),
    },
    { name: 'the website check dropped', key: 'web_check_ready', mutate: replaceOnce("website_url ~* '^https://[a-z0-9-]+(\\.[a-z0-9-]+)+$' and ", '') },
    { name: 'the domain allowed blank', key: 'web_check_ready', mutate: replaceOnce("and domain ~* '^[a-z0-9-]+(\\.[a-z0-9-]+)+$' ", '') },
    { name: 'a required field given a default', key: 'defaults_ready', mutate: replaceOnce('website_url text not null,', "website_url text not null default 'https://x.org',") },
    { name: 'a timestamp default changed', key: 'defaults_ready', mutate: replaceOnce('updated_at timestamptz not null default now()', 'updated_at timestamptz not null default clock_timestamp()') },
    { name: 'the gym key made deferrable', key: 'organization_fk_ready', mutate: replaceOnce('on delete cascade', 'on delete cascade deferrable') },
    { name: 'the primary key left off', key: 'primary_key_ready', mutate: replaceOnce('constraint pilot_organization_profiles_pkey primary key (organization_id),', '') },
    { name: 'the seed removed', key: 'seed_ready', mutate: replaceOnce(/insert into pilot\.organization_profiles \([\s\S]*?on conflict do nothing;/, 'select 1;') },
  ];

  test.each(mutants.map((mutant, index) => ({ ...mutant, index })))('$name: names $key', async ({ key, mutate, index }) => {
    const client = await freshDatabase(`orgprof_mutant_${index}`);
    try {
      await addOrganization(client, OPERATING_ORG);
      await client.query('drop table pilot.organization_profiles');
      await expect(applyRunner(client, mutate(migrationSql))).rejects.toThrow(
        new RegExp(`ORGANIZATION_PROFILES_NOT_READY: .*\\b${key}\\b`),
      );
      // Rolled back: the table the mutant created is gone again.
      const table = await client.query(`select to_regclass('pilot.organization_profiles') as rel`);
      expect(table.rows[0].rel).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a database where the migration never ran is refused', async () => {
    const client = await freshDatabase('orgprof_never');
    try {
      await client.query('drop table pilot.organization_profiles');
      await expect(applyRunner(client, 'select 1;')).rejects.toThrow(/ORGANIZATION_PROFILES_NOT_READY: .*\btable_ready\b/);
    } finally {
      await client.end();
    }
  });
});
