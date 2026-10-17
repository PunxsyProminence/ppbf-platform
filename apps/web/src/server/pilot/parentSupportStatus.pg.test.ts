// Real PostgreSQL contract for what a guardian is shown of their own child's
// membership, scholarship and community-support standing (PH-13, Q-D A):
// each program's standing with its dates; scholarship "yes" only when a
// non-ended membership's percent is above 0, otherwise none_recorded; live
// supports newest first, retired ones gone; never the percent or any note;
// and another family's child, an 18+ child, a deleted child and another gym's
// child are the same 404.
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

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes the module's queries (and guardianAccess's) into the embedded database.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-parent-support-status-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let status: typeof import('./parentSupportStatus');

const ORG = 'org-pss';
const OTHER_ORG = 'org-pss-other';
const OFFICE = 'acct-pss-office';
const OTHER_OFFICE = 'acct-pss-office-b';
const PARENT = 'acct-pss-parent';
const OTHER_PARENT = 'acct-pss-parent-b';
const SECOND_PARENT = 'acct-pss-parent-c'; // a second guardian legitimately linked to CHILD
const UNLINKED_PARENT = 'acct-pss-parent-d'; // was linked to CHILD; the link is removed

const CHILD = 'ATH-PSS-1'; // linked; active scholarship, a lapsed program, an ended one, supports
const ZERO = 'ATH-PSS-2'; // linked; memberships at 0 percent only
const ENDED_ONLY = 'ATH-PSS-3'; // linked; the only scholarship is on an ended membership
const LAPSED = 'ATH-PSS-4'; // linked; a lapsed scholarship
const EMPTY = 'ATH-PSS-5'; // linked; nothing recorded
const ADULT = 'ATH-PSS-6'; // linked; 18 or older
const DELETED = 'ATH-PSS-7'; // linked; deleted
const OTHER_FAMILY = 'ATH-PSS-8'; // linked to another guardian only
const OTHER_GYM = 'ATH-PSS-9'; // another gym, linked there to the same login
const ORDERED = 'ATH-PSS-10'; // linked; an ended row started after the active and lapsed ones

const SECRET_PERCENT = 37;
const SECRET_NOTE = 'Basis: hardship letter on file';
const SECRET_STAFF_NOTE = 'Office only: family asked for privacy';

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

let membershipSeq = 0;
async function membership(
  client: Client,
  values: { org?: string; athleteId: string; program: string; status: string; startedOn: string; endedOn?: string; percent?: number },
) {
  membershipSeq += 1;
  await client.query(
    `insert into pilot.program_memberships
       (organization_id, membership_id, athlete_id, program_name, status, started_on, ended_on,
        scholarship_percent, scholarship_note, notes, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11)`,
    [
      values.org ?? ORG,
      `mem-pss-${membershipSeq}`,
      values.athleteId,
      values.program,
      values.status,
      values.startedOn,
      values.endedOn ?? null,
      values.percent ?? 0,
      SECRET_NOTE,
      SECRET_STAFF_NOTE,
      values.org === OTHER_ORG ? OTHER_OFFICE : OFFICE,
    ],
  );
}

