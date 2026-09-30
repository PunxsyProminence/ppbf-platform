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

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

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

import { issueActivationCode, redeemActivationCode } from './activation';
import { deleteAthleteRecord, deleteGuardianAccount, type ActorIdentity } from './dataDeletion';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-deletion-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG_ID = 'org-adra';
const COACH = 'acct-coach-adra';
const ADMIN_ACCOUNT = 'acct-admin-adra';

const ATHLETE_ID = 'ATH-ADRA-1';
const ATHLETE_ACCOUNT = 'acct-athlete-adra';
/** A second athlete nobody deletes -- the control for every "was untouched". */
const BYSTANDER_ATHLETE_ID = 'ATH-ADRA-2';
const BYSTANDER_ACCOUNT = 'acct-athlete-adra-2';
/** A guardian account in this gym, the only guardian of ATHLETE_ID once linked. */
const GUARDIAN_ACCOUNT = 'acct-guardian-adra';

/** A second gym, for the organization-isolation cases. */
const OTHER_ORG_ID = 'org-adrb';
const OTHER_COACH = 'acct-coach-adrb';
/** The SAME athlete_id as ATHLETE_ID, held by the other gym -- athlete_id is unique only within a gym. */
const OTHER_SAME_ID_ACCOUNT = 'acct-athlete-adrb-same-id';
/** An athlete that exists only in the other gym. */
const OTHER_ONLY_ATHLETE_ID = 'ATH-ADRB-ONLY';
const OTHER_ONLY_ACCOUNT = 'acct-athlete-adrb-only';
const OTHER_GUARDIAN_ACCOUNT = 'acct-guardian-adrb';

/** Any PIN validatePinPolicy accepts. */
const CHOSEN_PIN = '481902';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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
  /* THE WHOLE SCHEMA (scripts/lib/full-schema.mjs). This suite used to apply
     the base file plus the two migrations it knew it needed; deletion scope B
     then made both deletion paths read tables from four more (video
     sessions, portraits, SHADOW conversations), and a hand-picked database
     that lacks them is one production has never had. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });

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

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;
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

/** A guardian account in `organizationId`; with `athleteId`, that athlete's only guardian. */
async function addGuardian(
  client: Client,
  organizationId: string,
  accountId: string,
  athleteId?: string,
): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'parent', $2, 'microsoft')`,
    [accountId, organizationId],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role)
     values ($1, $2, 'parent')`,
    [accountId, organizationId],
  );
  if (athleteId) {
    const parentId = `par-${accountId}`;
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, $2, $3, 'Guardian Name')`,
      [organizationId, parentId, accountId],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'parent')`,
      [organizationId, parentId, athleteId],
    );
  }
}

/**
 * A second gym holding an athlete with the SAME athlete_id as ATHLETE_ID, an
 * athlete only it holds, and a guardian of that one. Each athlete is signed
 * in, with a live session, like the athletes in the first gym.
 */
async function addOtherOrganization(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [OTHER_ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')`,
    [OTHER_COACH, OTHER_ORG_ID],
  );
  for (const [athleteId, accountId] of [
    [ATHLETE_ID, OTHER_SAME_ID_ACCOUNT],
    [OTHER_ONLY_ATHLETE_ID, OTHER_ONLY_ACCOUNT],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Athlete Name', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [OTHER_ORG_ID, athleteId, OTHER_COACH],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider,
         athlete_id, pin_hash, active_flag)
       values ($1, 'athlete', $2, 'ppbf_local', $3, 'argon2-hash-placeholder', true)`,
      [accountId, OTHER_ORG_ID, athleteId],
    );
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id)
       values ($1, $2, $3)`,
      [`hash-${accountId}`, accountId, OTHER_ORG_ID],
    );
  }
  await addGuardian(client, OTHER_ORG_ID, OTHER_GUARDIAN_ACCOUNT, OTHER_ONLY_ATHLETE_ID);
}

/**
 * Every row a deletion could write, in both gyms, so "nothing changed" is
 * compared rather than assumed.
 */
async function snapshot(client: Client): Promise<string> {
  const athletes = await client.query(
    `select organization_id, athlete_id, deleted_at::text as deleted_at from pilot.athletes order by 1, 2`,
  );
  const accounts = await client.query(
    `select account_id, active_flag, deleted_at::text as deleted_at from pilot.accounts order by 1`,
  );
  const memberships = await client.query(
    `select account_id, organization_id, active_flag from pilot.organization_memberships order by 1, 2`,
  );
  const sessions = await client.query(
    `select token_hash, revoked_at::text as revoked_at from pilot.session_tokens order by 1`,
  );
  const codes = await client.query(
    `select token_hash, superseded_at::text as superseded_at, consumed_at::text as consumed_at
       from pilot.account_activation_tokens order by 1`,
  );
  const audits = await client.query(`select count(*)::text as count from pilot.audit_events`);
  return JSON.stringify({
    athletes: athletes.rows,
    accounts: accounts.rows,
    memberships: memberships.rows,
    sessions: sessions.rows,
    codes: codes.rows,
    audits: audits.rows,
  });
}

