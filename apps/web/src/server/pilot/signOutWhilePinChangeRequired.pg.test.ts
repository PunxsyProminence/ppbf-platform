// Real PostgreSQL proof that a session which still owes a PIN change can sign
// out -- and is actually signed out afterwards -- while every other refusal
// the sign-out routes made before stays in place.
//
// THE DEFECT. requirePrincipal (http.ts) refuses a session whose account has
// must_change_pin set. Both sign-out routes used it, so an athlete who was
// handed a starting PIN and sent to /change-pin got a 403 from POST
// /api/pilot/auth/logout and /logout-all: the only things they could do were
// choose a PIN or walk away from the shared gym tablet still signed in. The
// routes now read the session through requirePrincipalForSignOut, which skips
// that one stop and nothing else.
//
// WHY REAL POSTGRES. "Signed out" means the token no longer resolves, and that
// is a row in pilot.session_tokens read back through resolvePrincipal's SQL.
// A mocked database would return whatever it was told. Here the REAL route
// handlers run against the REAL auth functions over an embedded Postgres, with
// db.ts routed to it, so each assertion below is about the production path.
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

import { NextRequest } from 'next/server';
import { Client } from 'pg';

// Routes db.ts into this suite's embedded database.
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
  sanitizedSqlState: jest.requireActual('./db').sanitizedSqlState,
}));

import { POST as logoutPost } from '../../../app/api/pilot/auth/logout/route';
import { POST as logoutAllPost } from '../../../app/api/pilot/auth/logout-all/route';
import { GET as profileMeGet } from '../../../app/api/pilot/profile/me/route';
import { GET as deletionRequestGet } from '../../../app/api/pilot/shadow/data/deletion-request/route';
import { resolvePrincipal } from './auth';
import { PILOT_SESSION_COOKIE } from './env';
import { requirePrincipal } from './http';
import { hashToken } from './security';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-signout-pin-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_signout_pin';
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // pilot.board_seats: resolvePrincipal asks it about every account.
  'pilot_slice_postgres_board_seats_migration.sql',
  // pilot.accounts.deleted_at: resolvePrincipal's deleted-account refusal.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
];

const ORG_ID = 'org-sopc';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let warn: jest.SpyInstance;

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

function requestWith(token: string | null, url = 'http://localhost/api/pilot/auth/logout'): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: token === null ? {} : { cookie: `${PILOT_SESSION_COOKIE}=${token}` },
  });
}

let accountCounter = 0;

/** An athlete account in this organization, with the given PIN-change state. */
async function seedAthlete(input: { mustChangePin: boolean; deleted?: boolean }): Promise<string> {
  accountCounter += 1;
  const accountId = `acct-ath-${accountCounter}`;
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id,
       pin_hash, must_change_pin, active_flag, deleted_at)
     values ($1, 'athlete', $2, 'ppbf_local', $3, 'not-a-real-hash', $4, true,
       case when $5::boolean then now() else null end)`,
    [accountId, ORG_ID, `ATH-${accountCounter}`, input.mustChangePin, input.deleted ?? false],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'athlete', true)`,
    [accountId, ORG_ID],
  );
  return accountId;
}

/**
 * A PIN session for the account, exactly the row loginWithAccountIdAndPin
 * writes (auth.ts), minus the scrypt: this suite is about the SESSION's fate,
 * not the credential. Returns the bearer token the browser would hold.
 */
async function mintSession(
  accountId: string,
  state: { expired?: boolean; revoked?: boolean } = {},
): Promise<string> {
  const token = `tok-${accountId}-${Math.random().toString(36).slice(2)}`;
  await client.query(
    `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at, revoked_at, sign_in_method)
     values ($1, $2, $3,
       case when $4::boolean then now() - interval '1 minute' else now() + interval '1 hour' end,
       case when $5::boolean then now() else null end,
       'pin')`,
    [hashToken(token), accountId, ORG_ID, state.expired ?? false, state.revoked ?? false],
  );
  return token;
}

async function revokedAt(token: string): Promise<Date | null> {
  const rows = (await client.query<{ revoked_at: Date | null }>(
    'select revoked_at from pilot.session_tokens where token_hash = $1',
    [hashToken(token)],
  )).rows;
  expect(rows).toHaveLength(1);
  return rows[0].revoked_at;
}

async function auditRows(accountId: string): Promise<Array<{ event_type: string; details: Record<string, unknown> }>> {
  return (await client.query<{ event_type: string; details: Record<string, unknown> }>(
    `select event_type, details from pilot.audit_events
     where actor_account_id = $1 order by audit_id`,
    [accountId],
  )).rows;
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
});

afterEach(() => {
  warn.mockRestore();
});

