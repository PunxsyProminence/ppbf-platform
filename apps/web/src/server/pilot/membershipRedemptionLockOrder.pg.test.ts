/**
 * Membership changes and activation-code redemption, against real PostgreSQL.
 *
 * Both write the same two rows: the login (pilot.accounts) and its membership
 * (pilot.organization_memberships). Redemption (activation.ts
 * redeemActivationCode) locks the account first and writes the membership
 * after. upsertOrganizationMembership (auth.ts), behind the platform owner's
 * membership route, used to write the membership first and the account after.
 * Two transactions taking the same two rows in opposite orders can each hold
 * the row the other is waiting for, and PostgreSQL ends that by killing one of
 * them (40P01, deadlock detected): the athlete's activation or the platform
 * owner's change fails at random.
 *
 * The interleaving is driven deterministically rather than by timing, and
 * through the SHIPPED functions rather than restated SQL: a gate connection
 * holds the code row, which parks the redemption right after it has taken the
 * account lock; the membership change is started while it is parked; the gate
 * is released only once both are seen waiting in pg_stat_activity.
 *
 * Spins up the same disposable, local-only embedded Postgres the other
 * migration suites use. It NEVER connects to production or staging.
 */

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
const PG_DATABASE = 'ppbf_test_membership_lock_order';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-membership-lock-order-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-lock-order';
const OTHER_ORG_ID = 'org-lock-order-other';
const ADMIN_ID = 'acct-lock-order-admin';
const ATHLETE_ID = 'ath-lock-order';
const ACCOUNT_ID = 'acct-lock-order-athlete';
const ISSUER = { issuedByAccountId: ADMIN_ID, issuedByRole: 'organization_admin' as const };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

type ActivationModule = typeof import('./activation');
type AuthModule = typeof import('./auth');
let activation: ActivationModule;
let auth: AuthModule;
let closePool: () => Promise<void>;

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

async function connect(): Promise<Client> {
  const connection = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await connection.connect();
  return connection;
}

