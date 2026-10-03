// Real PostgreSQL proof of who a parent password admits.
//
// Jason, 2026-10-01 (OD-2026-10-01-002 section 3): on /login, a password box
// under the email box; the same slow-down the athlete PIN has. And the rule
// part 1 left for this part: a stored hash proves nothing by itself, because
// deletion, deactivation and a role change leave it where it is.
//
// WHAT IT PROVES, WITH THE REAL FUNCTION
//
//   admission   loginWithEmailAndPassword mints a session recorded as
//               'password' for a live parent in an active organization who
//               types the password they set;
//   refusal     everything else is null -- each refusal beside a control that
//               differs in that one fact -- with one verification spent on
//               every outcome and no session row written;
//   the mint    a change to the account between the read and the mint, in the
//               gap where the scrypt runs or on another connection, is seen
//               by the mint, which holds the account row while it decides.
//
// WHY REAL POSTGRES. The lookup, the lock and the re-read are SQL, and what
// the lock makes another transaction do cannot be shown by a mocked database.
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

// The real scrypt, wrapped: a test can count verifications, and can make
// something happen in the gap between the sign-in's read and its mint, which
// is where the verification runs.
jest.mock('./security', () => {
  const actual = jest.requireActual('./security');
  return { ...actual, verifyPassword: jest.fn(actual.verifyPassword) };
});

import { ForbiddenError } from './errors';
import { setOwnPasswordFromLinkSession } from './parentPassword';
import { loginWithEmailAndPassword } from './parentPasswordSignIn';
import { PASSWORD_SCRYPT_COST, hashPassword, hashToken, verifyPassword } from './security';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-parent-password-signin-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_parent_password_signin';
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // pilot.board_seats: for the test that gives a parent a seat and shows it changes nothing.
  'pilot_slice_postgres_board_seats_migration.sql',
  'pilot_slice_postgres_magic_link_migration.sql',
  // pilot.accounts.deleted_at.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_parent_password_migration.sql',
];

const ORG_ID = 'org-pps';
const SUSPENDED_ORG_ID = 'org-pps-suspended';
// A second gym in good standing: a move to it is refused for being a move,
// not for where it went.
const OTHER_ACTIVE_ORG_ID = 'org-pps-other';
const GOOD_PASSWORD = 'three small boats';
const OTHER_PASSWORD = 'a different harbor';

const mockVerifyPassword = verifyPassword as jest.MockedFunction<typeof verifyPassword>;
const realVerifyPassword = (jest.requireActual('./security') as typeof import('./security')).verifyPassword;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let warn: jest.SpyInstance;
let sequence = 0;
/** GOOD_PASSWORD and OTHER_PASSWORD, hashed once: every seeded account shares them. */
let goodHash: string;
let otherHash: string;

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

interface Seeded { accountId: string; email: string }

/**
 * A live account provisioned the way staffProvisioning writes a guardian,
 * holding GOOD_PASSWORD unless told otherwise. Any role can be given a hash
 * here: that is the state part 1 leaves behind after a role change.
 */
