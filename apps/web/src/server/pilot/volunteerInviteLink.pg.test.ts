// Real PostgreSQL-backed test for volunteer roster linking in
// staffProvisioning.ts.
//
// pilot.volunteers.account_id exists precisely to connect a roster row to a
// platform login, and 'volunteer' has always been an invitable staff role,
// but neither side ever set or created the other: inviting a volunteer wrote
// pilot.accounts and pilot.organization_memberships and nothing in
// pilot.volunteers, and creating a volunteer roster row through
// /api/admin/volunteers left account_id null forever. An invited volunteer's
// login and their roster presence were two permanently disconnected records,
// with nothing anywhere reporting the gap.
//
// This suite proves, against the real schema:
//
// 1. Inviting a volunteer with no roster detail still creates and links a
//    pilot.volunteers row -- the connection closes unconditionally, not only
//    when a caller happens to supply extra fields.
// 2. Inviting a volunteer that names an existing, unclaimed roster row links
//    that row instead of creating a second one -- the "roster row already
//    existed first" path.
// 3. A re-invite of the same account reuses its existing roster row rather
//    than minting a duplicate one.
// 4. Naming a roster row already linked to a different account is refused,
//    and refusing it commits no half-written account.
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
const TEST_DB_NAME = 'ppbf_test_volunteer_invite_link';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-volunteer-invite-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_A = 'org-vol-invite-a';
const ORG_B = 'org-vol-invite-b';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let staffProvisioning: typeof import('./staffProvisioning');
let volunteers: typeof import('./volunteers');

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

async function accountExists(accountId: string): Promise<boolean> {
  const result = await client.query('select 1 from pilot.accounts where account_id = $1', [accountId]);
  return result.rowCount === 1;
}

async function volunteerRowFor(organizationId: string, accountId: string) {
  const result = await client.query(
    `select volunteer_id, full_name, role_focus, account_id, status
     from pilot.volunteers
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId],
  );
  return result.rows;
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
  await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  // volunteers.ts writes role_focus/availability/certification_status/
  // background_check_status/status, which only exist after this migration --
  // see volunteerProgram.pg.test.ts for the same dependency.
  await client.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_volunteer_program_migration.sql'), 'utf8'),
  );

  for (const orgId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active')`,
      [orgId],
    );
  }

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  staffProvisioning = await import('./staffProvisioning');
  volunteers = await import('./volunteers');
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

describe('inviting a volunteer closes the account/roster link unconditionally', () => {
  const PAT = 'pat@example.com';

  test('an invite naming no roster detail still creates and links a roster row', async () => {
    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: PAT,
      organizationId: ORG_A,
      role: 'volunteer',
    });

    expect(result.created).toBe(true);
    expect(result.volunteerLink?.volunteerId).toBeTruthy();

    const rows = await volunteerRowFor(ORG_A, PAT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      volunteer_id: result.volunteerLink?.volunteerId,
      // No name was supplied, so the honest placeholder is the login email --
      // never an invented name.
      full_name: PAT,
      account_id: PAT,
      status: 'pending',
    });
  });

  test('re-inviting the same account reuses the existing roster row', async () => {
    const before = await volunteerRowFor(ORG_A, PAT);

    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: PAT,
      organizationId: ORG_A,
      role: 'volunteer',
    });

    expect(result.created).toBe(false);
    expect(result.volunteerLink?.volunteerId).toBe(before[0].volunteer_id);

    const after = await volunteerRowFor(ORG_A, PAT);
    expect(after).toHaveLength(1);
  });
});

describe('inviting a volunteer with roster detail', () => {
  test('the supplied fields land on the created row', async () => {
    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'morgan@example.com',
      organizationId: ORG_A,
      role: 'volunteer',
      volunteer: {
        fullName: 'Morgan Lee',
        roleFocus: 'corner-coach',
        availability: 'weeknights',
      },
    });

    const rows = await volunteerRowFor(ORG_A, 'morgan@example.com');
    expect(rows[0]).toMatchObject({
      volunteer_id: result.volunteerLink?.volunteerId,
      full_name: 'Morgan Lee',
      role_focus: 'corner-coach',
    });
  });
});

