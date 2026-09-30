// Real PostgreSQL-backed test for the guardian-record claim in
// createOrUpdateMicrosoftStaffAccount.
//
// WHY THIS IS A REAL-POSTGRES TEST. The bug it pins was invisible to mocks by
// construction. The lookup asked pilot.parents for rows matching
// `account_id = $account or parent_id = 'par-' || $account`, and the mocked
// client in staffProvisioning.test.ts answered that query with whatever rows
// the test handed it -- so every test passed while the real predicate matched
// nothing. The roster import (scripts/seed-data.ts, #281) writes a guardian
// with a CONTENT-HASHED parent_id and account_id NULL, which satisfies neither
// side of that OR. The invite therefore inserted a second pilot.parents row for
// the same human: the account attached to the new row, and the guardian_links
// the import had already written for every sibling stayed on the orphaned one.
// The guardian signed in, the page rendered healthy, and they saw exactly the
// one child named in their invite.
//
// Only the real table can show that. The assertions below count rows in
// pilot.parents and follow pilot.guardian_links, rather than inspecting which
// SQL the module chose to send.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-claim-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_guardian_claim';

const ORG = 'org-claim';
const COACH_ID = 'acct-claim-coach';

// The two siblings the import links to one guardian. The whole point of the
// claim is that inviting the guardian about ONE of them must not lose the other.
const ATHLETE_A = 'ATH-CLAIM-A';
const ATHLETE_B = 'ATH-CLAIM-B';

// A third athlete, in the same org, belonging to a different family.
const ATHLETE_C = 'ATH-CLAIM-C';

// Shaped exactly like scripts/seed-data.ts writes it: `par_<org>_<sha256[:24]>`.
const IMPORTED_PARENT_ID = 'par_org-claim_9f2c4a7b18d3e05f6a2c4b19';
const IMPORTED_EMAIL = 'dana.guardian@example.org';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let staffProvisioning: typeof import('./staffProvisioning');
let auth: typeof import('./auth');
let intake: typeof import('./intake');
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

async function insertAthlete(client: Client, athleteId: string, fullName: string): Promise<void> {
  await client.query(
    `insert into pilot.athletes (
       organization_id, athlete_id, full_name, dob, weight_class, gym_status,
       emergency_contact, active_flag, coach_id, created_at, updated_at
     ) values ($1, $2, $3, '2012-05-01', 'youth-60kg', 'active', 'n/a', true, $4, now(), now())`,
    [ORG, athleteId, fullName, COACH_ID],
  );
}

/**
 * Writes a guardian the way the ROSTER IMPORT does, which is the precondition
 * for everything below: a pilot.parents row with a content-hashed parent_id and
 * NO account_id, plus one guardian_link per athlete on the roster.
 *
 * account_id is left NULL deliberately -- importing a family must not mint a
 * login (see docs/pinPolicy.ts: the account is created when you are with the
 * athlete, not in a batch the week before).
 */
async function insertImportedGuardian(options: {
  parentId: string;
  email: string | null;
  athleteIds: readonly string[];
  fullName?: string;
}): Promise<void> {
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, email)
     values ($1, $2, null, $3, $4)`,
    [ORG, options.parentId, options.fullName ?? 'Dana Guardian', options.email],
  );
  for (const athleteId of options.athleteIds) {
    await db.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother')`,
      [ORG, options.parentId, athleteId],
    );
  }
}

async function parentsFor(email: string): Promise<Array<{ parent_id: string; account_id: string | null }>> {
  return db.query<{ parent_id: string; account_id: string | null }>(
    `select parent_id, account_id
     from pilot.parents
     where organization_id = $1 and lower(trim(coalesce(email, ''))) = $2
     order by parent_id asc`,
    [ORG, email],
  );
}

