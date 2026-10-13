// Real PostgreSQL contract for guardian replies (#1542, FC-03): who may
// reply to which parent message, and who reads which replies. Built on
// FC-02's pilot.family_message_replies; this suite exercises the production
// SQL in familyMessageReplies.ts through the ./db mock below.
//
// The rulings it pins: a guardian replies only on a parent message about a
// child linked to them now, in their own gym; with two guardians of one
// child each reads only their own replies; staff read every reply on their
// own gym's athlete and never another gym's.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-reply-reads-pg-test-${Date.now()}`);
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

  replies = await import('./familyMessageReplies');
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

let replies: typeof import('./familyMessageReplies');

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
  activeClient = await freshDatabase('ppbf_test_family_reply_reads');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

function reply(accountId: string, noteId: string, replyText: string, organizationId = ORG_ID) {
  return replies.createFamilyMessageReply({ organizationId, accountId, noteId, replyText });
}

async function storedRows(): Promise<Array<Record<string, unknown>>> {
  const result = await activeClient!.query(
    `select organization_id, note_id::text as note_id, athlete_id, author_account_id, author_role, reply_text
       from pilot.family_message_replies order by created_at, reply_id`,
  );
  return result.rows;
}

describe('a guardian replies to a parent message (createFamilyMessageReply)', () => {
  test("a linked guardian's reply is stored on that note, as them, trimmed", async () => {
    const item = await reply(GUARDIAN_A, MESSAGE, '  Gloves are packed.  ');

    expect(item).toEqual(expect.objectContaining({ note_id: MESSAGE, reply_text: 'Gloves are packed.' }));
    expect(item.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await storedRows()).toEqual([{
      organization_id: ORG_ID,
      note_id: MESSAGE,
      athlete_id: ATHLETE,
      author_account_id: GUARDIAN_A,
      author_role: 'parent',
      reply_text: 'Gloves are packed.',
    }]);
  });

  test.each([
    ['a guardian not linked to that child', GUARDIAN_UNLINKED, MESSAGE, ORG_ID],
    ['a made-up message id', GUARDIAN_A, '99999999-9999-4999-8999-999999999999', ORG_ID],
    ['an id that is not a message id', GUARDIAN_A, 'note-1; drop table', ORG_ID],
    ["another gym's message", GUARDIAN_A, OTHER_GYM_MESSAGE, ORG_ID],
    ["this gym's guardian asking as the other gym", GUARDIAN_A, OTHER_GYM_MESSAGE, OTHER_ORG_ID],
    ['a note that is not a parent message', GUARDIAN_A, BARRIER, ORG_ID],
    ['a child who has turned 18', GUARDIAN_A, ADULT_MESSAGE, ORG_ID],
  ])('%s: the same "not found", and nothing is written', async (_label, accountId, noteId, org) => {
    await expect(reply(accountId, noteId, 'Hello.', org)).rejects.toThrow(NOT_YOURS);
    expect(await storedRows()).toEqual([]);
  });

  test('an empty reply and one over 2000 characters are refused in sentences', async () => {
    await expect(reply(GUARDIAN_A, MESSAGE, '   ')).rejects.toThrow('Write a reply before sending.');
    await expect(reply(GUARDIAN_A, MESSAGE, 'x'.repeat(2001))).rejects.toThrow('A reply is at most 2000 characters.');
    await reply(GUARDIAN_A, MESSAGE, 'x'.repeat(2000));
    expect(await storedRows()).toHaveLength(1);
  });

  test('a guardian whose link was removed can no longer reply on the old message', async () => {
    await reply(GUARDIAN_B, MESSAGE, 'First.');
    await activeClient!.query(`delete from pilot.guardian_links where organization_id = $1 and parent_id = 'P-B'`, [ORG_ID]);

    await expect(reply(GUARDIAN_B, MESSAGE, 'Second.')).rejects.toThrow(NOT_YOURS);
    expect(await storedRows()).toHaveLength(1);
  });

  test('two replies sent at once are both kept, with their own ids', async () => {
    const [first, second] = await Promise.all([
      reply(GUARDIAN_A, MESSAGE, 'One.'),
      reply(GUARDIAN_A, MESSAGE, 'Two.'),
    ]);

    expect(first.reply_id).not.toBe(second.reply_id);
    expect((await storedRows()).map((row) => row.reply_text).sort()).toEqual(['One.', 'Two.']);
  });
});

describe('who reads replies', () => {
  test('with two guardians of one child, each reads only their own (listOwnReplies)', async () => {
    await reply(GUARDIAN_A, MESSAGE, 'From A, first.');
    await reply(GUARDIAN_B, MESSAGE, 'From B.');
    await reply(GUARDIAN_A, MESSAGE, 'From A, second.');

    expect((await replies.listOwnReplies(ORG_ID, GUARDIAN_A, [ATHLETE])).map((row) => row.reply_text))
      .toEqual(['From A, first.', 'From A, second.']);
    expect((await replies.listOwnReplies(ORG_ID, GUARDIAN_B, [ATHLETE])).map((row) => row.reply_text))
      .toEqual(['From B.']);
    // A child no longer in scope reads nothing, and an empty scope is empty.
    expect(await replies.listOwnReplies(ORG_ID, GUARDIAN_A, [SIBLING])).toEqual([]);
    expect(await replies.listOwnReplies(ORG_ID, GUARDIAN_A, [])).toEqual([]);
  });

  test("staff read every reply on the athlete's messages, oldest first, named, and never another gym's", async () => {
    await reply(GUARDIAN_A, MESSAGE, 'From A.');
    await reply(GUARDIAN_B, MESSAGE, 'From B.');
    await reply(GUARDIAN_OTHER_GYM, OTHER_GYM_MESSAGE, 'Other gym reply.', OTHER_ORG_ID);

    const rows = await replies.listRepliesForStaff(ORG_ID, ATHLETE);
    expect(rows.map((row) => [row.author_name, row.reply_text, row.note_id])).toEqual([
      ['Alex Parent', 'From A.', MESSAGE],
      ['Jordan Parent', 'From B.', MESSAGE],
    ]);
    expect((await replies.listRepliesForStaff(OTHER_ORG_ID, ATHLETE)).map((row) => row.reply_text))
      .toEqual(['Other gym reply.']);
    expect(await replies.listRepliesForStaff(ORG_ID, SIBLING)).toEqual([]);
  });

  test('a reply whose author account is gone reads "A guardian" for staff', async () => {
    await reply(GUARDIAN_A, MESSAGE, 'Still here.');
    await activeClient!.query(`update pilot.family_message_replies set author_account_id = null`);

    expect((await replies.listRepliesForStaff(ORG_ID, ATHLETE)).map((row) => row.author_name)).toEqual(['A guardian']);
  });
});
