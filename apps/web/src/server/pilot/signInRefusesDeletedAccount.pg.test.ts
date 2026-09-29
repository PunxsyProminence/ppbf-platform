// Real PostgreSQL proof that sign-in refuses any account marked deleted
// (OD-2026-09-29-003 Q9, Jason "all recommended": A, one central rule; the
// rule is src/server/pilot/deletedAccountSignIn.ts).
//
// WHAT IT PROVES, PATH BY PATH, WITH THE REAL FUNCTIONS
//
// Every account below is in the state an admin path can leave a deleted
// person in: deleted_at set, and active_flag true, an active membership, a
// valid credential. Deletion itself clears active_flag, so a deleted account
// that is ALSO inactive was already refused before this rule; the case the
// rule exists for is the one an activation code, a PIN reset, a re-invite or
// the platform owner's status route turned back on (docs/DATA_RETENTION.md,
// "Still open").
//
// Each refusal is paired with a positive control on the SAME account with
// deleted_at cleared, so deleted_at is shown to be the only thing deciding.
//
// WHY REAL POSTGRES. The rule is a column read inside SQL strings -- which
// tsc cannot check and a mocked database cannot run -- and the base schema
// does not even have the column: it comes from the data-retention-deletion
// migration, applied here as production applies it.
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

import { NextRequest } from 'next/server';
import { Client } from 'pg';

// Routes db.ts into this suite's embedded database. withTransaction runs the
// callback on the SAME client, so redeemMagicLink's claim and session insert
// are one unit of work here exactly as in production.
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
  isLoopbackPostgresConnectionString: jest.requireActual('./db').isLoopbackPostgresConnectionString,
}));

// The real scrypt, counted: a deleted account must cost the same one PIN
// verification as a wrong PIN (the #1016 timing rule).
jest.mock('./security', () => {
  const actual = jest.requireActual('./security');
  return { ...actual, verifyPin: jest.fn(actual.verifyPin) };
});

import { loginWithAccountIdAndPin, loginWithMicrosoftEmail, resolvePrincipal } from './auth';
import { issueMagicLink } from './magicLink';
import { magicLinkDependencies, redeemMagicLink } from './magicLinkStore';
import { hashPin, hashToken, verifyPin } from './security';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-signin-deleted-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_signin_deleted';
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // pilot.board_seats: PIN sign-in and resolvePrincipal ask it about every account.
  'pilot_slice_postgres_board_seats_migration.sql',
  // pilot.magic_link_tokens.
  'pilot_slice_postgres_magic_link_migration.sql',
  // pilot.accounts.deleted_at.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
];

const ORG_ID = 'org-sird';
const PIN = '481902';

const PREFLIGHT_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-deletion-preflight.mjs');
const PREFLIGHT_DB_NAME = 'ppbf_test_signin_deleted_preflight';

// ts-jest downlevels a plain dynamic import into require(), which cannot load
// an ESM-only .mjs file. Hiding the call inside `new Function` keeps a real
// dynamic import in the emitted code. Same trick the other .pg suites use.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

interface DeletedAccess {
  refusedAccountsByRole: Array<{ role: string; count: number }>;
  refusedAccounts: number;
  refusedSessions: number;
  athletesExposed: number;
}

const mockVerifyPin = verifyPin as jest.MockedFunction<typeof verifyPin>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let warn: jest.SpyInstance;
const previousAppOrigin = process.env.PPBF_APP_ORIGIN;

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

function requestWithSession(token: string): NextRequest {
  // 'ppbf_pilot_session' is PILOT_SESSION_COOKIE, hardcoded as the other .pg
  // suites do.
  return new NextRequest('http://localhost/api/pilot/whatever', {
    headers: { cookie: `ppbf_pilot_session=${token}` },
  });
}