async function seedAccount(options: { role?: Role; password?: boolean; organizationId?: string } = {}): Promise<Seeded> {
  sequence += 1;
  const role = options.role ?? 'parent';
  const organizationId = options.organizationId ?? ORG_ID;
  const accountId = `acct-${role}-${sequence}`;
  const email = `${accountId}@example.com`;
  const withPassword = options.password !== false;
  await client.query(
    `insert into pilot.accounts
       (account_id, role, organization_id, auth_provider, login_email, active_flag, password_hash, password_set_at)
     values ($1, $2, $3, $4, $5, true, $6, case when $6::text is null then null else now() end)`,
    [accountId, role, organizationId, role === 'athlete' ? 'ppbf_local' : 'microsoft', email, withPassword ? goodHash : null],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)`,
    [accountId, organizationId, role],
  );
  return { accountId, email };
}

async function sessions(accountId: string): Promise<Array<{ token_hash: string; sign_in_method: string | null; organization_id: string }>> {
  return (await client.query(
    `select token_hash, sign_in_method, organization_id
       from pilot.session_tokens where account_id = $1 and revoked_at is null`,
    [accountId],
  )).rows;
}

async function totalSessions(): Promise<number> {
  return (await client.query('select count(*)::int as n from pilot.session_tokens')).rows[0].n;
}

function loggedReasons(): unknown[] {
  return warn.mock.calls
    .filter(([message]) => message === 'pilot-auth password login rejected')
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
  await adminClient.query(`drop database if exists ${TEST_DB_NAME}`);
  await adminClient.query(`create database ${TEST_DB_NAME}`);
  await adminClient.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  for (const file of MIGRATIONS) {
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active'), ($2, $2, 'suspended'), ($3, $3, 'active')`,
    [ORG_ID, SUSPENDED_ORG_ID, OTHER_ACTIVE_ORG_ID],
  );
  activeClient = client;
  goodHash = await hashPassword(GOOD_PASSWORD);
  otherHash = await hashPassword(OTHER_PASSWORD);
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
  mockVerifyPassword.mockReset();
  mockVerifyPassword.mockImplementation(realVerifyPassword);
});

afterEach(() => {
  warn.mockRestore();
});

describe('a parent who set a password signs in with it', () => {
  test('a session is minted, recorded as a password session, in the account\'s organization', async () => {
    const parent = await seedAccount();

    const result = await loginWithEmailAndPassword(parent.email, GOOD_PASSWORD);

    expect(result).not.toBeNull();
    expect(result!.principal).toMatchObject({
      accountId: parent.accountId,
      role: 'parent',
      organizationId: ORG_ID,
      sessionToken: result!.token,
    });
    expect(await sessions(parent.accountId)).toEqual([
      { token_hash: hashToken(result!.token), sign_in_method: 'password', organization_id: ORG_ID },
    ]);
    expect(loggedReasons()).toEqual([]);
  });

  test('the email is matched whatever its capitals and surrounding spaces', async () => {
    const parent = await seedAccount();

    const result = await loginWithEmailAndPassword(`  ${parent.email.toUpperCase()} `, GOOD_PASSWORD);

    expect(result?.principal.accountId).toBe(parent.accountId);
  });

  test('the password is not trimmed: with a space added it is a different password', async () => {
    const parent = await seedAccount();

    expect(await loginWithEmailAndPassword(parent.email, `${GOOD_PASSWORD} `)).toBeNull();
    expect(await loginWithEmailAndPassword(parent.email, ` ${GOOD_PASSWORD}`)).toBeNull();
    expect(loggedReasons()).toEqual(['wrong_password', 'wrong_password']);
  });

  test('a parent who holds a board seat signs in like any other parent', async () => {
    const parent = await seedAccount();
    await client.query(
      `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'treasurer', $2)`,
      [ORG_ID, parent.accountId],
    );

    expect(await loginWithEmailAndPassword(parent.email, GOOD_PASSWORD)).not.toBeNull();
  });

  test('the session it mints cannot set or replace a password: only an emailed-link session can', async () => {
    const parent = await seedAccount();
    const result = await loginWithEmailAndPassword(parent.email, GOOD_PASSWORD);

    const attempt = setOwnPasswordFromLinkSession({
      accountId: parent.accountId,
      sessionToken: result!.token,
      password: OTHER_PASSWORD,
      beforeHash: async () => undefined,
    });

    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(attempt).rejects.toMatchObject({ code: 'PASSWORD_SETUP_LINK_REQUIRED' });
    expect((await client.query('select password_hash from pilot.accounts where account_id = $1', [parent.accountId])).rows[0].password_hash)
      .toBe(goodHash);
  });
});

