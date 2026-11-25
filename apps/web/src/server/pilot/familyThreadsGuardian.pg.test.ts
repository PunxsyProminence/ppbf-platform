// Real PostgreSQL contract for the guardian half of family threads (W4 item 4, lane W4-4, PM-1b):
// a guardian reaches only children linked to them NOW (guardianAccess.ts), and only the threads
// THEY opened. This suite runs the production SQL in familyThreads.ts and guardianAccess.ts
// through the ./db mock below, against the full schema built in the apply-migrations `all` order.
//
// It proves, on a real database: a guardian opens a thread about their own child and reads it
// back; they are refused for a child they are not linked to in the same gym, a child of the same
// id in another gym, their child once 18, and their child once deleted; the co-guardian sees
// neither the thread nor the staff reply in it, cannot write in it and cannot record reading it;
// the opener writes again (Q2 A) and records reading staff; an ended link takes the thread out of
// their list. An unknown date of birth cannot be stored (pilot.athletes.dob is NOT NULL); the
// store's unit test (familyThreads.test.ts) covers how one would read (OD-2026-10-04-010).
//
// Spins up the disposable, local-only embedded Postgres the other suites use. It NEVER connects
// to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot load an ES module
   here. Building it through Function keeps a real dynamic import in the emitted code. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes familyThreads.ts's, guardianAccess.ts's and achievements.ts's queries into whichever
// embedded database the current test opened. Declared before the import so jest's hoisting sees it.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-threads-guardian-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG = 'org-ftg';
const OTHER_ORG = 'org-ftg-other';
const GUARDIAN = 'acct-ftg-guardian';
const CO_GUARDIAN = 'acct-ftg-coguardian';
const OTHER_GYM_GUARDIAN = 'acct-ftg-other-guardian';
const COACH = 'acct-ftg-coach';
const SECOND_COACH = 'acct-ftg-coach-b';
const CHILD = 'ATH-FTG-CHILD';
const SIBLING = 'ATH-FTG-SIBLING';
const UNLINKED = 'ATH-FTG-UNLINKED';
const GROWN = 'ATH-FTG-GROWN';
const MINOR_DOB = '2014-06-01';
const ADULT_DOB = '2000-01-01';

type Threads = typeof import('./familyThreads');
let threads: Threads;

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

// A gym with a child, the child's sibling, a child the guardian is not linked to and a grown
// child (18 or over) the guardian is still linked to on paper; the child's two guardians; a coach;
// and another gym with a child of the same id and that child's guardian.
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  const accounts: Array<[string, string, string]> = [
    [GUARDIAN, 'parent', ORG],
    [CO_GUARDIAN, 'parent', ORG],
    [COACH, 'coach', ORG],
    [SECOND_COACH, 'coach', ORG],
    [OTHER_GYM_GUARDIAN, 'parent', OTHER_ORG],
  ];
  for (const [account, role, org] of accounts) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [account, role, org],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)`,
      [account, org, role],
    );
  }
  const athletes: Array<[string, string, string]> = [
    [ORG, CHILD, MINOR_DOB],
    [ORG, SIBLING, MINOR_DOB],
    [ORG, UNLINKED, MINOR_DOB],
    [ORG, GROWN, ADULT_DOB],
    [OTHER_ORG, CHILD, MINOR_DOB],
  ];
  for (const [org, athlete, dob] of athletes) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Thread Child', $3, 'fly', 'active', 'contact', true, $4, now(), now())`,
      [org, athlete, dob, org === ORG ? COACH : OTHER_GYM_GUARDIAN],
    );
  }
  for (const [org, account] of [[ORG, GUARDIAN], [ORG, CO_GUARDIAN], [OTHER_ORG, OTHER_GYM_GUARDIAN]]) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'Thread Guardian')`,
      [org, `parent-${account}`, account],
    );
  }
  const links: Array<[string, string, string]> = [
    [ORG, GUARDIAN, CHILD],
    [ORG, GUARDIAN, SIBLING],
    [ORG, GUARDIAN, GROWN],
    [ORG, CO_GUARDIAN, CHILD],
    [OTHER_ORG, OTHER_GYM_GUARDIAN, CHILD],
  ];
  for (const [org, account, athlete] of links) {
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'guardian')`,
      [org, `parent-${account}`, athlete],
    );
  }
  activeClient = client;
  return client;
}

