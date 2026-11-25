// Real PostgreSQL contract for the staff half of family threads (W4 item 4, lane W4-4, PM-1c):
// the gym's coaches, organization admins and admins read every thread on an athlete they reach,
// with the guardian's name (Overwatch Q4 A on #2161), answer under it with an audit row in the
// same transaction, and record seeing a guardian's post, each for themselves. This suite runs the
// production SQL in familyThreads.ts, access.ts and audit.ts through the ./db mock below, against
// the full schema built in the apply-migrations `all` order.
//
// It proves, on a real database: staff read only this athlete's threads in their own gym; a reply
// writes one audit row (family_thread_reply, no words) and nothing to the SHADOW feed or
// telemetry, and the two commit or roll back together; a forged id, another gym's thread, a reply
// id, a deleted child and another gym's coach are one 404; a role outside the staff list and a
// staff account without an active seat here are refused; "new to me" is each staff member's own;
// the store's own checks hold with the database guards switched off.
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

import type { PilotRole } from './contracts';

/* ts-jest compiles a plain `await import()` down to require(), which cannot load an ES module
   here. Building it through Function keeps a real dynamic import in the emitted code. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes familyThreads.ts's, access.ts's, audit.ts's and achievements.ts's queries into whichever
// embedded database the current test opened. Declared before the import so jest's hoisting sees it.
let activeClient: Client | null = null;
// Set while withTransaction's callback runs. The mock's pooled query and queryOne refuse then: in
// production they would run on another connection, outside the transaction, so a write that
// forgot the transaction's client must fail here rather than pass by sharing this one.
let inTransaction = false;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    if (inTransaction) throw new Error('pooled query inside a transaction: pass its client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    if (inTransaction) throw new Error('pooled query inside a transaction: pass its client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    inTransaction = true;
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      inTransaction = false;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      inTransaction = false;
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-threads-staff-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG = 'org-fts';
const OTHER_ORG = 'org-fts-other';
const GUARDIAN = 'acct-fts-guardian';
const CO_GUARDIAN = 'acct-fts-coguardian';
const OTHER_GYM_GUARDIAN = 'acct-fts-other-guardian';
const COACH = 'acct-fts-coach';
const SECOND_COACH = 'acct-fts-coach-b';
const GYM_ADMIN = 'acct-fts-admin';
const SEATLESS_COACH = 'acct-fts-seatless';
const OTHER_GYM_COACH = 'acct-fts-other-coach';
const CHILD = 'ATH-FTS-CHILD';
const SIBLING = 'ATH-FTS-SIBLING';
const MINOR_DOB = '2014-06-01';

type Threads = typeof import('./familyThreads');
let getStaffAuthorName: typeof import('./achievements').getStaffAuthorName;
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

// A gym with a child and the child's sibling; the child's two guardians (the first also guards the
// sibling); two coaches, an organization admin and a coach whose seat here is no longer active; and
// another gym with a child of the same id, that child's guardian and that gym's coach.
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
  const accounts: Array<[string, string, string, boolean]> = [
    [GUARDIAN, 'parent', ORG, true],
    [CO_GUARDIAN, 'parent', ORG, true],
    [COACH, 'coach', ORG, true],
    [SECOND_COACH, 'coach', ORG, true],
    [GYM_ADMIN, 'organization_admin', ORG, true],
    [SEATLESS_COACH, 'coach', ORG, false],
    [OTHER_GYM_GUARDIAN, 'parent', OTHER_ORG, true],
    [OTHER_GYM_COACH, 'coach', OTHER_ORG, true],
  ];
  for (const [account, role, org, seated] of accounts) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [account, role, org],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, $4)`,
      [account, org, role, seated],
    );
  }
  const athletes: Array<[string, string, string]> = [
    [ORG, CHILD, COACH],
    [ORG, SIBLING, COACH],
    [OTHER_ORG, CHILD, OTHER_GYM_COACH],
  ];
  for (const [org, athlete, coach] of athletes) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Thread Child', $3, 'fly', 'active', 'contact', true, $4, now(), now())`,
      [org, athlete, MINOR_DOB, coach],
    );
  }
  const parents: Array<[string, string, string]> = [
    [ORG, GUARDIAN, 'First Guardian'],
    [ORG, CO_GUARDIAN, 'Second Guardian'],
    [OTHER_ORG, OTHER_GYM_GUARDIAN, 'Other Gym Guardian'],
  ];
  for (const [org, account, fullName] of parents) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, $4)`,
      [org, `parent-${account}`, account, fullName],
    );
  }
  // The first guardian's account also holds a parent record in this gym linked to no child, and
  // one in the other gym linked to that gym's child; both names sort before theirs. Staff must
  // still see the name on the record linked to this child in this gym (Q4 A).
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-unlinked-record', $2, 'Aab Unlinked Record'), ($3, 'parent-elsewhere-record', $2, 'Aaa Elsewhere Record')`,
    [ORG, GUARDIAN, OTHER_ORG],
  );
  const links: Array<[string, string, string]> = [
    [ORG, GUARDIAN, CHILD],
    [ORG, GUARDIAN, SIBLING],
    [ORG, CO_GUARDIAN, CHILD],
    [OTHER_ORG, OTHER_GYM_GUARDIAN, CHILD],
  ];
  for (const [org, account, athlete] of links) {
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'guardian')`,
      [org, `parent-${account}`, athlete],
    );
  }
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-elsewhere-record', $2, 'guardian')`,
    [OTHER_ORG, CHILD],
  );
  activeClient = client;
  return client;
}

// One status and one sentence, whichever it was (familyThreads.ts NOT_HERE).
const NOT_HERE = { status: 404, message: 'Not found: that message is not in your gym.' };

const staff = (accountId: string, role: PilotRole = 'coach', organizationId = ORG) => ({ organizationId, accountId, role });

const open = (accountId: string, athleteId = CHILD, organizationId = ORG, text = 'Is practice on Saturday?') =>
  threads.startFamilyThread({ organizationId, accountId, athleteId, text });

const reply = (accountId: string, threadId: string, role: PilotRole = 'coach', organizationId = ORG) =>
  threads.replyInFamilyThread(staff(accountId, role, organizationId), { threadId, text: 'Yes, see you Saturday.' });

async function counts(client: Client): Promise<{ posts: number; reads: number; audits: number }> {
  const result = await client.query(
    `select (select count(*)::int from pilot.family_thread_posts) as posts,
            (select count(*)::int from pilot.family_thread_reads) as reads,
            (select count(*)::int from pilot.audit_events where entity_type = 'family_thread_reply') as audits`,
  );
  return result.rows[0];
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
  threads = await import('./familyThreads');
  ({ getStaffAuthorName } = await import('./achievements'));
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

describe('family threads, the staff half (W4 item 4, PM-1c)', () => {
  test("a coach reads every thread on a child they reach, newest first, with the guardian's name and no account id", async () => {
    await freshDatabase('fts_list');
    const first = await open(GUARDIAN);
    const second = await open(CO_GUARDIAN);
    await open(GUARDIAN, SIBLING);
    await open(OTHER_GYM_GUARDIAN, CHILD, OTHER_ORG);
    const answer = await reply(COACH, first.thread_id);
    const again = await threads.writeAgainInFamilyThread({ organizationId: ORG, accountId: GUARDIAN, threadId: first.thread_id, text: 'Thank you!' });

    const list = await threads.listFamilyThreadsForStaff(staff(COACH), CHILD);
    expect(list.map((thread) => [thread.thread_id, thread.athlete_id, thread.guardian_name])).toEqual([
      [second.thread_id, CHILD, 'Second Guardian'],
      [first.thread_id, CHILD, 'First Guardian'],
    ]);
    expect(list[1].posts.map((post) => [post.post_id, post.from, post.new_to_me])).toEqual([
      [first.post_id, 'guardian', true],
      [answer.post_id, 'staff', false],
      [again.post_id, 'guardian', true],
    ]);
    expect(list[1].posts[0]).toEqual({
      post_id: first.post_id, from: 'guardian', staff_name: null, text: 'Is practice on Saturday?', created_at: first.created_at, new_to_me: true,
    });
    expect(list[1].posts[1].staff_name).toBe(await getStaffAuthorName(ORG, COACH, 'coach'));
    for (const account of [GUARDIAN, CO_GUARDIAN, COACH]) expect(JSON.stringify(list)).not.toContain(account);

    // The other gym's coach, asking about the same athlete id, reads only their own gym's thread.
    const elsewhere = await threads.listFamilyThreadsForStaff(staff(OTHER_GYM_COACH, 'coach', OTHER_ORG), CHILD);
    expect(elsewhere.map((thread) => thread.guardian_name)).toEqual(['Other Gym Guardian']);
  });

  test('a reply writes one audit row with no words in it, and nothing to the SHADOW feed or telemetry', async () => {
    const client = await freshDatabase('fts_audit');
    const opened = await open(GUARDIAN);
    const answer = await reply(COACH, opened.thread_id);

    const audit = await client.query(
      `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
         from pilot.audit_events where entity_type = 'family_thread_reply'`,
    );
    expect(audit.rows).toEqual([{
      event_type: 'create',
      actor_account_id: COACH,
      actor_role: 'coach',
      organization_id: ORG,
      entity_id: answer.post_id,
      details: { athlete_id: CHILD, thread_id: opened.thread_id },
    }]);
    const mirrors = await client.query(
      `select (select count(*)::int from pilot.shadow_events) as events,
              (select count(*)::int from pilot.shadow_telemetry_events) as metrics`,
    );
    expect(mirrors.rows[0]).toEqual({ events: 0, metrics: 0 });

    // The guardian who opened it sees the answer, from staff, new to them.
    const [mine] = await threads.listOwnFamilyThreads(ORG, GUARDIAN);
    expect(mine.posts[1]).toMatchObject({ post_id: answer.post_id, from: 'staff', new_to_me: true });
  });

  test('the reply and its audit row commit or roll back together', async () => {
    const client = await freshDatabase('fts_atomic');
    const opened = await open(GUARDIAN);
    await client.query(`create function pg_temp.refuse_audit() returns trigger language plpgsql as $$
      begin raise exception 'audit refused for the test'; end $$;
      create trigger refuse_family_thread_audit before insert on pilot.audit_events
        for each row when (new.entity_type = 'family_thread_reply') execute function pg_temp.refuse_audit()`);
    await expect(reply(COACH, opened.thread_id)).rejects.toThrow('audit refused for the test');
    expect(await counts(client)).toEqual({ posts: 1, reads: 0, audits: 0 });
  });

  test("a forged id, another gym's thread, a reply's id, another gym's coach and a deleted child are one 404", async () => {
    const client = await freshDatabase('fts_reach');
    const opened = await open(GUARDIAN);
    const answer = await reply(COACH, opened.thread_id);
    const elsewhere = await open(OTHER_GYM_GUARDIAN, CHILD, OTHER_ORG);
    const before = await counts(client);

    for (const threadId of ['not-an-id', '88888888-8888-4888-8888-888888888888', elsewhere.thread_id, answer.post_id]) {
      await expect(reply(COACH, threadId)).rejects.toMatchObject(NOT_HERE);
    }
    await expect(reply(OTHER_GYM_COACH, opened.thread_id, 'coach', OTHER_ORG)).rejects.toMatchObject(NOT_HERE);
    for (const postId of ['not-an-id', '88888888-8888-4888-8888-888888888888', elsewhere.post_id]) {
      await expect(threads.recordFamilyThreadReadByStaff(staff(COACH), postId)).rejects.toMatchObject(NOT_HERE);
    }
    await expect(threads.recordFamilyThreadReadByStaff(staff(OTHER_GYM_COACH, 'coach', OTHER_ORG), opened.post_id))
      .rejects.toMatchObject(NOT_HERE);

    await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, CHILD]);
    await expect(reply(COACH, opened.thread_id)).rejects.toMatchObject(NOT_HERE);
    await expect(threads.recordFamilyThreadReadByStaff(staff(COACH), opened.post_id)).rejects.toMatchObject(NOT_HERE);
    await expect(threads.listFamilyThreadsForStaff(staff(COACH), CHILD)).rejects.toThrow('Forbidden');
    expect(await counts(client)).toEqual(before);
  });

  test('a role outside the staff list is refused by the store itself, and an organization admin reads and answers', async () => {
    const client = await freshDatabase('fts_roles');
    const opened = await open(GUARDIAN);
    for (const role of ['parent', 'athlete', 'board', 'platform_owner', 'volunteer', 'staff'] as PilotRole[]) {
      await expect(reply(GUARDIAN, opened.thread_id, role)).rejects.toThrow('Forbidden');
      await expect(threads.recordFamilyThreadReadByStaff(staff(GUARDIAN, role), opened.post_id)).rejects.toThrow('Forbidden');
      // The co-guardian, called as anything but staff, reads nothing of the first guardian's thread.
      await expect(threads.listFamilyThreadsForStaff(staff(CO_GUARDIAN, role), CHILD)).rejects.toThrow('Forbidden');
    }
    expect(await counts(client)).toEqual({ posts: 1, reads: 0, audits: 0 });

    expect(await threads.listFamilyThreadsForStaff(staff(GYM_ADMIN, 'organization_admin'), CHILD)).toHaveLength(1);
    const answer = await reply(GYM_ADMIN, opened.thread_id, 'organization_admin');
    await threads.recordFamilyThreadReadByStaff(staff(GYM_ADMIN, 'organization_admin'), opened.post_id);
    const audit = await client.query(`select actor_role from pilot.audit_events where entity_id = $1`, [answer.post_id]);
    expect(audit.rows).toEqual([{ actor_role: 'organization_admin' }]);
    expect(await counts(client)).toEqual({ posts: 2, reads: 1, audits: 1 });
  });

  test('a staff account without an active seat in this gym is refused by the database guard, and nothing is kept', async () => {
    const client = await freshDatabase('fts_seat');
    const opened = await open(GUARDIAN);
    await expect(reply(SEATLESS_COACH, opened.thread_id)).rejects.toMatchObject({ status: 403 });
    await expect(threads.recordFamilyThreadReadByStaff(staff(SEATLESS_COACH), opened.post_id)).rejects.toMatchObject({ status: 403 });
    expect(await counts(client)).toEqual({ posts: 1, reads: 0, audits: 0 });
  });

  test("new to me is each staff member's own; a second look keeps the first time; a staff post is not a read", async () => {
    const client = await freshDatabase('fts_reads');
    const opened = await open(GUARDIAN);
    const answer = await reply(COACH, opened.thread_id);

    await threads.recordFamilyThreadReadByStaff(staff(COACH), opened.post_id);
    const first = await client.query(`select first_read_at from pilot.family_thread_reads`);
    await threads.recordFamilyThreadReadByStaff(staff(COACH), opened.post_id);
    const second = await client.query(`select first_read_at from pilot.family_thread_reads`);
    expect(second.rows).toEqual(first.rows);

    const [mine] = await threads.listFamilyThreadsForStaff(staff(COACH), CHILD);
    const [theirs] = await threads.listFamilyThreadsForStaff(staff(SECOND_COACH), CHILD);
    expect(mine.posts[0].new_to_me).toBe(false);
    expect(theirs.posts[0].new_to_me).toBe(true);

    await expect(threads.recordFamilyThreadReadByStaff(staff(SECOND_COACH), answer.post_id)).rejects.toMatchObject({ status: 404 });
    expect((await counts(client)).reads).toBe(1);
  });

  test("the store's own checks hold with the database guards and the thread and post keys switched off", async () => {
    // The database refuses these too (migration family-threads): its guards, and the keys that tie
    // a post to its thread and a read to its post in the same gym. Switched off here, in this
    // throwaway database, so each 404 below is the store's own check (familyThreads.ts).
    const client = await freshDatabase('fts_store_checks');
    const opened = await open(GUARDIAN);
    const answer = await reply(COACH, opened.thread_id);
    const elsewhere = await open(OTHER_GYM_GUARDIAN, CHILD, OTHER_ORG);
    await client.query(`alter table pilot.family_thread_posts disable trigger trg_family_thread_posts_guard;
      alter table pilot.family_thread_reads disable trigger trg_family_thread_reads_guard;
      alter table pilot.family_thread_reads drop constraint pilot_family_thread_reads_post_fk;
      alter table pilot.family_thread_posts drop constraint pilot_family_thread_posts_thread_fk`);
    const before = await counts(client);

    await expect(reply(COACH, answer.post_id)).rejects.toMatchObject({ status: 404 });
    await expect(reply(COACH, elsewhere.thread_id)).rejects.toMatchObject({ status: 404 });
    await expect(threads.recordFamilyThreadReadByStaff(staff(COACH), answer.post_id)).rejects.toMatchObject({ status: 404 });
    await expect(threads.recordFamilyThreadReadByStaff(staff(COACH), elsewhere.post_id)).rejects.toMatchObject({ status: 404 });
    await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, CHILD]);
    await expect(reply(COACH, opened.thread_id)).rejects.toMatchObject({ status: 404 });
    await expect(threads.recordFamilyThreadReadByStaff(staff(COACH), opened.post_id)).rejects.toMatchObject({ status: 404 });
    expect(await counts(client)).toEqual(before);
  });

  test('a removed guardian or staff account leaves the thread, unnamed; a reply needs words', async () => {
    const client = await freshDatabase('fts_removed');
    const opened = await open(GUARDIAN);
    const answer = await reply(SECOND_COACH, opened.thread_id);
    // pilot.parents.account_id has no delete action: the account's removal clears it first.
    await client.query(`update pilot.parents set account_id = null where account_id = $1`, [GUARDIAN]);
    await client.query(`delete from pilot.accounts where account_id in ($1, $2)`, [GUARDIAN, SECOND_COACH]);

    const [thread] = await threads.listFamilyThreadsForStaff(staff(COACH), CHILD);
    expect(thread.guardian_name).toBe('A guardian');
    expect(thread.posts.map((post) => [post.post_id, post.from, post.staff_name])).toEqual([
      [opened.post_id, 'guardian', null],
      [answer.post_id, 'staff', null],
    ]);

    for (const text of ['', '   ', null, 'x'.repeat(2001)]) {
      await expect(threads.replyInFamilyThread(staff(COACH), { threadId: opened.thread_id, text })).rejects.toMatchObject({ status: 400 });
    }
    expect((await counts(client)).posts).toBe(2);
  });
});
