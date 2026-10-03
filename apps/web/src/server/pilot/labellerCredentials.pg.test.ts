// Real PostgreSQL proof of the labelling-PIN storage (TEACH-LABELLER-HANDOFF-01, PR 1).
//
// WHAT IT PROVES, WITH THE REAL FUNCTIONS
//
//   the migration   creates the table, its key, its cascading membership key,
//                   both checks and the name index, twice over, through the
//                   runner production uses;
//   set             only a live coach or organization admin of the gym writes
//                   one, as a salted hash, and pilot.accounts is untouched;
//   clear           removes one inside the named organization only;
//   picker/verify   read eligibility live: a member deactivated, deleted,
//                   moved to another role or out of the gym stops appearing
//                   and stops verifying at once.
//
// Spins up the same disposable, local-only embedded Postgres the other .pg
// suites use. It NEVER connects to production or staging.

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
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
}));

import {
  clearLabellerCredential,
  getOwnLabellerCredential,
  labellerPinTargetKey,
  listLabellerPicker,
  setOwnLabellerCredential,
  verifyLabellerPin,
} from './labellerCredentials';
import { clearRateLimit } from './rateLimit';
import { verifyPin } from './security';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-labeller-credentials-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-labeller-credentials-migration.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_labeller_credentials_migration.sql';
const TEST_DB_NAME = 'ppbf_test_labeller_credentials';
const RUNNER_DB_NAME = 'ppbf_test_labeller_credentials_runner';
const BASE = [
  'pilot_slice_postgres.sql',
  // pilot.accounts.deleted_at.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
];

const ORG_ID = 'org-pp';
const OTHER_ORG_ID = 'org-other';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let sequence = 0;

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

type Role = 'coach' | 'organization_admin' | 'admin' | 'athlete' | 'parent' | 'staff' | 'volunteer' | 'platform_owner';

/** A live account and its membership in `org`. */
async function seedAccount(role: Role, org = ORG_ID): Promise<string> {
  sequence += 1;
  const accountId = `acct-${role}-${sequence}`;
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag, pin_hash)
     values ($1, $2, $3, 'microsoft', $4, true, 'scrypt$account$untouched')`,
    [accountId, role, org, `${accountId}@example.com`],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)`,
    [accountId, org, role],
  );
  return accountId;
}