async function outstandingCode(client: Client, accountId: string) {
  const result = await client.query<{ superseded_at: string | null; consumed_at: string | null }>(
    `select superseded_at::text as superseded_at, consumed_at::text as consumed_at
       from pilot.account_activation_tokens where account_id = $1`,
    [accountId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

function issueCodeFor(accountId: string) {
  return issueActivationCode({
    accountId,
    organizationId: ORG_ID,
    issuedByAccountId: ADMIN_ACCOUNT,
    issuedByRole: 'organization_admin',
  });
}

describe('deleting an athlete closes the door the athlete came in through', () => {
  test('the athlete account is deactivated, not merely marked', async () => {
    await withDatabase('adra_account', async (client) => {
      // Control: before the deletion the account is genuinely usable.
      expect((await accountRow(client, ATHLETE_ACCOUNT)).active_flag).toBe(true);

      await deleteAthleteRecord(admin, ATHLETE_ID, 'withdrew from the program');

      const after = await accountRow(client, ATHLETE_ACCOUNT);
      // active_flag is what the rest of the platform gates on. Sign-in and
      // resolvePrincipal also refuse deleted_at now (deletedAccountSignIn.ts),
      // but a deletion still clears the flag rather than rely on that alone.
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

  test('deleting the same athlete twice is refused, and the first deletion stands unchanged', async () => {
    // Owner decision 2026-09-29 ("1A"). A repeat used to write deleted_at =
    // now() again, which restarts the 2-year clock the purge measures from.
    await withDatabase('adra_twice', async (client) => {
      await deleteAthleteRecord(admin, ATHLETE_ID, 'withdrew');

      const stamp = async () => (await client.query<{ deleted_at: string }>(
        `select deleted_at::text as deleted_at from pilot.athletes
          where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      )).rows[0].deleted_at;
      const audits = async () => Number((await client.query<{ count: string }>(
        `select count(*)::text as count from pilot.audit_events
          where event_type = 'data_deletion_initiated' and entity_id = $1`,
        [ATHLETE_ID],
      )).rows[0].count);

      const firstStamp = await stamp();
      expect(await audits()).toBe(1);

      await expect(deleteAthleteRecord(admin, ATHLETE_ID, 'again')).rejects.toMatchObject({
        status: 409,
        code: 'ALREADY_DELETED',
      });

      // Nothing changed: the same deleted_at, and still exactly one audit row.
      expect(await stamp()).toBe(firstStamp);
      expect(await audits()).toBe(1);
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

/**
 * A closed login stays closed. redeemActivationCode sets active_flag = true
 * on the account and its membership and never reads deleted_at, so a code
 * handed out before the deletion -- live for 14 days by default -- let the
 * athlete sign back in to their withdrawn record with no admin involved. Both
 * deletion paths now cancel outstanding codes in their own transaction.
 *
 * The bystander's code is redeemed at the end of each case: it proves this
 * harness can redeem a code at all, so the refusal above it is the deletion's
 * doing and not a broken fixture, and it proves the cancellation stayed on the
 * account it was aimed at.
 */
describe('a code issued before the deletion cannot reopen the login after it', () => {
  test('deleting an athlete cancels their outstanding code, and redeeming it is refused', async () => {
    await withDatabase('adra_code', async (client) => {
      const code = await issueCodeFor(ATHLETE_ACCOUNT);
      const bystanderCode = await issueCodeFor(BYSTANDER_ACCOUNT);

      await deleteAthleteRecord(admin, ATHLETE_ID, 'withdrew');

      const cancelled = await outstandingCode(client, ATHLETE_ACCOUNT);
      expect(cancelled.superseded_at).not.toBeNull();
      expect(cancelled.consumed_at).toBeNull();

      await expect(redeemActivationCode(code.code, CHOSEN_PIN)).rejects.toThrow(
        'Unauthorized: activation code is invalid, already used, or expired',
      );
      const after = await accountRow(client, ATHLETE_ACCOUNT);
      expect(after.active_flag).toBe(false);
      expect(after.deleted_at).not.toBeNull();
      expect(await liveSessionCount(client, ATHLETE_ACCOUNT)).toBe(0);

      expect((await outstandingCode(client, BYSTANDER_ACCOUNT)).superseded_at).toBeNull();
      await expect(redeemActivationCode(bystanderCode.code, CHOSEN_PIN)).resolves.toMatchObject({
        accountId: BYSTANDER_ACCOUNT,
      });
    });
  });

  test('deleting a guardian cancels the code of the child the cascade withdrew, and redeeming it is refused', async () => {
    await withDatabase('adra_code_cascade', async (client) => {
      await addGuardian(client, ORG_ID, GUARDIAN_ACCOUNT, ATHLETE_ID);
      const code = await issueCodeFor(ATHLETE_ACCOUNT);
      const bystanderCode = await issueCodeFor(BYSTANDER_ACCOUNT);

      const result = await deleteGuardianAccount(admin, GUARDIAN_ACCOUNT, 'family left');

      // The cascade really withdrew the child and closed the child's login --
      // otherwise the refusal below would prove nothing about the cascade.
      expect(result.deletedRecordsCounts.athletes).toBe(1);
      expect((await accountRow(client, ATHLETE_ACCOUNT)).active_flag).toBe(false);

      expect((await outstandingCode(client, ATHLETE_ACCOUNT)).superseded_at).not.toBeNull();
      await expect(redeemActivationCode(code.code, CHOSEN_PIN)).rejects.toThrow(
        'Unauthorized: activation code is invalid, already used, or expired',
      );
      expect((await accountRow(client, ATHLETE_ACCOUNT)).active_flag).toBe(false);

      expect((await outstandingCode(client, BYSTANDER_ACCOUNT)).superseded_at).toBeNull();
      await expect(redeemActivationCode(bystanderCode.code, CHOSEN_PIN)).resolves.toMatchObject({
        accountId: BYSTANDER_ACCOUNT,
      });
    });
  });
});

describe('deleting the same guardian twice', () => {
  test('is refused, and the first deletion stands unchanged', async () => {
    // Owner decision 2026-09-29 ("1A"), the guardian path. A repeat used to
    // write deleted_at = now() again, restarting the 1-year clock.
    await withDatabase('adra_guardian_twice', async (client) => {
      await addGuardian(client, ORG_ID, GUARDIAN_ACCOUNT);
      await deleteGuardianAccount(admin, GUARDIAN_ACCOUNT, 'asked');

      const audits = async () => Number((await client.query<{ count: string }>(
        `select count(*)::text as count from pilot.audit_events
          where event_type = 'data_deletion_initiated' and entity_id = $1`,
        [GUARDIAN_ACCOUNT],
      )).rows[0].count);
      expect(await audits()).toBe(1);
      const before = await snapshot(client);

      await expect(deleteGuardianAccount(admin, GUARDIAN_ACCOUNT, 'again')).rejects.toMatchObject({
        status: 409,
        code: 'ALREADY_DELETED',
      });

      // Nothing changed anywhere: same deleted_at, still exactly one audit row.
      expect(await snapshot(client)).toBe(before);
      expect(await audits()).toBe(1);
    });
  });
});

/**
 * Organization isolation, a hard requirement for minors' records. The route
 * takes the organization from the session only (route.test.ts pins that); these
 * cases pin that the service, handed one gym, cannot reach the other.
 */
describe('an admin can delete only in their own gym', () => {
  test('an athlete that exists only in another gym is not found, and neither gym changes', async () => {
    await withDatabase('adra_iso_only_other', async (client) => {
      await addOtherOrganization(client);
      const before = await snapshot(client);

      await expect(deleteAthleteRecord(admin, OTHER_ONLY_ATHLETE_ID, 'probe')).rejects.toThrow(
        'Not found: athlete does not exist in this organization',
      );

      expect(await snapshot(client)).toBe(before);
    });
  });

  test('when both gyms hold the same athlete_id, only the admin\'s own athlete and login are closed', async () => {
    await withDatabase('adra_iso_same_id', async (client) => {
      await addOtherOrganization(client);

      await deleteAthleteRecord(admin, ATHLETE_ID, 'withdrew');

      const rows = await client.query<{ organization_id: string; deleted_at: string | null }>(
        `select organization_id, deleted_at::text as deleted_at from pilot.athletes
          where athlete_id = $1 order by organization_id`,
        [ATHLETE_ID],
      );
      expect(rows.rows).toEqual([
        { organization_id: ORG_ID, deleted_at: expect.any(String) },
        { organization_id: OTHER_ORG_ID, deleted_at: null },
      ]);

      expect((await accountRow(client, ATHLETE_ACCOUNT)).active_flag).toBe(false);
      const other = await accountRow(client, OTHER_SAME_ID_ACCOUNT);
      expect(other.active_flag).toBe(true);
      expect(other.deleted_at).toBeNull();
      expect(await liveSessionCount(client, OTHER_SAME_ID_ACCOUNT)).toBe(1);
    });
  });

  test('a guardian account in another gym is not found, and neither gym changes', async () => {
    await withDatabase('adra_iso_guardian', async (client) => {
      await addOtherOrganization(client);
      const before = await snapshot(client);

      await expect(deleteGuardianAccount(admin, OTHER_GUARDIAN_ACCOUNT, 'probe')).rejects.toThrow(
        'Not found: parent account does not exist or is not a parent role',
      );

      expect(await snapshot(client)).toBe(before);
    });
  });
});