async function linkedAthletesFor(parentId: string): Promise<string[]> {
  const rows = await db.query<{ athlete_id: string }>(
    `select athlete_id from pilot.guardian_links
     where organization_id = $1 and parent_id = $2
     order by athlete_id asc`,
    [ORG, parentId],
  );
  return rows.map((row) => row.athlete_id);
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
  // pilot.parents, pilot.guardian_links, pilot.accounts and
  // pilot.organization_memberships are all base-schema; no incremental
  // migration participates in the claim. The retention migration is applied
  // for pilot.accounts.deleted_at, which intake's guardian-login checks read
  // (the deleted-login cases at the bottom). Production applies it through
  // apply-migrations.yml's data-retention-deletion entry.
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_data_retention_deletion_migration.sql'), 'utf8'),
  );

  await migrateClient.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG],
  );
  await migrateClient.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
     values ($1, 'coach', $2, 'microsoft', 'claim-coach@example.org', true)`,
    [COACH_ID, ORG],
  );
  await insertAthlete(migrateClient, ATHLETE_A, 'Sibling A');
  await insertAthlete(migrateClient, ATHLETE_B, 'Sibling B');
  await insertAthlete(migrateClient, ATHLETE_C, 'Unrelated C');
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  staffProvisioning = await import('./staffProvisioning');
  auth = await import('./auth');
  intake = await import('./intake');
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

// Each test owns its guardian rows so one test's claim cannot satisfy the next.
afterEach(async () => {
  await db.query('delete from pilot.guardian_links where organization_id = $1', [ORG]);
  await db.query('delete from pilot.parents where organization_id = $1', [ORG]);
  await db.query(
    `delete from pilot.organization_memberships
     where organization_id = $1 and account_id <> $2`,
    [ORG, COACH_ID],
  );
  await db.query('delete from pilot.accounts where organization_id = $1 and account_id <> $2', [ORG, COACH_ID]);
});

describe('inviting a guardian the roster import already wrote', () => {
  test('claims the imported record and keeps every sibling link on it', async () => {
    await insertImportedGuardian({
      parentId: IMPORTED_PARENT_ID,
      email: IMPORTED_EMAIL,
      athleteIds: [ATHLETE_A, ATHLETE_B],
    });

    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: IMPORTED_EMAIL,
      organizationId: ORG,
      role: 'parent',
      guardian: { athleteId: ATHLETE_A, fullName: 'Dana Guardian', relationshipToAthlete: 'mother' },
    });

    // The imported id, not par-<accountId>. guardian_links key on parent_id, so
    // this is the difference between keeping the family and splitting it.
    expect(result.guardianLink).toEqual({ parentId: IMPORTED_PARENT_ID, athleteId: ATHLETE_A });

    // Exactly one guardian record for this human. Before the fix there were two.
    const parents = await parentsFor(IMPORTED_EMAIL);
    expect(parents).toHaveLength(1);
    expect(parents[0]).toEqual({ parent_id: IMPORTED_PARENT_ID, account_id: IMPORTED_EMAIL });

    // Both children, though the invite named only one. This is the assertion
    // that fails when the claim regresses: the second sibling is the one the
    // guardian silently loses.
    expect(await linkedAthletesFor(IMPORTED_PARENT_ID)).toEqual([ATHLETE_A, ATHLETE_B]);

    // And nothing was stranded under the derived id.
    const derived = await db.query<{ parent_id: string }>(
      'select parent_id from pilot.parents where organization_id = $1 and parent_id = $2',
      [ORG, `par-${IMPORTED_EMAIL}`],
    );
    expect(derived).toHaveLength(0);
  });

  test('matches on the normalized address, so roster casing and stray spaces still claim', async () => {
    await insertImportedGuardian({
      parentId: IMPORTED_PARENT_ID,
      email: IMPORTED_EMAIL,
      athleteIds: [ATHLETE_A, ATHLETE_B],
    });

    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: `  ${IMPORTED_EMAIL.toUpperCase()} `,
      organizationId: ORG,
      role: 'parent',
      guardian: { athleteId: ATHLETE_B, fullName: 'Dana Guardian', relationshipToAthlete: 'mother' },
    });

    expect(result.guardianLink?.parentId).toBe(IMPORTED_PARENT_ID);
    expect(await parentsFor(IMPORTED_EMAIL)).toHaveLength(1);
    expect(await linkedAthletesFor(IMPORTED_PARENT_ID)).toEqual([ATHLETE_A, ATHLETE_B]);
  });

  test('a second invite for the other sibling still resolves to the one record', async () => {
    await insertImportedGuardian({
      parentId: IMPORTED_PARENT_ID,
      email: IMPORTED_EMAIL,
      athleteIds: [ATHLETE_A],
    });

    await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: IMPORTED_EMAIL,
      organizationId: ORG,
      role: 'parent',
      guardian: { athleteId: ATHLETE_A, fullName: 'Dana Guardian', relationshipToAthlete: 'mother' },
    });

    // Second invite: same guardian, different child. Now the account owns the
    // record, so this exercises the already-claimed path rather than the claim.
    const second = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: IMPORTED_EMAIL,
      organizationId: ORG,
      role: 'parent',
      guardian: { athleteId: ATHLETE_B, fullName: 'Dana Guardian', relationshipToAthlete: 'mother' },
    });

    expect(second.guardianLink?.parentId).toBe(IMPORTED_PARENT_ID);
    expect(await parentsFor(IMPORTED_EMAIL)).toHaveLength(1);
    expect(await linkedAthletesFor(IMPORTED_PARENT_ID)).toEqual([ATHLETE_A, ATHLETE_B]);
  });

  test('refuses to claim an unclaimed record that carries a different address', async () => {
    // Sits exactly on the derived id, so the fallback would collide with it.
    await insertImportedGuardian({
      parentId: `par-${IMPORTED_EMAIL}`,
      email: 'someone.else@example.org',
      athleteIds: [ATHLETE_C],
      fullName: 'Unrelated Guardian',
    });

    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: IMPORTED_EMAIL,
        organizationId: ORG,
        role: 'parent',
        guardian: { athleteId: ATHLETE_A, fullName: 'Dana Guardian', relationshipToAthlete: 'mother' },
      }),
    ).rejects.toThrow('Forbidden: guardian record id is already in use by another guardian');

    // The other family keeps their child, and no link was written.
    expect(await linkedAthletesFor(`par-${IMPORTED_EMAIL}`)).toEqual([ATHLETE_C]);
  });

  test('refuses to guess when two unclaimed records carry the same address', async () => {
    await insertImportedGuardian({
      parentId: 'par_org-claim_aaaaaaaaaaaaaaaaaaaaaaaa',
      email: IMPORTED_EMAIL,
      athleteIds: [ATHLETE_A],
    });
    await insertImportedGuardian({
      parentId: 'par_org-claim_bbbbbbbbbbbbbbbbbbbbbbbb',
      email: IMPORTED_EMAIL,
      athleteIds: [ATHLETE_B],
    });

    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: IMPORTED_EMAIL,
        organizationId: ORG,
        role: 'parent',
        guardian: { athleteId: ATHLETE_A, fullName: 'Dana Guardian', relationshipToAthlete: 'mother' },
      }),
    ).rejects.toThrow('Conflict: more than one unclaimed guardian record carries this email address');

    // Claiming either would have stranded the other's child, so it wrote
    // nothing and left both families intact for a human to reconcile.
    expect(await parentsFor(IMPORTED_EMAIL)).toHaveLength(2);
    expect(await linkedAthletesFor('par_org-claim_aaaaaaaaaaaaaaaaaaaaaaaa')).toEqual([ATHLETE_A]);
    expect(await linkedAthletesFor('par_org-claim_bbbbbbbbbbbbbbbbbbbbbbbb')).toEqual([ATHLETE_B]);
  });

  test('an imported record with no email is not claimed, and says so by leaving a second row', async () => {
    // The documented limitation, pinned rather than left to be discovered. The
    // importer allows a guardian with a phone and no email; nothing but the
    // name is left to match on, and merging two families because two adults
    // share a name is worse than the duplicate. A human reconciles this one.
    await insertImportedGuardian({
      parentId: 'par_org-claim_cccccccccccccccccccccccc',
      email: null,
      athleteIds: [ATHLETE_A],
    });

    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: IMPORTED_EMAIL,
      organizationId: ORG,
      role: 'parent',
      guardian: { athleteId: ATHLETE_B, fullName: 'Dana Guardian', relationshipToAthlete: 'mother' },
    });

    expect(result.guardianLink?.parentId).toBe(`par-${IMPORTED_EMAIL}`);
    expect(await linkedAthletesFor('par_org-claim_cccccccccccccccccccccccc')).toEqual([ATHLETE_A]);
    expect(await linkedAthletesFor(`par-${IMPORTED_EMAIL}`)).toEqual([ATHLETE_B]);
  });
});

// R5 (Jason 2026-09-29, "A"). Intake promotion provisions the guardian's login
// through createOrUpdateMicrosoftStaffAccount with role parent, and that
// function re-roles an existing account to the role it is given. A guardian
// email that belonged to a coach turned the coach's login into a parent login.
// Intake now refuses, before its first write, and provisioning refuses too
// when intake asks it to. These run the real lookups against real rows.
async function accountRow(accountId: string) {
  const rows = await db.query<Record<string, unknown>>(
    `select account_id, login_email, auth_provider, role, organization_id, athlete_id,
            pin_hash, active_flag, is_platform_owner, deleted_at, updated_at
     from pilot.accounts where account_id = $1`,
    [accountId],
  );
  return rows[0];
}

async function membershipsOf(accountId: string) {
  return db.query<{ role: string; active_flag: boolean }>(
    'select role, active_flag from pilot.organization_memberships where account_id = $1 order by organization_id',
    [accountId],
  );
}

async function guardianRowCount(): Promise<number> {
  const parents = await db.query<{ n: string }>(
    'select count(*)::text as n from pilot.parents where organization_id = $1',
    [ORG],
  );
  const links = await db.query<{ n: string }>(
    'select count(*)::text as n from pilot.guardian_links where organization_id = $1',
    [ORG],
  );
  return Number(parents[0].n) + Number(links[0].n);
}

describe('intake refuses to turn an existing non-parent account into a guardian login', () => {
  const COACH_EMAIL = 'claim-coach@example.org';

  test('the pre-write check refuses the coach\'s email with 409, matched as sign-in matches it', async () => {
    const before = await accountRow(COACH_ID);

    await expect(
      staffProvisioning.assertGuardianLoginProvisionable({
        loginEmail: `  ${COACH_EMAIL.toUpperCase()} `,
        organizationId: ORG,
        accountIdHint: COACH_ID,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'EXISTING_ACCOUNT_ROLE_CONFLICT',
      message: expect.stringContaining(`${COACH_EMAIL} already belongs to an existing coach account`),
    });

    expect(await accountRow(COACH_ID)).toEqual(before);
    expect(await guardianRowCount()).toBe(0);
  });

  test('the pre-write check refuses the coach\'s account_id named under a new email', async () => {
    await expect(
      staffProvisioning.assertGuardianLoginProvisionable({
        loginEmail: 'brand.new.guardian@example.org',
        organizationId: ORG,
        accountIdHint: COACH_ID,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`account_id "${COACH_ID}" already belongs to an existing coach account`),
    });
  });

  test('provisioning with refuseRoleChange refuses the coach and writes nothing', async () => {
    const sessionHash = 'r5-coach-session';
    await db.query(
      'insert into pilot.session_tokens (token_hash, account_id, organization_id) values ($1, $2, $3)',
      [sessionHash, COACH_ID, ORG],
    );
    const before = await accountRow(COACH_ID);

    try {
      await expect(
        staffProvisioning.createOrUpdateMicrosoftStaffAccount({
          loginEmail: COACH_EMAIL,
          organizationId: ORG,
          role: 'parent',
          accountIdHint: COACH_ID,
          refuseRoleChange: true,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'EXISTING_ACCOUNT_ROLE_CONFLICT' });

      // Still a coach, untouched: role, credential, active flag, updated_at.
      expect(await accountRow(COACH_ID)).toEqual(before);
      // No parent membership, no guardian record or link, and the coach's
      // session was not revoked.
      const memberships = await db.query<{ role: string }>(
        'select role from pilot.organization_memberships where account_id = $1',
        [COACH_ID],
      );
      expect(memberships).toEqual([]);
      expect(await guardianRowCount()).toBe(0);
      const sessions = await db.query<{ revoked_at: string | null }>(
        'select revoked_at from pilot.session_tokens where token_hash = $1',
        [sessionHash],
      );
      expect(sessions).toEqual([{ revoked_at: null }]);
    } finally {
      await db.query('delete from pilot.session_tokens where token_hash = $1', [sessionHash]);
    }
  });

  test('an existing parent login passes the check and is provisioned without a role change', async () => {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
       values ('acct-r5-parent', 'parent', $1, 'microsoft', 'r5.parent@example.org', true)`,
      [ORG],
    );

    await expect(
      staffProvisioning.assertGuardianLoginProvisionable({
        loginEmail: 'r5.parent@example.org',
        organizationId: ORG,
        accountIdHint: 'acct-r5-parent',
      }),
    ).resolves.toBeUndefined();

    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'r5.parent@example.org',
      organizationId: ORG,
      role: 'parent',
      accountIdHint: 'acct-r5-parent',
      refuseRoleChange: true,
    });

    expect(result.accountId).toBe('acct-r5-parent');
    expect((await accountRow('acct-r5-parent')).role).toBe('parent');
  });

  // Scope of the rule: the invite surfaces re-role on purpose and keep doing so.
  test('an invite without refuseRoleChange still changes an existing account\'s role', async () => {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
       values ('acct-r5-staff', 'staff', $1, 'microsoft', 'r5.staff@example.org', true)`,
      [ORG],
    );

    await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'r5.staff@example.org',
      organizationId: ORG,
      role: 'coach',
    });

    expect((await accountRow('acct-r5-staff')).role).toBe('coach');
  });

  // The athlete side of the same rule: createOrUpdateAthleteAccount would
  // re-role the coach into a locked athlete account.
  test('an athlete account_id naming the coach is refused 409 and the coach is untouched', async () => {
    const before = await accountRow(COACH_ID);

    await expect(
      intake.assertAthleteAccountIdProvisionable({ accountId: COACH_ID, athleteId: ATHLETE_C, organizationId: ORG }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'EXISTING_ACCOUNT_ROLE_CONFLICT',
      message: expect.stringContaining(`account_id "${COACH_ID}" already belongs to an existing coach account`),
    });

    expect(await accountRow(COACH_ID)).toEqual(before);
    await expect(
      intake.assertAthleteAccountIdProvisionable({
        accountId: 'acct-r5-new-athlete',
        athleteId: ATHLETE_C,
        organizationId: ORG,
      }),
    ).resolves.toBeUndefined();
  });
});

// createOrUpdateAthleteAccount's update branch sets role athlete, sets
// athlete_id to the promoted athlete, clears the PIN, deactivates the login and
// revokes its sessions. Pointed at another child's athlete login it re-bound
// that login to the promoted child: the first child was locked out, and the
// next activation code for the login showed the promoted child's records to
// the first child's family. Pointed at the coach it made the coach a locked
// athlete login. The pre-write check refuses both, and so does the write.
describe('intake does not re-bind another child\'s login, or re-role an account, as an athlete login', () => {
  const CHILD_A_LOGIN = 'acct-claim-child-a';

  async function insertChildALogin(): Promise<void> {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag)
       values ($1, 'athlete', $2, $3, 'child-a-pin-hash', true)`,
      [CHILD_A_LOGIN, ORG, ATHLETE_A],
    );
    await db.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'athlete', true)`,
      [CHILD_A_LOGIN, ORG],
    );
  }

  test('the pre-write check refuses child A\'s login named for athlete B with 409, and allows it for A', async () => {
    await insertChildALogin();

    await expect(
      intake.assertAthleteAccountIdProvisionable({ accountId: CHILD_A_LOGIN, athleteId: ATHLETE_B, organizationId: ORG }),
    ).rejects.toMatchObject({ status: 409, code: 'EXISTING_ATHLETE_ACCOUNT_CONFLICT' });

    await expect(
      intake.assertAthleteAccountIdProvisionable({ accountId: CHILD_A_LOGIN, athleteId: ATHLETE_A, organizationId: ORG }),
    ).resolves.toBeUndefined();
  });

  test('the write refuses to re-bind child A\'s login to athlete B and leaves the login untouched', async () => {
    await insertChildALogin();
    const sessionHash = 'claim-child-a-session';
    await db.query(
      'insert into pilot.session_tokens (token_hash, account_id, organization_id) values ($1, $2, $3)',
      [sessionHash, CHILD_A_LOGIN, ORG],
    );
    const before = await accountRow(CHILD_A_LOGIN);

    await expect(auth.createOrUpdateAthleteAccount(CHILD_A_LOGIN, ATHLETE_B, ORG))
      .rejects.toMatchObject({ status: 409, code: 'EXISTING_ATHLETE_ACCOUNT_CONFLICT' });

    // Still child A's: bound to A, PIN kept, active, not rewritten.
    expect(await accountRow(CHILD_A_LOGIN)).toEqual(before);
    expect(before).toMatchObject({ athlete_id: ATHLETE_A, pin_hash: 'child-a-pin-hash', active_flag: true });
    expect(await membershipsOf(CHILD_A_LOGIN)).toEqual([{ role: 'athlete', active_flag: true }]);
    const sessions = await db.query<{ revoked_at: string | null }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [sessionHash],
    );
    expect(sessions).toEqual([{ revoked_at: null }]);
  });

  test('the write refuses to make the coach\'s login an athlete login and leaves it untouched', async () => {
    const before = await accountRow(COACH_ID);

    await expect(auth.createOrUpdateAthleteAccount(COACH_ID, ATHLETE_C, ORG))
      .rejects.toMatchObject({ status: 409, code: 'EXISTING_ATHLETE_ACCOUNT_CONFLICT' });

    expect(await accountRow(COACH_ID)).toEqual(before);
    expect(await membershipsOf(COACH_ID)).toEqual([]);
  });

  test('re-provisioning child A\'s own login, or an athlete login bound to no record, still works', async () => {
    await insertChildALogin();

    await auth.createOrUpdateAthleteAccount(CHILD_A_LOGIN, ATHLETE_A, ORG);

    expect(await accountRow(CHILD_A_LOGIN)).toMatchObject({
      role: 'athlete',
      athlete_id: ATHLETE_A,
      pin_hash: null,
      active_flag: false,
    });

    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, active_flag)
       values ('acct-claim-unbound', 'athlete', $1, null, false)`,
      [ORG],
    );

    await auth.createOrUpdateAthleteAccount('acct-claim-unbound', ATHLETE_B, ORG);

    expect(await accountRow('acct-claim-unbound')).toMatchObject({ role: 'athlete', athlete_id: ATHLETE_B });
  });
});