describe('everything else is refused, with the same nothing', () => {
  type Refusal = {
    label: string;
    reason: string;
    /** Seeds the case; returns the email and password to try. */
    arrange: () => Promise<{ email: string; password: string; accountId?: string }>;
  };

  const update = (sql: string, accountId: string) => client.query(sql, [accountId]);

  const REFUSALS: Refusal[] = [
    {
      label: 'an email no account has',
      reason: 'unknown_or_inactive_account',
      arrange: async () => ({ email: 'nobody-by-this-name@example.com', password: GOOD_PASSWORD }),
    },
    {
      label: 'the wrong password',
      reason: 'wrong_password',
      arrange: async () => {
        const parent = await seedAccount();
        return { ...parent, password: OTHER_PASSWORD };
      },
    },
    {
      label: 'a parent who never set a password',
      reason: 'no_password_set',
      arrange: async () => ({ ...(await seedAccount({ password: false })), password: GOOD_PASSWORD }),
    },
    {
      label: 'a login marked deleted, still active, hash still stored',
      reason: 'deleted_account',
      arrange: async () => {
        const parent = await seedAccount();
        await update('update pilot.accounts set deleted_at = now() where account_id = $1', parent.accountId);
        return { ...parent, password: GOOD_PASSWORD };
      },
    },
    {
      label: 'a deactivated login, hash still stored',
      reason: 'unknown_or_inactive_account',
      arrange: async () => {
        const parent = await seedAccount();
        await update('update pilot.accounts set active_flag = false where account_id = $1', parent.accountId);
        return { ...parent, password: GOOD_PASSWORD };
      },
    },
    {
      label: 'a parent whose organization is suspended',
      reason: 'organization_not_active',
      arrange: async () => ({ ...(await seedAccount({ organizationId: SUSPENDED_ORG_ID })), password: GOOD_PASSWORD }),
    },
    {
      label: 'a parent since made a coach, hash still stored',
      reason: 'role_not_password_eligible',
      arrange: async () => {
        const parent = await seedAccount();
        await update(`update pilot.accounts set role = 'coach' where account_id = $1`, parent.accountId);
        return { ...parent, password: GOOD_PASSWORD };
      },
    },
    ...(['coach', 'staff', 'volunteer', 'athlete', 'organization_admin'] as const).map((role): Refusal => ({
      label: `a ${role} row that carries a password hash`,
      reason: 'role_not_password_eligible',
      arrange: async () => ({ ...(await seedAccount({ role })), password: GOOD_PASSWORD }),
    })),
  ];

  test.each(REFUSALS)('$label: null, no session, one verification, reason $reason', async ({ arrange, reason }) => {
    const { email, password, accountId } = await arrange();
    const before = await totalSessions();

    const result = await loginWithEmailAndPassword(email, password);

    expect(result).toBeNull();
    expect(await totalSessions()).toBe(before);
    if (accountId) expect(await sessions(accountId)).toEqual([]);
    // One scrypt on every outcome, at the cost a real hash is stored at.
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
    expect(mockVerifyPassword.mock.calls[0][1]).toMatch(
      new RegExp(`^scrypt\\$${PASSWORD_SCRYPT_COST.N}\\$${PASSWORD_SCRYPT_COST.r}\\$${PASSWORD_SCRYPT_COST.p}\\$[0-9a-f]+\\$[0-9a-f]+$`),
    );
    expect(loggedReasons()).toEqual([reason]);
  });

  test('each of those, put right, signs in: the refusal was that one fact', async () => {
    const deleted = await seedAccount();
    await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [deleted.accountId]);
    expect(await loginWithEmailAndPassword(deleted.email, GOOD_PASSWORD)).toBeNull();
    await client.query('update pilot.accounts set deleted_at = null where account_id = $1', [deleted.accountId]);
    expect(await loginWithEmailAndPassword(deleted.email, GOOD_PASSWORD)).not.toBeNull();

    const inactive = await seedAccount();
    await client.query('update pilot.accounts set active_flag = false where account_id = $1', [inactive.accountId]);
    expect(await loginWithEmailAndPassword(inactive.email, GOOD_PASSWORD)).toBeNull();
    await client.query('update pilot.accounts set active_flag = true where account_id = $1', [inactive.accountId]);
    expect(await loginWithEmailAndPassword(inactive.email, GOOD_PASSWORD)).not.toBeNull();

    const reroled = await seedAccount();
    await client.query(`update pilot.accounts set role = 'staff' where account_id = $1`, [reroled.accountId]);
    expect(await loginWithEmailAndPassword(reroled.email, GOOD_PASSWORD)).toBeNull();
    await client.query(`update pilot.accounts set role = 'parent' where account_id = $1`, [reroled.accountId]);
    expect(await loginWithEmailAndPassword(reroled.email, GOOD_PASSWORD)).not.toBeNull();

    const suspended = await seedAccount({ organizationId: SUSPENDED_ORG_ID });
    expect(await loginWithEmailAndPassword(suspended.email, GOOD_PASSWORD)).toBeNull();
    await client.query(`update pilot.organizations set status = 'active' where organization_id = $1`, [SUSPENDED_ORG_ID]);
    try {
      expect(await loginWithEmailAndPassword(suspended.email, GOOD_PASSWORD)).not.toBeNull();
    } finally {
      await client.query(`update pilot.organizations set status = 'suspended' where organization_id = $1`, [SUSPENDED_ORG_ID]);
    }
  });

  test('a refusal says why in the log and never who', async () => {
    const parent = await seedAccount();

    await loginWithEmailAndPassword(parent.email, OTHER_PASSWORD);
    await loginWithEmailAndPassword('nobody-by-this-name@example.com', OTHER_PASSWORD);

    const said = JSON.stringify(warn.mock.calls);
    expect(said).not.toContain(parent.email);
    expect(said).not.toContain(parent.accountId);
    expect(said).not.toContain('nobody-by-this-name');
    expect(said).not.toContain(OTHER_PASSWORD);
    for (const [, detail] of warn.mock.calls) {
      expect(Object.keys(detail as object)).toEqual(['reason']);
    }
  });

  test.each([
    ['an empty email', '', GOOD_PASSWORD],
    ['an empty password', 'someone@example.com', ''],
    ['an email longer than an address can be', `${'a'.repeat(300)}@example.com`, GOOD_PASSWORD],
    ['an email one character past the longest address', `${'a'.repeat(243)}@example.com`, GOOD_PASSWORD],
    ['a password one character past four times the longest allowed', 'someone@example.com', 'x'.repeat(513)],
  ])('%s is refused on the request alone: nothing is looked up or hashed', async (_label, email, password) => {
    expect(await loginWithEmailAndPassword(email, password)).toBeNull();

    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(loggedReasons()).toEqual(['malformed_credentials']);
  });

  test('at the limit, not past it, a request is an ordinary attempt: looked up and verified', async () => {
    expect(await loginWithEmailAndPassword(`${'a'.repeat(242)}@example.com`, 'x'.repeat(512))).toBeNull();

    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
    expect(loggedReasons()).toEqual(['unknown_or_inactive_account']);
  });

  test('a PIN hash is not a password: a row holding only a PIN is refused', async () => {
    const parent = await seedAccount({ password: false });
    const { hashPin } = jest.requireActual('./security') as typeof import('./security');
    await client.query('update pilot.accounts set pin_hash = $2 where account_id = $1', [parent.accountId, await hashPin('482915')]);

    expect(await loginWithEmailAndPassword(parent.email, '482915')).toBeNull();
    expect(loggedReasons()).toEqual(['no_password_set']);
  });

  // The column is not null, so the constraint is lifted for this one case and
  // put back. The default organization is pointed at a real, active one: if
  // the old fallback came back, this would mint a session there, not throw.
  test('an account with no organization is refused, not placed in the default organization', async () => {
    const parent = await seedAccount();
    const previousDefaultOrg = process.env.PPBF_PILOT_DEFAULT_ORG_ID;
    process.env.PPBF_PILOT_DEFAULT_ORG_ID = OTHER_ACTIVE_ORG_ID;
    await client.query('alter table pilot.accounts alter column organization_id drop not null');
    try {
      await client.query('update pilot.accounts set organization_id = null where account_id = $1', [parent.accountId]);
      const before = await totalSessions();

      expect(await loginWithEmailAndPassword(parent.email, GOOD_PASSWORD)).toBeNull();
      expect(await totalSessions()).toBe(before);
      expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
      expect(loggedReasons()).toEqual(['no_organization']);
    } finally {
      await client.query('update pilot.accounts set organization_id = $2 where account_id = $1', [parent.accountId, ORG_ID]);
      await client.query('alter table pilot.accounts alter column organization_id set not null');
      if (previousDefaultOrg === undefined) delete process.env.PPBF_PILOT_DEFAULT_ORG_ID;
      else process.env.PPBF_PILOT_DEFAULT_ORG_ID = previousDefaultOrg;
    }
  });
});

