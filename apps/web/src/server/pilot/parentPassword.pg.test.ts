// Real PostgreSQL proof of parent password storage and of who may set one.
//
// Jason, 2026-10-01: "yes they will need away to sign in with a password ...
// the magic link should prompt them to make a password".
//
// WHAT IT PROVES, WITH THE REAL FUNCTIONS
//
//   the migration   adds the three columns and both checks to a database that
//                   lacks them, twice over, through the runner production uses;
//   redemption      redeemMagicLink marks the session it mints 'magic_link' and
//                   says whether to offer a password;
//   set-password    setOwnPasswordFromLinkSession accepts a session an emailed
//                   link minted in the last fifteen minutes, on a live parent
//                   account, and refuses everything else -- each refusal beside
//                   a control that differs in that one fact.
//
// WHY REAL POSTGRES. The proof and both refusal sets are SQL: a column read, an
// interval on the database clock, an UPDATE whose WHERE restates the proof.
// tsc cannot check any of it and a mocked database cannot run it.
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
// When set, withTransaction awaits it after the callback and before COMMIT:
// the transaction is held open with its locks, so a second connection can be
// shown to wait on them.
let mockHoldBeforeCommit: (() => Promise<void>) | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await activeClient.query('BEGIN');
    try {
      const result = await fn(activeClient);
      if (mockHoldBeforeCommit) await mockHoldBeforeCommit();
      await activeClient.query('COMMIT');
      return result;
    } catch (error) {
      await activeClient.query('ROLLBACK');
      throw error;
    }
  }),
}));

// The real scrypt, wrapped: a test can make something happen in the gap
// between set-password's read and its write, which is where the hash runs.
jest.mock('./security', () => {
  const actual = jest.requireActual('./security');
  return { ...actual, hashPassword: jest.fn(actual.hashPassword) };
});

import { ForbiddenError, ValidationError } from './errors';
import { redeemMagicLink } from './magicLinkStore';
import { setOwnPasswordFromLinkSession } from './parentPassword';
import { hashPassword, hashPin, hashToken, verifyPassword } from './security';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-parent-password-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-parent-password-migration.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_parent_password_migration.sql';
const TEST_DB_NAME = 'ppbf_test_parent_password';
const RUNNER_DB_NAME = 'ppbf_test_parent_password_runner';
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // pilot.board_seats: redemption and set-password ask it about the account.
  'pilot_slice_postgres_board_seats_migration.sql',
  'pilot_slice_postgres_magic_link_migration.sql',
  // pilot.accounts.deleted_at.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  MIGRATION_FILE,
];

const ORG_ID = 'org-pp';
// A second gym, for a board seat held somewhere other than the session's organization.
const OTHER_ORG_ID = 'org-pp-other';
const GOOD_PASSWORD = 'three small boats';

// ts-jest downlevels a plain dynamic import into require(), which cannot load
// an ESM-only .mjs file. Same trick the other .pg suites use.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const mockHashPassword = hashPassword as jest.MockedFunction<typeof hashPassword>;
const realHashPassword = (jest.requireActual('./security') as typeof import('./security')).hashPassword;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let warn: jest.SpyInstance;
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

type Role = 'parent' | 'coach' | 'staff' | 'volunteer' | 'athlete' | 'organization_admin';

/** A live account, provisioned the way staffProvisioning writes a guardian. */
async function seedAccount(role: Role = 'parent'): Promise<string> {
  sequence += 1;
  const accountId = `acct-${role}-${sequence}`;
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
     values ($1, $2, $3, $4, $5, true)`,
    [accountId, role, ORG_ID, role === 'athlete' ? 'ppbf_local' : 'microsoft', `${accountId}@example.com`],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)`,
    [accountId, ORG_ID, role],
  );
  return accountId;
}

/** A session row as some door would have minted it. Returns the raw token. */
async function seedSession(accountId: string, options: {
  method?: string | null;
  ageMinutes?: number;
  revoked?: boolean;
  expired?: boolean;
} = {}): Promise<string> {
  sequence += 1;
  const token = `session-token-${sequence}`;
  const method = options.method === undefined ? 'magic_link' : options.method;
  await client.query(
    `insert into pilot.session_tokens
       (token_hash, account_id, organization_id, created_at, expires_at, revoked_at, sign_in_method)
     values ($1, $2, $3,
             now() - ($4::int * interval '1 minute'),
             case when $5::boolean then now() - interval '1 second' else now() + interval '1 day' end,
             case when $6::boolean then now() else null end,
             $7)`,
    [hashToken(token), accountId, ORG_ID, options.ageMinutes ?? 0, options.expired === true, options.revoked === true, method],
  );
  return token;
}

