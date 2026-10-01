// Real PostgreSQL-backed test: an admin acting on a login marked deleted is
// refused, and the login is left exactly as deletion left it.
//
// Owner decision (docs/current/OWNER_DECISIONS.md): OD-2026-09-30-004 e2, Jason
// chose A -- refuse with a clear message, like intake's 409. Before it, a new
// activation code, a PIN reset, a staff re-invite and the platform owner's
// status and membership routes each succeeded on a deleted login and left it
// shown as active, with a PIN or a code, while sign-in refused it and nothing
// said why. The same rule here covers: creating a login for a withdrawn
// athlete, linking a guardian to one, assigning or transferring the gym's admin
// seat or master SHADOW access to a deleted login, and redeeming a code that
// belongs to one.
//
// Real Postgres because each refusal lives in the write statement's own where
// clause, and a mocked client answers whatever it is told. Every case reads the
// row back and compares it with the row before.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-deleted-login-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_deleted_login_actions';

const ORG = 'org-deleted-login';
const OTHER_ORG = 'org-deleted-login-other';
// The acting admin; never deleted, never touched by a test.
const COACH_ID = 'acct-deleted-login-admin';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let staffProvisioning: typeof import('./staffProvisioning');
let auth: typeof import('./auth');
let activation: typeof import('./activation');
let db: typeof import('./db');

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


async function insertAthlete(athleteId: string, options: { deleted?: boolean } = {}): Promise<void> {
  await db.query(
    `insert into pilot.athletes (
       organization_id, athlete_id, full_name, dob, weight_class, gym_status,
       emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at
     ) values ($1, $2, $2, '2012-05-01', 'youth-60kg', 'active', 'n/a', true, $3, now(), now(),
               case when $4 then now() else null end)`,
    [ORG, athleteId, COACH_ID, options.deleted ?? false],
  );
}

/**
 * A login, with its membership. `deleted` writes the state deletion leaves:
 * deleted_at set and both active flags false.
 */