async function support(client: Client, values: { org?: string; athleteId: string; kind: string; providedOn: string }) {
  const result = await client.query(
    `insert into pilot.family_support_records
       (organization_id, athlete_id, support_kind, provided_on, recorded_by_account_id, recorded_by_role)
     values ($1, $2, $3, $4::date, $5, 'organization_admin')
     returning record_id::text as record_id`,
    [values.org ?? ORG, values.athleteId, values.kind, values.providedOn, values.org === OTHER_ORG ? OTHER_OFFICE : OFFICE],
  );
  return result.rows[0].record_id as string;
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

  status = await import('./parentSupportStatus');

  const name = 'ppbf_test_parent_support_status';
  const root = new Client({ connectionString: connectionStringFor('postgres') });
  await root.connect();
  await root.query(`drop database if exists ${name}`);
  await root.query(`create database ${name}`);
  await root.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG, OTHER_ORG]) {
    await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [accountId, role, org] of [
    [OFFICE, 'organization_admin', ORG],
    [OTHER_OFFICE, 'organization_admin', OTHER_ORG],
    [PARENT, 'parent', ORG],
    [OTHER_PARENT, 'parent', ORG],
    [SECOND_PARENT, 'parent', ORG],
    [UNLINKED_PARENT, 'parent', ORG],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, org],
    );
  }
  // The office writes supports through an active seat in its own gym (the table's guard).
  for (const [accountId, org] of [[OFFICE, ORG], [OTHER_OFFICE, OTHER_ORG]] as const) {
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role) values ($1, $2, 'organization_admin')`,
      [accountId, org],
    );
  }
  for (const [org, athleteId, dob] of [
    [ORG, CHILD, '2012-03-04'],
    [ORG, ZERO, '2012-03-04'],
    [ORG, ENDED_ONLY, '2012-03-04'],
    [ORG, LAPSED, '2012-03-04'],
    [ORG, EMPTY, '2012-03-04'],
    [ORG, ADULT, '2000-03-04'],
    [ORG, DELETED, '2012-03-04'],
    [ORG, OTHER_FAMILY, '2012-03-04'],
    [ORG, ORDERED, '2012-03-04'],
    [OTHER_ORG, OTHER_GYM, '2012-03-04'],
    // The same athlete ids in the other gym, so a missing gym predicate would show its rows.
    [OTHER_ORG, CHILD, '2012-03-04'],
    [OTHER_ORG, ZERO, '2012-03-04'],
    [OTHER_ORG, EMPTY, '2012-03-04'],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Status Athlete', $3::date, 'fly', 'active', 'contact', true, $4, now(), now())`,
      [org, athleteId, dob, org === OTHER_ORG ? OTHER_OFFICE : OFFICE],
    );
  }
  for (const [org, parentId, accountId] of [
    [ORG, 'parent-pss-1', PARENT],
    [ORG, 'parent-pss-2', OTHER_PARENT],
    [ORG, 'parent-pss-3', SECOND_PARENT],
    [ORG, 'parent-pss-4', UNLINKED_PARENT],
    [OTHER_ORG, 'parent-pss-x', PARENT],
  ] as const) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'Guardian')`,
      [org, parentId, accountId],
    );
  }
  for (const [org, parentId, athleteId] of [
    [ORG, 'parent-pss-1', CHILD],
    [ORG, 'parent-pss-1', ZERO],
    [ORG, 'parent-pss-1', ENDED_ONLY],
    [ORG, 'parent-pss-1', LAPSED],
    [ORG, 'parent-pss-1', EMPTY],
    [ORG, 'parent-pss-1', ADULT],
    [ORG, 'parent-pss-1', DELETED],
    [ORG, 'parent-pss-1', ORDERED],
    [ORG, 'parent-pss-2', OTHER_FAMILY],
    [ORG, 'parent-pss-3', CHILD],
    [ORG, 'parent-pss-4', CHILD],
    [OTHER_ORG, 'parent-pss-x', OTHER_GYM],
    [OTHER_ORG, 'parent-pss-x', CHILD],
  ] as const) {
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'parent')`,
      [org, parentId, athleteId],
    );
  }

  // CHILD: an active scholarship, a lapsed program, an ended program.
  await membership(client, { athleteId: CHILD, program: 'Youth Boxing', status: 'active', startedOn: '2025-09-01', percent: SECRET_PERCENT });
  await membership(client, { athleteId: CHILD, program: 'Wrestling', status: 'lapsed', startedOn: '2025-01-15' });
  await membership(client, { athleteId: CHILD, program: 'Summer Camp', status: 'ended', startedOn: '2024-06-01', endedOn: '2024-08-15' });
  await support(client, { athleteId: CHILD, kind: 'Gloves and wraps', providedOn: '2025-03-01' });
  await support(client, { athleteId: CHILD, kind: 'Transportation to the regional tournament', providedOn: '2025-09-20' });
  const retired = await support(client, { athleteId: CHILD, kind: 'Entered in error', providedOn: '2025-10-01' });
  await client.query(
    `update pilot.family_support_records set retired_by_account_id = $3 where organization_id = $1 and record_id = $2::uuid`,
    [ORG, retired, OFFICE],
  );

  await membership(client, { athleteId: ZERO, program: 'Youth Boxing', status: 'active', startedOn: '2025-09-01', percent: 0 });
  await membership(client, { athleteId: ENDED_ONLY, program: 'Youth Boxing', status: 'ended', startedOn: '2024-01-01', endedOn: '2024-12-31', percent: 50 });
  await membership(client, { athleteId: ENDED_ONLY, program: 'Youth Boxing', status: 'active', startedOn: '2025-01-01', percent: 0 });
  await membership(client, { athleteId: LAPSED, program: 'Youth Boxing', status: 'lapsed', startedOn: '2025-02-01', percent: 25 });
  // Newest start is the ended one: by start date alone it would come first.
  await membership(client, { athleteId: ORDERED, program: 'Open Gym', status: 'ended', startedOn: '2025-05-01', endedOn: '2025-06-01' });
  await membership(client, { athleteId: ORDERED, program: 'Wrestling', status: 'lapsed', startedOn: '2024-01-01' });
  await membership(client, { athleteId: ORDERED, program: 'Youth Boxing', status: 'active', startedOn: '2023-01-01' });

  // Records on every child the guardian may not read, so a refusal is not an empty answer.
  for (const athleteId of [ADULT, DELETED, OTHER_FAMILY]) {
    await membership(client, { athleteId, program: 'Youth Boxing', status: 'active', startedOn: '2025-09-01', percent: 100 });
    await support(client, { athleteId, kind: 'Fee covered', providedOn: '2025-09-02' });
  }
  // ZERO and EMPTY hold an active 100% scholarship in the other gym: only a
  // missing gym predicate on the scholarship read would make them "yes".
  for (const athleteId of [OTHER_GYM, CHILD, ZERO, EMPTY]) {
    await membership(client, { org: OTHER_ORG, athleteId, program: 'Other Gym Boxing', status: 'active', startedOn: '2025-09-01', percent: 100 });
    await support(client, { org: OTHER_ORG, athleteId, kind: 'Other gym support', providedOn: '2025-09-03' });
  }
  await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, DELETED]);

  activeClient = client;
});

