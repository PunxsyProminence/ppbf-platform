// Real PostgreSQL-backed contract test for the OTHER half of athlete deletion:
// not "is the row marked", but "can the athlete still get in".
//
// WHY THIS SUITE EXISTS. deleteGuardianAccount does three things in one
// transaction -- sets deleted_at, clears active_flag, revokes sessions --
// because #690 found that writing deleted_at alone left a deleted guardian
// reading their minor's records and re-issuing themselves magic links.
// deleteAthleteRecord, the same function for the other party, did exactly one
// of the three. So the same hole was open on the athlete side and nobody had
// looked: the athlete row was marked deleted while pilot.accounts.active_flag
// stayed true and every existing session token stayed valid.
//
// The self-access branch of assertActorCanAccessAthlete could not have caught
// it either -- it compares actor.athleteId to the requested id and reads no
// row at all. A withdrawn athlete kept a working login to their own record for
// the entire two-year retention window.
//
// WHY REAL POSTGRES, and not a mocked db. This change is three UPDATE
// statements against three tables, and the first version of it named a column
// that does not exist (session_tokens has token_hash, not token_id).
// `tsc --noEmit` passed on it, because the column name is inside a string. A
// mocked client would have passed too. Only a real database rejects it.
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

// Routes dataDeletion.ts's transaction into whichever embedded database the
// current test opened. Declared before the import so jest's mock hoisting sees
// it. withTransaction runs the callback against the SAME client so that the
// deletion, the account deactivation and the session revocation are one unit
// of work here exactly as they are in production.
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
}));

import { deleteAthleteRecord, type ActorIdentity } from './dataDeletion';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-deletion-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RETENTION_MIGRATION = 'pilot_slice_postgres_data_retention_deletion_migration.sql';

const ORG_ID = 'org-adra';
const COACH = 'acct-coach-adra';
const ADMIN_ACCOUNT = 'acct-admin-adra';

const ATHLETE_ID = 'ATH-ADRA-1';
const ATHLETE_ACCOUNT = 'acct-athlete-adra';
/** A second athlete nobody deletes -- the control for every "was untouched". */
const BYSTANDER_ATHLETE_ID = 'ATH-ADRA-2';
const BYSTANDER_ACCOUNT = 'acct-athlete-adra-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let retentionMigrationSql: string;

const admin: ActorIdentity = {
  accountId: ADMIN_ACCOUNT,
  role: 'organization_admin',
  organizationId: ORG_ID,
};

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

/**
 * Two athletes, each with a signed-in account holding a live session token.
 * They differ in nothing until one of them is deleted.
 */
async function freshDatabase(name: string): Promise<Client> {
  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  await adminClient.query(`drop database if exists ${name}`);
  await adminClient.query(`create database ${name}`);
  await adminClient.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(retentionMigrationSql);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  for (const [accountId, role] of [[COACH, 'coach'], [ADMIN_ACCOUNT, 'organization_admin']] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, ORG_ID],
    );
  }

  for (const [athleteId, accountId] of [
    [ATHLETE_ID, ATHLETE_ACCOUNT],
    [BYSTANDER_ATHLETE_ID, BYSTANDER_ACCOUNT],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Athlete Name', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [ORG_ID, athleteId, COACH],
    );
    // An activated athlete: a PIN set, active, and holding a live session --
    // which is what makes "still signed in" the state under test rather than
    // a hypothetical.
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider,
         athlete_id, pin_hash, active_flag)
       values ($1, 'athlete', $2, 'ppbf_local', $3, 'argon2-hash-placeholder', true)
       on conflict do nothing`,
      [accountId, ORG_ID, athleteId],
    );
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id)
       values ($1, $2, $3)`,
      [`hash-${accountId}`, accountId, ORG_ID],
    );
  }

  return client;
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  retentionMigrationSql = await fs.readFile(path.join(INFRA_DIR, RETENTION_MIGRATION), 'utf8');
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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  activeClient = null;
});