describe('a session that still owes a PIN change', () => {
  test('is refused by requirePrincipal and by data-serving routes (the condition the defect depended on)', async () => {
    const accountId = await seedAthlete({ mustChangePin: true });
    const token = await mintSession(accountId);

    // The session itself is live and resolves; it is the stop that refuses.
    expect(await resolvePrincipal(requestWith(token))).toMatchObject({ accountId, mustChangePin: true });
    await expect(requirePrincipal(requestWith(token))).rejects.toThrow('Forbidden: PIN change required');

    // Two representative routes built on requirePrincipal, run for real: one
    // reads the caller's own profile, one their own deletion request. Both
    // 403 before touching anything.
    const me = await profileMeGet(requestWith(token, 'http://localhost/api/pilot/profile/me'));
    expect(me.status).toBe(403);
    await expect(me.json()).resolves.toEqual({ error: 'Forbidden: PIN change required before using this account' });
    const deletion = await deletionRequestGet(requestWith(token, 'http://localhost/api/pilot/shadow/data/deletion-request'));
    expect(deletion.status).toBe(403);
  });

  test('can POST /api/pilot/auth/logout, and its token no longer authenticates afterwards', async () => {
    const accountId = await seedAthlete({ mustChangePin: true });
    const token = await mintSession(accountId);
    expect(await revokedAt(token)).toBeNull();

    const response = await logoutPost(requestWith(token));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const cookie = response.cookies.get(PILOT_SESSION_COOKIE);
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);

    // Signed out: the row is revoked and the token resolves to nobody, so the
    // next person at the tablet is not this athlete.
    expect(await revokedAt(token)).not.toBeNull();
    expect(await resolvePrincipal(requestWith(token))).toBeNull();
    // ... and a second POST with the dead token is refused like any other.
    expect((await logoutPost(requestWith(token))).status).toBe(401);

    // Audited under the caller, as before the fix.
    expect(await auditRows(accountId)).toEqual([{ event_type: 'logout', details: {} }]);
  });

  test('can POST /api/pilot/auth/logout-all, and every session it held here is ended', async () => {
    const accountId = await seedAthlete({ mustChangePin: true });
    const tablet = await mintSession(accountId);
    const phone = await mintSession(accountId);
    // Somebody else's session in the same gym must be left alone.
    const bystanderId = await seedAthlete({ mustChangePin: false });
    const bystander = await mintSession(bystanderId);

    const response = await logoutAllPost(requestWith(tablet, 'http://localhost/api/pilot/auth/logout-all'));

    expect(response.status).toBe(200);
    expect(response.cookies.get(PILOT_SESSION_COOKIE)?.maxAge).toBe(0);

    expect(await revokedAt(tablet)).not.toBeNull();
    expect(await revokedAt(phone)).not.toBeNull();
    expect(await revokedAt(bystander)).toBeNull();
    expect(await resolvePrincipal(requestWith(tablet))).toBeNull();
    expect(await resolvePrincipal(requestWith(phone))).toBeNull();
    // Still a working session, not merely un-revoked: it resolves to its owner.
    expect((await resolvePrincipal(requestWith(bystander)))?.accountId).toBe(bystanderId);

    expect(await auditRows(accountId)).toEqual([
      { event_type: 'update', details: { action: 'session_revoke_all_self' } },
    ]);
  });
});

describe('the refusals both routes made before are unchanged', () => {
  const routes: Array<[string, (request: NextRequest) => Promise<Response>]> = [
    ['logout', logoutPost],
    ['logout-all', logoutAllPost],
  ];

  for (const [name, handler] of routes) {
    test(`${name}: no cookie, an unknown token, an expired token, a revoked token and a deleted account all get 401 and change nothing`, async () => {
      const accountId = await seedAthlete({ mustChangePin: true });
      const live = await mintSession(accountId);
      const expired = await mintSession(accountId, { expired: true });
      const revokedEarlier = await mintSession(accountId, { revoked: true });
      const deletedToken = await mintSession(await seedAthlete({ mustChangePin: true, deleted: true }));

      for (const token of [null, 'tok-nobody-ever-minted', expired, revokedEarlier, deletedToken]) {
        const response = await handler(requestWith(token));
        expect({ token, status: response.status }).toEqual({ token, status: 401 });
      }

      // Nothing was revoked by a refused call: the live session is still live
      // (logout-all with a dead cookie must not end the account's others).
      expect(await revokedAt(live)).toBeNull();
      expect((await resolvePrincipal(requestWith(live)))?.accountId).toBe(accountId);
      expect(await auditRows(accountId)).toEqual([]);
    });
  }

  test('an athlete who has already chosen their PIN still signs out (positive control)', async () => {
    const accountId = await seedAthlete({ mustChangePin: false });
    const token = await mintSession(accountId);

    expect((await logoutPost(requestWith(token))).status).toBe(200);
    expect(await resolvePrincipal(requestWith(token))).toBeNull();
  });
});
