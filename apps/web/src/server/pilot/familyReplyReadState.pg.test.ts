// Real PostgreSQL contract for which guardian replies a staff member has seen
// (#1542's track, FC-09b), on FC-09's pilot.family_reply_reads: a coach's read
// is stored once and the first time kept; two coaches are two reads and each
// lists only their own; another gym's staff, a guardian and a coach whose seat
// has been switched off are refused; a reply of another athlete is not listed.
// This suite exercises the production SQL in familyReplyReads.ts and access.ts
// through the ./db mock below.
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

// Routes familyReplyReads.ts's and access.ts's queries into whichever embedded
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-reply-read-state-pg-test-${Date.now()}`);
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

  reads = await import('./familyReplyReads');
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

const ORG_ID = 'org-rstate';
const OTHER_ORG_ID = 'org-rstate-other';
const COACH = 'acct-rstate-coach';
const SECOND_COACH = 'acct-rstate-coach-b';
const OFFICE = 'acct-rstate-office';
const SWITCHED_OFF_COACH = 'acct-rstate-off';
const OTHER_GYM_COACH = 'acct-rstate-other-coach';
const GUARDIAN = 'acct-rstate-guardian';
// The same athlete id in both gyms: a cross-gym read keyed on the id alone
// would mix them.
const ATHLETE = 'ATH-RSTATE-1';
const SIBLING = 'ATH-RSTATE-2';

const MESSAGE = '11111111-1111-4111-8111-111111111111';
const SIBLING_MESSAGE = '22222222-2222-4222-8222-222222222222';
const OTHER_GYM_MESSAGE = '33333333-3333-4333-8333-333333333333';
const REPLY = '44444444-4444-4444-8444-444444444444';
const SECOND_REPLY = '55555555-5555-4555-8555-555555555555';
const SIBLING_REPLY = '66666666-6666-4666-8666-666666666666';
const OTHER_GYM_REPLY = '77777777-7777-4777-8777-777777777777';

const NOT_HERE = 'Not found: that reply is not in your gym.';

let reads: typeof import('./familyReplyReads');

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

  // Staff authority is the active seat in the gym (auth.ts): every staff
  // member below holds one, except the coach whose seat has been switched off.
  for (const [accountId, role, org, seatActive] of [
    [COACH, 'coach', ORG_ID, true],
    [SECOND_COACH, 'coach', ORG_ID, true],
    [OFFICE, 'organization_admin', ORG_ID, true],
    [SWITCHED_OFF_COACH, 'coach', ORG_ID, false],
    [GUARDIAN, 'parent', ORG_ID, true],
    [OTHER_GYM_COACH, 'coach', OTHER_ORG_ID, true],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, org],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, $4)`,
      [accountId, org, role, seatActive],
    );
  }

  for (const [org, athleteId, coach] of [
    [ORG_ID, ATHLETE, COACH],
    [ORG_ID, SIBLING, COACH],
    [OTHER_ORG_ID, ATHLETE, OTHER_GYM_COACH],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Reply Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, coach],
    );
  }

  for (const [org, noteId, athleteId, coach] of [
    [ORG_ID, MESSAGE, ATHLETE, COACH],
    [ORG_ID, SIBLING_MESSAGE, SIBLING, COACH],
    [OTHER_ORG_ID, OTHER_GYM_MESSAGE, ATHLETE, OTHER_GYM_COACH],
  ] as const) {
    await client.query(
      `insert into pilot.coach_observations
         (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
       values ($1, $2::uuid, $3, $4, 'parent_message', 'Bring gloves Thursday.')`,
      [org, noteId, athleteId, coach],
    );
  }

  for (const [org, replyId, noteId, athleteId] of [
    [ORG_ID, REPLY, MESSAGE, ATHLETE],
    [ORG_ID, SECOND_REPLY, MESSAGE, ATHLETE],
    [ORG_ID, SIBLING_REPLY, SIBLING_MESSAGE, SIBLING],
    [OTHER_ORG_ID, OTHER_GYM_REPLY, OTHER_GYM_MESSAGE, ATHLETE],
  ] as const) {
    await client.query(
      `insert into pilot.family_message_replies
         (organization_id, reply_id, note_id, athlete_id, author_account_id, author_role, reply_text)
       values ($1, $2::uuid, $3::uuid, $4, $5, 'parent', 'We will.')`,
      [org, replyId, noteId, athleteId, GUARDIAN],
    );
  }

  return client;
}

