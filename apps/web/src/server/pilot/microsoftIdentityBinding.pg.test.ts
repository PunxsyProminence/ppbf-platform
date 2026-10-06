// Real PostgreSQL proof of CL-A19: a Microsoft sign-in is bound to the Entra
// object id (oid) and tenant id (tid), not to the email claim.
//
// Audit finding CL-A19 (claude-A-auth.md): loginWithMicrosoftEmail matched on
// claims.email / preferred_username / upn only. Whoever could change a user's
// mail attribute inside the pinned tenant signed in as the account that
// address belonged to.
//
// WHAT IT PROVES, WITH THE REAL FUNCTIONS
//
//   the migration   adds both columns, the both-or-neither check and the
//                   partial unique index, twice over, through the runner
//                   production uses; refuses a database whose index of that
//                   name is not unique;
//   first sign-in   stores the oid and tid it presented (trust on first use)
//                   and mints a session;
//   later sign-ins  admit the same pair; refuse a different oid, or the same
//                   oid from a different tenant, before any session row exists,
//                   and leave the stored pair as it was;
//   one user        an oid already bound to one account cannot bind a second;
//   refusals        an account refused for another reason (inactive, deleted)
//                   is not bound by the attempt.
//
// WHY REAL POSTGRES. The binding is an UPDATE guarded by "still unbound" and a
// partial unique index; a mocked database runs neither.
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

jest.mock('./db', () => {
  const actual = jest.requireActual('./db');
  return {
    ...actual,
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
        await activeClient.query('COMMIT');
        return result;
      } catch (error) {
        await activeClient.query('ROLLBACK');
        throw error;
      }
    }),
  };
});

import {
  clearMicrosoftIdentityOnLoginEmailChangeTx,
  createOrUpdateMicrosoftPlatformOwnerAccount,
  loginWithMicrosoftEmail,
} from './auth';
import { unbindMicrosoftIdentity } from './microsoftIdentityUnbind';
import { createOrUpdateMicrosoftStaffAccount } from './staffProvisioning';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-microsoft-identity-binding-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-microsoft-identity-binding-migration.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_microsoft_identity_binding_migration.sql';
const TEST_DB_NAME = 'ppbf_test_microsoft_identity_binding';
const RUNNER_DB_NAME = 'ppbf_test_microsoft_identity_binding_runner';
const PRIOR_MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // pilot.accounts.deleted_at, read by accountDeletedSql.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
];

const ORG_ID = 'org-pp';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

// ts-jest downlevels a plain dynamic import into require(), which cannot load
// an ESM-only .mjs file. Same trick the other .pg suites use.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let migrationSql: string;
let applyMigrationTransaction: (db: Client, sql: string) => Promise<void>;
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

async function applyPriorMigrations(db: Client): Promise<void> {
  for (const file of PRIOR_MIGRATIONS) {
    await db.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  // The base schema now carries the binding for new databases. Production
  // predates it, so the migration is proved against a table without it
  // (dropping the columns drops their check and index with them).
  await db.query('alter table pilot.accounts drop column microsoft_oid, drop column microsoft_tid');
  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [ORG_ID],
  );
}

function objectId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

/** A live Microsoft account with an active membership, as staff provisioning writes one. */
async function seedAccount(options: { active?: boolean; deleted?: boolean } = {}): Promise<{ accountId: string; email: string }> {
  sequence += 1;
  const email = `coach-${sequence}@example.com`;
  // account_id is case-sensitive (L2 DATA IDENTITY); kept distinct from the email casing on purpose.
  const accountId = `Coach-${sequence}@example.com`;
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag, deleted_at)
     values ($1, 'coach', $2, 'microsoft', $3, $4, case when $5::boolean then now() end)`,
    [accountId, ORG_ID, email, options.active ?? true, options.deleted === true],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'coach', true)`,
    [accountId, ORG_ID],
  );
  return { accountId, email };
}

async function storedIdentity(accountId: string): Promise<{ microsoft_oid: string | null; microsoft_tid: string | null }> {
  return (await client.query(
    'select microsoft_oid, microsoft_tid from pilot.accounts where account_id = $1',
    [accountId],
  )).rows[0];
}

async function sessionCount(accountId: string): Promise<number> {
  return (await client.query(
    'select count(*)::int as n from pilot.session_tokens where account_id = $1',
    [accountId],
  )).rows[0].n;
}