function nextPin(): string {
  sequence += 1;
  // Never a repeated digit or a straight run: 2580, 2581, ... stay legal.
  return String(2580 + (sequence % 300)).padStart(4, '0');
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ACCEPTED';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

async function verify(accountId: string, pin: string, org = ORG_ID): Promise<string> {
  // Each call starts with clear buckets: these tests are about eligibility,
  // not the pause, which labellerCredentials.test.ts proves.
  clearRateLimit(labellerPinTargetKey(org, accountId));
  return codeOf(verifyLabellerPin({ organizationId: org, accountId, pin }));
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

  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  for (const database of [TEST_DB_NAME, RUNNER_DB_NAME]) {
    await adminClient.query(`drop database if exists ${database}`);
    await adminClient.query(`create database ${database}`);
  }
  await adminClient.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  for (const file of [...BASE, MIGRATION_FILE]) {
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
  await client?.end();
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

describe('the labeller-credentials migration, through its runner', () => {
  let runnerDb: Client;
  let applyMigrationTransaction: (db: Client, sql: string) => Promise<void>;
  let migrationSql: string;

  beforeAll(async () => {
    const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
    applyMigrationTransaction = runner.applyMigrationTransaction as typeof applyMigrationTransaction;
    migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
    runnerDb = new Client({ connectionString: connectionStringFor(RUNNER_DB_NAME) });
    await runnerDb.connect();
    for (const file of BASE) {
      await runnerDb.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
    }
  });

  afterAll(async () => {
    await runnerDb?.end();
  });

  it('applies to a database without the table, and again as a no-op', async () => {
    expect((await runnerDb.query(`select to_regclass('pilot.labeller_credentials') as t`)).rows[0].t).toBeNull();
    await applyMigrationTransaction(runnerDb, migrationSql);
    await applyMigrationTransaction(runnerDb, migrationSql);
    expect((await runnerDb.query(`select to_regclass('pilot.labeller_credentials') as t`)).rows[0].t).not.toBeNull();
  });

  it('refuses a table that holds the right check name over the wrong rule', async () => {
    await runnerDb.query('begin');
    try {
      await runnerDb.query(
        `alter table pilot.labeller_credentials drop constraint pilot_labeller_credentials_display_name_check`,
      );
      await runnerDb.query(
        `alter table pilot.labeller_credentials add constraint pilot_labeller_credentials_display_name_check
           check (char_length(display_name) <= 400)`,
      );
      await expect(applyMigrationTransaction(runnerDb, migrationSql)).rejects.toThrow(
        /LABELLER_CREDENTIALS_MIGRATION_NOT_READY/,
      );
    } finally {
      await runnerDb.query('rollback').catch(() => {});
    }
  });

  it.each([
    ['a name index without the organization', `drop index pilot.pilot_labeller_credentials_display_name_uq;
      create unique index pilot_labeller_credentials_display_name_uq on pilot.labeller_credentials (lower(display_name))`],
    ['a key with an extra column', `alter table pilot.labeller_credentials drop constraint labeller_credentials_pkey;
      alter table pilot.labeller_credentials add primary key (organization_id, account_id, display_name)`],
    ['a foreign key that does not cascade', `alter table pilot.labeller_credentials drop constraint pilot_labeller_credentials_membership_fk;
      alter table pilot.labeller_credentials add constraint pilot_labeller_credentials_membership_fk
        foreign key (account_id, organization_id) references pilot.organization_memberships (account_id, organization_id)`],
  ])('refuses %s', async (_label, sabotage) => {
    await runnerDb.query('begin');
    try {
      await runnerDb.query(sabotage);
      await expect(applyMigrationTransaction(runnerDb, migrationSql)).rejects.toThrow(
        /LABELLER_CREDENTIALS_MIGRATION_NOT_READY/,
      );
    } finally {
      await runnerDb.query('rollback').catch(() => {});
    }
  });
});

describe('setting your own labelling PIN', () => {
  it.each(['coach', 'organization_admin', 'admin'] as const)('a live %s can, and it is stored only as a hash', async (role) => {
    const accountId = await seedAccount(role);
    const pin = nextPin();
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: `Name ${accountId}`, pin });

    const stored = (await client.query(
      'select pin_hash from pilot.labeller_credentials where organization_id = $1 and account_id = $2',
      [ORG_ID, accountId],
    )).rows[0];
    expect(stored.pin_hash).toMatch(/^scrypt\$/);
    expect(await verifyPin(pin, stored.pin_hash)).toBe(true);
    const account = (await client.query('select pin_hash from pilot.accounts where account_id = $1', [accountId])).rows[0];
    expect(account.pin_hash).toBe('scrypt$account$untouched');
    expect(await verify(accountId, pin)).toBe('ACCEPTED');
  });

  it.each(['athlete', 'parent', 'staff', 'volunteer', 'platform_owner'] as const)('a %s cannot', async (role) => {
    const accountId = await seedAccount(role);
    expect(await codeOf(setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: 'X', pin: '2580' })))
      .toBe('LABELLER_NOT_ELIGIBLE');
    expect(await getOwnLabellerCredential(ORG_ID, accountId)).toBeNull();
  });

  it('a coach of another gym cannot set one here', async () => {
    const accountId = await seedAccount('coach', OTHER_ORG_ID);
    expect(await codeOf(setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: 'X', pin: '2580' })))
      .toBe('LABELLER_NOT_ELIGIBLE');
  });

  it('a deactivated, deleted or off-the-list coach cannot', async () => {
    const inactive = await seedAccount('coach');
    await client.query('update pilot.accounts set active_flag = false where account_id = $1', [inactive]);
    const deleted = await seedAccount('coach');
    await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [deleted]);
    const removed = await seedAccount('coach');
    await client.query('update pilot.organization_memberships set active_flag = false where account_id = $1', [removed]);
    for (const accountId of [inactive, deleted, removed]) {
      expect(await codeOf(setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: `N ${accountId}`, pin: '2580' })))
        .toBe('LABELLER_NOT_ELIGIBLE');
    }
  });

  it('replacing it changes the PIN and the name, and the old PIN stops working', async () => {
    const accountId = await seedAccount('coach');
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: 'First Name', pin: '2580' });
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: 'Second Name', pin: '1357' });
    expect((await getOwnLabellerCredential(ORG_ID, accountId))?.display_name).toBe('Second Name');
    expect(await verify(accountId, '2580')).toBe('LABELLER_PIN_REFUSED');
    expect(await verify(accountId, '1357')).toBe('ACCEPTED');
  });

  it('two labellers in one gym cannot share a name, whatever the case', async () => {
    const a = await seedAccount('coach');
    const b = await seedAccount('coach');
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId: a, displayName: 'Coach Sam', pin: '2580' });
    expect(await codeOf(setOwnLabellerCredential({ organizationId: ORG_ID, accountId: b, displayName: 'coach sam', pin: '2580' })))
      .toBe('LABELLER_NAME_TAKEN');
    // Renaming onto a taken name goes through the update half of the upsert.
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId: b, displayName: 'Coach Robin', pin: '2580' });
    expect(await codeOf(setOwnLabellerCredential({ organizationId: ORG_ID, accountId: b, displayName: 'COACH SAM', pin: '2580' })))
      .toBe('LABELLER_NAME_TAKEN');
    expect((await getOwnLabellerCredential(ORG_ID, b))?.display_name).toBe('Coach Robin');
  });

  it('a name held by someone no longer a live labeller is freed; a live holder keeps it', async () => {
    const former = await seedAccount('coach');
    const live = await seedAccount('coach');
    const next = await seedAccount('coach');
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId: former, displayName: 'Coach Pat', pin: '2580' });
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId: live, displayName: 'Coach Lee', pin: '2580' });
    await client.query('update pilot.organization_memberships set active_flag = false where account_id = $1', [former]);

    expect(await codeOf(setOwnLabellerCredential({ organizationId: ORG_ID, accountId: next, displayName: 'coach lee', pin: '2580' })))
      .toBe('LABELLER_NAME_TAKEN');
    expect(await codeOf(setOwnLabellerCredential({ organizationId: ORG_ID, accountId: next, displayName: 'Coach Pat', pin: '2580' })))
      .toBe('ACCEPTED');
    expect(await getOwnLabellerCredential(ORG_ID, former)).toBeNull();
    expect(await getOwnLabellerCredential(ORG_ID, live)).not.toBeNull();
  });

  it('the same name in two gyms is two names', async () => {
    const here = await seedAccount('coach');
    const there = await seedAccount('coach', OTHER_ORG_ID);
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId: here, displayName: 'Coach Two Gyms', pin: '2580' });
    expect(await codeOf(setOwnLabellerCredential({ organizationId: OTHER_ORG_ID, accountId: there, displayName: 'Coach Two Gyms', pin: '2580' })))
      .toBe('ACCEPTED');
  });

  it('the table refuses a plaintext PIN and an untrimmed name even from a raw write', async () => {
    const accountId = await seedAccount('coach');
    await expect(client.query(
      `insert into pilot.labeller_credentials (organization_id, account_id, display_name, pin_hash) values ($1, $2, 'Raw', '2580')`,
      [ORG_ID, accountId],
    )).rejects.toThrow(/pin_hash_check/);
    await expect(client.query(
      `insert into pilot.labeller_credentials (organization_id, account_id, display_name, pin_hash) values ($1, $2, ' Raw', 'scrypt$x$y')`,
      [ORG_ID, accountId],
    )).rejects.toThrow(/display_name_check/);
  });
});