// The verification is the gap: the account was read before it and the session
// is minted after it. Each of these happens inside that gap.
describe('a change between the read and the mint is seen by the mint', () => {
  type Change = { label: string; change: (parent: Seeded) => Promise<unknown> };

  const CHANGES: Change[] = [
    {
      label: 'the account is marked deleted',
      change: (parent) => client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [parent.accountId]),
    },
    {
      label: 'the account is deactivated',
      change: (parent) => client.query('update pilot.accounts set active_flag = false where account_id = $1', [parent.accountId]),
    },
    {
      label: 'the account stops being a parent',
      change: (parent) => client.query(`update pilot.accounts set role = 'coach' where account_id = $1`, [parent.accountId]),
    },
    {
      label: 'the password is cleared',
      change: (parent) => client.query(
        'update pilot.accounts set password_hash = null, password_set_at = null where account_id = $1', [parent.accountId],
      ),
    },
    {
      label: 'the password is replaced with another',
      change: (parent) => client.query('update pilot.accounts set password_hash = $2 where account_id = $1', [parent.accountId, otherHash]),
    },
    {
      label: 'the sign-in email is changed',
      change: (parent) => client.query(
        'update pilot.accounts set login_email = $2 where account_id = $1', [parent.accountId, `moved-${parent.email}`],
      ),
    },
    {
      label: 'the account is moved to another organization, itself active',
      change: (parent) => client.query(
        'update pilot.accounts set organization_id = $2 where account_id = $1', [parent.accountId, OTHER_ACTIVE_ORG_ID],
      ),
    },
  ];

  test.each(CHANGES)('$label: refused, and no session exists', async ({ change }) => {
    const parent = await seedAccount();
    mockVerifyPassword.mockImplementation(async (password, hash) => {
      const verified = await realVerifyPassword(password, hash);
      await change(parent);
      return verified;
    });

    expect(await loginWithEmailAndPassword(parent.email, GOOD_PASSWORD)).toBeNull();

    expect(await sessions(parent.accountId)).toEqual([]);
    expect(loggedReasons()).toEqual(['state_changed_before_mint']);
  });

  test('the organization is suspended: refused, and no session exists', async () => {
    const organizationId = `org-pps-gap-${sequence += 1}`;
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [organizationId],
    );
    const parent = await seedAccount({ organizationId });
    mockVerifyPassword.mockImplementation(async (password, hash) => {
      const verified = await realVerifyPassword(password, hash);
      await client.query(`update pilot.organizations set status = 'suspended' where organization_id = $1`, [organizationId]);
      return verified;
    });

    expect(await loginWithEmailAndPassword(parent.email, GOOD_PASSWORD)).toBeNull();

    expect(await sessions(parent.accountId)).toEqual([]);
    expect(loggedReasons()).toEqual(['state_changed_before_mint']);
  });

  test('a change that touches none of it does not refuse: the control', async () => {
    const parent = await seedAccount();
    mockVerifyPassword.mockImplementation(async (password, hash) => {
      const verified = await realVerifyPassword(password, hash);
      await client.query('update pilot.accounts set updated_at = now() where account_id = $1', [parent.accountId]);
      return verified;
    });

    expect(await loginWithEmailAndPassword(parent.email, GOOD_PASSWORD)).not.toBeNull();
  });
});