/** What the sign-in resolved to: the account it admitted, null, or the refusal's message. */
async function signIn(email: string, oid: string, tid: string = TENANT): Promise<string | null> {
  try {
    const result = await loginWithMicrosoftEmail(email, { objectId: oid, tenantId: tid });
    return result ? result.principal.accountId : null;
  } catch (error) {
    return error instanceof Error ? `THREW:${error.message}` : 'THREW';
  }
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

  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runner.applyMigrationTransaction as typeof applyMigrationTransaction;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  await applyPriorMigrations(client);
  await applyMigrationTransaction(client, migrationSql);
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

describe('the microsoft-identity-binding migration, through its runner', () => {
  let runnerDb: Client;

  beforeAll(async () => {
    runnerDb = new Client({ connectionString: connectionStringFor(RUNNER_DB_NAME) });
    await runnerDb.connect();
    await applyPriorMigrations(runnerDb);
  });

  afterAll(async () => {
    await runnerDb?.end();
  });

  async function columns(): Promise<string[]> {
    return (await runnerDb.query(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'accounts'
          and column_name in ('microsoft_oid', 'microsoft_tid')
        order by 1`,
    )).rows.map((row) => row.column_name as string);
  }

  test('adds both columns to a database that lacks them, and a second run changes nothing', async () => {
    expect(await columns()).toEqual([]);
    await runnerDb.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email)
       values ('existing@example.com', 'coach', $1, 'microsoft', 'existing@example.com')`,
      [ORG_ID],
    );

    await applyMigrationTransaction(runnerDb, migrationSql);
    expect(await columns()).toEqual(['microsoft_oid', 'microsoft_tid']);
    await applyMigrationTransaction(runnerDb, migrationSql);
    expect(await columns()).toEqual(['microsoft_oid', 'microsoft_tid']);

    // No backfill: an existing account starts unbound.
    const row = (await runnerDb.query(
      `select microsoft_oid, microsoft_tid from pilot.accounts where account_id = 'existing@example.com'`,
    )).rows[0];
    expect(row).toEqual({ microsoft_oid: null, microsoft_tid: null });
  });

  test('refuses half an identity, either half', async () => {
    const { accountId } = await seedAccount();
    await expect(client.query('update pilot.accounts set microsoft_oid = $2 where account_id = $1', [accountId, objectId()]))
      .rejects.toThrow(/pilot_accounts_microsoft_identity_pair_check/);
    await expect(client.query('update pilot.accounts set microsoft_tid = $2 where account_id = $1', [accountId, TENANT]))
      .rejects.toThrow(/pilot_accounts_microsoft_identity_pair_check/);
  });

  test('one (tenant, oid) binds one account; the same oid in another tenant, and unbound rows, do not collide', async () => {
    const first = await seedAccount();
    const second = await seedAccount();
    const third = await seedAccount();
    const oid = objectId();
    await client.query('update pilot.accounts set microsoft_oid = $2, microsoft_tid = $3 where account_id = $1', [first.accountId, oid, TENANT]);

    await expect(client.query('update pilot.accounts set microsoft_oid = $2, microsoft_tid = $3 where account_id = $1', [second.accountId, oid, TENANT]))
      .rejects.toThrow(/pilot_accounts_microsoft_identity_uq/);
    await client.query('update pilot.accounts set microsoft_oid = $2, microsoft_tid = $3 where account_id = $1', [second.accountId, oid, OTHER_TENANT]);
    expect(await storedIdentity(third.accountId)).toEqual({ microsoft_oid: null, microsoft_tid: null });
  });

  test('refuses, and rolls back, a database whose index of that name is not unique', async () => {
    const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
    await adminClient.connect();
    await adminClient.query('drop database if exists ppbf_test_microsoft_identity_binding_wrong');
    await adminClient.query('create database ppbf_test_microsoft_identity_binding_wrong');
    await adminClient.end();
    const wrongDb = new Client({ connectionString: connectionStringFor('ppbf_test_microsoft_identity_binding_wrong') });
    await wrongDb.connect();
    try {
      await applyPriorMigrations(wrongDb);
      await wrongDb.query('alter table pilot.accounts add column microsoft_oid text null, add column microsoft_tid text null');
      await wrongDb.query('create index pilot_accounts_microsoft_identity_uq on pilot.accounts (microsoft_tid, microsoft_oid)');

      await expect(applyMigrationTransaction(wrongDb, migrationSql)).rejects.toThrow(/MICROSOFT_IDENTITY_BINDING_NOT_READY/);
      const pairCheck = (await wrongDb.query(
        `select count(*)::int as n from pg_constraint where conname = 'pilot_accounts_microsoft_identity_pair_check'`,
      )).rows[0].n;
      expect(pairCheck).toBe(0);
    } finally {
      await wrongDb.end();
    }
  });
});

describe('the binding runner refuses a database whose audit vocabulary predates it', () => {
  test('refuses, and rolls back, when audit_events_event_type_check does not admit microsoft_identity_mismatch', async () => {
    const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
    await adminClient.connect();
    await adminClient.query('drop database if exists ppbf_test_microsoft_identity_binding_old_vocab');
    await adminClient.query('create database ppbf_test_microsoft_identity_binding_old_vocab');
    await adminClient.end();
    const oldDb = new Client({ connectionString: connectionStringFor('ppbf_test_microsoft_identity_binding_old_vocab') });
    await oldDb.connect();
    try {
      await applyPriorMigrations(oldDb);
      // The vocabulary as production holds it before audit-event-vocabulary is re-run.
      await oldDb.query('alter table pilot.audit_events drop constraint audit_events_event_type_check');
      await oldDb.query(`alter table pilot.audit_events add constraint audit_events_event_type_check
        check (event_type in ('create', 'update', 'login', 'logout'))`);

      await expect(applyMigrationTransaction(oldDb, migrationSql)).rejects.toThrow(/"audit_vocabulary_ready":false/);
      const columns = (await oldDb.query(
        `select count(*)::int as n from information_schema.columns
          where table_schema = 'pilot' and table_name = 'accounts' and column_name = 'microsoft_oid'`,
      )).rows[0].n;
      expect(columns).toBe(0);
    } finally {
      await oldDb.end();
    }
  });
});

describe('loginWithMicrosoftEmail binds to the directory identity', () => {
  test('the first sign-in stores the oid and tid it presented and mints a session', async () => {
    const { accountId, email } = await seedAccount();
    const oid = objectId();

    expect(await signIn(email, oid)).toBe(accountId);
    expect(await storedIdentity(accountId)).toEqual({ microsoft_oid: oid, microsoft_tid: TENANT });
    expect(await sessionCount(accountId)).toBe(1);
  });

  test('a later sign-in with the same pair is admitted', async () => {
    const { accountId, email } = await seedAccount();
    const oid = objectId();
    await signIn(email, oid);

    expect(await signIn(email.toUpperCase(), oid)).toBe(accountId);
    expect(await sessionCount(accountId)).toBe(2);
  });

  // The finding itself: the email now names a different directory user.
  test('a different oid presenting the bound email is refused before any session exists, and the binding stands', async () => {
    const { accountId, email } = await seedAccount();
    const owner = objectId();
    await signIn(email, owner);

    expect(await signIn(email, objectId())).toBe('THREW:Forbidden: Microsoft identity mismatch');
    expect(await sessionCount(accountId)).toBe(1);
    expect(await storedIdentity(accountId)).toEqual({ microsoft_oid: owner, microsoft_tid: TENANT });
  });

  test('the same oid from a different tenant is refused', async () => {
    const { accountId, email } = await seedAccount();
    const oid = objectId();
    await signIn(email, oid);

    expect(await signIn(email, oid, OTHER_TENANT)).toBe('THREW:Forbidden: Microsoft identity mismatch');
    expect(await sessionCount(accountId)).toBe(1);
  });

  test('a directory user already bound to one account cannot bind a second', async () => {
    const first = await seedAccount();
    const second = await seedAccount();
    const oid = objectId();
    await signIn(first.email, oid);

    expect(await signIn(second.email, oid)).toBe('THREW:Forbidden: Microsoft identity already bound to another account');
    expect(await storedIdentity(second.accountId)).toEqual({ microsoft_oid: null, microsoft_tid: null });
    expect(await sessionCount(second.accountId)).toBe(0);
  });

  test('an account refused for another reason is not bound by the attempt', async () => {
    const inactive = await seedAccount({ active: false });
    const deleted = await seedAccount({ deleted: true });

    expect(await signIn(inactive.email, objectId())).toBeNull();
    expect(await signIn(deleted.email, objectId())).toBeNull();
    expect(await storedIdentity(inactive.accountId)).toEqual({ microsoft_oid: null, microsoft_tid: null });
    expect(await storedIdentity(deleted.accountId)).toEqual({ microsoft_oid: null, microsoft_tid: null });
  });

  // The binding write is guarded by "still unbound". If another sign-in bound
  // the account between this one's read and its write, the write changes
  // nothing and this sign-in must be judged against what was stored.
  test('losing the first-use race to a different oid is refused', async () => {
    const { accountId, email } = await seedAccount();
    const winner = objectId();
    const db = jest.requireMock('./db') as { queryOne: jest.Mock };
    const realQueryOne = db.queryOne.getMockImplementation()!;
    db.queryOne.mockImplementationOnce(async (text: string, params: unknown[] = []) => {
      const row = await realQueryOne(text, params);
      await client.query('update pilot.accounts set microsoft_oid = $2, microsoft_tid = $3 where account_id = $1', [accountId, winner, TENANT]);
      return row;
    });

    expect(await signIn(email, objectId())).toBe('THREW:Forbidden: Microsoft identity mismatch');
    expect(await sessionCount(accountId)).toBe(0);
    expect(await storedIdentity(accountId)).toEqual({ microsoft_oid: winner, microsoft_tid: TENANT });
  });
});

// CL-A19: the binding names the directory user an account's email belonged to.
// A provisioning write that points the account at a different email clears it,
// in the same transaction, and records that it did.
describe('provisioning a different login email clears the binding', () => {
  async function clearedAuditRows(accountId: string): Promise<number> {
    return (await client.query(
      `select count(*)::int as n from pilot.audit_events
        where entity_type = 'account' and entity_id = $1 and event_type = 'update'
          and details->>'change' = 'microsoft_identity_cleared'`,
      [accountId],
    )).rows[0].n;
  }

  test('re-pointing the platform owner account at a new email clears its binding and records it', async () => {
    const { accountId, email } = await seedAccount();
    const owner = objectId();
    await signIn(email, owner);
    expect((await storedIdentity(accountId)).microsoft_oid).toBe(owner);

    await createOrUpdateMicrosoftPlatformOwnerAccount({
      loginEmail: `new-${email}`,
      organizationId: ORG_ID,
      accountIdHint: accountId,
    });

    expect(await storedIdentity(accountId)).toEqual({ microsoft_oid: null, microsoft_tid: null });
    expect(await clearedAuditRows(accountId)).toBe(1);
  });

  test('the same email, in another case, keeps the binding and records nothing', async () => {
    const { accountId, email } = await seedAccount();
    const owner = objectId();
    await signIn(email, owner);

    await createOrUpdateMicrosoftPlatformOwnerAccount({
      loginEmail: email.toUpperCase(),
      organizationId: ORG_ID,
      accountIdHint: accountId,
    });

    expect(await storedIdentity(accountId)).toEqual({ microsoft_oid: owner, microsoft_tid: TENANT });
    expect(await clearedAuditRows(accountId)).toBe(0);
  });

  test('a write that is refused keeps the binding: the clear rolls back with it', async () => {
    const { accountId, email } = await seedAccount();
    const owner = objectId();
    await signIn(email, owner);
    await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [accountId]);

    await expect(createOrUpdateMicrosoftPlatformOwnerAccount({
      loginEmail: `new-${email}`,
      organizationId: ORG_ID,
      accountIdHint: accountId,
    })).rejects.toThrow();

    expect(await storedIdentity(accountId)).toEqual({ microsoft_oid: owner, microsoft_tid: TENANT });
    expect(await clearedAuditRows(accountId)).toBe(0);
  });

  test('re-inviting a bound staff account by its own email keeps the binding', async () => {
    const { accountId, email } = await seedAccount();
    const owner = objectId();
    await signIn(email, owner);

    await createOrUpdateMicrosoftStaffAccount({
      loginEmail: email,
      organizationId: ORG_ID,
      role: 'coach',
      callerInvitableRoles: ['coach'],
    });

    expect(await storedIdentity(accountId)).toEqual({ microsoft_oid: owner, microsoft_tid: TENANT });
    expect(await clearedAuditRows(accountId)).toBe(0);
  });
});