async function storedPassword(accountId: string): Promise<{ password_hash: string | null; password_set_at: Date | null }> {
  return (await client.query(
    'select password_hash, password_set_at from pilot.accounts where account_id = $1',
    [accountId],
  )).rows[0];
}

async function liveSessionCount(accountId: string): Promise<number> {
  return (await client.query(
    'select count(*)::int as n from pilot.session_tokens where account_id = $1 and revoked_at is null',
    [accountId],
  )).rows[0].n;
}

/** The refusal's code, or what it resolved to. Never lets a pass look like a refusal. */
async function refusalOf(input: { accountId: string; sessionToken: string; password?: string }): Promise<string> {
  try {
    await setOwnPasswordFromLinkSession({ password: GOOD_PASSWORD, ...input });
    return 'ACCEPTED';
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) {
      return error.code ?? 'NO_CODE';
    }
    throw error;
  }
}

function loggedReasons(): unknown[] {
  return warn.mock.calls
    .filter(([message]) => message === 'pilot-auth set-password rejected')
    .map(([, detail]) => (detail as { reason: unknown }).reason);
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
  for (const file of MIGRATIONS) {
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [OTHER_ORG_ID],
  );
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
  // Swallowed as most .pg suites do: on Windows the killed server can still
  // hold the folder (EBUSY), and test-embedded-pg-server.mjs sweeps leftovers.
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockHashPassword.mockReset();
  mockHashPassword.mockImplementation(realHashPassword);
});

afterEach(() => {
  warn.mockRestore();
});