/** An account in the state an admin path can leave a deleted person in. */
async function seedAccount(input: {
  accountId: string;
  role: 'athlete' | 'coach' | 'parent';
  authProvider: 'ppbf_local' | 'microsoft' | 'magic_link';
  deleted: boolean;
  loginEmail?: string;
  pinHash?: string;
  athleteId?: string;
}): Promise<void> {
  // deleted_at is written by the insert itself. The parent-deletion cascade
  // is an UPDATE trigger that acts only when deleted_at goes from null to set,
  // so it never acts in this suite, and no guardian links exist for it to
  // follow. No pilot.athletes row: nothing on these paths reads one.
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email,
       athlete_id, pin_hash, active_flag, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, true, case when $8::boolean then now() else null end)`,
    [
      input.accountId,
      input.role,
      ORG_ID,
      input.authProvider,
      input.loginEmail ?? null,
      input.athleteId ?? null,
      input.pinHash ?? null,
      input.deleted,
    ],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)`,
    [input.accountId, ORG_ID, input.role],
  );
}

async function setDeleted(accountId: string, deleted: boolean): Promise<void> {
  await client.query(
    `update pilot.accounts set deleted_at = case when $2::boolean then now() else null end where account_id = $1`,
    [accountId, deleted],
  );
}

async function sessionRows(accountId: string): Promise<Array<{ revoked_at: Date | null }>> {
  return (await client.query<{ revoked_at: Date | null }>(
    'select revoked_at from pilot.session_tokens where account_id = $1',
    [accountId],
  )).rows;
}

