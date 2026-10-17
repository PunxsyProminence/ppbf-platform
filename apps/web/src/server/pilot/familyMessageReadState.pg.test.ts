// Real PostgreSQL contract for whether the family opened a parent message
// (#1542, FC-05), on FC-04's pilot.family_message_reads: a guardian records a
// read only on a parent message about a child linked to them now, in their own
// gym; a second open keeps the first time; staff see, per note, that the family
// opened it and the earliest time -- never which guardian, and nothing from
// another gym; and a guardian reads back only their own opens (FC-08). Same
// seeded gym as familyMessageReplyReads.pg.test.ts.
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

// Routes access.ts's and guardianAccess.ts's queries into whichever embedded
// database the current test opened. Declared before the import so jest's mock
// hoisting sees it.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-read-state-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');


let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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

  reads = await import('./familyMessageReads');
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

const ORG_ID = 'org-freply';
const OTHER_ORG_ID = 'org-freply-other';
const COACH = 'acct-freply-coach';
const OTHER_COACH = 'acct-freply-coach-x';
const GUARDIAN_A = 'acct-freply-guardian-a';
const GUARDIAN_B = 'acct-freply-guardian-b';
const GUARDIAN_UNLINKED = 'acct-freply-guardian-c';
const GUARDIAN_OTHER_GYM = 'acct-freply-guardian-x';
// The same athlete id in both gyms: a cross-gym read keyed on the id alone
// would mix them.
const ATHLETE = 'ATH-FREPLY-1';
const SIBLING = 'ATH-FREPLY-2';
const ADULT = 'ATH-FREPLY-ADULT';

const MESSAGE = '11111111-1111-4111-8111-111111111111';
const BARRIER = '22222222-2222-4222-8222-222222222222';
const ADULT_MESSAGE = '33333333-3333-4333-8333-333333333333';
const SIBLING_MESSAGE = '44444444-4444-4444-8444-444444444444';
const OTHER_GYM_MESSAGE = '55555555-5555-4555-8555-555555555555';

const NOT_YOURS = 'Not found: that message is not on your page.';

let reads: typeof import('./familyMessageReads');

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }

  for (const [accountId, role, org] of [
    [COACH, 'coach', ORG_ID],
    [GUARDIAN_A, 'parent', ORG_ID],
    [GUARDIAN_B, 'parent', ORG_ID],
    [GUARDIAN_UNLINKED, 'parent', ORG_ID],
    [OTHER_COACH, 'coach', OTHER_ORG_ID],
    [GUARDIAN_OTHER_GYM, 'parent', OTHER_ORG_ID],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, org],
    );
  }

  for (const [org, athleteId, dob, coach] of [
    [ORG_ID, ATHLETE, '2012-03-04', COACH],
    [ORG_ID, SIBLING, '2013-05-06', COACH],
    [ORG_ID, ADULT, '2000-01-01', COACH],
    [OTHER_ORG_ID, ATHLETE, '2012-03-04', OTHER_COACH],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Reply Athlete', $3, 'fly', 'active', 'contact', true, $4, now(), now())`,
      [org, athleteId, dob, coach],
    );
  }

  // Guardian A and B both hold the athlete; A also holds the adult; the
  // unlinked guardian holds only the sibling; the other gym's guardian holds
  // that gym's athlete of the same id.
  for (const [org, parentId, accountId, name, athleteIds] of [
    [ORG_ID, 'P-A', GUARDIAN_A, 'Alex Parent', [ATHLETE, ADULT]],
    [ORG_ID, 'P-B', GUARDIAN_B, 'Jordan Parent', [ATHLETE]],
    [ORG_ID, 'P-C', GUARDIAN_UNLINKED, 'Casey Parent', [SIBLING]],
    [OTHER_ORG_ID, 'P-X', GUARDIAN_OTHER_GYM, 'Other Gym Parent', [ATHLETE]],
  ] as const) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, $4)`,
      [org, parentId, accountId, name],
    );
    for (const athleteId of athleteIds) {
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, $2, $3, 'parent')`,
        [org, parentId, athleteId],
      );
    }
  }

  for (const [org, noteId, athleteId, coach, noteType, text] of [
    [ORG_ID, MESSAGE, ATHLETE, COACH, 'parent_message', 'Bring gloves Thursday.'],
    [ORG_ID, BARRIER, ATHLETE, COACH, 'home_barrier', 'No lift on Thursdays.'],
    [ORG_ID, ADULT_MESSAGE, ADULT, COACH, 'parent_message', 'Fight night tickets.'],
    [ORG_ID, SIBLING_MESSAGE, SIBLING, COACH, 'parent_message', 'Mouthguard fitting.'],
    [OTHER_ORG_ID, OTHER_GYM_MESSAGE, ATHLETE, OTHER_COACH, 'parent_message', 'Other gym note.'],
  ] as const) {
    await client.query(
      `insert into pilot.coach_observations
         (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
       values ($1, $2::uuid, $3, $4, $5, $6)`,
      [org, noteId, athleteId, coach, noteType, text],
    );
  }

  return client;
}