async function insertAccount(
  accountId: string,
  role: string,
  options: {
    organizationId?: string;
    athleteId?: string;
    email?: string;
    deleted?: boolean;
    active?: boolean;
    microsoft?: boolean;
    pinHash?: string | null;
  } = {},
): Promise<void> {
  const organizationId = options.organizationId ?? ORG;
  const deleted = options.deleted ?? false;
  const active = deleted ? false : options.active ?? true;
  await db.query(
    `insert into pilot.accounts
       (account_id, role, organization_id, athlete_id, auth_provider, login_email, pin_hash, active_flag, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9 then now() else null end)`,
    [
      accountId,
      role,
      organizationId,
      options.athleteId ?? null,
      options.microsoft ? 'microsoft' : 'ppbf_local',
      options.email ?? null,
      options.microsoft ? null : options.pinHash === undefined ? 'hash-kept' : options.pinHash,
      active,
      deleted,
    ],
  );
  await db.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, $4)`,
    [accountId, organizationId, role, active],
  );
}

interface AccountRow {
  account_id: string;
  role: string;
  organization_id: string;
  athlete_id: string | null;
  pin_hash: string | null;
  active_flag: boolean;
  deleted: boolean;
}

async function accountRow(accountId: string): Promise<AccountRow | null> {
  return db.queryOne<AccountRow>(
    `select account_id, role, organization_id, athlete_id, pin_hash, active_flag, deleted_at is not null as deleted
     from pilot.accounts where account_id = $1`,
    [accountId],
  );
}

async function membershipActive(accountId: string): Promise<boolean | null> {
  const row = await db.queryOne<{ active_flag: boolean }>(
    'select active_flag from pilot.organization_memberships where account_id = $1 and organization_id = $2',
    [accountId, ORG],
  );
  return row ? row.active_flag : null;
}

async function tokenCount(accountId: string): Promise<number> {
  const rows = await db.query('select 1 from pilot.account_activation_tokens where account_id = $1', [accountId]);
  return rows.length;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  // DATA_DIR is deliberately NOT pre-created: initdb refuses to chmod a
  // directory it did not make itself.

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
    const timeout = setTimeout(() => {
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 150_000);

    const rl = readline.createInterface({ input: serverProcess.stdout });
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

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  // The base schema, plus the retention migration for pilot.accounts.deleted_at
  // and pilot.athletes.deleted_at. Production applies it through
  // apply-migrations.yml's data-retention-deletion entry.
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  // pilot.account_activation_tokens.
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_onboarding_migration.sql'), 'utf8'),
  );
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_data_retention_deletion_migration.sql'), 'utf8'),
  );
  await migrateClient.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active'), ($2, $2, 'active') on conflict do nothing`,
    [ORG, OTHER_ORG],
  );
  await migrateClient.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
     values ($1, 'organization_admin', $2, 'microsoft', 'deleted-login-admin@example.org', true)`,
    [COACH_ID, ORG],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  staffProvisioning = await import('./staffProvisioning');
  auth = await import('./auth');
  activation = await import('./activation');
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


afterEach(async () => {
  jest.restoreAllMocks();
  await db.query('delete from pilot.account_activation_tokens');
  await db.query('delete from pilot.session_tokens');
  await db.query('delete from pilot.guardian_links');
  await db.query('delete from pilot.parents');
  await db.query('delete from pilot.organization_memberships where account_id <> $1', [COACH_ID]);
  await db.query('delete from pilot.accounts where account_id <> $1', [COACH_ID]);
  await db.query('delete from pilot.athletes');
});

const DELETED_MESSAGE = (login: string) =>
  `Conflict: the login "${login}" was deleted. A deleted login cannot sign in and nothing here changes it; `
  + 'a deletion is not undone from the app. A returning person needs a new login: a new account_id, or for a '
  + 'staff or guardian login a different email address, because the deleted login keeps its own.';

const ISSUER = { issuedByAccountId: COACH_ID, issuedByRole: 'organization_admin' as const };

describe('a new activation code', () => {
  test('is refused 409 for a deleted athlete login, by name, and no code is written', async () => {
    await insertAthlete('ATH-1', { deleted: true });
    await insertAccount('acct-deleted', 'athlete', { athleteId: 'ATH-1', deleted: true });

    const refusal = activation.issueActivationCode({ accountId: 'acct-deleted', organizationId: ORG, ...ISSUER });
    await expect(refusal).rejects.toMatchObject({ status: 409, code: 'DELETED_LOGIN' });
    await expect(refusal).rejects.toThrow(DELETED_MESSAGE('acct-deleted'));
    expect(await tokenCount('acct-deleted')).toBe(0);
  });

  test('a deleted login in another organization gets the same answer as one that does not exist', async () => {
    await insertAccount('acct-other-org-deleted', 'athlete', { organizationId: OTHER_ORG, deleted: true });

    await expect(
      activation.issueActivationCode({ accountId: 'acct-other-org-deleted', organizationId: ORG, ...ISSUER }),
    ).rejects.toThrow('Not found: no pending athlete account matches that identifier');
    await expect(
      activation.issueActivationCode({ accountId: 'acct-no-such', organizationId: ORG, ...ISSUER }),
    ).rejects.toThrow('Not found: no pending athlete account matches that identifier');
  });

  test('is still issued for a login that is not deleted', async () => {
    await insertAthlete('ATH-1');
    await insertAccount('acct-live', 'athlete', { athleteId: 'ATH-1', active: false });

    const issued = await activation.issueActivationCode({ accountId: 'acct-live', organizationId: ORG, ...ISSUER });
    expect(issued.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(await tokenCount('acct-live')).toBe(1);
  });
});

describe('a PIN reset', () => {
  test('is refused 409 for a deleted athlete login and leaves it exactly as it was', async () => {
    await insertAthlete('ATH-1', { deleted: true });
    await insertAccount('acct-deleted', 'athlete', { athleteId: 'ATH-1', deleted: true });
    const before = await accountRow('acct-deleted');

    await expect(
      activation.provisionAthleteActivation({ accountId: 'acct-deleted', organizationId: ORG, ...ISSUER, mode: 'reset' }),
    ).rejects.toMatchObject({ status: 409, code: 'DELETED_LOGIN' });

    expect(await accountRow('acct-deleted')).toEqual(before);
    expect(before?.pin_hash).toBe('hash-kept');
    expect(await tokenCount('acct-deleted')).toBe(0);
  });

  test('still resets a login that is not deleted', async () => {
    await insertAthlete('ATH-1');
    await insertAccount('acct-live', 'athlete', { athleteId: 'ATH-1' });

    await activation.provisionAthleteActivation({ accountId: 'acct-live', organizationId: ORG, ...ISSUER, mode: 'reset' });
    expect(await accountRow('acct-live')).toMatchObject({ pin_hash: null, active_flag: false });
    expect(await tokenCount('acct-live')).toBe(1);
  });
});

describe('creating an athlete login', () => {
  // Whether an athlete RECORD was withdrawn is not this change's rule and is
  // not read: what is refused is a record a deleted LOGIN still holds. The
  // two outcomes for a withdrawn record are stated here so neither is implied.
  test('a withdrawn athlete record is not itself refused: its deleted login refuses it, and with no login one is created as before', async () => {
    // Withdrawn the way deletion leaves it: the record and its login both marked.
    await insertAthlete('ATH-WITHDRAWN', { deleted: true });
    await insertAccount('acct-withdrawn-old', 'athlete', { athleteId: 'ATH-WITHDRAWN', deleted: true });
    await expect(
      activation.provisionAthleteActivation({
        accountId: 'acct-new', athleteId: 'ATH-WITHDRAWN', organizationId: ORG, ...ISSUER, mode: 'create',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'ATHLETE_RECORD_HELD_BY_DELETED_LOGIN' });
    expect(await accountRow('acct-new')).toBeNull();

    // A withdrawn record that never had a login: unchanged from before.
    await insertAthlete('ATH-WITHDRAWN-NO-LOGIN', { deleted: true });
    await activation.provisionAthleteActivation({
      accountId: 'acct-new-2', athleteId: 'ATH-WITHDRAWN-NO-LOGIN', organizationId: ORG, ...ISSUER, mode: 'create',
    });
    expect(await accountRow('acct-new-2')).toMatchObject({ athlete_id: 'ATH-WITHDRAWN-NO-LOGIN', deleted: false });
  });

  test('is refused 409 when a deleted login still holds the record, without naming that login', async () => {
    await insertAthlete('ATH-HELD');
    await insertAccount('acct-old-deleted', 'athlete', { athleteId: 'ATH-HELD', deleted: true });

    const refusal = activation.provisionAthleteActivation({
      accountId: 'acct-new', athleteId: 'ATH-HELD', organizationId: ORG, ...ISSUER, mode: 'create',
    });
    await expect(refusal).rejects.toMatchObject({ status: 409, code: 'ATHLETE_RECORD_HELD_BY_DELETED_LOGIN' });
    await expect(refusal).rejects.not.toThrow(/acct-old-deleted/);
    expect(await accountRow('acct-new')).toBeNull();
  });

  test('naming a deleted login as the new account_id is refused 409 as deleted', async () => {
    await insertAthlete('ATH-NEW');
    await insertAccount('acct-deleted', 'athlete', { deleted: true });

    await expect(
      activation.provisionAthleteActivation({
        accountId: 'acct-deleted', athleteId: 'ATH-NEW', organizationId: ORG, ...ISSUER, mode: 'create',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'DELETED_LOGIN' });
  });

  test('an athlete with a live login, and an enrolled athlete with none, behave as before', async () => {
    await insertAthlete('ATH-HAS');
    await insertAccount('acct-has', 'athlete', { athleteId: 'ATH-HAS' });
    await insertAthlete('ATH-NONE');

    await expect(
      activation.provisionAthleteActivation({
        accountId: 'acct-second', athleteId: 'ATH-HAS', organizationId: ORG, ...ISSUER, mode: 'create',
      }),
    ).rejects.toThrow('Athlete is already linked to another account');

    await activation.provisionAthleteActivation({
      accountId: 'acct-first', athleteId: 'ATH-NONE', organizationId: ORG, ...ISSUER, mode: 'create',
    });
    expect(await accountRow('acct-first')).toMatchObject({ athlete_id: 'ATH-NONE', active_flag: false, deleted: false });
  });
});

describe('redeeming a code that belongs to a deleted login', () => {
  test('answers the generic failure and writes nothing: not active, no PIN, no membership, code not consumed', async () => {
    await insertAthlete('ATH-1');
    await insertAccount('acct-pending', 'athlete', { athleteId: 'ATH-1', active: false, pinHash: null });
    const issued = await activation.issueActivationCode({ accountId: 'acct-pending', organizationId: ORG, ...ISSUER });
    // Deleted while the code is still live (deletion normally supersedes the
    // code too; this is the path where it did not).
    await db.query('update pilot.accounts set deleted_at = now() where account_id = $1', ['acct-pending']);

    await expect(activation.redeemActivationCode(issued.code, '482913')).rejects.toThrow(
      'Unauthorized: activation code is invalid, already used, or expired',
    );

    expect(await accountRow('acct-pending')).toMatchObject({ active_flag: false, pin_hash: null, deleted: true });
    expect(await membershipActive('acct-pending')).not.toBe(true);
    const token = await db.queryOne<{ consumed: boolean }>(
      'select consumed_at is not null as consumed from pilot.account_activation_tokens where account_id = $1',
      ['acct-pending'],
    );
    expect(token?.consumed).toBe(false);
  });

  test('an unknown code gets the same generic failure', async () => {
    await expect(activation.redeemActivationCode('ABCD-2345-EFGH', '482913')).rejects.toThrow(
      'Unauthorized: activation code is invalid, already used, or expired',
    );
  });

  test('a code for a login that is not deleted still redeems', async () => {
    await insertAthlete('ATH-1');
    await insertAccount('acct-pending', 'athlete', { athleteId: 'ATH-1', active: false, pinHash: null });
    const issued = await activation.issueActivationCode({ accountId: 'acct-pending', organizationId: ORG, ...ISSUER });

    const redeemed = await activation.redeemActivationCode(issued.code, '482913');
    expect(redeemed.accountId).toBe('acct-pending');
    expect((await accountRow('acct-pending'))?.active_flag).toBe(true);
    expect(await membershipActive('acct-pending')).toBe(true);
  });
});

// LOCK ORDER: the account row, then its codes -- for deletion, a PIN reset,
// issuance and redemption alike. These run two or three real connections
// against each other. The "deletion" here is deletion's own two statements for
// an athlete login, replayed in an open transaction in the order
// deleteAthleteRecord runs them (dataDeletion.ts: the account update, then
// supersedeOutstandingActivationCodes); deleteAthleteRecord itself is not
// run, because it needs the full schema.
describe('issuance, redemption and deletion take the account row before its codes', () => {
  const ACCOUNT = 'acct-racing';

  /**
   * Resolves once some backend is WAITING ON A LOCK while running a statement
   * that contains `fragment`, read from pg_stat_activity. This is what makes
   * these tests fail without the fix rather than pass by luck: "it had not
   * finished after half a second" is also true of a slow machine, while "it
   * is blocked on a lock" is only true if it took the lock order under test.
   * Throws after ten seconds if nothing ever waits.
   */
  async function waitUntilBlocked(fragment: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await db.query(
        `select 1 from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and position($1 in query) > 0`,
        [fragment],
      );
      if (waiting.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`No backend ever waited on a lock while running: ${fragment}`);
  }

  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    return client;
  }

  const DELETE_ACCOUNT_SQL =
    'update pilot.accounts set deleted_at = now(), active_flag = false, updated_at = now() where account_id = $1';
  const SUPERSEDE_SQL =
    `update pilot.account_activation_tokens set superseded_at = now()
     where account_id = $1 and consumed_at is null and superseded_at is null`;

  async function liveCodes(): Promise<number> {
    const rows = await db.query(
      `select 1 from pilot.account_activation_tokens
       where account_id = $1 and consumed_at is null and superseded_at is null`,
      [ACCOUNT],
    );
    return rows.length;
  }

  /** A promise's outcome, and whether it has one yet. */
  function watch<T>(promise: Promise<T>) {
    const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
    const done = promise.then(
      (value) => { state.settled = true; state.value = value; },
      (error: unknown) => { state.settled = true; state.error = error; },
    );
    return { state, done };
  }

  beforeEach(async () => {
    await insertAthlete('ATH-RACING');
    await insertAccount(ACCOUNT, 'athlete', { athleteId: 'ATH-RACING', active: false, pinHash: null });
  });

  test('deletion first, not yet committed: issuance waits, then is refused, and no live code is left', async () => {
    const deletion = await connect();
    try {
      await deletion.query('begin');
      await deletion.query(DELETE_ACCOUNT_SQL, [ACCOUNT]);
      await deletion.query(SUPERSEDE_SQL, [ACCOUNT]);

      const issuing = watch(activation.issueActivationCode({ accountId: ACCOUNT, organizationId: ORG, ...ISSUER }));
      // Issuance is blocked on the account row the deletion holds. Without
      // the account lock it never waits: it reads the old row and returns a
      // code, and this times out.
      await waitUntilBlocked('from pilot.accounts a');
      expect(issuing.state.settled).toBe(false);

      await deletion.query('commit');
      await issuing.done;

      expect(issuing.state.value).toBeUndefined();
      expect(issuing.state.error).toMatchObject({ status: 409, code: 'DELETED_LOGIN' });
      expect(await liveCodes()).toBe(0);
    } finally {
      await deletion.query('rollback').catch(() => undefined);
      await deletion.end();
    }
  });

  test('issuance first, not yet committed: deletion waits, then supersedes the code issuance wrote', async () => {
    const gate = await connect();
    const deletion = await connect();
    try {
      // Holds issuance open after it has taken the account lock: its first
      // write to the codes table waits on this.
      await gate.query('begin');
      await gate.query('lock table pilot.account_activation_tokens in exclusive mode');

      const issuing = watch(activation.issueActivationCode({ accountId: ACCOUNT, organizationId: ORG, ...ISSUER }));
      // Issuance has the account row and is held at its first write to the codes.
      await waitUntilBlocked('update pilot.account_activation_tokens');
      expect(issuing.state.settled).toBe(false);

      await deletion.query('begin');
      const deleting = watch(deletion.query(DELETE_ACCOUNT_SQL, [ACCOUNT]));
      // The deletion cannot mark the login deleted while issuance holds it.
      await waitUntilBlocked('update pilot.accounts set deleted_at');
      expect(deleting.state.settled).toBe(false);

      await gate.query('commit');
      await issuing.done;
      expect(issuing.state.error).toBeUndefined();
      expect(issuing.state.value?.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

      await deleting.done;
      expect(deleting.state.error).toBeUndefined();
      await deletion.query(SUPERSEDE_SQL, [ACCOUNT]);
      await deletion.query('commit');

      expect((await accountRow(ACCOUNT))?.deleted).toBe(true);
      expect(await liveCodes()).toBe(0);
    } finally {
      await gate.query('rollback').catch(() => undefined);
      await deletion.query('rollback').catch(() => undefined);
      await gate.end();
      await deletion.end();
    }
  });

  test('a redemption waiting for the account row does not hold the code row', async () => {
    const issued = await activation.issueActivationCode({ accountId: ACCOUNT, organizationId: ORG, ...ISSUER });
    const holder = await connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from pilot.accounts where account_id = $1 for update', [ACCOUNT]);

      const redeeming = watch(activation.redeemActivationCode(issued.code, '482913'));
      // The redemption is blocked on the account row, its first lock.
      await waitUntilBlocked('select 1 from pilot.accounts where account_id');
      expect(redeeming.state.settled).toBe(false);

      // Account first, then code. The old order locked the code and then
      // waited for the account, and this statement would fail (55P03).
      await expect(
        holder.query('select 1 from pilot.account_activation_tokens where account_id = $1 for update nowait', [ACCOUNT]),
      ).resolves.toMatchObject({ rowCount: 1 });

      await holder.query('commit');
      await redeeming.done;
      expect(redeeming.state.error).toBeUndefined();
      expect((await accountRow(ACCOUNT))?.active_flag).toBe(true);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });

  test('two redemptions of one code at once: exactly one succeeds', async () => {
    const issued = await activation.issueActivationCode({ accountId: ACCOUNT, organizationId: ORG, ...ISSUER });

    const outcomes = await Promise.allSettled([
      activation.redeemActivationCode(issued.code, '482913'),
      activation.redeemActivationCode(issued.code, '482913'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toContain('Unauthorized: activation code is invalid, already used, or expired');
    expect(await liveCodes()).toBe(0);
  });
});

describe('a staff or guardian re-invite', () => {
  const EMAIL = 'gone.person@example.org';

  test.each([['coach' as const, 'coach' as const], ['parent' as const, 'parent' as const], ['parent' as const, 'coach' as const]])(
    'a deleted %s login re-invited as %s is refused 409 and stays deleted and inactive',
    async (existingRole, invitedRole) => {
      await insertAccount('acct-gone', existingRole, { email: EMAIL, deleted: true, microsoft: true });
      const before = await accountRow('acct-gone');

      const refusal = staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: EMAIL, organizationId: ORG, role: invitedRole,
      });
      await expect(refusal).rejects.toMatchObject({ status: 409, code: 'DELETED_LOGIN' });
      await expect(refusal).rejects.toThrow(DELETED_MESSAGE(EMAIL));

      expect(await accountRow('acct-gone')).toEqual(before);
      expect(before).toMatchObject({ active_flag: false, deleted: true });
    },
  );

  test('a login deleted between provisioning\'s read and its write is refused and not reactivated', async () => {
    await insertAccount('acct-coach', 'coach', { email: EMAIL, microsoft: true });

    const realQueryOne = db.queryOne;
    jest.spyOn(db, 'queryOne').mockImplementation((async (sql: string, params?: unknown[]) => {
      const row = await realQueryOne(sql, params);
      if (sql.includes('lower(login_email) = $1')) {
        // The read saw a live login; it is deleted now, as deletion leaves it.
        await db.query(
          'update pilot.accounts set deleted_at = now(), active_flag = false where account_id = $1',
          ['acct-coach'],
        );
        await db.query('update pilot.organization_memberships set active_flag = false where account_id = $1', [
          'acct-coach',
        ]);
      }
      return row;
    }) as typeof db.queryOne);

    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({ loginEmail: EMAIL, organizationId: ORG, role: 'coach' }),
    ).rejects.toMatchObject({ status: 409, code: 'DELETED_LOGIN' });

    expect(await accountRow('acct-coach')).toMatchObject({ active_flag: false, deleted: true, role: 'coach' });
    expect(await membershipActive('acct-coach')).toBe(false);
  });

  test('intake: a guardian login re-roled between the read and the write is refused and keeps its new role', async () => {
    await insertAccount('acct-parent', 'parent', { email: EMAIL, microsoft: true });

    const realQueryOne = db.queryOne;
    jest.spyOn(db, 'queryOne').mockImplementation((async (sql: string, params?: unknown[]) => {
      const row = await realQueryOne(sql, params);
      if (sql.includes('lower(login_email) = $1')) {
        await db.query("update pilot.accounts set role = 'coach' where account_id = $1", ['acct-parent']);
      }
      return row;
    }) as typeof db.queryOne);

    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: EMAIL, organizationId: ORG, role: 'parent', accountIdHint: 'acct-parent',
        refuseRoleChange: true, refuseDeactivatedLogin: true,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'EXISTING_ACCOUNT_ROLE_CONFLICT' });

    expect((await accountRow('acct-parent'))?.role).toBe('coach');
  });

  // Two cases, because each proves a different line. Moved and still live:
  // only the write's own organization condition stops the invite pulling the
  // login back into this gym. Moved and deleted there: the reason lookup is
  // scoped, so this gym is not told the login was deleted.
  test.each([
    ['still live there', false],
    ['deleted there', true],
  ])('a login moved to another organization between the read and the write (%s) is refused, generically, and stays there', async (_label, deletedThere) => {
    await insertAccount('acct-coach', 'coach', { email: EMAIL, microsoft: true });

    const realQueryOne = db.queryOne;
    jest.spyOn(db, 'queryOne').mockImplementation((async (sql: string, params?: unknown[]) => {
      const row = await realQueryOne(sql, params);
      if (sql.includes('lower(login_email) = $1')) {
        await db.query(
          `update pilot.accounts
           set organization_id = $2,
               deleted_at = case when $3 then now() else null end,
               active_flag = not $3
           where account_id = $1`,
          ['acct-coach', OTHER_ORG, deletedThere],
        );
      }
      return row;
    }) as typeof db.queryOne);

    const refusal = staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: EMAIL, organizationId: ORG, role: 'staff',
    });
    await expect(refusal).rejects.toThrow('Forbidden: account already exists in another organization');
    await expect(refusal).rejects.not.toMatchObject({ code: 'DELETED_LOGIN' });

    // Not pulled back, not re-roled, and nothing about it changed.
    expect(await accountRow('acct-coach')).toMatchObject({
      organization_id: OTHER_ORG,
      role: 'coach',
      deleted: deletedThere,
      active_flag: !deletedThere,
    });
  });

  test('a re-invite of a deactivated, not deleted, login still reactivates it', async () => {
    await insertAccount('acct-coach', 'coach', { email: EMAIL, microsoft: true, active: false });

    await staffProvisioning.createOrUpdateMicrosoftStaffAccount({ loginEmail: EMAIL, organizationId: ORG, role: 'coach' });
    expect(await accountRow('acct-coach')).toMatchObject({ active_flag: true, deleted: false });
  });
});

describe('the platform owner\'s status and membership routes', () => {
  test.each([true, false])('status %s on a deleted login is refused 409 and changes nothing', async (activeFlag) => {
    await insertAccount('acct-gone', 'coach', { deleted: true, microsoft: true });
    const before = await accountRow('acct-gone');

    await expect(auth.setAccountActiveStatus('acct-gone', ORG, activeFlag)).rejects.toMatchObject({
      status: 409,
      code: 'DELETED_LOGIN',
    });
    expect(await accountRow('acct-gone')).toEqual(before);
    expect(await membershipActive('acct-gone')).toBe(false);
  });

  test('status still changes a login that is not deleted, and a missing one keeps its old answer', async () => {
    await insertAccount('acct-coach', 'coach', { microsoft: true });

    await auth.setAccountActiveStatus('acct-coach', ORG, false);
    expect((await accountRow('acct-coach'))?.active_flag).toBe(false);
    await expect(auth.setAccountActiveStatus('acct-none', ORG, true)).rejects.toThrow(
      'Missing account_id or organization_id',
    );
  });

  test.each([true, false])('membership (active %s) on a deleted login is refused 409 and writes no membership', async (activeFlag) => {
    await insertAccount('acct-gone', 'coach', { deleted: true, microsoft: true });
    const before = await accountRow('acct-gone');

    await expect(
      auth.upsertOrganizationMembership('acct-gone', OTHER_ORG, 'staff', activeFlag),
    ).rejects.toMatchObject({ status: 409, code: 'DELETED_LOGIN' });

    expect(await accountRow('acct-gone')).toEqual(before);
    expect(
      await db.query('select 1 from pilot.organization_memberships where account_id = $1 and organization_id = $2', [
        'acct-gone',
        OTHER_ORG,
      ]),
    ).toHaveLength(0);
  });

  test('membership still writes for a login that is not deleted', async () => {
    await insertAccount('acct-coach', 'coach', { microsoft: true });

    await auth.upsertOrganizationMembership('acct-coach', ORG, 'staff', true);
    expect((await accountRow('acct-coach'))?.role).toBe('staff');
  });
});

describe('privilege to a deleted login', () => {
  test('assign-admin is refused 409 and the login keeps its role', async () => {
    await insertAccount('acct-gone', 'coach', { deleted: true, microsoft: true });

    await expect(auth.promoteAccountToOrganizationAdmin('acct-gone', ORG)).rejects.toMatchObject({
      status: 409,
      code: 'DELETED_LOGIN',
    });
    expect((await accountRow('acct-gone'))?.role).toBe('coach');
  });

  test('transfer-admin to a deleted login is refused 409 and neither side changes', async () => {
    await insertAccount('acct-admin', 'organization_admin', { microsoft: true });
    await insertAccount('acct-gone', 'coach', { deleted: true, microsoft: true });

    await expect(auth.transferOrganizationAdmin('acct-admin', 'acct-gone', ORG, 'coach')).rejects.toMatchObject({
      status: 409,
      code: 'DELETED_LOGIN',
    });
    expect((await accountRow('acct-admin'))?.role).toBe('organization_admin');
    expect(await accountRow('acct-gone')).toMatchObject({ role: 'coach', active_flag: false, deleted: true });
  });

  test('transfer-admin from a deleted login is refused 409 and the target is not promoted', async () => {
    await insertAccount('acct-gone-admin', 'organization_admin', { deleted: true, microsoft: true });
    await insertAccount('acct-coach', 'coach', { microsoft: true });

    await expect(
      auth.transferOrganizationAdmin('acct-gone-admin', 'acct-coach', ORG, 'coach'),
    ).rejects.toMatchObject({ status: 409, code: 'DELETED_LOGIN' });
    expect((await accountRow('acct-coach'))?.role).toBe('coach');
    expect(await accountRow('acct-gone-admin')).toMatchObject({ role: 'organization_admin', active_flag: false });
  });

  test('assign-admin and transfer-admin still work between logins that are not deleted', async () => {
    await insertAccount('acct-admin', 'organization_admin', { microsoft: true });
    await insertAccount('acct-coach', 'coach', { microsoft: true });
    await insertAccount('acct-staff', 'staff', { microsoft: true });

    await auth.transferOrganizationAdmin('acct-admin', 'acct-coach', ORG, 'coach');
    await auth.promoteAccountToOrganizationAdmin('acct-staff', ORG);
    expect((await accountRow('acct-coach'))?.role).toBe('organization_admin');
    expect((await accountRow('acct-admin'))?.role).toBe('coach');
    expect((await accountRow('acct-staff'))?.role).toBe('organization_admin');
  });

  test.each([true, false])('master SHADOW access (%s) on a deleted staff login is refused 409 and not changed', async (granted) => {
    await insertAccount('acct-gone', 'staff', { deleted: true, microsoft: true });

    await expect(auth.setAccountMasterShadowAccess('acct-gone', granted)).rejects.toMatchObject({
      status: 409,
      code: 'DELETED_LOGIN',
    });
    const row = await db.queryOne<{ has_master_shadow_access: boolean }>(
      'select has_master_shadow_access from pilot.accounts where account_id = $1',
      ['acct-gone'],
    );
    expect(row?.has_master_shadow_access).toBe(false);
  });

  test('a deleted parent keeps the one answer a parent always got; a live staff login is still granted', async () => {
    await insertAccount('acct-gone-parent', 'parent', { deleted: true, microsoft: true });
    await insertAccount('acct-staff', 'staff', { microsoft: true });

    await expect(auth.setAccountMasterShadowAccess('acct-gone-parent', true)).rejects.toThrow(
      'Not found: no such account, or its role cannot hold cross-organization access',
    );
    expect((await auth.setAccountMasterShadowAccess('acct-staff', true)).hasMasterShadowAccess).toBe(true);
  });
});
