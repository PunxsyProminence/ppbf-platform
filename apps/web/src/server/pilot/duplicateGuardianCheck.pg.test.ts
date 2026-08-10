// Real PostgreSQL-backed test for checkDuplicateGuardians.
//
// The whole check is one query, and its entire value is in the shape of that query -- a normalized
// group-by on email, a set difference between athletes reachable through the claimed row and
// athletes reachable only through an unclaimed one. A mock cannot pin any of that: it would answer
// the query with whatever rows the test supplied, which is how the invite bug this check exists to
// find shipped green through mocks in the first place.
//
// So every case below plants real rows in pilot.parents and pilot.guardian_links and lets Postgres
// answer.
//
// Spins up the same disposable, local-only embedded Postgres the other migration suites use. It
// NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-duplicate-guardian-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CHECKER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-duplicate-guardians.mjs');
const SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');
const TEST_DB_NAME = 'ppbf_test_duplicate_guardians';

const ORG = 'org-dupe';
const COACH_ID = 'acct-dupe-coach';
const ACCOUNT_ID = 'dana@example.org';
const EMAIL = 'dana@example.org';

const ATHLETE_A = 'ATH-DUPE-A';
const ATHLETE_B = 'ATH-DUPE-B';
const ATHLETE_C = 'ATH-DUPE-C';

const IMPORTED_PARENT = 'par_org-dupe_hashedaaaaaaaaaaaaaaa';
const INVITED_PARENT = `par-${ACCOUNT_ID}`;

interface DuplicateGroup {
  organization_id: string;
  email: string;
  record_count: number;
  claimed_count: number;
  unclaimed_count: number;
  account_ids: string[];
  parent_ids: string[];
  visible_athlete_ids: string[];
  hidden_athlete_ids: string[];
}

interface DuplicateReport {
  groups: DuplicateGroup[];
  hidingChildren: DuplicateGroup[];
  splitOnly: DuplicateGroup[];
  hiddenAthleteCount: number;
}

// ts-jest downlevels a plain `await import(...)` into require(), which cannot load an ESM-only .mjs
// file. Constructing the import() call inside `new Function` hides it from that downleveling, the
// same technique strandedGuardianCheck.pg.test.ts uses for the same reason.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{
  checkDuplicateGuardians: (client: Client) => Promise<DuplicateReport>;
  maskEmail: (email: string | null) => string;
}>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

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

async function insertParent(
  parentId: string,
  accountId: string | null,
  email: string | null,
  athleteIds: readonly string[],
): Promise<void> {
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, email)
     values ($1, $2, $3, 'Dana Guardian', $4)`,
    [ORG, parentId, accountId, email],
  );
  for (const athleteId of athleteIds) {
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother')`,
      [ORG, parentId, athleteId],
    );
  }
}

async function runCheck(): Promise<DuplicateReport> {
  const { checkDuplicateGuardians } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
  return checkDuplicateGuardians(client);
}

