// Real PostgreSQL-backed test for guardian provisioning in staffProvisioning.ts.
//
// The failure this covers is silent by construction, which is why it needs a
// real database rather than a mocked client. Inviting someone as
// "Parent / Guardian" wrote pilot.accounts and pilot.organization_memberships
// and nothing else, while every parent read path resolves a child by joining
// pilot.parents on account_id and then pilot.guardian_links. Both halves are
// individually correct: the account signs in, the query runs and matches
// nothing. No error is raised anywhere, and a family sees an empty list.
//
// So the suite proves three things that cannot be proven by reading code:
//
// 1. The negative control -- an account row alone genuinely resolves zero
//    children against the real schema. If a future change made the account
//    sufficient on its own, the rest of this suite would pass while testing
//    nothing, so the broken shape is asserted directly.
//
// 2. Provisioning writes the account, pilot.parents and pilot.guardian_links
//    as one transaction, and the resolution query used by
//    /api/pilot/athletes/list and access.ts then returns exactly that child.
//
// 3. A refused link commits nothing. An athlete id from another organization,
//    or one that does not exist, must leave no account behind -- a half-written
//    guardian is the same silent failure by another route.
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
const TEST_DB_NAME = 'ppbf_test_guardian_invite_link';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-invite-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');

const ORG_A = 'org-guardian-a';
const ORG_B = 'org-guardian-b';
const COACH_A = 'coach-a@example.com';
const COACH_B = 'coach-b@example.com';

// The exact shape of the parent branch in /api/pilot/athletes/list. Restated
// here rather than imported so this suite fails if provisioning and that read
// ever stop agreeing about how a child is resolved.
const PARENT_RESOLVES_CHILDREN = `
  select a.athlete_id
  from pilot.athletes a
  join pilot.guardian_links gl
    on gl.organization_id = a.organization_id and gl.athlete_id = a.athlete_id
  join pilot.parents p
    on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
  where a.organization_id = $1 and p.account_id = $2
  order by a.athlete_id asc`;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let staffProvisioning: typeof import('./staffProvisioning');

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

async function resolvedChildren(organizationId: string, accountId: string): Promise<string[]> {
  const result = await client.query<{ athlete_id: string }>(PARENT_RESOLVES_CHILDREN, [
    organizationId,
    accountId,
  ]);
  return result.rows.map((row) => row.athlete_id);
}

async function accountExists(accountId: string): Promise<boolean> {
  const result = await client.query('select 1 from pilot.accounts where account_id = $1', [accountId]);
  return result.rowCount === 1;
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
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  await client.query(await fs.readFile(SCHEMA_SQL_PATH, 'utf8'));

  for (const orgId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active')`,
      [orgId],
    );
  }

  // pilot.athletes.coach_id is not null and carries a foreign key, so each gym
  // needs a coach before it can hold an athlete.
  await client.query(
    `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag)
     values ($1, $1, 'microsoft', 'coach', $3, false, null, null, true),
            ($2, $2, 'microsoft', 'coach', $4, false, null, null, true)`,
    [COACH_A, COACH_B, ORG_A, ORG_B],
  );

  // created_at/updated_at are not null with no default on pilot.athletes.
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, 'ath-a1', 'Alex Johnson', '2013-04-02', 'bantam', 'active', 'contact', true, $3, now(), now()),
       ($1, 'ath-a2', 'Sam Rivera', '2012-09-11', 'fly', 'active', 'contact', true, $3, now(), now()),
       ($2, 'ath-b1', 'Other Gym Child', '2012-02-20', 'fly', 'active', 'contact', true, $4, now(), now())`,
    [ORG_A, ORG_B, COACH_A, COACH_B],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  staffProvisioning = await import('./staffProvisioning');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();
  await client.end();

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

describe('the silent failure itself', () => {
  // Negative control. This is the state the old invite produced, written by
  // hand so the suite proves the hazard is real rather than assuming it.
  test('a parent account with no guardian rows resolves zero children and raises nothing', async () => {
    await client.query(
      `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag)
       values ('stranded@example.com', 'stranded@example.com', 'microsoft', 'parent', $1, false, null, null, true)`,
      [ORG_A],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ('stranded@example.com', $1, 'parent', true)`,
      [ORG_A],
    );

    // The account is indistinguishable from a healthy one at the account level.
    const account = await client.query<{ role: string; active_flag: boolean }>(
      'select role, active_flag from pilot.accounts where account_id = $1',
      ['stranded@example.com'],
    );
    expect(account.rows[0]).toEqual({ role: 'parent', active_flag: true });

    // And the read that matters returns an empty list, with no error.
    await expect(resolvedChildren(ORG_A, 'stranded@example.com')).resolves.toEqual([]);
  });

  test('listOrganizationGuardianLinks is what makes the stranded account visible', async () => {
    const links = await staffProvisioning.listOrganizationGuardianLinks(ORG_A);
    expect(links.some((link) => link.account_id === 'stranded@example.com')).toBe(false);
  });
});