describe('the mint against a concurrent writer on another connection', () => {
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
    throw new Error('the sign-in never waited on a lock: it ran straight past the other transaction');
  }

  type Writer = { label: string; write: (db: Client, accountId: string) => Promise<unknown> };
  const WRITERS: Writer[] = [
    {
      label: 'a deletion',
      write: (db, accountId) => db.query('update pilot.accounts set deleted_at = now() where account_id = $1', [accountId]),
    },
    {
      label: 'a deactivation',
      write: (db, accountId) => db.query('update pilot.accounts set active_flag = false where account_id = $1', [accountId]),
    },
    {
      label: 'a role change',
      write: (db, accountId) => db.query(`update pilot.accounts set role = 'coach' where account_id = $1`, [accountId]),
    },
    {
      label: 'a cleared password',
      write: (db, accountId) => db.query(
        'update pilot.accounts set password_hash = null, password_set_at = null where account_id = $1', [accountId],
      ),
    },
  ];

  describe.each(WRITERS)('$label', ({ write }) => {
    test('in flight first: the sign-in WAITS for it, and refuses once it commits', async () => {
      const parent = await seedAccount();
      await other.query('begin');
      await write(other, parent.accountId);

      const pending = loginWithEmailAndPassword(parent.email, GOOD_PASSWORD);
      try {
        await untilMainWaitsOnALock();
        // Still undecided while the other transaction is open. Read from the
        // third connection: the one under test is the one that is waiting.
        expect((await watcher.query('select count(*)::int as n from pilot.session_tokens where account_id = $1', [parent.accountId])).rows)
          .toEqual([{ n: 0 }]);
      } finally {
        await other.query('commit');
      }

      expect(await pending).toBeNull();
      expect(await sessions(parent.accountId)).toEqual([]);
      expect(loggedReasons()).toEqual(['state_changed_before_mint']);
    });

    test('in flight first, then rolled back: the sign-in waits, then goes through', async () => {
      const parent = await seedAccount();
      await other.query('begin');
      await write(other, parent.accountId);

      const pending = loginWithEmailAndPassword(parent.email, GOOD_PASSWORD);
      try {
        await untilMainWaitsOnALock();
      } finally {
        await other.query('rollback');
      }

      expect(await pending).not.toBeNull();
      expect(await sessions(parent.accountId)).toHaveLength(1);
    });

    test('the sign-in in flight first: the other writer cannot proceed until the session exists', async () => {
      const parent = await seedAccount();
      let reached!: () => void;
      let release!: () => void;
      const reachedTheGate = new Promise<void>((resolve) => { reached = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      mockHoldBeforeCommit = async () => { reached(); await released; };

      const pending = loginWithEmailAndPassword(parent.email, GOOD_PASSWORD);
      try {
        await reachedTheGate;
        // The mint holds the account row, uncommitted. The other writer waits
        // on it; with a lock timeout it gives up instead of overlapping.
        await other.query(`set lock_timeout = '400ms'`);
        await expect(write(other, parent.accountId)).rejects.toMatchObject({ code: '55P03' });
      } finally {
        // Always let the held transaction finish, or a failed expectation
        // above leaves the suite's one connection stuck inside it.
        release();
      }
      expect(await pending).not.toBeNull();

      // After the commit the other writer goes through, and the session the
      // sign-in minted is there for it to revoke: it cannot have been missed.
      await other.query('reset lock_timeout');
      await write(other, parent.accountId);
      const revoked = await other.query(
        'update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null',
        [parent.accountId],
      );
      expect(revoked.rowCount).toBe(1);
      expect(await sessions(parent.accountId)).toEqual([]);
    });
  });

  // A suspension writes the ORGANIZATION row and then revokes that
  // organization's sessions (setOrganizationStatus, auth.ts). It never takes
  // the account row, so only the mint's share lock on the organization row
  // orders the two.
  describe('a suspension of the organization', () => {
    async function seedOrganization(): Promise<string> {
      const organizationId = `org-pps-race-${sequence += 1}`;
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
        [organizationId],
      );
      return organizationId;
    }

    const suspend = (db: Client, organizationId: string) => db.query(
      `update pilot.organizations set status = 'suspended', updated_at = now() where organization_id = $1`,
      [organizationId],
    );

    test('in flight first: the sign-in WAITS for it, and refuses once it commits', async () => {
      const organizationId = await seedOrganization();
      const parent = await seedAccount({ organizationId });
      // Suspended only inside the mint: the first, unlocked read must still
      // find the organization active, or the sign-in is refused before it
      // ever reaches the lock this test is about.
      mockVerifyPassword.mockImplementation(async (password, hash) => {
        const verified = await realVerifyPassword(password, hash);
        await other.query('begin');
        await suspend(other, organizationId);
        return verified;
      });

      const pending = loginWithEmailAndPassword(parent.email, GOOD_PASSWORD);
      try {
        await untilMainWaitsOnALock();
      } finally {
        await other.query('commit');
      }

      expect(await pending).toBeNull();
      expect(await sessions(parent.accountId)).toEqual([]);
      expect(loggedReasons()).toEqual(['state_changed_before_mint']);
    });

    test('in flight first, then rolled back: the sign-in waits, then goes through', async () => {
      const organizationId = await seedOrganization();
      const parent = await seedAccount({ organizationId });
      mockVerifyPassword.mockImplementation(async (password, hash) => {
        const verified = await realVerifyPassword(password, hash);
        await other.query('begin');
        await suspend(other, organizationId);
        return verified;
      });

      const pending = loginWithEmailAndPassword(parent.email, GOOD_PASSWORD);
      try {
        await untilMainWaitsOnALock();
      } finally {
        await other.query('rollback');
      }

      expect(await pending).not.toBeNull();
    });

    test('the sign-in in flight first: the suspension waits, then revokes the session it minted', async () => {
      const organizationId = await seedOrganization();
      const parent = await seedAccount({ organizationId });
      let reached!: () => void;
      let release!: () => void;
      const reachedTheGate = new Promise<void>((resolve) => { reached = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      mockHoldBeforeCommit = async () => { reached(); await released; };

      const pending = loginWithEmailAndPassword(parent.email, GOOD_PASSWORD);
      try {
        await reachedTheGate;
        await other.query(`set lock_timeout = '400ms'`);
        await expect(suspend(other, organizationId)).rejects.toMatchObject({ code: '55P03' });
      } finally {
        release();
      }
      expect(await pending).not.toBeNull();

      // The suspension as setOrganizationStatus runs it: the status, then the
      // organization's live sessions. The one just minted is among them.
      await other.query('reset lock_timeout');
      await other.query('begin');
      await suspend(other, organizationId);
      const revoked = await other.query(
        'update pilot.session_tokens set revoked_at = now() where organization_id = $1 and revoked_at is null',
        [organizationId],
      );
      await other.query('commit');
      expect(revoked.rowCount).toBe(1);
      expect(await sessions(parent.accountId)).toEqual([]);
    });
  });
});
