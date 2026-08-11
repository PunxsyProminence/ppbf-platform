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
  // migration participates in the claim, so none is applied.
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));

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