// Provisioning's upsert sets active_flag and the membership back to true and
// reads nothing about deleted_at. Intake promoting a new child under a deleted
// guardian's old email brought that login back, and the retention purge
// (deleted_at older than a year, role parent, active_flag not read) would
// later hard-delete it and its guardian records while it was live.
describe('intake does not restore a deleted guardian login', () => {
  const DELETED_EMAIL = 'claim.deleted.guardian@example.org';
  const DELETED_ID = 'acct-claim-deleted-parent';

  async function insertDeletedParentLogin(): Promise<void> {
    // The state deleteGuardianAccount leaves: deleted_at set, login and
    // membership inactive.
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag, deleted_at)
       values ($1, 'parent', $2, 'microsoft', $3, false, now() - interval '30 days')`,
      [DELETED_ID, ORG, DELETED_EMAIL],
    );
    await db.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'parent', false)`,
      [DELETED_ID, ORG],
    );
  }

  test('the pre-write check refuses it with 409, matched as sign-in matches it', async () => {
    await insertDeletedParentLogin();

    await expect(
      staffProvisioning.assertGuardianLoginProvisionable({
        loginEmail: `  ${DELETED_EMAIL.toUpperCase()} `,
        organizationId: ORG,
        accountIdHint: DELETED_ID,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'DELETED_GUARDIAN_LOGIN' });
  });

  test('provisioning as intake calls it refuses it and leaves it deleted and inactive', async () => {
    await insertDeletedParentLogin();
    const before = await accountRow(DELETED_ID);

    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: DELETED_EMAIL,
        organizationId: ORG,
        role: 'parent',
        accountIdHint: DELETED_ID,
        refuseRoleChange: true,
        refuseDeletedLogin: true,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'DELETED_GUARDIAN_LOGIN' });

    expect(await accountRow(DELETED_ID)).toEqual(before);
    expect(before).toMatchObject({ active_flag: false });
    expect(before.deleted_at).not.toBeNull();
    expect(await membershipsOf(DELETED_ID)).toEqual([{ role: 'parent', active_flag: false }]);
    expect(await guardianRowCount()).toBe(0);
  });
});