// The recovery #1294's release gate asks for: a directory user deleted and
// re-created gets a new oid, and every sign-in is refused until something
// clears the binding. Owner ruling (relayed by overwatch, 2026-10-06), option
// A: an organization admin clears it for active members of their own
// organization, never the platform owner, never themselves; the platform
// owner clears it for anyone but themselves; the bootstrap-key route clears
// the platform owner's own.
describe('unbinding a Microsoft identity so the next sign-in re-binds', () => {
  const OTHER_ORG_ID = 'org-other';

  beforeAll(async () => {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [OTHER_ORG_ID],
    );
  });

  async function seedMember(options: {
    role?: string;
    organizationId?: string;
    platformOwner?: boolean;
    membershipActive?: boolean;
  } = {}): Promise<{ accountId: string; email: string; oid: string }> {
    sequence += 1;
    const role = options.role ?? 'coach';
    const organizationId = options.organizationId ?? ORG_ID;
    const email = `member-${sequence}@example.com`;
    const accountId = `Member-${sequence}@example.com`;
    const oid = objectId();
    await client.query(
      `insert into pilot.accounts
         (account_id, role, organization_id, auth_provider, login_email, active_flag, is_platform_owner, microsoft_oid, microsoft_tid)
       values ($1, $2, $3, 'microsoft', $4, true, $5, $6, $7)`,
      [accountId, role, organizationId, email, options.platformOwner === true, oid, TENANT],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, $4)`,
      [accountId, organizationId, role, options.membershipActive ?? true],
    );
    return { accountId, email, oid };
  }

  async function unbindAuditRows(accountId: string): Promise<Array<{ actor_account_id: string | null; actor_role: string | null; organization_id: string; details: Record<string, unknown> }>> {
    return (await client.query(
      `select actor_account_id, actor_role, organization_id, details from pilot.audit_events
        where entity_type = 'account' and entity_id = $1 and event_type = 'update'
          and details->>'change' = 'microsoft_identity_cleared'
        order by audit_id`,
      [accountId],
    )).rows;
  }

  async function seedSession(accountId: string, organizationId: string = ORG_ID): Promise<void> {
    sequence += 1;
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id) values ($1, $2, $3)`,
      [`hash-${sequence}`, accountId, organizationId],
    );
  }

  async function liveSessions(accountId: string): Promise<number> {
    return (await client.query(
      'select count(*)::int as n from pilot.session_tokens where account_id = $1 and revoked_at is null',
      [accountId],
    )).rows[0].n;
  }

  async function unbind(actor: { accountId: string; role: string; organizationId: string }, target: string): Promise<string> {
    try {
      const result = await unbindMicrosoftIdentity(
        actor as Parameters<typeof unbindMicrosoftIdentity>[0],
        target,
      );
      return result.cleared ? 'cleared' : 'already-unbound';
    } catch (error) {
      return error instanceof Error ? `THREW:${error.message}` : 'THREW';
    }
  }

  test('an organization admin unbinds a member of their own organization; the audit row names them; the next sign-in re-binds', async () => {
    const admin = await seedMember({ role: 'organization_admin' });
    const coach = await seedMember();
    const recreated = objectId();
    expect(await signIn(coach.email, recreated)).toBe('THREW:Forbidden: Microsoft identity mismatch');

    expect(await unbind({ accountId: admin.accountId, role: 'organization_admin', organizationId: ORG_ID }, coach.accountId)).toBe('cleared');

    expect(await storedIdentity(coach.accountId)).toEqual({ microsoft_oid: null, microsoft_tid: null });
    const rows = await unbindAuditRows(coach.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_account_id: admin.accountId,
      actor_role: 'organization_admin',
      organization_id: ORG_ID,
      details: {
        change: 'microsoft_identity_cleared',
        reason: 'admin_unbind',
        previous_microsoft_tid: TENANT,
        previous_microsoft_oid_suffix: coach.oid.slice(-4),
      },
    });

    expect(await signIn(coach.email, recreated)).toBe(coach.accountId);
    expect(await storedIdentity(coach.accountId)).toEqual({ microsoft_oid: recreated, microsoft_tid: TENANT });
  });

  // Owner ruling 2026-10-06 (relayed by overwatch): "Yes, sign out devices".
  // Sessions minted under the old directory user end with the binding.
  test('an unbind signs the target out everywhere, in the same transaction, and no one else', async () => {
    const admin = await seedMember({ role: 'organization_admin' });
    const coach = await seedMember();
    const bystander = await seedMember();
    await seedSession(coach.accountId);
    await seedSession(coach.accountId, OTHER_ORG_ID);
    await seedSession(admin.accountId);
    await seedSession(bystander.accountId);

    expect(await unbind({ accountId: admin.accountId, role: 'organization_admin', organizationId: ORG_ID }, coach.accountId)).toBe('cleared');

    expect(await liveSessions(coach.accountId)).toBe(0);
    expect(await liveSessions(admin.accountId)).toBe(1);
    expect(await liveSessions(bystander.accountId)).toBe(1);
  });

  test('a refused or no-op unbind signs no one out', async () => {
    const admin = await seedMember({ role: 'organization_admin' });
    const elsewhere = await seedMember({ organizationId: OTHER_ORG_ID });
    const unbound = await seedMember();
    await client.query('update pilot.accounts set microsoft_oid = null, microsoft_tid = null where account_id = $1', [unbound.accountId]);
    await seedSession(elsewhere.accountId, OTHER_ORG_ID);
    await seedSession(unbound.accountId);
    const actor = { accountId: admin.accountId, role: 'organization_admin', organizationId: ORG_ID };

    expect(await unbind(actor, elsewhere.accountId)).toBe('THREW:Not found: account');
    expect(await unbind(actor, unbound.accountId)).toBe('already-unbound');
    expect(await liveSessions(elsewhere.accountId)).toBe(1);
    expect(await liveSessions(unbound.accountId)).toBe(1);
  });

  test('the login-email-change clear signs the account out too', async () => {
    const coach = await seedMember();
    await seedSession(coach.accountId);

    const db = jest.requireMock('./db') as { withTransaction: (fn: (c: unknown) => Promise<unknown>) => Promise<unknown> };
    const cleared = await db.withTransaction((tx) =>
      clearMicrosoftIdentityOnLoginEmailChangeTx(tx as Parameters<typeof clearMicrosoftIdentityOnLoginEmailChangeTx>[0], coach.accountId, `new-${coach.email}`),
    );

    expect(cleared).toBe(true);
    expect(await liveSessions(coach.accountId)).toBe(0);
  });

  test('an organization admin cannot unbind outside their organization, an inactive member, the platform owner, or themselves', async () => {
    const admin = await seedMember({ role: 'organization_admin' });
    const actor = { accountId: admin.accountId, role: 'organization_admin', organizationId: ORG_ID };
    const elsewhere = await seedMember({ organizationId: OTHER_ORG_ID });
    const inactive = await seedMember({ membershipActive: false });
    const owner = await seedMember({ role: 'platform_owner', platformOwner: true });
    // A legacy owner row: role says owner, the flag was never set. Sign-in
    // treats it as the owner, so this must too.
    const legacyOwner = await seedMember({ role: 'platform_owner', platformOwner: false });

    expect(await unbind(actor, legacyOwner.accountId)).toBe('THREW:Not found: account');
    expect(await unbind(actor, elsewhere.accountId)).toBe('THREW:Not found: account');
    expect(await unbind(actor, inactive.accountId)).toBe('THREW:Not found: account');
    expect(await unbind(actor, owner.accountId)).toBe('THREW:Not found: account');
    expect(await unbind(actor, 'no-such-account')).toBe('THREW:Not found: account');
    expect(await unbind(actor, admin.accountId)).toBe('THREW:Forbidden: an account cannot unbind its own Microsoft identity');

    for (const target of [elsewhere, inactive, owner, legacyOwner, admin]) {
      expect(await storedIdentity(target.accountId)).toEqual({ microsoft_oid: target.oid, microsoft_tid: TENANT });
      expect(await unbindAuditRows(target.accountId)).toHaveLength(0);
    }
  });

  test('a coach cannot unbind anyone', async () => {
    const coach = await seedMember();
    const other = await seedMember();

    expect(await unbind({ accountId: coach.accountId, role: 'coach', organizationId: ORG_ID }, other.accountId))
      .toBe('THREW:Forbidden: role not allowed');
    expect(await storedIdentity(other.accountId)).toEqual({ microsoft_oid: other.oid, microsoft_tid: TENANT });
  });

  test('the platform owner unbinds an organization admin in any organization, but not themselves', async () => {
    const owner = await seedMember({ role: 'platform_owner', platformOwner: true });
    const actor = { accountId: owner.accountId, role: 'platform_owner', organizationId: ORG_ID };
    const otherAdmin = await seedMember({ role: 'organization_admin', organizationId: OTHER_ORG_ID });

    expect(await unbind(actor, otherAdmin.accountId)).toBe('cleared');
    expect(await storedIdentity(otherAdmin.accountId)).toEqual({ microsoft_oid: null, microsoft_tid: null });
    expect(await unbindAuditRows(otherAdmin.accountId)).toEqual([
      expect.objectContaining({ actor_account_id: owner.accountId, actor_role: 'platform_owner', organization_id: OTHER_ORG_ID }),
    ]);

    expect(await unbind(actor, owner.accountId)).toBe('THREW:Forbidden: an account cannot unbind its own Microsoft identity');
    expect(await storedIdentity(owner.accountId)).toEqual({ microsoft_oid: owner.oid, microsoft_tid: TENANT });

    // "Anyone but self" includes another owner-flagged account.
    const secondOwner = await seedMember({ role: 'platform_owner', platformOwner: true, organizationId: OTHER_ORG_ID });
    expect(await unbind(actor, secondOwner.accountId)).toBe('cleared');
  });

  test('an account that is not bound is reported as such and records nothing', async () => {
    const admin = await seedMember({ role: 'organization_admin' });
    const coach = await seedMember();
    await client.query('update pilot.accounts set microsoft_oid = null, microsoft_tid = null where account_id = $1', [coach.accountId]);

    expect(await unbind({ accountId: admin.accountId, role: 'organization_admin', organizationId: ORG_ID }, coach.accountId))
      .toBe('already-unbound');
    expect(await unbindAuditRows(coach.accountId)).toHaveLength(0);
  });

  test('the bootstrap-key path clears the platform owner\'s own binding, same email, and records it', async () => {
    const owner = await seedMember({ role: 'platform_owner', platformOwner: true });
    await seedSession(owner.accountId);

    const result = await createOrUpdateMicrosoftPlatformOwnerAccount({
      loginEmail: owner.email,
      organizationId: ORG_ID,
      accountIdHint: owner.accountId,
      rebindMicrosoftIdentity: true,
    });

    expect(result.microsoftIdentityCleared).toBe(true);
    expect(await storedIdentity(owner.accountId)).toEqual({ microsoft_oid: null, microsoft_tid: null });
    expect(await unbindAuditRows(owner.accountId)).toEqual([
      expect.objectContaining({
        actor_account_id: null,
        details: expect.objectContaining({ reason: 'owner_bootstrap', previous_microsoft_oid_suffix: owner.oid.slice(-4) }),
      }),
    ]);
    expect(await liveSessions(owner.accountId)).toBe(0);
  });

  test('a bootstrap that also changes the email clears once, reports it, and records one row', async () => {
    const owner = await seedMember({ role: 'platform_owner', platformOwner: true });

    const result = await createOrUpdateMicrosoftPlatformOwnerAccount({
      loginEmail: `new-${owner.email}`,
      organizationId: ORG_ID,
      accountIdHint: owner.accountId,
      rebindMicrosoftIdentity: true,
    });

    expect(result.microsoftIdentityCleared).toBe(true);
    expect(await storedIdentity(owner.accountId)).toEqual({ microsoft_oid: null, microsoft_tid: null });
    expect(await unbindAuditRows(owner.accountId)).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ reason: 'login_email_changed' }) }),
    ]);
  });

  test('the bootstrap path refused for a deleted login keeps the binding', async () => {
    const owner = await seedMember({ role: 'platform_owner', platformOwner: true });
    await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [owner.accountId]);

    await expect(createOrUpdateMicrosoftPlatformOwnerAccount({
      loginEmail: owner.email,
      organizationId: ORG_ID,
      accountIdHint: owner.accountId,
      rebindMicrosoftIdentity: true,
    })).rejects.toThrow();

    expect(await storedIdentity(owner.accountId)).toEqual({ microsoft_oid: owner.oid, microsoft_tid: TENANT });
    expect(await unbindAuditRows(owner.accountId)).toHaveLength(0);
  });
});