afterAll(async () => {
  await activeClient?.end();
  activeClient = null;
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
  // Windows can hold the folder a moment after Postgres exits; the helper's sweep clears it next run.
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("a guardian's view of their child's membership, scholarship and support (PH-13)", () => {
  test('a linked under-18 child: each program with its standing and dates, scholarship yes, supports newest first', async () => {
    const result = await status.getSupportStatusForGuardian(ORG, PARENT, CHILD);
    expect(result).toEqual({
      memberships: [
        { program_name: 'Youth Boxing', status: 'active', started_on: '2025-09-01', ended_on: null },
        { program_name: 'Wrestling', status: 'lapsed', started_on: '2025-01-15', ended_on: null },
        { program_name: 'Summer Camp', status: 'ended', started_on: '2024-06-01', ended_on: '2024-08-15' },
      ],
      scholarship: 'yes',
      // The retired record is gone; the other gym's rows for the same athlete id are not here.
      supports: [
        { support_kind: 'Transportation to the regional tournament', provided_on: '2025-09-20' },
        { support_kind: 'Gloves and wraps', provided_on: '2025-03-01' },
      ],
    });
  });

  test('never the scholarship percent, the scholarship note, a staff note or a staff id', async () => {
    const result = await status.getSupportStatusForGuardian(ORG, PARENT, CHILD);
    const text = JSON.stringify(result);
    for (const secret of [String(SECRET_PERCENT), SECRET_NOTE, SECRET_STAFF_NOTE, OFFICE, 'scholarship_percent', 'scholarship_note', 'notes', 'record_id', 'membership_id']) {
      expect(text).not.toContain(secret);
    }
    for (const row of result.memberships) expect(Object.keys(row).sort()).toEqual(['ended_on', 'program_name', 'started_on', 'status']);
    for (const row of result.supports) expect(Object.keys(row).sort()).toEqual(['provided_on', 'support_kind']);
  });

  test('0 percent is none recorded; so is a scholarship only on an ended membership; a lapsed one still counts', async () => {
    expect((await status.getSupportStatusForGuardian(ORG, PARENT, ZERO)).scholarship).toBe('none_recorded');
    const endedOnly = await status.getSupportStatusForGuardian(ORG, PARENT, ENDED_ONLY);
    expect(endedOnly.scholarship).toBe('none_recorded');
    expect(endedOnly.memberships).toEqual([
      { program_name: 'Youth Boxing', status: 'active', started_on: '2025-01-01', ended_on: null },
      { program_name: 'Youth Boxing', status: 'ended', started_on: '2024-01-01', ended_on: '2024-12-31' },
    ]);
    const lapsed = await status.getSupportStatusForGuardian(ORG, PARENT, LAPSED);
    expect(lapsed.scholarship).toBe('yes');
    expect(lapsed.memberships).toEqual([{ program_name: 'Youth Boxing', status: 'lapsed', started_on: '2025-02-01', ended_on: null }]);
  });

  test('nothing recorded is empty lists and none_recorded, not a refusal', async () => {
    expect(await status.getSupportStatusForGuardian(ORG, PARENT, EMPTY)).toEqual({
      memberships: [],
      scholarship: 'none_recorded',
      supports: [],
    });
  });

  test.each([
    ['another family\'s child', ORG, OTHER_FAMILY],
    ['an 18+ child', ORG, ADULT],
    ['a deleted child', ORG, DELETED],
    ['another gym\'s child, asked from this gym', ORG, OTHER_GYM],
  ])('%s is the same 404', async (_label, org, athleteId) => {
    await expect(status.getSupportStatusForGuardian(org, PARENT, athleteId))
      .rejects.toMatchObject({ status: 404, message: status.NOT_YOUR_CHILD });
  });

  test('live rows come first even when an ended row started after them', async () => {
    expect((await status.getSupportStatusForGuardian(ORG, PARENT, ORDERED)).memberships).toEqual([
      { program_name: 'Youth Boxing', status: 'active', started_on: '2023-01-01', ended_on: null },
      { program_name: 'Wrestling', status: 'lapsed', started_on: '2024-01-01', ended_on: null },
      { program_name: 'Open Gym', status: 'ended', started_on: '2025-05-01', ended_on: '2025-06-01' },
    ]);
  });

  test("another gym's active 100% scholarship for the same athlete id does not count here", async () => {
    expect((await status.getSupportStatusForGuardian(ORG, PARENT, ZERO)).scholarship).toBe('none_recorded');
    expect((await status.getSupportStatusForGuardian(ORG, PARENT, EMPTY)).scholarship).toBe('none_recorded');
  });

  test('a second guardian legitimately linked to the same child reads the same status', async () => {
    const first = await status.getSupportStatusForGuardian(ORG, PARENT, CHILD);
    expect(await status.getSupportStatusForGuardian(ORG, SECOND_PARENT, CHILD)).toEqual(first);
  });

  test('a guardian whose link was removed is the same 404', async () => {
    // Linked first, so the 404 below is the removal and not a fixture gap.
    expect((await status.getSupportStatusForGuardian(ORG, UNLINKED_PARENT, CHILD)).scholarship).toBe('yes');
    await activeClient!.query(
      `delete from pilot.guardian_links where organization_id = $1 and parent_id = $2 and athlete_id = $3`,
      [ORG, 'parent-pss-4', CHILD],
    );
    await expect(status.getSupportStatusForGuardian(ORG, UNLINKED_PARENT, CHILD))
      .rejects.toMatchObject({ status: 404, message: status.NOT_YOUR_CHILD });
    // The other guardians' links are untouched.
    expect((await status.getSupportStatusForGuardian(ORG, PARENT, CHILD)).scholarship).toBe('yes');
    expect((await status.getSupportStatusForGuardian(ORG, SECOND_PARENT, CHILD)).scholarship).toBe('yes');
  });

  test('another guardian cannot read this family\'s child', async () => {
    await expect(status.getSupportStatusForGuardian(ORG, OTHER_PARENT, CHILD))
      .rejects.toMatchObject({ status: 404, message: status.NOT_YOUR_CHILD });
  });
});