/** Until at least `count` backends wait on a lock, the first running `fragment`. */
async function waitUntilWaiting(count: number, fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await client.query<{ query: string }>(
      `select query from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (waiting.rows.length >= count && waiting.rows.some((row) => row.query.includes(fragment))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Never saw ${count} backend(s) waiting on a lock, one running: ${fragment}`);
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();

  const { applyFullSchema } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { applyFullSchema: (c: Client) => Promise<void> };
  await applyFullSchema(client);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active'), ($2, $2, 'active') on conflict do nothing`,
    [ORG_ID, OTHER_ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
     values ($1, 'organization_admin', $2, 'microsoft', 'lock-order-admin@example.org', true)`,
    [ADMIN_ID, ORG_ID],
  );

  // Env before import: db.ts builds its pool on first use.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  activation = await import('./activation');
  auth = await import('./auth');
  ({ closePool } = await import('./db'));
});

afterAll(async () => {
  await closePool?.();
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

beforeEach(async () => {
  await client.query('delete from pilot.session_tokens where account_id = $1', [ACCOUNT_ID]);
  await client.query('delete from pilot.account_activation_tokens where account_id = $1', [ACCOUNT_ID]);
  await client.query('delete from pilot.organization_memberships where account_id = $1', [ACCOUNT_ID]);
  await client.query('delete from pilot.accounts where account_id = $1', [ACCOUNT_ID]);
  await client.query('delete from pilot.athletes where athlete_id = $1', [ATHLETE_ID]);
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Lock Order Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, ADMIN_ID],
  );
  // The shipped path: an athlete login waiting for activation, with its
  // inactive membership row already present.
  await auth.createAthleteAccountPendingActivation(ACCOUNT_ID, ATHLETE_ID, ORG_ID);
});

describe('a membership change and a redemption on the same login', () => {
  test('redemption holding the account while the membership changes: both finish, neither deadlocks', async () => {
    const issued = await activation.issueActivationCode({ accountId: ACCOUNT_ID, organizationId: ORG_ID, ...ISSUER });
    const gate = await connect();
    try {
      // Parks the redemption at its code lock, after it has taken the
      // account lock (activation.ts: account first, then its codes).
      await gate.query('begin');
      await gate.query('select 1 from pilot.account_activation_tokens where account_id = $1 for update', [ACCOUNT_ID]);

      const redeeming = watch(activation.redeemActivationCode(issued.code, '482913'));
      await waitUntilWaiting(1, 'from pilot.account_activation_tokens');
      expect(redeeming.state.settled).toBe(false);

      // The redemption holds the account. The membership change must wait
      // for it WITHOUT holding the membership row: in the old order it wrote
      // the membership here and then waited for the account.
      const upserting = watch(auth.upsertOrganizationMembership(ACCOUNT_ID, ORG_ID, 'athlete', true));
      await waitUntilWaiting(2, 'pilot.accounts');
      expect(upserting.state.settled).toBe(false);

      // Released, the redemption goes on to write the membership. In the old
      // order that row was held by the waiting membership change, and one of
      // the two failed with 40P01 (deadlock detected).
      await gate.query('commit');
      await Promise.all([redeeming.done, upserting.done]);

      expect(redeeming.state.error).toBeUndefined();
      expect(upserting.state.error).toBeUndefined();
      expect(redeeming.state.value).toMatchObject({ accountId: ACCOUNT_ID, organizationId: ORG_ID });

      const account = await client.query<{ active_flag: boolean; role: string; pin_set: boolean }>(
        'select active_flag, role, pin_hash is not null as pin_set from pilot.accounts where account_id = $1',
        [ACCOUNT_ID],
      );
      expect(account.rows[0]).toEqual({ active_flag: true, role: 'athlete', pin_set: true });

      const membership = await client.query<{ active_flag: boolean; role: string }>(
        'select active_flag, role from pilot.organization_memberships where account_id = $1 and organization_id = $2',
        [ACCOUNT_ID, ORG_ID],
      );
      expect(membership.rows).toEqual([{ active_flag: true, role: 'athlete' }]);

      const liveCodes = await client.query(
        'select 1 from pilot.account_activation_tokens where account_id = $1 and consumed_at is null',
        [ACCOUNT_ID],
      );
      expect(liveCodes.rows).toHaveLength(0);
    } finally {
      await gate.query('rollback').catch(() => undefined);
      await gate.end();
    }
  });

  test('the membership change waits on the account row before it touches the membership', async () => {
    const holder = await connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from pilot.accounts where account_id = $1 for no key update', [ACCOUNT_ID]);

      const upserting = watch(auth.upsertOrganizationMembership(ACCOUNT_ID, ORG_ID, 'athlete', true));
      await waitUntilWaiting(1, 'pilot.accounts');
      expect(upserting.state.settled).toBe(false);

      // Account first, then membership: while the change waits for the
      // account it holds nothing, so the membership row is free. In the old
      // order the change had already written it, and this fails (55P03).
      await expect(
        holder.query(
          'select 1 from pilot.organization_memberships where account_id = $1 and organization_id = $2 for update nowait',
          [ACCOUNT_ID, ORG_ID],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      await holder.query('commit');
      await upserting.done;
      expect(upserting.state.error).toBeUndefined();
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });

  test('moving the login to another gym does not upgrade its lock under a transaction that references the account', async () => {
    // organization_id is in the unique index uq_pilot_accounts_org_account,
    // so the update that moves a login to another gym needs FOR UPDATE, which
    // waits on the key-share lock any insert referencing the account holds.
    // The membership change takes FOR UPDATE up front, before it holds
    // anything. Taken as FOR NO KEY UPDATE, it would hold that, wait here for
    // the upgrade, and the holder's own update of the account below would
    // wait on it: 40P01.
    const holder = await connect();
    try {
      await holder.query('begin');
      await holder.query(
        `insert into pilot.session_tokens (token_hash, account_id, organization_id)
         values ('lock-order-session', $1, $2)`,
        [ACCOUNT_ID, ORG_ID],
      );

      const upserting = watch(auth.upsertOrganizationMembership(ACCOUNT_ID, OTHER_ORG_ID, 'athlete', true));
      await waitUntilWaiting(1, 'pilot.accounts');
      expect(upserting.state.settled).toBe(false);

      await expect(
        holder.query('update pilot.accounts set updated_at = now() where account_id = $1', [ACCOUNT_ID]),
      ).resolves.toMatchObject({ rowCount: 1 });

      await holder.query('commit');
      await upserting.done;
      expect(upserting.state.error).toBeUndefined();

      const account = await client.query<{ organization_id: string }>(
        'select organization_id from pilot.accounts where account_id = $1',
        [ACCOUNT_ID],
      );
      expect(account.rows[0].organization_id).toBe(OTHER_ORG_ID);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });
});