async function staffReply(client: Client, threadId: string, athleteId = CHILD, author = COACH): Promise<string> {
  const result = await client.query(
    `insert into pilot.family_thread_posts
       (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
     values ($1, gen_random_uuid(), $2::uuid, $3, $4, 'coach', 'Yes, see you Saturday.')
     returning post_id::text as post_id`,
    [ORG, threadId, athleteId, author],
  );
  return result.rows[0].post_id;
}

const start = (accountId: string, athleteId: string, text: unknown = 'Is practice on Saturday?') =>
  threads.startFamilyThread({ organizationId: ORG, accountId, athleteId, text });

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
  threads = await import('./familyThreads');
});

afterEach(async () => {
  if (activeClient) await activeClient.end();
  activeClient = null;
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

describe('family threads, the guardian half (W4 item 4, PM-1b)', () => {
  test('a guardian opens a thread about their own child and reads it back, with no account id in it', async () => {
    await freshDatabase('ftg_own');
    const opened = await start(GUARDIAN, CHILD);
    const list = await threads.listOwnFamilyThreads(ORG, GUARDIAN);
    expect(list).toEqual([
      {
        thread_id: opened.thread_id,
        athlete_id: CHILD,
        created_at: opened.created_at,
        posts: [{
          post_id: opened.post_id,
          from: 'you',
          staff_name: null,
          text: 'Is practice on Saturday?',
          created_at: opened.created_at,
          new_to_me: false,
        }],
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(GUARDIAN);
  });

  test('a guardian reaches only a child linked to them now: not another child, another gym, a grown child or a deleted one', async () => {
    const client = await freshDatabase('ftg_reach');
    // Not linked, in this gym. The same child id is linked to this guardian only in this gym, so
    // the other gym's child cannot be named from here; the other gym's guardian cannot name ours.
    await expect(start(GUARDIAN, UNLINKED)).rejects.toMatchObject({ status: 403 });
    await expect(start(OTHER_GYM_GUARDIAN, CHILD)).rejects.toMatchObject({ status: 403 });
    // Linked on paper, but 18 or over: the link has gone dormant (OD-2026-10-07-008).
    await expect(start(GUARDIAN, GROWN)).rejects.toMatchObject({ status: 403 });
    // Linked, but the child's record is deleted.
    await client.query('update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2', [ORG, SIBLING]);
    await expect(start(GUARDIAN, SIBLING)).rejects.toMatchObject({ status: 403 });
    // A child that does not exist anywhere.
    await expect(start(GUARDIAN, 'ATH-NOWHERE')).rejects.toMatchObject({ status: 403 });

    const stored = await client.query('select count(*)::int as n from pilot.family_thread_posts');
    expect(stored.rows[0].n).toBe(0);
  });

  test('the database itself never holds an unknown date of birth to read', async () => {
    const client = await freshDatabase('ftg_dob');
    await expect(
      client.query(
        `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
           emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, 'ATH-FTG-NODOB', 'No Date', null, 'fly', 'active', 'contact', true, $2, now(), now())`,
        [ORG, COACH],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  test("the co-guardian sees neither the guardian's thread nor the staff reply in it, and cannot act on either", async () => {
    const client = await freshDatabase('ftg_coguardian');
    const opened = await start(GUARDIAN, CHILD);
    const reply = await staffReply(client, opened.thread_id);
    const theirs = await start(CO_GUARDIAN, CHILD, 'Can we talk about Tuesday?');

    const coList = await threads.listOwnFamilyThreads(ORG, CO_GUARDIAN);
    expect(coList.map((thread) => thread.thread_id)).toEqual([theirs.thread_id]);
    expect(JSON.stringify(coList)).not.toContain(reply);
    expect(JSON.stringify(coList)).not.toContain('see you Saturday');

    await expect(
      threads.writeAgainInFamilyThread({ organizationId: ORG, accountId: CO_GUARDIAN, threadId: opened.thread_id, text: 'Me too.' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      threads.recordFamilyThreadReadByGuardian({ organizationId: ORG, accountId: CO_GUARDIAN, postId: reply }),
    ).rejects.toMatchObject({ status: 404 });

    // And the guardian does not see the co-guardian's thread.
    const own = await threads.listOwnFamilyThreads(ORG, GUARDIAN);
    expect(own.map((thread) => thread.thread_id)).toEqual([opened.thread_id]);
    const reads = await client.query('select count(*)::int as n from pilot.family_thread_reads');
    expect(reads.rows[0].n).toBe(0);
  });

  test("the store's own checks hold with the database guards switched off", async () => {
    // The database refuses these too (migration family-threads). Switched off here, so each 404
    // below is the store's own check (familyThreads.ts), not the trigger's (OD-2026-10-12-024, Q2 A).
    const client = await freshDatabase('ftg_store_checks');
    const opened = await start(GUARDIAN, CHILD);
    const reply = await staffReply(client, opened.thread_id);
    await client.query(`alter table pilot.family_thread_posts disable trigger trg_family_thread_posts_guard;
      alter table pilot.family_thread_reads disable trigger trg_family_thread_reads_guard`);
    await expect(
      threads.writeAgainInFamilyThread({ organizationId: ORG, accountId: CO_GUARDIAN, threadId: opened.thread_id, text: 'Me too.' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      threads.recordFamilyThreadReadByGuardian({ organizationId: ORG, accountId: CO_GUARDIAN, postId: reply }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      threads.recordFamilyThreadReadByGuardian({ organizationId: ORG, accountId: GUARDIAN, postId: opened.post_id }),
    ).rejects.toMatchObject({ status: 404 });
    const left = await client.query(
      `select (select count(*)::int from pilot.family_thread_posts) as posts, (select count(*)::int from pilot.family_thread_reads) as reads`,
    );
    expect(left.rows[0]).toEqual({ posts: 2, reads: 0 });
  });

  test("another gym's guardian, in their own gym, reaches nothing of this gym's thread", async () => {
    const client = await freshDatabase('ftg_other_gym');
    const opened = await start(GUARDIAN, CHILD);
    const reply = await staffReply(client, opened.thread_id);
    // Their session is in their own gym; the ids are this gym's.
    await expect(
      threads.writeAgainInFamilyThread({ organizationId: OTHER_ORG, accountId: OTHER_GYM_GUARDIAN, threadId: opened.thread_id, text: 'Hi' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      threads.recordFamilyThreadReadByGuardian({ organizationId: OTHER_ORG, accountId: OTHER_GYM_GUARDIAN, postId: reply }),
    ).rejects.toMatchObject({ status: 404 });
    // Their own child of the same id is theirs; this gym's thread is not in their list.
    const theirs = await threads.startFamilyThread({ organizationId: OTHER_ORG, accountId: OTHER_GYM_GUARDIAN, athleteId: CHILD, text: 'Hello' });
    expect((await threads.listOwnFamilyThreads(OTHER_ORG, OTHER_GYM_GUARDIAN)).map((thread) => thread.thread_id)).toEqual([theirs.thread_id]);

    // One login with guardian records in both gyms, linked to the child of the same id in each:
    // signed in to the other gym, this gym's thread is not theirs to write in or read from there.
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'Thread Guardian')`,
      [OTHER_ORG, `parent-${GUARDIAN}`, GUARDIAN],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'guardian')`,
      [OTHER_ORG, `parent-${GUARDIAN}`, CHILD],
    );
    await expect(
      threads.writeAgainInFamilyThread({ organizationId: OTHER_ORG, accountId: GUARDIAN, threadId: opened.thread_id, text: 'Hi' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      threads.recordFamilyThreadReadByGuardian({ organizationId: OTHER_ORG, accountId: GUARDIAN, postId: reply }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await threads.listOwnFamilyThreads(OTHER_ORG, GUARDIAN)).toEqual([]);
  });

  test('the opener sees the staff reply as new, writes again (Q2 A), and records the read once', async () => {
    const client = await freshDatabase('ftg_thread');
    const opened = await start(GUARDIAN, CHILD);
    const reply = await staffReply(client, opened.thread_id);

    let [thread] = await threads.listOwnFamilyThreads(ORG, GUARDIAN);
    const staffPost = thread.posts[1];
    expect(staffPost).toMatchObject({ post_id: reply, from: 'staff', new_to_me: true });
    expect(typeof staffPost.staff_name).toBe('string');
    expect(staffPost.staff_name).not.toBe('');
    expect(JSON.stringify(thread)).not.toContain(COACH);

    const again = await threads.writeAgainInFamilyThread({
      organizationId: ORG, accountId: GUARDIAN, threadId: opened.thread_id, text: 'Thank you!',
    });
    await threads.recordFamilyThreadReadByGuardian({ organizationId: ORG, accountId: GUARDIAN, postId: reply });
    await threads.recordFamilyThreadReadByGuardian({ organizationId: ORG, accountId: GUARDIAN, postId: reply });

    [thread] = await threads.listOwnFamilyThreads(ORG, GUARDIAN);
    expect(thread.posts.map((item) => [item.post_id, item.from, item.new_to_me])).toEqual([
      [opened.post_id, 'you', false],
      [reply, 'staff', false],
      [again.post_id, 'you', false],
    ]);
    const reads = await client.query('select count(*)::int as n from pilot.family_thread_reads');
    expect(reads.rows[0].n).toBe(1);

    // A staff member whose account has since been removed: the reply stays, from staff, unnamed.
    const gone = await staffReply(client, opened.thread_id, CHILD, SECOND_COACH);
    await client.query('delete from pilot.accounts where account_id = $1', [SECOND_COACH]);
    [thread] = await threads.listOwnFamilyThreads(ORG, GUARDIAN);
    expect(thread.posts.find((item) => item.post_id === gone)).toMatchObject({ from: 'staff', staff_name: null, new_to_me: true });

    // Their own words are not a read; a forged id and a non-id are the same 404.
    for (const postId of [opened.post_id, '88888888-8888-4888-8888-888888888888', 'not-an-id']) {
      await expect(
        threads.recordFamilyThreadReadByGuardian({ organizationId: ORG, accountId: GUARDIAN, postId }),
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  test('when the link ends, the thread leaves the guardian list and takes no more posts or reads', async () => {
    const client = await freshDatabase('ftg_link_ends');
    const opened = await start(GUARDIAN, CHILD);
    const reply = await staffReply(client, opened.thread_id);
    const sibling = await start(GUARDIAN, SIBLING);
    // Newest thread first.
    expect((await threads.listOwnFamilyThreads(ORG, GUARDIAN)).map((thread) => thread.thread_id))
      .toEqual([sibling.thread_id, opened.thread_id]);

    // The child turns 18 (their date of birth corrected to an adult's).
    await client.query('update pilot.athletes set dob = $3 where organization_id = $1 and athlete_id = $2', [ORG, CHILD, ADULT_DOB]);
    expect((await threads.listOwnFamilyThreads(ORG, GUARDIAN)).map((thread) => thread.thread_id)).toEqual([sibling.thread_id]);
    await expect(
      threads.writeAgainInFamilyThread({ organizationId: ORG, accountId: GUARDIAN, threadId: opened.thread_id, text: 'Still here.' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      threads.recordFamilyThreadReadByGuardian({ organizationId: ORG, accountId: GUARDIAN, postId: reply }),
    ).rejects.toMatchObject({ status: 404 });

    // The link to the sibling removed: nothing is left in the list.
    await client.query(
      'delete from pilot.guardian_links where organization_id = $1 and parent_id = $2 and athlete_id = $3',
      [ORG, `parent-${GUARDIAN}`, SIBLING],
    );
    await expect(threads.listOwnFamilyThreads(ORG, GUARDIAN)).resolves.toEqual([]);
  });

  test('a message needs words, up to 2000 characters', async () => {
    const client = await freshDatabase('ftg_text');
    for (const text of ['', '   ', 'x'.repeat(2001), null, 42, 'hi\u0000there']) {
      await expect(start(GUARDIAN, CHILD, text)).rejects.toMatchObject({ status: 400 });
    }
    await start(GUARDIAN, CHILD, `  ${'x'.repeat(2000)}  `);
    const stored = await client.query('select length(post_text)::int as n from pilot.family_thread_posts');
    expect(stored.rows).toEqual([{ n: 2000 }]);
  });
});