describe('the parent-password migration, through its runner', () => {
  let runnerDb: Client;
  let applyMigrationTransaction: (db: Client, sql: string) => Promise<void>;
  let migrationSql: string;

  async function shape(): Promise<{ columns: string[]; constraints: string[] }> {
    const columns = (await runnerDb.query(
      `select table_name || '.' || column_name as name from information_schema.columns
        where table_schema = 'pilot'
          and ((table_name = 'accounts' and column_name in ('password_hash', 'password_set_at'))
            or (table_name = 'session_tokens' and column_name = 'sign_in_method'))
        order by 1`,
    )).rows.map((row) => row.name as string);
    const constraints = (await runnerDb.query(
      `select conname from pg_constraint
        where conname in ('pilot_accounts_password_pair_check', 'pilot_session_tokens_sign_in_method_check')
        order by 1`,
    )).rows.map((row) => row.conname as string);
    return { columns, constraints };
  }

  beforeAll(async () => {
    const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
    applyMigrationTransaction = runner.applyMigrationTransaction as typeof applyMigrationTransaction;
    migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

    runnerDb = new Client({ connectionString: connectionStringFor(RUNNER_DB_NAME) });
    await runnerDb.connect();
    await runnerDb.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));

    // The base schema declares the new columns for a NEW environment. An
    // existing one never had them, so this database is put back to that shape
    // before the migration is asked to do anything.
    await runnerDb.query(`
      alter table pilot.accounts drop constraint pilot_accounts_password_pair_check;
      alter table pilot.accounts drop column password_hash, drop column password_set_at;
      alter table pilot.session_tokens drop constraint pilot_session_tokens_sign_in_method_check;
      alter table pilot.session_tokens drop column sign_in_method;
    `);
    await runnerDb.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ('org-r', 'org-r', 'active')`,
    );
    await runnerDb.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email)
       values ('existing-parent', 'parent', 'org-r', 'microsoft', 'existing@example.com')`,
    );
    await runnerDb.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id) values ('existing-session', 'existing-parent', 'org-r')`,
    );
  });

  afterAll(async () => {
    await runnerDb?.end();
  });

  test('the database starts without the columns, so the migration is what adds them', async () => {
    expect(await shape()).toEqual({ columns: [], constraints: [] });
  });

  test('a migration that leaves a check out is refused and rolled back whole', async () => {
    const withoutMethodCheck = migrationSql.replace(
      /alter table pilot\.session_tokens add constraint pilot_session_tokens_sign_in_method_check[\s\S]*?;/,
      '',
    );
    expect(withoutMethodCheck).not.toBe(migrationSql);

    await expect(applyMigrationTransaction(runnerDb, withoutMethodCheck))
      .rejects.toThrow(/PARENT_PASSWORD_MIGRATION_NOT_READY.*"sign_in_method_check_ready":false/);
    // Nothing of the half-applied file is left behind.
    expect(await shape()).toEqual({ columns: [], constraints: [] });
  });

  test('a pair check under the right name that checks something else is refused too', async () => {
    const wrongBody = migrationSql.replace(
      'check ((password_hash is null) = (password_set_at is null));',
      'check (password_hash is null or length(password_hash) > 0);',
    );
    expect(wrongBody).not.toBe(migrationSql);

    await expect(applyMigrationTransaction(runnerDb, wrongBody))
      .rejects.toThrow(/PARENT_PASSWORD_MIGRATION_NOT_READY.*"password_pair_check_ready":false/);
    expect(await shape()).toEqual({ columns: [], constraints: [] });
  });

  test('a migration that leaves a column out is refused', async () => {
    const withoutTimestamp = migrationSql
      .replace(/alter table pilot\.accounts\s+add column if not exists password_set_at timestamptz null;/, '')
      .replace('check ((password_hash is null) = (password_set_at is null));', 'check (password_hash is null or password_hash <> \'password_set_at\');');
    expect(withoutTimestamp).not.toBe(migrationSql);

    await expect(applyMigrationTransaction(runnerDb, withoutTimestamp))
      .rejects.toThrow(/PARENT_PASSWORD_MIGRATION_NOT_READY.*"account_columns_ready":false/);
    expect(await shape()).toEqual({ columns: [], constraints: [] });
  });

  // The migration adds a check only when no constraint of that NAME exists.
  // So a database that already holds the right name over the wrong rule is
  // not repaired by it, and readiness is what has to notice.
  describe('a constraint of the right name that does the wrong thing is already there', () => {
    async function withPreExisting(setup: string, teardown: string, expected: RegExp): Promise<void> {
      await runnerDb.query(setup);
      try {
        const before = await shape();
        await expect(applyMigrationTransaction(runnerDb, migrationSql)).rejects.toThrow(expected);
        // Rolled back whole: nothing the migration would have added is there.
        expect(await shape()).toEqual(before);
      } finally {
        await runnerDb.query(teardown);
      }
      expect(await shape()).toEqual({ columns: [], constraints: [] });
    }

    test('a method check admitting only magic_link: refused, rolled back, reported not ready', async () => {
      await withPreExisting(
        `alter table pilot.session_tokens add column sign_in_method text null;
         alter table pilot.session_tokens add constraint pilot_session_tokens_sign_in_method_check
           check (sign_in_method is null or sign_in_method in ('magic_link'));`,
        `alter table pilot.session_tokens drop constraint pilot_session_tokens_sign_in_method_check;
         alter table pilot.session_tokens drop column sign_in_method;`,
        /PARENT_PASSWORD_MIGRATION_NOT_READY:sign_in_method check refuses password/,
      );
    });

    test('a method check that admits anything: refused', async () => {
      await withPreExisting(
        `alter table pilot.session_tokens add column sign_in_method text null;
         alter table pilot.session_tokens add constraint pilot_session_tokens_sign_in_method_check
           check (sign_in_method is null or sign_in_method <> 'magic_link' or sign_in_method in ('magic_link', 'password', 'pin', 'microsoft'));`,
        `alter table pilot.session_tokens drop constraint pilot_session_tokens_sign_in_method_check;
         alter table pilot.session_tokens drop column sign_in_method;`,
        /PARENT_PASSWORD_MIGRATION_NOT_READY:sign_in_method check admits "emailed"/,
      );
    });

    test('a method check that refuses "not recorded": refused', async () => {
      await withPreExisting(
        // The existing session gets a method first, or this check could not be added.
        `alter table pilot.session_tokens add column sign_in_method text null;
         update pilot.session_tokens set sign_in_method = 'magic_link';
         alter table pilot.session_tokens add constraint pilot_session_tokens_sign_in_method_check
           check (sign_in_method is not null and sign_in_method in ('magic_link', 'password', 'pin', 'microsoft'));`,
        `alter table pilot.session_tokens drop constraint pilot_session_tokens_sign_in_method_check;
         alter table pilot.session_tokens drop column sign_in_method;`,
        /PARENT_PASSWORD_MIGRATION_NOT_READY:sign_in_method check refuses null/,
      );
    });

    // Mentions both columns, so a text match on the definition is satisfied.
    test.each([
      ['a hash needs a timestamp, but a timestamp alone is allowed', 'password_hash is null or password_set_at is not null', '01:refuse'],
      ['a timestamp needs a hash, but a hash alone is allowed', 'password_set_at is null or password_hash is not null', '10:refuse'],
      ['exactly one of the two', '(password_hash is null) <> (password_set_at is null)', '00:admit'],
    ])('a pair check that is not both-or-neither (%s): refused', async (_label, rule, failingCase) => {
      await withPreExisting(
        // The existing account gets a hash alone or nothing, whichever this rule allows.
        `alter table pilot.accounts add column password_hash text null, add column password_set_at timestamptz null;
         update pilot.accounts set password_hash = 'h' where ${failingCase === '00:admit'};
         alter table pilot.accounts add constraint pilot_accounts_password_pair_check check (${rule}) not valid;
         alter table pilot.accounts validate constraint pilot_accounts_password_pair_check;`,
        `alter table pilot.accounts drop constraint pilot_accounts_password_pair_check;
         alter table pilot.accounts drop column password_hash, drop column password_set_at;`,
        new RegExp(`PARENT_PASSWORD_MIGRATION_NOT_READY:password pair check is not both-or-neither \\(case ${failingCase}\\)`),
      );
    });
  });

  test('it adds the three columns and both checks, and applying it again changes nothing', async () => {
    await applyMigrationTransaction(runnerDb, migrationSql);
    const first = await shape();
    expect(first).toEqual({
      columns: ['accounts.password_hash', 'accounts.password_set_at', 'session_tokens.sign_in_method'],
      constraints: ['pilot_accounts_password_pair_check', 'pilot_session_tokens_sign_in_method_check'],
    });

    await applyMigrationTransaction(runnerDb, migrationSql);
    expect(await shape()).toEqual(first);
  });

  test('existing rows are untouched: no password, no recorded method', async () => {
    expect((await runnerDb.query(
      `select password_hash, password_set_at from pilot.accounts where account_id = 'existing-parent'`,
    )).rows).toEqual([{ password_hash: null, password_set_at: null }]);
    expect((await runnerDb.query(
      `select sign_in_method from pilot.session_tokens where token_hash = 'existing-session'`,
    )).rows).toEqual([{ sign_in_method: null }]);
  });

  test('half a credential is refused by the table', async () => {
    await expect(runnerDb.query(
      `update pilot.accounts set password_hash = 'scrypt$x' where account_id = 'existing-parent'`,
    )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_accounts_password_pair_check' });
    await expect(runnerDb.query(
      `update pilot.accounts set password_set_at = now() where account_id = 'existing-parent'`,
    )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_accounts_password_pair_check' });
  });

  test('a sign-in method outside the four doors is refused by the table', async () => {
    await expect(runnerDb.query(
      `update pilot.session_tokens set sign_in_method = 'emailed' where token_hash = 'existing-session'`,
    )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_session_tokens_sign_in_method_check' });
    await runnerDb.query(
      `update pilot.session_tokens set sign_in_method = 'magic_link' where token_hash = 'existing-session'`,
    );
  });
});

describe('redeeming an emailed link', () => {
  async function seedLink(accountId: string): Promise<string> {
    sequence += 1;
    const token = `link-token-${sequence}`;
    await client.query(
      `insert into pilot.magic_link_tokens (token_hash, account_id, organization_id, sent_to_email, expires_at)
       values ($1, $2, $3, $4, now() + interval '15 minutes')`,
      [hashToken(token), accountId, ORG_ID, `${accountId}@example.com`],
    );
    return token;
  }

  test('the session it mints is recorded as a magic_link session, and a parent is offered a password', async () => {
    const parent = await seedAccount('parent');

    const result = await redeemMagicLink(await seedLink(parent));

    expect(result.ok).toBe(true);
    expect(result.passwordSetup).toBe('offer');
    expect((await client.query(
      'select sign_in_method from pilot.session_tokens where token_hash = $1',
      [hashToken(result.session!.token)],
    )).rows).toEqual([{ sign_in_method: 'magic_link' }]);
  });

  test('the session a redemption mints is one set-password accepts', async () => {
    const parent = await seedAccount('parent');
    const result = await redeemMagicLink(await seedLink(parent));

    expect(await refusalOf({ accountId: parent, sessionToken: result.session!.token })).toBe('ACCEPTED');
  });

  test.each(['coach', 'staff', 'volunteer'] as const)('a %s redeems as before and is offered no password', async (role) => {
    const account = await seedAccount(role);

    const result = await redeemMagicLink(await seedLink(account));

    expect(result.ok).toBe(true);
    expect(result.passwordSetup).toBe('none');
  });

  test('a parent who holds a board seat is offered no password', async () => {
    const parent = await seedAccount('parent');
    await client.query(
      `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'treasurer', $2)`,
      [ORG_ID, parent],
    );

    const result = await redeemMagicLink(await seedLink(parent));

    expect(result.ok).toBe(true);
    expect(result.passwordSetup).toBe('none');
  });

  // The password is the account's, not one organization's: a seat on another
  // gym's board is still a seat.
  test('a parent who holds a seat on the board of ANOTHER organization is offered no password', async () => {
    const parent = await seedAccount('parent');
    await client.query(
      `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'treasurer', $2)`,
      [OTHER_ORG_ID, parent],
    );

    const result = await redeemMagicLink(await seedLink(parent));

    expect(result.ok).toBe(true);
    expect(result.passwordSetup).toBe('none');
  });
});

describe('setting a password', () => {
  test('a parent on a fresh emailed-link session sets one: hashed, timestamped, and it verifies', async () => {
    const parent = await seedAccount('parent');
    const token = await seedSession(parent);

    await setOwnPasswordFromLinkSession({ accountId: parent, sessionToken: token, password: GOOD_PASSWORD });

    const stored = await storedPassword(parent);
    expect(stored.password_hash).toMatch(/^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(stored.password_hash).not.toContain(GOOD_PASSWORD);
    expect(stored.password_set_at).toBeInstanceOf(Date);
    await expect(verifyPassword(GOOD_PASSWORD, stored.password_hash!)).resolves.toBe(true);
    expect(loggedReasons()).toEqual([]);
  });

  test('every other session of the account ends; the one that set the password stays', async () => {
    const parent = await seedAccount('parent');
    const other = await seedSession(parent, { method: null });
    const older = await seedSession(parent, { ageMinutes: 600 });
    const token = await seedSession(parent);
    const bystander = await seedAccount('parent');
    await seedSession(bystander);

    await setOwnPasswordFromLinkSession({ accountId: parent, sessionToken: token, password: GOOD_PASSWORD });

    const revoked = (await client.query(
      'select token_hash, revoked_at is not null as revoked from pilot.session_tokens where account_id = $1',
      [parent],
    )).rows;
    expect(revoked).toEqual(expect.arrayContaining([
      { token_hash: hashToken(other), revoked: true },
      { token_hash: hashToken(older), revoked: true },
      { token_hash: hashToken(token), revoked: false },
    ]));
    // Another account's session is not this account's to end.
    expect(await liveSessionCount(bystander)).toBe(1);
  });

  test('a new emailed link replaces the password: the old one stops verifying', async () => {
    const parent = await seedAccount('parent');
    await setOwnPasswordFromLinkSession({
      accountId: parent, sessionToken: await seedSession(parent), password: GOOD_PASSWORD,
    });

    await setOwnPasswordFromLinkSession({
      accountId: parent, sessionToken: await seedSession(parent), password: 'a different harbor',
    });

    const stored = await storedPassword(parent);
    await expect(verifyPassword('a different harbor', stored.password_hash!)).resolves.toBe(true);
    await expect(verifyPassword(GOOD_PASSWORD, stored.password_hash!)).resolves.toBe(false);
  });

  test('a PIN hash an old parent row still carries is left alone and is not the password', async () => {
    const parent = await seedAccount('parent');
    const pinHash = await hashPin('481902');
    await client.query('update pilot.accounts set pin_hash = $2 where account_id = $1', [parent, pinHash]);

    await setOwnPasswordFromLinkSession({
      accountId: parent, sessionToken: await seedSession(parent), password: GOOD_PASSWORD,
    });

    const row = (await client.query('select pin_hash, password_hash from pilot.accounts where account_id = $1', [parent])).rows[0];
    expect(row.pin_hash).toBe(pinHash);
    expect(row.password_hash).not.toBe(pinHash);
  });
});

describe('set-password refuses everything but a fresh emailed-link session on a live parent account', () => {
  /** Every refusal: the code the page reads, nothing stored, no scrypt spent, no session ended. */
  async function expectRefused(accountId: string, sessionToken: string, reason: string, password?: string): Promise<void> {
    const liveBefore = await liveSessionCount(accountId);

    expect(await refusalOf({ accountId, sessionToken, password })).toBe('PASSWORD_SETUP_LINK_REQUIRED');

    expect(await storedPassword(accountId)).toEqual({ password_hash: null, password_set_at: null });
    expect(mockHashPassword).not.toHaveBeenCalled();
    expect(await liveSessionCount(accountId)).toBe(liveBefore);
    expect(loggedReasons()).toEqual([reason]);
  }

  test.each([
    ['no recorded method (every session minted before the migration)', null],
    ['a password session', 'password'],
    ['a Microsoft session', 'microsoft'],
    ['a PIN session', 'pin'],
  ])('a live session with %s is not proof', async (_label, method) => {
    const parent = await seedAccount('parent');

    await expectRefused(parent, await seedSession(parent, { method }), 'no_recent_link_session');
  });

  test('a link session is proof for fifteen minutes: 14 is accepted, 16 is refused', async () => {
    const early = await seedAccount('parent');
    expect(await refusalOf({ accountId: early, sessionToken: await seedSession(early, { ageMinutes: 14 }) })).toBe('ACCEPTED');
    mockHashPassword.mockClear();

    const late = await seedAccount('parent');
    await expectRefused(late, await seedSession(late, { ageMinutes: 16 }), 'no_recent_link_session');
  });

  test('a revoked link session is not proof', async () => {
    const parent = await seedAccount('parent');

    await expectRefused(parent, await seedSession(parent, { revoked: true }), 'no_recent_link_session');
  });

  test('an expired link session is not proof', async () => {
    const parent = await seedAccount('parent');

    await expectRefused(parent, await seedSession(parent, { expired: true }), 'no_recent_link_session');
  });

  test('one account\'s link session cannot set another account\'s password', async () => {
    const victim = await seedAccount('parent');
    const attacker = await seedAccount('parent');
    const attackerToken = await seedSession(attacker);

    await expectRefused(victim, attackerToken, 'unknown_deleted_or_inactive_account');
    // And the attacker's own account is untouched by the attempt.
    expect(await storedPassword(attacker)).toEqual({ password_hash: null, password_set_at: null });
  });

  test('a token that names no session is refused', async () => {
    const parent = await seedAccount('parent');

    await expectRefused(parent, 'no-such-session-token', 'unknown_deleted_or_inactive_account');
  });

  // The state an admin path can leave a deleted person in: marked deleted,
  // active again (deletedAccountSignIn.ts). With the mark cleared, accepted.
  test('an account marked deleted cannot set a password, even active with a fresh link session', async () => {
    const parent = await seedAccount('parent');
    const token = await seedSession(parent);
    await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [parent]);

    await expectRefused(parent, token, 'unknown_deleted_or_inactive_account');

    await client.query('update pilot.accounts set deleted_at = null where account_id = $1', [parent]);
    warn.mockClear();
    expect(await refusalOf({ accountId: parent, sessionToken: token })).toBe('ACCEPTED');
  });

  test('a deactivated account cannot set a password; reactivated, it can', async () => {
    const parent = await seedAccount('parent');
    const token = await seedSession(parent);
    await client.query('update pilot.accounts set active_flag = false where account_id = $1', [parent]);

    await expectRefused(parent, token, 'unknown_deleted_or_inactive_account');

    await client.query('update pilot.accounts set active_flag = true where account_id = $1', [parent]);
    warn.mockClear();
    expect(await refusalOf({ accountId: parent, sessionToken: token })).toBe('ACCEPTED');
  });

  test.each(['coach', 'staff', 'volunteer', 'organization_admin', 'athlete'] as const)(
    'a %s cannot set a password, on the same fresh link session a parent could',
    async (role) => {
      const account = await seedAccount(role);

      await expectRefused(account, await seedSession(account), 'role_not_password_eligible');
    },
  );

  test('a parent who holds a board seat cannot; with the seat given up, they can', async () => {
    const parent = await seedAccount('parent');
    const token = await seedSession(parent);
    await client.query(
      `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'secretary', $2)`,
      [ORG_ID, parent],
    );

    await expectRefused(parent, token, 'role_not_password_eligible');

    await client.query('delete from pilot.board_seats where account_id = $1', [parent]);
    warn.mockClear();
    expect(await refusalOf({ accountId: parent, sessionToken: token })).toBe('ACCEPTED');
  });

  test('a seat on the board of ANOTHER organization refuses it just the same', async () => {
    const parent = await seedAccount('parent');
    const token = await seedSession(parent);
    await client.query(
      `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'secretary', $2)`,
      [OTHER_ORG_ID, parent],
    );

    await expectRefused(parent, token, 'role_not_password_eligible');
  });

  test('a refusal logs a reason and never who it was', async () => {
    const parent = await seedAccount('parent');
    await refusalOf({ accountId: parent, sessionToken: await seedSession(parent, { method: null }) });

    // A guardian's account_id is usually their email address.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(parent);
    expect(warn.mock.calls).toEqual([['pilot-auth set-password rejected', { reason: 'no_recent_link_session' }]]);
  });
});

describe('a password the rules refuse', () => {
  test.each([
    ['too short', 'nine char', 'PASSWORD_TOO_SHORT'],
    ['common', 'password123', 'PASSWORD_TOO_GUESSABLE'],
    ['the gym name with a year', 'Punxsy2026!!', 'PASSWORD_TOO_GUESSABLE'],
  ])('%s: named to the parent, nothing stored, no session ended', async (_label, password, code) => {
    const parent = await seedAccount('parent');
    const token = await seedSession(parent);
    await seedSession(parent, { method: null });

    expect(await refusalOf({ accountId: parent, sessionToken: token, password })).toBe(code);

    expect(await storedPassword(parent)).toEqual({ password_hash: null, password_set_at: null });
    expect(mockHashPassword).not.toHaveBeenCalled();
    expect(await liveSessionCount(parent)).toBe(2);
  });

  test('the account\'s own email name with digits added is refused', async () => {
    const parent = await seedAccount('parent');
    await client.query(`update pilot.accounts set login_email = 'riverbend@example.com' where account_id = $1`, [parent]);

    expect(await refusalOf({ accountId: parent, sessionToken: await seedSession(parent), password: 'riverbend2026' }))
      .toBe('PASSWORD_TOO_GUESSABLE');
  });

  test('someone not entitled to set a password is not told what the rules refuse', async () => {
    const coach = await seedAccount('coach');

    expect(await refusalOf({ accountId: coach, sessionToken: await seedSession(coach), password: 'short' }))
      .toBe('PASSWORD_SETUP_LINK_REQUIRED');
  });
});

// The read that decides and the write that stores are separated by a scrypt.
// Each test changes one fact inside that gap; the write must notice.
describe('a change between the check and the write is refused by the write', () => {
  async function refusedAfter(change: (accountId: string, token: string) => Promise<void>): Promise<string> {
    const parent = await seedAccount('parent');
    const token = await seedSession(parent);
    const bystanderSession = await seedSession(parent, { method: null });
    mockHashPassword.mockImplementationOnce(async (password) => {
      await change(parent, token);
      return realHashPassword(password);
    });

    expect(await refusalOf({ accountId: parent, sessionToken: token })).toBe('PASSWORD_SETUP_LINK_REQUIRED');

    expect(mockHashPassword).toHaveBeenCalledTimes(1);
    expect(await storedPassword(parent)).toEqual({ password_hash: null, password_set_at: null });
    expect(loggedReasons()).toEqual(['state_changed_before_write']);
    // The refused write ended nobody else's session either.
    expect((await client.query(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [hashToken(bystanderSession)],
    )).rows).toEqual([{ revoked_at: null }]);
    return parent;
  }

  test('the account is marked deleted', async () => {
    await refusedAfter(async (accountId) => {
      await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [accountId]);
    });
  });

  test('the account is deactivated', async () => {
    await refusedAfter(async (accountId) => {
      await client.query('update pilot.accounts set active_flag = false where account_id = $1', [accountId]);
    });
  });

  test('the session is revoked (what a role change or an admin sign-out does)', async () => {
    await refusedAfter(async (_accountId, token) => {
      await client.query('update pilot.session_tokens set revoked_at = now() where token_hash = $1', [hashToken(token)]);
    });
  });

  test('the fifteen minutes run out', async () => {
    await refusedAfter(async (_accountId, token) => {
      await client.query(
        `update pilot.session_tokens set created_at = now() - interval '16 minutes' where token_hash = $1`,
        [hashToken(token)],
      );
    });
  });

  // A seat grant revokes no session (boardSeats.ts), so the session proof
  // alone would let this one through.
  test('the account is given a board seat', async () => {
    await refusedAfter(async (accountId) => {
      await client.query(
        `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'chair', $2)`,
        [ORG_ID, accountId],
      );
    });
  });

  test('the account is given a seat on the board of another organization', async () => {
    await refusedAfter(async (accountId) => {
      await client.query(
        `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'chair', $2)`,
        [OTHER_ORG_ID, accountId],
      );
    });
  });

  // Every role change in the app revokes the account's sessions. This one
  // deliberately does not, so the role is what the write is seen to refuse on.
  test('the account stops being a parent, with its session left alive', async () => {
    await refusedAfter(async (accountId) => {
      await client.query(`update pilot.accounts set role = 'coach' where account_id = $1`, [accountId]);
    });
  });

  test('the session stops being a link session', async () => {
    await refusedAfter(async (_accountId, token) => {
      await client.query('update pilot.session_tokens set sign_in_method = null where token_hash = $1', [hashToken(token)]);
    });
  });
});

// TWO INDEPENDENT CONNECTIONS. The tests above change state on the one
// connection the code under test uses, between its read and its write: that
// shows the write re-decides, not that it is safe against a writer running AT
// THE SAME TIME. These hold a second transaction open on its own connection
// and show the two cannot overlap, in both orders.
describe('set-password against a concurrent writer on another connection', () => {
  let other: Client;
  let watcher: Client;
  let mainPid: number;

  beforeAll(async () => {
    other = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    watcher = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await other.connect();
    await watcher.connect();
    mainPid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
  });

  afterEach(async () => {
    mockHoldBeforeCommit = null;
    await other.query('rollback').catch(() => undefined);
    await other.query('reset lock_timeout');
  });

  afterAll(async () => {
    await other?.end();
    await watcher?.end();
  });

  /** Resolves once the code under test is waiting on a lock, seen from a third connection. */
  async function untilMainWaitsOnALock(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const row = (await watcher.query(
        'select wait_event_type from pg_stat_activity where pid = $1',
        [mainPid],
      )).rows[0];
      if (row?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('set-password never waited on a lock: it ran straight past the other transaction');
  }

  type Writer = { label: string; reason: string; write: (db: Client, accountId: string, token: string) => Promise<unknown> };
  const WRITERS: Writer[] = [
    {
      label: 'a revocation of the proof session',
      reason: 'the session lock',
      write: (db, _accountId, token) => db.query(
        'update pilot.session_tokens set revoked_at = now() where token_hash = $1', [hashToken(token)],
      ),
    },
    {
      // By SQL, not through assignBoardSeat: the lock comes from the foreign
      // key on pilot.board_seats.account_id, which any insert takes.
      label: 'a board-seat grant',
      reason: 'the account lock, through the seat\'s foreign key',
      write: (db, accountId) => db.query(
        `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'at-large', $2)`, [ORG_ID, accountId],
      ),
    },
    {
      label: 'a board-seat grant in another organization',
      reason: 'the account lock, through the seat\'s foreign key',
      write: (db, accountId) => db.query(
        `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'at-large', $2)`, [OTHER_ORG_ID, accountId],
      ),
    },
    {
      label: 'a deletion',
      reason: 'the account lock',
      write: (db, accountId) => db.query('update pilot.accounts set deleted_at = now() where account_id = $1', [accountId]),
    },
    {
      label: 'a deactivation',
      reason: 'the account lock',
      write: (db, accountId) => db.query('update pilot.accounts set active_flag = false where account_id = $1', [accountId]),
    },
    {
      label: 'a role change',
      reason: 'the account lock',
      write: (db, accountId) => db.query(`update pilot.accounts set role = 'coach' where account_id = $1`, [accountId]),
    },
  ];

  describe.each(WRITERS)('$label', ({ write }) => {
    test('in flight first: set-password WAITS for it, and refuses once it commits', async () => {
      const parent = await seedAccount('parent');
      const token = await seedSession(parent);
      await other.query('begin');
      await write(other, parent, token);

      const pending = refusalOf({ accountId: parent, sessionToken: token });
      await untilMainWaitsOnALock();
      // Still undecided while the other transaction is open. Read from the
      // third connection: the one under test is the one that is waiting.
      expect((await watcher.query('select password_hash from pilot.accounts where account_id = $1', [parent])).rows)
        .toEqual([{ password_hash: null }]);
      await other.query('commit');

      expect(await pending).toBe('PASSWORD_SETUP_LINK_REQUIRED');
      expect(await storedPassword(parent)).toEqual({ password_hash: null, password_set_at: null });
      expect(loggedReasons()).toEqual(['state_changed_before_write']);
    });

    test('in flight first, then rolled back: set-password waits, then goes through', async () => {
      const parent = await seedAccount('parent');
      const token = await seedSession(parent);
      await other.query('begin');
      await write(other, parent, token);

      const pending = refusalOf({ accountId: parent, sessionToken: token });
      await untilMainWaitsOnALock();
      await other.query('rollback');

      expect(await pending).toBe('ACCEPTED');
      expect((await storedPassword(parent)).password_hash).not.toBeNull();
    });

    test('set-password in flight first: the other writer cannot proceed until it commits', async () => {
      const parent = await seedAccount('parent');
      const token = await seedSession(parent);
      let reached!: () => void;
      let release!: () => void;
      const reachedTheGate = new Promise<void>((resolve) => { reached = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      mockHoldBeforeCommit = async () => { reached(); await released; };

      const pending = refusalOf({ accountId: parent, sessionToken: token });
      await reachedTheGate;
      // The password write holds its locks, uncommitted. The other writer
      // waits on them; with a lock timeout it gives up instead of overlapping.
      await other.query(`set lock_timeout = '400ms'`);
      await expect(write(other, parent, token)).rejects.toMatchObject({ code: '55P03' });
      // And nothing is visible to it yet.
      expect((await other.query('select password_hash from pilot.accounts where account_id = $1', [parent])).rows)
        .toEqual([{ password_hash: null }]);

      release();
      expect(await pending).toBe('ACCEPTED');

      // After the commit the other writer goes through, in that order: the
      // password was set while the account and the proof were still good.
      await other.query('reset lock_timeout');
      await write(other, parent, token);
      expect((await storedPassword(parent)).password_hash).not.toBeNull();
    });
  });
});