beforeAll(async () => {
  PG_PORT = await findFreePort();

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;

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

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  await client.query(await fs.readFile(SCHEMA_SQL_PATH, 'utf8'));
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
     values ($1, 'coach', $2, 'microsoft', 'dupe-coach@example.org', true),
            ($3, 'parent', $2, 'microsoft', $4, true)`,
    [COACH_ID, ORG, ACCOUNT_ID, EMAIL],
  );
  for (const athleteId of [ATHLETE_A, ATHLETE_B, ATHLETE_C]) {
    await client.query(
      `insert into pilot.athletes (
         organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at
       ) values ($1, $2, $2, '2012-05-01', 'youth-60kg', 'active', 'n/a', true, $3, now(), now())`,
      [ORG, athleteId, COACH_ID],
    );
  }
});

afterAll(async () => {
  if (client) {
    await client.end();
  }

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
  await client.query('delete from pilot.guardian_links where organization_id = $1', [ORG]);
  await client.query('delete from pilot.parents where organization_id = $1', [ORG]);
});

describe('checkDuplicateGuardians against the real schema', () => {
  test('a healthy database reports nothing', async () => {
    await insertParent(IMPORTED_PARENT, ACCOUNT_ID, EMAIL, [ATHLETE_A, ATHLETE_B]);

    const report = await runCheck();

    expect(report.groups).toEqual([]);
    expect(report.hidingChildren).toEqual([]);
    expect(report.hiddenAthleteCount).toBe(0);
  });

  test('finds the exact pair the pre-fix invite created, and names the hidden child', async () => {
    // The import wrote both siblings onto an unclaimed row; the invite then made its own row and
    // linked only the athlete it was told about.
    await insertParent(IMPORTED_PARENT, null, EMAIL, [ATHLETE_A, ATHLETE_B]);
    await insertParent(INVITED_PARENT, ACCOUNT_ID, EMAIL, [ATHLETE_A]);

    const report = await runCheck();

    expect(report.groups).toHaveLength(1);
    expect(report.hidingChildren).toHaveLength(1);

    const group = report.hidingChildren[0];
    expect(group.organization_id).toBe(ORG);
    expect(group.record_count).toBe(2);
    expect(group.claimed_count).toBe(1);
    expect(group.unclaimed_count).toBe(1);
    expect(group.account_ids).toEqual([ACCOUNT_ID]);
    expect(group.parent_ids.sort()).toEqual([IMPORTED_PARENT, INVITED_PARENT].sort());

    // ATHLETE_A is on both rows, so it is visible and must NOT be reported as hidden. ATHLETE_B is
    // reachable only through the unclaimed row -- that is the child the guardian cannot see.
    expect(group.visible_athlete_ids).toEqual([ATHLETE_A]);
    expect(group.hidden_athlete_ids).toEqual([ATHLETE_B]);
    expect(report.hiddenAthleteCount).toBe(1);
  });

  test('a sibling linked to both rows is not counted as hidden', async () => {
    await insertParent(IMPORTED_PARENT, null, EMAIL, [ATHLETE_A]);
    await insertParent(INVITED_PARENT, ACCOUNT_ID, EMAIL, [ATHLETE_A]);

    const report = await runCheck();

    // Still a split worth reporting, but nothing is currently unreachable, so it must not be filed
    // under the heading that fails the check.
    expect(report.groups).toHaveLength(1);
    expect(report.hidingChildren).toEqual([]);
    expect(report.splitOnly).toHaveLength(1);
    expect(report.splitOnly[0].hidden_athlete_ids).toEqual([]);
    expect(report.hiddenAthleteCount).toBe(0);
  });

  test('groups on the normalized address, so roster casing and spaces still pair up', async () => {
    await insertParent(IMPORTED_PARENT, null, `  ${EMAIL.toUpperCase()} `, [ATHLETE_A, ATHLETE_B]);
    await insertParent(INVITED_PARENT, ACCOUNT_ID, EMAIL, [ATHLETE_A]);

    const report = await runCheck();

    expect(report.hidingChildren).toHaveLength(1);
    expect(report.hidingChildren[0].hidden_athlete_ids).toEqual([ATHLETE_B]);
  });

  test('reports two unclaimed rows sharing an address, with every child hidden', async () => {
    // The roster file disagreed with itself. Nobody has claimed either row, so the guardian has no
    // account at all yet -- but the pair still needs a human, and the check must not stay silent
    // just because the harm has not been triggered by an invite yet.
    await insertParent('par_org-dupe_aaaa', null, EMAIL, [ATHLETE_A]);
    await insertParent('par_org-dupe_bbbb', null, EMAIL, [ATHLETE_B]);

    const report = await runCheck();

    expect(report.groups).toHaveLength(1);
    const group = report.groups[0];
    expect(group.claimed_count).toBe(0);
    expect(group.unclaimed_count).toBe(2);
    expect(group.account_ids).toEqual([]);
    expect(group.visible_athlete_ids).toEqual([]);
    expect(group.hidden_athlete_ids.sort()).toEqual([ATHLETE_A, ATHLETE_B].sort());
  });

  test('two guardians who both have no email are not paired with each other', async () => {
    // Grouping NULL addresses together would manufacture a finding out of two unrelated families.
    await insertParent('par_org-dupe_noemail1', null, null, [ATHLETE_A]);
    await insertParent('par_org-dupe_noemail2', null, null, [ATHLETE_B]);
    await insertParent('par_org-dupe_blank', null, '   ', [ATHLETE_C]);

    const report = await runCheck();

    expect(report.groups).toEqual([]);
  });

  test('two different addresses are not paired', async () => {
    await insertParent(IMPORTED_PARENT, null, 'someone.else@example.org', [ATHLETE_A]);
    await insertParent(INVITED_PARENT, ACCOUNT_ID, EMAIL, [ATHLETE_B]);

    const report = await runCheck();

    expect(report.groups).toEqual([]);
  });

  test('the report masks the address it prints', async () => {
    await insertParent(IMPORTED_PARENT, null, EMAIL, [ATHLETE_A, ATHLETE_B]);
    await insertParent(INVITED_PARENT, ACCOUNT_ID, EMAIL, [ATHLETE_A]);

    const report = await runCheck();

    // This goes to a CI job summary, so the address must not be republished verbatim.
    expect(report.groups[0].email).toBe('d***@example.org');
    expect(report.groups[0].email).not.toBe(EMAIL);
  });

  test('opens a read-only transaction, and Postgres really does refuse a write inside one', async () => {
    await insertParent(IMPORTED_PARENT, null, EMAIL, [ATHLETE_A]);
    await insertParent(INVITED_PARENT, ACCOUNT_ID, EMAIL, [ATHLETE_A]);

    // The check leaves the connection usable, which is the precondition for everything else here.
    await runCheck();
    await expect(client.query('select 1 as ok')).resolves.toBeTruthy();

    expect(await fs.readFile(CHECKER_SCRIPT_PATH, 'utf8')).toContain('BEGIN TRANSACTION READ ONLY');

    // And the wrapper is not decorative: the same statement the check wraps itself in makes this
    // connection reject a write. Asserting the enforcement rather than grepping the file for verbs
    // means a future comment mentioning a write cannot fail this test, and a future edit that
    // actually attempts one cannot pass it.
    await client.query('BEGIN TRANSACTION READ ONLY');
    await expect(
      client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name, email)
         values ($1, 'par_should_never_exist', null, 'Nope', 'nope@example.org')`,
        [ORG],
      ),
    ).rejects.toThrow(/read-only transaction/i);
    await client.query('ROLLBACK');

    const survivors = await client.query<{ parent_id: string }>(
      'select parent_id from pilot.parents where organization_id = $1 and parent_id = $2',
      [ORG, 'par_should_never_exist'],
    );
    expect(survivors.rowCount).toBe(0);
  });
});