beforeEach(async () => {
  activeClient = await freshDatabase('ppbf_test_family_reply_read_state');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

function read(accountId: string, role: string, replyId: string, organizationId = ORG_ID) {
  return reads.recordFamilyReplyRead(
    { organizationId, accountId, role: role as Parameters<typeof reads.recordFamilyReplyRead>[0]['role'] },
    replyId,
  );
}

async function storedReads(): Promise<Array<Record<string, unknown>>> {
  const result = await activeClient!.query(
    `select organization_id, reply_id::text as reply_id, reader_account_id, reader_role,
            to_char(first_read_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as first_read_at
       from pilot.family_reply_reads order by reader_account_id, reply_id`,
  );
  return result.rows;
}

describe('a staff member sees a reply (recordFamilyReplyRead)', () => {
  test("a coach's read is stored once, and a second look keeps the first time", async () => {
    expect(await read(COACH, 'coach', REPLY)).toEqual({ reply_id: REPLY });
    const [first] = await storedReads();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await read(COACH, 'coach', REPLY);

    expect(await storedReads()).toEqual([
      { organization_id: ORG_ID, reply_id: REPLY, reader_account_id: COACH, reader_role: 'coach', first_read_at: first!.first_read_at },
    ]);
  });

  test('an organization admin of the gym records their own read', async () => {
    await read(OFFICE, 'organization_admin', REPLY);
    expect((await storedReads()).map((row) => [row.reader_account_id, row.reader_role])).toEqual([[OFFICE, 'organization_admin']]);
  });

  test.each([
    ["another gym's coach, asking as their own gym", OTHER_GYM_COACH, 'coach', REPLY, OTHER_ORG_ID],
    ["this gym's coach, on another gym's reply", COACH, 'coach', OTHER_GYM_REPLY, ORG_ID],
    ['a made-up reply id', COACH, 'coach', '99999999-9999-4999-8999-999999999999', ORG_ID],
    ['an id that is not a reply id', COACH, 'coach', 'r1; drop table', ORG_ID],
  ])('%s: the same "not found", and nothing is written', async (_label, accountId, role, replyId, org) => {
    await expect(read(accountId, role, replyId, org)).rejects.toThrow(NOT_HERE);
    expect(await storedReads()).toEqual([]);
  });

  test('a guardian is refused, and nothing is written', async () => {
    await expect(read(GUARDIAN, 'parent', REPLY)).rejects.toThrow('Forbidden');
    expect(await storedReads()).toEqual([]);
  });

  test('a coach whose seat in the gym is switched off is refused, and nothing is written', async () => {
    await expect(read(SWITCHED_OFF_COACH, 'coach', REPLY)).rejects.toMatchObject({ status: 403 });
    expect(await storedReads()).toEqual([]);
  });

  test("a reply of a deleted athlete is the same \"not found\"", async () => {
    await activeClient!.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG_ID, SIBLING]);
    await expect(read(COACH, 'coach', SIBLING_REPLY)).rejects.toThrow(NOT_HERE);
    expect(await storedReads()).toEqual([]);
  });
});

describe("what a staff member sees as already read (listOwnReplyReads)", () => {
  test('two coaches are two reads, and each lists only their own', async () => {
    await read(COACH, 'coach', REPLY);
    await read(SECOND_COACH, 'coach', SECOND_REPLY);
    expect(await storedReads()).toHaveLength(2);

    expect(await reads.listOwnReplyReads(ORG_ID, COACH, ATHLETE)).toEqual([{ reply_id: REPLY }]);
    expect(await reads.listOwnReplyReads(ORG_ID, SECOND_COACH, ATHLETE)).toEqual([{ reply_id: SECOND_REPLY }]);
    // Someone who has seen nothing has nothing listed, whatever others saw.
    expect(await reads.listOwnReplyReads(ORG_ID, OFFICE, ATHLETE)).toEqual([]);
  });

  test("a reply of another athlete is not listed, and another gym's reads are never read", async () => {
    await read(COACH, 'coach', REPLY);
    await read(COACH, 'coach', SIBLING_REPLY);
    await read(OTHER_GYM_COACH, 'coach', OTHER_GYM_REPLY, OTHER_ORG_ID);

    expect(await reads.listOwnReplyReads(ORG_ID, COACH, ATHLETE)).toEqual([{ reply_id: REPLY }]);
    expect(await reads.listOwnReplyReads(ORG_ID, COACH, SIBLING)).toEqual([{ reply_id: SIBLING_REPLY }]);
    expect(await reads.listOwnReplyReads(OTHER_ORG_ID, COACH, ATHLETE)).toEqual([]);
    expect(await reads.listOwnReplyReads(ORG_ID, OTHER_GYM_COACH, ATHLETE)).toEqual([]);
    expect(await reads.listOwnReplyReads(OTHER_ORG_ID, OTHER_GYM_COACH, ATHLETE)).toEqual([{ reply_id: OTHER_GYM_REPLY }]);
  });
});