async function withDatabase(name: string, run: (client: Client) => Promise<void>): Promise<void> {
  const client = await freshDatabase(name);
  activeClient = client;
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

async function accountRow(client: Client, accountId: string) {
  const result = await client.query<{ active_flag: boolean; deleted_at: string | null }>(
    `select active_flag, deleted_at from pilot.accounts where account_id = $1`,
    [accountId],
  );
  return result.rows[0];
}

async function liveSessionCount(client: Client, accountId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count from pilot.session_tokens
     where account_id = $1 and revoked_at is null`,
    [accountId],
  );
  return Number(result.rows[0].count);
}

describe('deleting an athlete closes the door the athlete came in through', () => {
  test('the athlete account is deactivated, not merely marked', async () => {
    await withDatabase('adra_account', async (client) => {
      // Control: before the deletion the account is genuinely usable.
      expect((await accountRow(client, ATHLETE_ACCOUNT)).active_flag).toBe(true);

      await deleteAthleteRecord(admin, ATHLETE_ID, 'withdrew from the program');

      const after = await accountRow(client, ATHLETE_ACCOUNT);
      // active_flag is the one the rest of the platform gates on -- magicLink
      // and resolvePrincipal both read it and neither reads deleted_at.
      expect(after.active_flag).toBe(false);
      expect(after.deleted_at).not.toBeNull();
    });
  });

  test('every live session for that athlete is revoked in the same transaction', async () => {
    await withDatabase('adra_sessions', async (client) => {
      expect(await liveSessionCount(client, ATHLETE_ACCOUNT)).toBe(1);

      await deleteAthleteRecord(admin, ATHLETE_ID, 'withdrew');

      // A cleared PIN alone would not have done this: an athlete already
      // signed in holds a token resolvePrincipal accepts.
      expect(await liveSessionCount(client, ATHLETE_ACCOUNT)).toBe(0);
    });
  });

  test('no other athlete is touched', async () => {
    await withDatabase('adra_bystander', async (client) => {
      await deleteAthleteRecord(admin, ATHLETE_ID, 'withdrew');

      // Without this, a statement missing its athlete_id predicate -- which
      // would deactivate every athlete in the gym -- passes both tests above.
      const bystander = await accountRow(client, BYSTANDER_ACCOUNT);
      expect(bystander.active_flag).toBe(true);
      expect(bystander.deleted_at).toBeNull();
      expect(await liveSessionCount(client, BYSTANDER_ACCOUNT)).toBe(1);
    });
  });

  test('the athlete row is soft-deleted, not removed', async () => {
    await withDatabase('adra_soft', async (client) => {
      await deleteAthleteRecord(admin, ATHLETE_ID, 'withdrew');

      const result = await client.query<{ deleted_at: string | null }>(
        `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].deleted_at).not.toBeNull();
    });
  });

  test('the audit row reports what actually happened, with counts', async () => {
    await withDatabase('adra_audit', async (client) => {
      const result = await deleteAthleteRecord(admin, ATHLETE_ID, 'withdrew');

      const audit = await client.query<{ details: Record<string, unknown> }>(
        `select details from pilot.audit_events where audit_id = $1`,
        [result.auditEventId],
      );
      expect(audit.rows[0].details).toMatchObject({
        account_deactivated: true,
        sessions_revoked: 1,
      });
      expect(result.deletedRecordsCounts.accounts).toBe(1);
    });
  });

  test('an athlete with no account deletes cleanly and claims nothing it did not do', async () => {
    await withDatabase('adra_no_account', async (client) => {
      // A promoted-but-never-activated athlete has no account row at all.
      await client.query(`delete from pilot.session_tokens where account_id = $1`, [ATHLETE_ACCOUNT]);
      await client.query(`delete from pilot.accounts where account_id = $1`, [ATHLETE_ACCOUNT]);

      const result = await deleteAthleteRecord(admin, ATHLETE_ID, 'never activated');

      const audit = await client.query<{ details: Record<string, unknown> }>(
        `select details from pilot.audit_events where audit_id = $1`,
        [result.auditEventId],
      );
      // The honest answer is false/0, not a silent true. An audit row that
      // claimed an access closure that never happened is worse than no row.
      expect(audit.rows[0].details).toMatchObject({
        account_deactivated: false,
        sessions_revoked: 0,
      });
      expect(result.deletedRecordsCounts.accounts).toBe(0);
    });
  });
});