describe('clearing a labelling PIN', () => {
  it('removes it inside the named organization, and only there', async () => {
    const accountId = await seedAccount('coach');
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: `Clear ${accountId}`, pin: '2580' });
    expect(await clearLabellerCredential(OTHER_ORG_ID, accountId)).toBe(false);
    expect(await getOwnLabellerCredential(ORG_ID, accountId)).not.toBeNull();
    expect(await clearLabellerCredential(ORG_ID, accountId)).toBe(true);
    expect(await getOwnLabellerCredential(ORG_ID, accountId)).toBeNull();
    expect(await verify(accountId, '2580')).toBe('LABELLER_PIN_REFUSED');
  });

  it('goes with the membership', async () => {
    const accountId = await seedAccount('coach');
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: `Gone ${accountId}`, pin: '2580' });
    await client.query('delete from pilot.organization_memberships where account_id = $1 and organization_id = $2', [accountId, ORG_ID]);
    expect(await getOwnLabellerCredential(ORG_ID, accountId)).toBeNull();
  });
});

describe('the picker and verification read eligibility live', () => {
  it('a member who stops being a live labeller leaves the picker and stops verifying', async () => {
    const changes: Array<[string, string]> = [
      ['deactivated', 'update pilot.accounts set active_flag = false where account_id = $1'],
      ['deleted', 'update pilot.accounts set deleted_at = now() where account_id = $1'],
      ['moved to staff', `update pilot.accounts set role = 'staff' where account_id = $1`],
      ['taken off the member list', 'update pilot.organization_memberships set active_flag = false where account_id = $1'],
    ];
    for (const [label, sql] of changes) {
      const accountId = await seedAccount('coach');
      await setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: `Live ${accountId}`, pin: '2580' });
      expect((await listLabellerPicker(ORG_ID)).map((entry) => entry.account_id)).toContain(accountId);
      expect(await verify(accountId, '2580')).toBe('ACCEPTED');

      await client.query(sql, [accountId]);
      expect({ label, inPicker: (await listLabellerPicker(ORG_ID)).some((entry) => entry.account_id === accountId) })
        .toEqual({ label, inPicker: false });
      expect({ label, verify: await verify(accountId, '2580') }).toEqual({ label, verify: 'LABELLER_PIN_REFUSED' });
    }
  });

  it('a suspended gym has no picker and verifies nobody', async () => {
    const accountId = await seedAccount('coach', OTHER_ORG_ID);
    await setOwnLabellerCredential({ organizationId: OTHER_ORG_ID, accountId, displayName: 'Other Gym', pin: '2580' });
    expect(await verify(accountId, '2580', OTHER_ORG_ID)).toBe('ACCEPTED');
    await client.query(`update pilot.organizations set status = 'suspended' where organization_id = $1`, [OTHER_ORG_ID]);
    try {
      expect(await listLabellerPicker(OTHER_ORG_ID)).toEqual([]);
      expect(await verify(accountId, '2580', OTHER_ORG_ID)).toBe('LABELLER_PIN_REFUSED');
    } finally {
      await client.query(`update pilot.organizations set status = 'active' where organization_id = $1`, [OTHER_ORG_ID]);
    }
  });

  it('a labeller of one gym is not verified, or listed, for another', async () => {
    const accountId = await seedAccount('coach');
    await setOwnLabellerCredential({ organizationId: ORG_ID, accountId, displayName: `Home ${accountId}`, pin: '2580' });
    expect(await verify(accountId, '2580', OTHER_ORG_ID)).toBe('LABELLER_PIN_REFUSED');
    expect((await listLabellerPicker(OTHER_ORG_ID)).map((entry) => entry.account_id)).not.toContain(accountId);
  });

  it('the picker never carries a hash', async () => {
    for (const entry of await listLabellerPicker(ORG_ID)) {
      expect(Object.keys(entry).sort()).toEqual(['account_id', 'display_name']);
    }
  });
});