describe('inviting a guardian writes the link that makes the account work', () => {
  const DANA = 'dana@example.com';

  test('the account, the guardian record and the link land together', async () => {
    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: DANA,
      organizationId: ORG_A,
      role: 'parent',
      guardian: { athleteId: 'ath-a1', fullName: 'Dana Johnson', relationshipToAthlete: 'mother' },
    });

    expect(result.created).toBe(true);
    expect(result.guardianLink).toEqual({ parentId: `par-${DANA}`, athleteId: 'ath-a1' });

    // The whole point: the read path now returns the child.
    await expect(resolvedChildren(ORG_A, DANA)).resolves.toEqual(['ath-a1']);
  });

  test('a second invite adds a second child to the same guardian record', async () => {
    await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: DANA,
      organizationId: ORG_A,
      role: 'parent',
      guardian: { athleteId: 'ath-a2', fullName: 'Dana Johnson', relationshipToAthlete: 'mother' },
    });

    await expect(resolvedChildren(ORG_A, DANA)).resolves.toEqual(['ath-a1', 'ath-a2']);

    const parents = await client.query(
      'select parent_id from pilot.parents where organization_id = $1 and account_id = $2',
      [ORG_A, DANA],
    );
    expect(parents.rowCount).toBe(1);
  });

  test('the console read reports both children, scoped to the organization', async () => {
    const links = await staffProvisioning.listOrganizationGuardianLinks(ORG_A);
    const forDana = links.filter((link) => link.account_id === DANA);

    expect(forDana.map((link) => link.athlete_full_name)).toEqual(['Alex Johnson', 'Sam Rivera']);
    expect(await staffProvisioning.listOrganizationGuardianLinks(ORG_B)).toEqual([]);
  });
});

describe('a refused link commits nothing', () => {
  test('an athlete id that does not exist leaves no account behind', async () => {
    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'typo@example.com',
        organizationId: ORG_A,
        role: 'parent',
        guardian: { athleteId: 'ath-typo', fullName: 'Typo Parent', relationshipToAthlete: 'mother' },
      }),
    ).rejects.toThrow('Missing athlete_id');

    await expect(accountExists('typo@example.com')).resolves.toBe(false);
  });

  // Athletes are minors, and the organization is the boundary that keeps one
  // gym's records out of another gym's hands.
  test('an athlete in another organization is refused, and no account is created', async () => {
    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'crossorg@example.com',
        organizationId: ORG_A,
        role: 'parent',
        guardian: { athleteId: 'ath-b1', fullName: 'Cross Org', relationshipToAthlete: 'mother' },
      }),
    ).rejects.toThrow('Missing athlete_id');

    await expect(accountExists('crossorg@example.com')).resolves.toBe(false);
  });
});

describe('removeGuardianLink', () => {
  const DANA = 'dana@example.com';

  test('detaching one child leaves the other resolving', async () => {
    await staffProvisioning.removeGuardianLink({
      organizationId: ORG_A,
      accountId: DANA,
      athleteId: 'ath-a2',
    });

    await expect(resolvedChildren(ORG_A, DANA)).resolves.toEqual(['ath-a1']);
  });

  // The one action that could recreate the original bug.
  test('refuses to detach the last child, and the link survives the attempt', async () => {
    await expect(
      staffProvisioning.removeGuardianLink({
        organizationId: ORG_A,
        accountId: DANA,
        athleteId: 'ath-a1',
      }),
    ).rejects.toThrow('Forbidden: this is the only athlete this guardian is linked to');

    await expect(resolvedChildren(ORG_A, DANA)).resolves.toEqual(['ath-a1']);
  });
});