describe('inviting a volunteer whose roster row already exists', () => {
  test('naming an existing unclaimed row links it instead of creating a second one', async () => {
    const volunteerId = await volunteers.createVolunteer({
      organizationId: ORG_A,
      fullName: 'Casey Rivers',
      roleFocus: 'equipment',
      availability: 'weekends',
      certificationStatus: 'complete',
      backgroundCheckStatus: 'clear',
    });

    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'casey@example.com',
      organizationId: ORG_A,
      role: 'volunteer',
      volunteer: { volunteerId },
    });

    expect(result.volunteerLink).toEqual({ volunteerId });

    const row = await volunteers.getVolunteer(ORG_A, volunteerId);
    expect(row?.account_id).toBe('casey@example.com');
    expect(row?.full_name).toBe('Casey Rivers');

    // Exactly one row for this account -- linking must not also create a
    // second, unrelated one.
    expect(await volunteerRowFor(ORG_A, 'casey@example.com')).toHaveLength(1);
  });
});

describe('a refused volunteer link commits nothing', () => {
  test('a volunteer_id that does not exist in this organization is refused, and no account is created', async () => {
    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'typo-vol@example.com',
        organizationId: ORG_A,
        role: 'volunteer',
        volunteer: { volunteerId: 'not-a-real-id' },
      }),
    ).rejects.toThrow('Missing volunteer_id');

    await expect(accountExists('typo-vol@example.com')).resolves.toBe(false);
  });

  test('a volunteer_id already linked to a different account is refused, and no account is created', async () => {
    // pilot.volunteers.account_id carries a foreign key, so the owning
    // account has to exist first -- created directly rather than through
    // createOrUpdateMicrosoftStaffAccount so this fixture does not itself
    // depend on the volunteer-linking behavior under test.
    await client.query(
      `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag)
       values ('existing-owner@example.com', 'existing-owner@example.com', 'microsoft', 'volunteer', $1, false, null, null, true)`,
      [ORG_A],
    );

    const takenId = await volunteers.createVolunteer(
      {
        organizationId: ORG_A,
        fullName: 'Already Linked',
        roleFocus: null,
        availability: null,
        certificationStatus: null,
        backgroundCheckStatus: null,
        accountId: 'existing-owner@example.com',
      },
    );

    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'newcomer@example.com',
        organizationId: ORG_A,
        role: 'volunteer',
        volunteer: { volunteerId: takenId },
      }),
    ).rejects.toThrow('Forbidden: this volunteer roster row is already linked to a different account');

    await expect(accountExists('newcomer@example.com')).resolves.toBe(false);

    const row = await volunteers.getVolunteer(ORG_A, takenId);
    expect(row?.account_id).toBe('existing-owner@example.com');
  });

  // Organization scoping matters here for the same reason it matters for
  // guardian links: a volunteer_id is not a secret, and this must not let one
  // gym's invite reach into another gym's roster.
  test('a volunteer_id belonging to another organization is refused', async () => {
    const otherOrgId = await volunteers.createVolunteer({
      organizationId: ORG_B,
      fullName: 'Org B Volunteer',
      roleFocus: null,
      availability: null,
      certificationStatus: null,
      backgroundCheckStatus: null,
    });

    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'crossorg-vol@example.com',
        organizationId: ORG_A,
        role: 'volunteer',
        volunteer: { volunteerId: otherOrgId },
      }),
    ).rejects.toThrow('Missing volunteer_id');

    await expect(accountExists('crossorg-vol@example.com')).resolves.toBe(false);
  });
});

describe('a volunteer roster link is refused on every other role', () => {
  test('passing volunteer detail to a coach invite is forbidden', async () => {
    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'coach-with-volunteer@example.com',
        organizationId: ORG_A,
        role: 'coach',
        volunteer: { fullName: 'Should Not Land' },
      }),
    ).rejects.toThrow('Forbidden: a volunteer roster link belongs only to the volunteer role');

    await expect(accountExists('coach-with-volunteer@example.com')).resolves.toBe(false);
  });
});