function loggedReasons(): unknown[] {
  return warn.mock.calls
    .filter(([message]) => message === 'pilot-auth login rejected')
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
     values ($1, $1, 'active')`,
    [ORG_ID],
  );
  activeClient = client;

  // magicLinkDependencies refuses to build a link without an origin.
  process.env.PPBF_APP_ORIGIN = 'https://app.ppbf.test';
});

afterAll(async () => {
  activeClient = null;
  if (previousAppOrigin === undefined) delete process.env.PPBF_APP_ORIGIN;
  else process.env.PPBF_APP_ORIGIN = previousAppOrigin;
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
  mockVerifyPin.mockClear();
});

afterEach(() => {
  warn.mockRestore();
});

describe('PIN sign-in', () => {
  test('an account marked deleted, active, with the right PIN cannot sign in; with deleted_at cleared it can', async () => {
    await seedAccount({
      accountId: 'acct-ath-pin',
      role: 'athlete',
      authProvider: 'ppbf_local',
      athleteId: 'ATH-SIRD-1',
      pinHash: await hashPin(PIN),
      deleted: true,
    });

    const refused = await loginWithAccountIdAndPin('acct-ath-pin', PIN);

    expect(refused).toBeNull();
    expect(loggedReasons()).toEqual(['deleted_account']);
    // One scrypt, against the account's own hash -- no faster than a wrong PIN.
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(await sessionRows('acct-ath-pin')).toEqual([]);

    // Positive control: the same account, the same PIN, deleted_at cleared.
    await setDeleted('acct-ath-pin', false);
    const admitted = await loginWithAccountIdAndPin('acct-ath-pin', PIN);

    expect(admitted?.principal.accountId).toBe('acct-ath-pin');
    expect(await sessionRows('acct-ath-pin')).toHaveLength(1);
  });
});

describe('an existing session', () => {
  test('resolves to nobody once its account is marked deleted, and to the person again once cleared', async () => {
    await seedAccount({
      accountId: 'acct-ath-session',
      role: 'athlete',
      authProvider: 'ppbf_local',
      athleteId: 'ATH-SIRD-2',
      pinHash: await hashPin(PIN),
      deleted: false,
    });
    const login = await loginWithAccountIdAndPin('acct-ath-session', PIN);
    expect(login).not.toBeNull();
    const request = requestWithSession(login!.token);

    // Positive control: a live account's session resolves.
    expect((await resolvePrincipal(request))?.accountId).toBe('acct-ath-session');

    // Marked deleted while everything else stays live: active, a member, the
    // session unrevoked and unexpired.
    await setDeleted('acct-ath-session', true);
    expect(await resolvePrincipal(request)).toBeNull();

    // Not revoked (an inactive account's session is not revoked here either),
    // so clearing deleted_at alone brings it back -- deleted_at is what decided.
    expect(await sessionRows('acct-ath-session')).toEqual([{ revoked_at: null }]);
    await setDeleted('acct-ath-session', false);
    expect((await resolvePrincipal(request))?.accountId).toBe('acct-ath-session');
  });
});

describe('Microsoft sign-in', () => {
  test('an account marked deleted, active, cannot sign in; with deleted_at cleared it can', async () => {
    await seedAccount({
      accountId: 'acct-coach-ms',
      role: 'coach',
      authProvider: 'microsoft',
      loginEmail: 'coach.ms@sird.test',
      deleted: true,
    });

    expect(await loginWithMicrosoftEmail('coach.ms@sird.test')).toBeNull();
    expect(await sessionRows('acct-coach-ms')).toEqual([]);

    await setDeleted('acct-coach-ms', false);
    const admitted = await loginWithMicrosoftEmail('coach.ms@sird.test');

    expect(admitted?.principal.accountId).toBe('acct-coach-ms');
    expect((await resolvePrincipal(requestWithSession(admitted!.token)))?.accountId).toBe('acct-coach-ms');
  });
});

describe('magic link', () => {
  function capturingDependencies(sent: string[]) {
    return {
      ...magicLinkDependencies(),
      sendMail: async (message: { to: string }) => {
        sent.push(message.to);
      },
    };
  }

  async function storedLinkCount(accountId: string): Promise<number> {
    return (await client.query('select 1 from pilot.magic_link_tokens where account_id = $1', [accountId])).rowCount ?? 0;
  }

  test('a deleted guardian asking for a link is sent nothing and stored nothing; with deleted_at cleared, one is sent', async () => {
    await seedAccount({
      accountId: 'acct-parent-issue',
      role: 'parent',
      authProvider: 'magic_link',
      loginEmail: 'parent.issue@sird.test',
      deleted: true,
    });
    const sent: string[] = [];

    await issueMagicLink('parent.issue@sird.test', capturingDependencies(sent));

    expect(sent).toEqual([]);
    expect(await storedLinkCount('acct-parent-issue')).toBe(0);

    await setDeleted('acct-parent-issue', false);
    await issueMagicLink('parent.issue@sird.test', capturingDependencies(sent));

    expect(sent).toEqual(['parent.issue@sird.test']);
    expect(await storedLinkCount('acct-parent-issue')).toBe(1);
  });

  test('a link held by a deleted guardian issues no session and is not used up; with deleted_at cleared it signs in', async () => {
    await seedAccount({
      accountId: 'acct-parent-redeem',
      role: 'parent',
      authProvider: 'magic_link',
      loginEmail: 'parent.redeem@sird.test',
      deleted: true,
    });
    // A link issued before the deletion, still inside its 15 minutes.
    const linkToken = 'link-token-parent-redeem';
    await client.query(
      `insert into pilot.magic_link_tokens (token_hash, account_id, organization_id, sent_to_email, expires_at)
       values ($1, $2, $3, $4, now() + interval '15 minutes')`,
      [hashToken(linkToken), 'acct-parent-redeem', ORG_ID, 'parent.redeem@sird.test'],
    );

    const refused = await redeemMagicLink(linkToken);

    expect(refused).toEqual({ ok: false, reason: 'ACCOUNT_INACTIVE' });
    expect(await sessionRows('acct-parent-redeem')).toEqual([]);
    const token = await client.query<{ consumed_at: Date | null }>(
      'select consumed_at from pilot.magic_link_tokens where token_hash = $1',
      [hashToken(linkToken)],
    );
    expect(token.rows[0].consumed_at).toBeNull();

    await setDeleted('acct-parent-redeem', false);
    const admitted = await redeemMagicLink(linkToken);

    expect(admitted.ok).toBe(true);
    expect((await resolvePrincipal(requestWithSession(admitted.session!.token)))?.accountId)
      .toBe('acct-parent-redeem');
  });
});

describe('the deletion preflight check (scripts/pilot-check-deletion-preflight.mjs)', () => {
  // Before this rule the check counted an account marked deleted but flagged
  // active, and any session it holds, as "a real person who can still get in"
  // and exited 1. Under the rule neither is access: they are reported as
  // refused and do not fail the check. A deleted athlete whose own login is
  // NOT marked deleted still can sign in, and still fails it.
  //
  // Its own database: the counts are over whole tables, and the sign-in cases
  // above leave rows behind.
  let preflightDb: Client;
  let countDeletedAccess: (db: Client) => Promise<DeletedAccess>;
  let deletionPreflightExitCode: (access: DeletedAccess) => number;

  beforeAll(async () => {
    const preflight = await nativeDynamicImport(pathToFileURL(PREFLIGHT_SCRIPT_PATH).href);
    countDeletedAccess = preflight.countDeletedAccess as typeof countDeletedAccess;
    deletionPreflightExitCode = preflight.deletionPreflightExitCode as typeof deletionPreflightExitCode;

    const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
    await adminClient.connect();
    await adminClient.query(`drop database if exists ${PREFLIGHT_DB_NAME}`);
    await adminClient.query(`create database ${PREFLIGHT_DB_NAME}`);
    await adminClient.end();

    preflightDb = new Client({ connectionString: connectionStringFor(PREFLIGHT_DB_NAME) });
    await preflightDb.connect();
    for (const file of MIGRATIONS) {
      await preflightDb.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
    }
    await preflightDb.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active')`,
      [ORG_ID],
    );
  });

  afterAll(async () => {
    await preflightDb?.end().catch(() => {});
  });

  test('a withdrawn athlete\'s login left active is refused, not exposure, until its deleted_at is cleared', async () => {
    // pilot.athletes.coach_id references an account.
    await preflightDb.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
       values ('pf-coach', 'coach', $1, 'microsoft', 'pf.coach@sird.test', true)`,
      [ORG_ID],
    );
    // What the deletion screen leaves (both rows marked deleted), after an
    // admin path set the login active again, with a session still live.
    await preflightDb.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, 'PF-ATH-1', 'Preflight Athlete', '2011-02-10', '119', 'withdrawn',
         'none', false, 'pf-coach', now(), now(), now())`,
      [ORG_ID],
    );
    await preflightDb.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, active_flag, deleted_at)
       values ('pf-ath-login', 'athlete', $1, 'ppbf_local', 'PF-ATH-1', true, now())`,
      [ORG_ID],
    );
    await preflightDb.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at)
       values ('pf-session', 'pf-ath-login', $1, now() + interval '1 hour')`,
      [ORG_ID],
    );

    const refused = await countDeletedAccess(preflightDb);

    expect(refused).toEqual({
      refusedAccountsByRole: [{ role: 'athlete', count: 1 }],
      refusedAccounts: 1,
      refusedSessions: 1,
      athletesExposed: 0,
    });
    expect(deletionPreflightExitCode(refused)).toBe(0);

    // The same login, deleted_at cleared while the athlete row stays deleted:
    // sign-in now admits it, so it is exposure and the check fails.
    await preflightDb.query(`update pilot.accounts set deleted_at = null where account_id = 'pf-ath-login'`);

    const exposed = await countDeletedAccess(preflightDb);

    expect(exposed).toEqual({
      refusedAccountsByRole: [],
      refusedAccounts: 0,
      refusedSessions: 0,
      athletesExposed: 1,
    });
    expect(deletionPreflightExitCode(exposed)).toBe(1);
  });
});