beforeEach(async () => {
  activeClient = await freshDatabase('ppbf_test_family_read_state');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

function read(accountId: string, noteId: string, organizationId = ORG_ID) {
  return reads.recordFamilyMessageRead({ organizationId, accountId, noteId });
}

async function storedReads(): Promise<Array<Record<string, unknown>>> {
  const result = await activeClient!.query(
    `select organization_id, note_id::text as note_id, athlete_id, reader_account_id, reader_role
       from pilot.family_message_reads order by reader_account_id`,
  );
  return result.rows;
}

describe('a guardian opens a parent message (recordFamilyMessageRead)', () => {
  test('a linked guardian opening it is stored once, and a second open keeps the first time', async () => {
    const first = await read(GUARDIAN_A, MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await read(GUARDIAN_A, MESSAGE);

    expect(first.note_id).toBe(MESSAGE);
    expect(first.first_read_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(again.first_read_at).toBe(first.first_read_at);
    expect(await storedReads()).toEqual([
      { organization_id: ORG_ID, note_id: MESSAGE, athlete_id: ATHLETE, reader_account_id: GUARDIAN_A, reader_role: 'parent' },
    ]);
  });

  test.each([
    ['a guardian not linked to that child', GUARDIAN_UNLINKED, MESSAGE, ORG_ID],
    ["a guardian of the first child, on the sibling's message", GUARDIAN_A, SIBLING_MESSAGE, ORG_ID],
    ['a made-up message id', GUARDIAN_A, '99999999-9999-4999-8999-999999999999', ORG_ID],
    ['an id that is not a message id', GUARDIAN_A, 'note-1; drop table', ORG_ID],
    ["another gym's message", GUARDIAN_A, OTHER_GYM_MESSAGE, ORG_ID],
    ["this gym's guardian asking as the other gym", GUARDIAN_A, OTHER_GYM_MESSAGE, OTHER_ORG_ID],
    ['a note that is not a parent message', GUARDIAN_A, BARRIER, ORG_ID],
    ['a child who has turned 18', GUARDIAN_A, ADULT_MESSAGE, ORG_ID],
  ])('%s: the same "not found", and nothing is written', async (_label, accountId, noteId, org) => {
    await expect(read(accountId, noteId, org)).rejects.toThrow(NOT_YOURS);
    expect(await storedReads()).toEqual([]);
  });
});

test('two opens by the same guardian at once both answer with the one first time', async () => {
  const [one, two] = await Promise.all([read(GUARDIAN_A, MESSAGE), read(GUARDIAN_A, MESSAGE)]);
  expect(one.first_read_at).toBe(two.first_read_at);
  expect(await storedReads()).toHaveLength(1);
});

describe('what staff see (listFamilyReadStateForStaff)', () => {
  test('two guardians opening it are one "opened", at the earliest time, with no reader named', async () => {
    const first = await read(GUARDIAN_A, MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await read(GUARDIAN_B, MESSAGE);
    // Each guardian is answered with their own first time, never the other's.
    expect(second.first_read_at > first.first_read_at).toBe(true);
    expect((await read(GUARDIAN_B, MESSAGE)).first_read_at).toBe(second.first_read_at);
    expect((await read(GUARDIAN_A, MESSAGE)).first_read_at).toBe(first.first_read_at);
    expect(await storedReads()).toHaveLength(2);

    const state = await reads.listFamilyReadStateForStaff(ORG_ID, ATHLETE);
    expect(state).toEqual([{ note_id: MESSAGE, first_read_at: first.first_read_at }]);
    expect(Object.keys(state[0]!).sort()).toEqual(['first_read_at', 'note_id']);
  });

  test('a message nobody opened is not in the list, and another gym is never read', async () => {
    await read(GUARDIAN_OTHER_GYM, OTHER_GYM_MESSAGE, OTHER_ORG_ID);

    expect(await reads.listFamilyReadStateForStaff(ORG_ID, ATHLETE)).toEqual([]);
    expect(await reads.listFamilyReadStateForStaff(ORG_ID, SIBLING)).toEqual([]);
    expect((await reads.listFamilyReadStateForStaff(OTHER_ORG_ID, ATHLETE)).map((row) => row.note_id)).toEqual([OTHER_GYM_MESSAGE]);
  });
});

describe("a guardian's own opens (listOwnMessageReads, FC-08)", () => {
  test("each guardian gets their own opens and first time, never the other guardian's", async () => {
    const mine = await read(GUARDIAN_A, MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // B has not opened it: B's list is empty although A's open is stored.
    expect(await reads.listOwnMessageReads(ORG_ID, GUARDIAN_B)).toEqual([]);
    expect(await reads.listOwnMessageReads(ORG_ID, GUARDIAN_A)).toEqual([{ note_id: MESSAGE, first_read_at: mine.first_read_at }]);

    const theirs = await read(GUARDIAN_B, MESSAGE);
    expect(theirs.first_read_at > mine.first_read_at).toBe(true);
    expect(await reads.listOwnMessageReads(ORG_ID, GUARDIAN_B)).toEqual([{ note_id: MESSAGE, first_read_at: theirs.first_read_at }]);
    expect(await reads.listOwnMessageReads(ORG_ID, GUARDIAN_A)).toEqual([{ note_id: MESSAGE, first_read_at: mine.first_read_at }]);
  });

  test("another gym's opens and an 18+ child's are not in the list", async () => {
    await read(GUARDIAN_A, MESSAGE);
    await read(GUARDIAN_OTHER_GYM, OTHER_GYM_MESSAGE, OTHER_ORG_ID);
    // An open stored before the child turned 18: the link has ended since, so
    // it drops out with the child's notes.
    await activeClient!.query(
      `insert into pilot.family_message_reads (organization_id, note_id, athlete_id, reader_account_id, reader_role)
       values ($1, $2::uuid, $3, $4, 'parent')`,
      [ORG_ID, ADULT_MESSAGE, ADULT, GUARDIAN_A],
    );
    // A row under this guardian's account in the other gym, on that gym's
    // athlete of the same id: a read keyed on account and athlete alone would
    // bring it in.
    await activeClient!.query(
      `insert into pilot.family_message_reads (organization_id, note_id, athlete_id, reader_account_id, reader_role)
       values ($1, $2::uuid, $3, $4, 'parent')`,
      [OTHER_ORG_ID, OTHER_GYM_MESSAGE, ATHLETE, GUARDIAN_A],
    );

    expect((await reads.listOwnMessageReads(ORG_ID, GUARDIAN_A)).map((row) => row.note_id)).toEqual([MESSAGE]);
    // This gym's guardian asking as the other gym holds no link there.
    expect(await reads.listOwnMessageReads(OTHER_ORG_ID, GUARDIAN_A)).toEqual([]);
    expect((await reads.listOwnMessageReads(OTHER_ORG_ID, GUARDIAN_OTHER_GYM)).map((row) => row.note_id)).toEqual([OTHER_GYM_MESSAGE]);
    expect(await reads.listOwnMessageReads(ORG_ID, GUARDIAN_UNLINKED)).toEqual([]);
  });

  test("a deleted child's opens drop out of the list", async () => {
    await read(GUARDIAN_A, MESSAGE);
    expect((await reads.listOwnMessageReads(ORG_ID, GUARDIAN_A)).map((row) => row.note_id)).toEqual([MESSAGE]);
    await activeClient!.query('update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2', [ORG_ID, ATHLETE]);
    expect(await reads.listOwnMessageReads(ORG_ID, GUARDIAN_A)).toEqual([]);
  });
});
