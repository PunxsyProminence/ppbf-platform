// Real PostgreSQL contract test for pilot_slice_postgres_family_threads_migration.sql (W4 item 4,
// lane W4-4, PM-1a: a message a guardian starts to the coach about their own child, and the
// replies under it).
//
// What needs a real database to prove: that only a guardian opens a thread; that every other
// post sits under an opening post of the same gym and athlete; that a guardian writes again only
// in the thread they opened (Overwatch Q2 A on #2161) and a staff author holds that role on an
// active seat in the gym; that posts are append-only and survive their author's removal
// detached (D-9); that a read is the guardian reading staff in their own thread, or staff
// reading a guardian, and keeps its first time; that nothing is deleted by hand but everything
// goes with its athlete; that re-applying is a no-op; that the file holds nothing destructive;
// and that the runner's readiness assertion refuses a result it did not produce. Spins up the
// disposable local embedded Postgres the other migration suites use. It never connects to
// production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-threads-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-family-threads-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_family_threads_migration.sql';

const ORG = 'org-fthreads';
const OTHER_ORG = 'org-fthreads-other';
const GUARDIAN = 'acct-fthreads-guardian';
const CO_GUARDIAN = 'acct-fthreads-coguardian';
const COACH = 'acct-fthreads-coach';
const SECOND_COACH = 'acct-fthreads-coach-b';
const OFFICE = 'acct-fthreads-office';
const VISITING_COACH = 'acct-fthreads-visiting';
const LAPSED_COACH = 'acct-fthreads-lapsed';
const OTHER_GYM_COACH = 'acct-fthreads-other-coach';
const OTHER_GYM_GUARDIAN = 'acct-fthreads-other-guardian';
const SIBLING_GUARDIAN = 'acct-fthreads-sibling-guardian';
const ADMIN = 'acct-fthreads-admin';
const ATHLETE = 'ATH-FTHREADS-1';
const SIBLING = 'ATH-FTHREADS-2';

const THREAD = '11111111-1111-4111-8111-111111111111';
const REPLY = '22222222-2222-4222-8222-222222222222';
const FOLLOW_UP = '33333333-3333-4333-8333-333333333333';
const SIBLING_THREAD = '44444444-4444-4444-8444-444444444444';
const FOREIGN_THREAD = '55555555-5555-4555-8555-555555555555';
const CO_THREAD = '66666666-6666-4666-8666-666666666666';
const NEW_POST = '77777777-7777-4777-8777-777777777777';

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyRunner: Apply;
let migrationSql: string;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

interface PostValues {
  org?: string;
  postId?: string;
  threadId?: string;
  athleteId?: string;
  author?: string | null;
  role?: string;
  text?: string;
}

function post(client: Client, values: PostValues = {}) {
  const postId = values.postId ?? NEW_POST;
  return client.query(
    `insert into pilot.family_thread_posts
       (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
     values ($1, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
    [
      values.org ?? ORG,
      postId,
      values.threadId ?? postId,
      values.athleteId ?? ATHLETE,
      values.author === undefined ? GUARDIAN : values.author,
      values.role ?? 'parent',
      values.text ?? 'Is practice on Saturday?',
    ],
  );
}

function read(
  client: Client,
  values: { org?: string; postId?: string; reader?: string; role?: string } = {},
  onConflict = '',
) {
  return client.query(
    `insert into pilot.family_thread_reads (organization_id, post_id, reader_account_id, reader_role)
     values ($1, $2::uuid, $3, $4) ${onConflict}`,
    [values.org ?? ORG, values.postId ?? THREAD, values.reader ?? COACH, values.role ?? 'coach'],
  );
}

// A guardian's account removed the way the purge removes it: the guardian record lets go of the
// login first (pilot.parents.account_id has no delete action), then the account goes.
async function removeAccount(client: Client, account: string): Promise<void> {
  await client.query('update pilot.parents set account_id = null where account_id = $1', [account]);
  await client.query('delete from pilot.accounts where account_id = $1', [account]);
}

async function count(client: Client, table: string): Promise<number> {
  const result = await client.query(`select count(*)::int as n from pilot.${table}`);
  return result.rows[0].n;
}

// A gym with a child, the child's two guardians, the gym's staff, a coach visiting from the
// other gym, a coach whose seat here has ended and a coach of the other gym only. One guardian
// has opened a thread about the child, a coach has answered under it and the guardian has
// written again; the same guardian has a thread about the child's sibling, the co-guardian has
// a thread of their own, and the other gym has a thread about its child of the same id.
async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  if (schema === 'none') return client;

  // The whole schema in the `all` order, which includes this migration.
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
    [OFFICE, 'organization_admin', ORG],
    [VISITING_COACH, 'coach', OTHER_ORG],
    [LAPSED_COACH, 'coach', OTHER_ORG],
    [OTHER_GYM_COACH, 'coach', OTHER_ORG],
    [OTHER_GYM_GUARDIAN, 'parent', OTHER_ORG],
    [SIBLING_GUARDIAN, 'parent', ORG],
    [ADMIN, 'admin', ORG],
  ];
  for (const [account, role, org] of accounts) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [account, role, org],
    );
  }
  // Authority comes from an active seat in the gym, as sign-in grants it (auth.ts).
  const seats: Array<[string, string, string, boolean]> = [
    [GUARDIAN, ORG, 'parent', true],
    [CO_GUARDIAN, ORG, 'parent', true],
    [COACH, ORG, 'coach', true],
    [SECOND_COACH, ORG, 'coach', true],
    [OFFICE, ORG, 'organization_admin', true],
    [VISITING_COACH, ORG, 'coach', true],
    [LAPSED_COACH, ORG, 'coach', false],
    [OTHER_GYM_COACH, OTHER_ORG, 'coach', true],
    [OTHER_GYM_GUARDIAN, OTHER_ORG, 'parent', true],
    [SIBLING_GUARDIAN, ORG, 'parent', true],
    [ADMIN, ORG, 'admin', true],
  ];
  for (const [account, org, role, active] of seats) {
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, $4)`,
      [account, org, role, active],
    );
  }
  for (const [org, athlete] of [[ORG, ATHLETE], [ORG, SIBLING], [OTHER_ORG, ATHLETE]]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Thread Athlete', '2013-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athlete, org === ORG ? COACH : OTHER_GYM_COACH],
    );
  }
  // A guardian's reach is a guardian record in the gym, linked to the child (guardianAccess.ts).
  // The guardian is linked to both children; the co-guardian to the first only; another
  // guardian to the sibling only; the other gym's guardian to that gym's child.
  const links: Array<[string, string, string]> = [
    [ORG, GUARDIAN, ATHLETE],
    [ORG, GUARDIAN, SIBLING],
    [ORG, CO_GUARDIAN, ATHLETE],
    [ORG, SIBLING_GUARDIAN, SIBLING],
    [OTHER_ORG, OTHER_GYM_GUARDIAN, ATHLETE],
  ];
  const guardians: Array<[string, string]> = [
    [ORG, GUARDIAN],
    [ORG, CO_GUARDIAN],
    [ORG, SIBLING_GUARDIAN],
    [OTHER_ORG, OTHER_GYM_GUARDIAN],
  ];
  for (const [org, account] of guardians) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'Thread Guardian')`,
      [org, `parent-${account}`, account],
    );
  }
  for (const [org, account, athlete] of links) {
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'guardian')`,
      [org, `parent-${account}`, athlete],
    );
  }
  await post(client, { postId: THREAD });
  await post(client, { postId: REPLY, threadId: THREAD, author: COACH, role: 'coach', text: 'Yes, 10am.' });
  await post(client, { postId: FOLLOW_UP, threadId: THREAD, text: 'Thank you.' });
  await post(client, { postId: SIBLING_THREAD, athleteId: SIBLING });
  await post(client, { postId: CO_THREAD, author: CO_GUARDIAN });
  await post(client, { org: OTHER_ORG, postId: FOREIGN_THREAD, author: OTHER_GYM_GUARDIAN });
  return client;
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('family threads migration (W4 item 4, PM-1a)', () => {
  test('a thread, a staff reply and the guardian writing again are stored; re-applying through the runner is a no-op', async () => {
    const client = await freshDatabase('fthreads_store');
    try {
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);
      const rows = await client.query(
        `select post_id::text, thread_id::text, author_account_id, author_role
           from pilot.family_thread_posts where organization_id = $1 and thread_id = $2::uuid order by created_at, post_id`,
        [ORG, THREAD],
      );
      expect(rows.rows).toEqual([
        { post_id: THREAD, thread_id: THREAD, author_account_id: GUARDIAN, author_role: 'parent' },
        { post_id: REPLY, thread_id: THREAD, author_account_id: COACH, author_role: 'coach' },
        { post_id: FOLLOW_UP, thread_id: THREAD, author_account_id: GUARDIAN, author_role: 'parent' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('only a guardian opens a thread', async () => {
    const client = await freshDatabase('fthreads_opening');
    try {
      for (const [author, role] of [[COACH, 'coach'], [OFFICE, 'organization_admin']]) {
        await expect(post(client, { author, role })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_family_thread_posts_opening_check',
        });
      }
      // A role outside the four, on a reply (an opening post would also break the opening check).
      await expect(post(client, { threadId: THREAD, role: 'athlete' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_posts_role_check',
      });
      await expect(post(client, { author: null })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_posts_author_required',
      });
      expect(await count(client, 'family_thread_posts')).toBe(6);
    } finally {
      await client.end();
    }
  });

  test('a post sits only under an opening post of the same gym and the same athlete', async () => {
    const client = await freshDatabase('fthreads_under');
    try {
      // Under a reply, not an opening post.
      await expect(post(client, { threadId: REPLY, author: COACH, role: 'coach' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_posts_under_opening',
      });
      // Under a thread about another child: the thread key carries the athlete.
      await expect(post(client, { threadId: SIBLING_THREAD, author: COACH, role: 'coach' })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_family_thread_posts_thread_fk',
      });
      // Under another gym's thread, named from this gym; and under no thread at all.
      for (const threadId of [FOREIGN_THREAD, '88888888-8888-4888-8888-888888888888']) {
        await expect(post(client, { threadId, author: COACH, role: 'coach' })).rejects.toMatchObject({
          code: '23503',
          constraint: 'pilot_family_thread_posts_thread_fk',
        });
      }
      // About a child that is not in this gym: nobody is that child's guardian here, which the
      // guard says before the athlete key would.
      await expect(post(client, { athleteId: 'ATH-NOWHERE' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_posts_guardian_of_child',
      });
      expect(await count(client, 'family_thread_posts')).toBe(6);
    } finally {
      await client.end();
    }
  });

  test('a guardian writes again only in the thread they opened (Q2 A)', async () => {
    const client = await freshDatabase('fthreads_own');
    try {
      // The child's other guardian, in this guardian's thread; and this guardian in theirs.
      await expect(post(client, { threadId: THREAD, author: CO_GUARDIAN })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_posts_own_thread',
      });
      await expect(post(client, { threadId: CO_THREAD, author: GUARDIAN })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_posts_own_thread',
      });
      // The opener's account removed: the thread stays, and takes no more guardian posts.
      await removeAccount(client, CO_GUARDIAN);
      await expect(post(client, { threadId: CO_THREAD, author: GUARDIAN })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_posts_own_thread',
      });
      await post(client, { threadId: THREAD });
      expect(await count(client, 'family_thread_posts')).toBe(7);
    } finally {
      await client.end();
    }
  });

  test('a guardian post or read needs a live guardian of THIS child in this gym', async () => {
    const client = await freshDatabase('fthreads_guardian_link');
    try {
      const refused: Array<[string, string]> = [
        // A coach writing as a guardian; another gym's guardian naming this gym's child; the
        // guardian of the sibling only, about this child; a login that is nobody's guardian.
        [COACH, ATHLETE],
        [OTHER_GYM_GUARDIAN, ATHLETE],
        [SIBLING_GUARDIAN, ATHLETE],
        [ADMIN, SIBLING],
      ];
      for (const [author, athleteId] of refused) {
        await expect(post(client, { author, athleteId })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_family_thread_posts_guardian_of_child',
        });
      }
      // A switched-off login and a deleted one, though still linked.
      await client.query('update pilot.accounts set active_flag = false where account_id = $1', [CO_GUARDIAN]);
      await expect(post(client, { author: CO_GUARDIAN })).rejects.toMatchObject({
        constraint: 'pilot_family_thread_posts_guardian_of_child',
      });
      await client.query('update pilot.accounts set active_flag = true, deleted_at = now() where account_id = $1', [CO_GUARDIAN]);
      await expect(post(client, { author: CO_GUARDIAN })).rejects.toMatchObject({
        constraint: 'pilot_family_thread_posts_guardian_of_child',
      });

      // The guardian's link to the child ended: no more posts in their own thread, no reads.
      await client.query(
        'delete from pilot.guardian_links where organization_id = $1 and parent_id = $2 and athlete_id = $3',
        [ORG, `parent-${GUARDIAN}`, ATHLETE],
      );
      await expect(post(client, { threadId: THREAD })).rejects.toMatchObject({
        constraint: 'pilot_family_thread_posts_guardian_of_child',
      });
      await expect(read(client, { postId: REPLY, reader: GUARDIAN, role: 'parent' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_reads_guardian_of_child',
      });
      // Still the sibling's guardian.
      await post(client, { athleteId: SIBLING });
      expect(await count(client, 'family_thread_posts')).toBe(7);
      expect(await count(client, 'family_thread_reads')).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the rules hold for rows written together in one statement', async () => {
    const client = await freshDatabase('fthreads_one_statement');
    try {
      // The co-guardian's post in a thread that the same statement opens.
      await expect(
        client.query(
          `insert into pilot.family_thread_posts
             (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
           values ($1, $2::uuid, $3::uuid, $4, $5, 'parent', 'Mine too.'),
                  ($1, $3::uuid, $3::uuid, $4, $6, 'parent', 'A new thread.')`,
          [ORG, '99999999-9999-4999-8999-999999999999', NEW_POST, ATHLETE, CO_GUARDIAN, GUARDIAN],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'pilot_family_thread_posts_thread_fk' });
      // A staff reply in the co-guardian's thread, and this guardian's read of it, in one statement.
      await expect(
        client.query(
          `with reply as (
             insert into pilot.family_thread_posts
               (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
             values ($1, $2::uuid, $3::uuid, $4, $5, 'coach', 'Noted.') returning organization_id, post_id)
           insert into pilot.family_thread_reads (organization_id, post_id, reader_account_id, reader_role)
           select organization_id, post_id, $6, 'parent' from reply
           union all select organization_id, post_id, $7, 'organization_admin' from reply`,
          [ORG, NEW_POST, CO_THREAD, ATHLETE, COACH, GUARDIAN, OFFICE],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_thread_reads_guardian_own_thread' });
      // The co-guardian's read of a staff reply recorded BEFORE the reply is stored, in the same
      // statement: the read's rules cannot be applied to a post that is not there yet, so it is
      // refused, not left to the foreign key that would look only once the reply exists.
      await expect(
        client.query(
          `with seen as (
             insert into pilot.family_thread_reads (organization_id, post_id, reader_account_id, reader_role)
             values ($1, $2::uuid, $3, 'parent') returning organization_id, post_id)
           insert into pilot.family_thread_posts
             (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
           select organization_id, post_id, $4::uuid, $5, $6, 'coach', 'Noted.' from seen`,
          [ORG, NEW_POST, CO_GUARDIAN, THREAD, ATHLETE, COACH],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'pilot_family_thread_reads_post_fk' });
      expect(await count(client, 'family_thread_posts')).toBe(6);
      expect(await count(client, 'family_thread_reads')).toBe(0);

      // In order, one statement can open a thread and answer it: the opening is already stored.
      await client.query(
        `insert into pilot.family_thread_posts
           (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
         values ($1, $2::uuid, $2::uuid, $3, $4, 'parent', 'A new thread.'),
                ($1, $5::uuid, $2::uuid, $3, $4, 'parent', 'And more.')`,
        [ORG, NEW_POST, ATHLETE, GUARDIAN, '99999999-9999-4999-8999-999999999999'],
      );
      expect(await count(client, 'family_thread_posts')).toBe(8);
    } finally {
      await client.end();
    }
  });

  test('staff write only through an active seat in this gym, in the role they hold there', async () => {
    const client = await freshDatabase('fthreads_staff');
    try {
      const refused: Array<[string, string]> = [
        [OTHER_GYM_COACH, 'coach'],
        [LAPSED_COACH, 'coach'],
        [COACH, 'organization_admin'],
        [GUARDIAN, 'coach'],
        ['acct-nobody', 'coach'],
      ];
      for (const [author, role] of refused) {
        await expect(post(client, { threadId: THREAD, author, role })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_family_thread_posts_staff_of_this_gym',
        });
      }
      await client.query('update pilot.accounts set active_flag = false where account_id = $1', [SECOND_COACH]);
      await expect(post(client, { threadId: THREAD, author: SECOND_COACH, role: 'coach' })).rejects.toMatchObject({
        constraint: 'pilot_family_thread_posts_staff_of_this_gym',
      });
      await client.query('update pilot.accounts set active_flag = true, deleted_at = now() where account_id = $1', [SECOND_COACH]);
      await expect(post(client, { threadId: THREAD, author: SECOND_COACH, role: 'coach' })).rejects.toMatchObject({
        constraint: 'pilot_family_thread_posts_staff_of_this_gym',
      });

      // The office, an admin, and a coach from the other gym with an active coach seat here.
      await post(client, { postId: NEW_POST, threadId: THREAD, author: OFFICE, role: 'organization_admin' });
      await post(client, { postId: '99999999-9999-4999-8999-999999999999', threadId: THREAD, author: VISITING_COACH, role: 'coach' });
      await post(client, { postId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', threadId: THREAD, author: ADMIN, role: 'admin' });
      expect(await count(client, 'family_thread_posts')).toBe(9);
    } finally {
      await client.end();
    }
  });

  test('a post is 1 to 2000 characters of text', async () => {
    const client = await freshDatabase('fthreads_text');
    try {
      for (const text of ['', '   ', '\n\n\t', 'x'.repeat(2001)]) {
        await expect(post(client, { text })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_family_thread_posts_text_check',
        });
      }
      await post(client, { text: 'x'.repeat(2000) });
    } finally {
      await client.end();
    }
  });

  test('a post is append-only; only its author can be taken away, by the account going', async () => {
    const client = await freshDatabase('fthreads_append');
    try {
      for (const change of [
        "post_text = 'Edited.'",
        "author_role = 'coach'",
        `athlete_id = '${SIBLING}'`,
        `thread_id = '${CO_THREAD}'`,
        "created_at = now() - interval '1 day'",
        `author_account_id = '${CO_GUARDIAN}'`,
        // Detaching the author by hand: only the account's removal does that.
        'author_account_id = null',
      ]) {
        await expect(
          client.query(`update pilot.family_thread_posts set ${change} where post_id = $1::uuid`, [THREAD]),
        ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_thread_posts_append_only' });
      }
      // The guardian's account removed: their posts stay, detached, still a guardian's.
      await removeAccount(client, GUARDIAN);
      const left = await client.query(
        `select post_id::text, author_account_id, author_role from pilot.family_thread_posts
          where organization_id = $1 and post_id = any($2::uuid[]) order by post_id`,
        [ORG, [THREAD, FOLLOW_UP]],
      );
      expect(left.rows).toEqual([
        { post_id: THREAD, author_account_id: null, author_role: 'parent' },
        { post_id: FOLLOW_UP, author_account_id: null, author_role: 'parent' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a read is the opener reading staff in their own thread, or staff reading a guardian', async () => {
    const client = await freshDatabase('fthreads_reads');
    try {
      await read(client, { postId: REPLY, reader: GUARDIAN, role: 'parent' });
      await read(client, { postId: THREAD });
      await read(client, { postId: FOLLOW_UP, reader: OFFICE, role: 'organization_admin' });
      await read(client, { postId: THREAD, reader: VISITING_COACH });

      // A guardian reading their own words, the other guardian reading staff in this
      // guardian's thread, and a guardian reading the other guardian's opening post.
      for (const [postId, reader] of [[THREAD, GUARDIAN], [REPLY, CO_GUARDIAN], [CO_THREAD, GUARDIAN]]) {
        await expect(read(client, { postId, reader, role: 'parent' })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_family_thread_reads_guardian_own_thread',
        });
      }
      // Staff record reads of what a guardian wrote, not of each other.
      await expect(read(client, { postId: REPLY, reader: SECOND_COACH })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_reads_staff_reads_guardian',
      });
      for (const [reader, role] of [[OTHER_GYM_COACH, 'coach'], [LAPSED_COACH, 'coach'], [COACH, 'organization_admin'], [GUARDIAN, 'coach']]) {
        await expect(read(client, { reader, role })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_family_thread_reads_reader_of_this_gym',
        });
      }
      await expect(read(client, { reader: COACH, role: 'athlete' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_reads_role_check',
      });
      // Only a real post of this gym.
      for (const postId of [FOREIGN_THREAD, '88888888-8888-4888-8888-888888888888']) {
        await expect(read(client, { postId })).rejects.toMatchObject({
          code: '23503',
          constraint: 'pilot_family_thread_reads_post_fk',
        });
      }
      expect(await count(client, 'family_thread_reads')).toBe(4);
    } finally {
      await client.end();
    }
  });

  test('when a post was written and when a read was first made are the database clock, not the caller', async () => {
    const client = await freshDatabase('fthreads_clock');
    try {
      await client.query(
        `insert into pilot.family_thread_posts
           (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text, created_at)
         values ($1, $2::uuid, $2::uuid, $3, $4, 'parent', 'Backdated?', now() - interval '30 days')`,
        [ORG, NEW_POST, ATHLETE, GUARDIAN],
      );
      await client.query(
        `insert into pilot.family_thread_reads (organization_id, post_id, reader_account_id, reader_role, first_read_at)
         values ($1, $2::uuid, $3, 'coach', now() - interval '30 days')`,
        [ORG, NEW_POST, COACH],
      );
      const stamps = await client.query(
        `select (select created_at > now() - interval '1 minute' from pilot.family_thread_posts where post_id = $1::uuid) as post_now,
                (select first_read_at > now() - interval '1 minute' from pilot.family_thread_reads where post_id = $1::uuid) as read_now`,
        [NEW_POST],
      );
      expect(stamps.rows[0]).toEqual({ post_now: true, read_now: true });
    } finally {
      await client.end();
    }
  });

  test('a second look is the same row and keeps the first time; a read is never changed', async () => {
    const client = await freshDatabase('fthreads_first');
    try {
      await read(client);
      const first = await client.query('select first_read_at from pilot.family_thread_reads');
      await expect(read(client)).rejects.toMatchObject({ code: '23505', constraint: 'pilot_family_thread_reads_pkey' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await read(client, {}, 'on conflict (organization_id, post_id, reader_account_id) do nothing');
      const rows = await client.query('select first_read_at from pilot.family_thread_reads');
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].first_read_at.toISOString()).toBe(first.rows[0].first_read_at.toISOString());

      for (const change of ["first_read_at = now() - interval '1 day'", "reader_role = 'coach'", `reader_account_id = '${SECOND_COACH}'`]) {
        await expect(client.query(`update pilot.family_thread_reads set ${change}`)).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_family_thread_reads_first_read_kept',
        });
      }
    } finally {
      await client.end();
    }
  });

  test('nothing is deleted by hand; reads go with their reader, and everything goes with the athlete', async () => {
    const client = await freshDatabase('fthreads_cascade');
    try {
      await read(client);
      await read(client, { reader: SECOND_COACH });
      await read(client, { postId: REPLY, reader: GUARDIAN, role: 'parent' });
      await expect(client.query('delete from pilot.family_thread_posts where post_id = $1::uuid', [REPLY])).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_posts_no_delete',
      });
      await expect(client.query('delete from pilot.family_thread_reads')).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_thread_reads_no_delete',
      });

      // A coach's account removed: their read goes; the reply they wrote stays, detached.
      await post(client, { postId: NEW_POST, threadId: THREAD, author: SECOND_COACH, role: 'coach' });
      await removeAccount(client, SECOND_COACH);
      expect(await count(client, 'family_thread_reads')).toBe(2);
      const reply = await client.query('select author_account_id, author_role from pilot.family_thread_posts where post_id = $1::uuid', [NEW_POST]);
      expect(reply.rows).toEqual([{ author_account_id: null, author_role: 'coach' }]);

      // The child removed: every thread about them, every post in it and every read of it go.
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE]);
      const left = await client.query(
        'select organization_id, post_id::text from pilot.family_thread_posts order by organization_id, post_id',
      );
      expect(left.rows).toEqual([
        { organization_id: ORG, post_id: SIBLING_THREAD },
        { organization_id: OTHER_ORG, post_id: FOREIGN_THREAD },
      ]);
      expect(await count(client, 'family_thread_reads')).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive and alters no existing table', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|schema|function)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\balter\s+table\b/);
    expect(sql).not.toMatch(/\bcoach_observations\b|\bfamily_message_replies\b|\bfamily_message_reads\b|\bfamily_reply_reads\b/);
  });

  // Every readiness column the runner asserts, in its order: each must be able to refuse.
  const READINESS = [
    'posts_table_ready', 'posts_columns_ready', 'posts_primary_key_ready', 'posts_post_athlete_key_ready',
    'posts_athlete_fk_ready', 'posts_thread_fk_ready', 'posts_author_fk_set_null', 'posts_organization_fk_ready',
    'posts_role_check_ready', 'posts_opening_check_ready', 'posts_text_check_ready', 'posts_thread_index_ready',
    'posts_athlete_index_ready', 'posts_author_index_ready', 'posts_guard_ready',
    'reads_table_ready', 'reads_columns_ready', 'reads_primary_key_ready', 'reads_post_fk_ready',
    'reads_reader_fk_cascade', 'reads_organization_fk_ready', 'reads_reader_index_ready', 'reads_role_check_ready',
    'reads_guard_ready',
  ];
  const P = 'pilot.family_thread_posts';
  const R = 'pilot.family_thread_reads';
  // One change per readiness column that leaves the object there by name but in another shape.
  // Each runs inside the runner's transaction and is rolled back by its refusal.
  const SWAPS: Array<[string, string]> = [
    [`alter table ${P} alter column author_role drop not null`, 'posts_columns_ready'],
    [`alter table ${R} drop constraint pilot_family_thread_reads_post_fk;
      alter table ${P} drop constraint pilot_family_thread_posts_pkey,
        add constraint pilot_family_thread_posts_pkey unique (organization_id, post_id)`, 'posts_primary_key_ready'],
    [`alter table ${P} drop constraint pilot_family_thread_posts_thread_fk,
        drop constraint pilot_family_thread_posts_post_athlete_key,
        add constraint pilot_family_thread_posts_post_athlete_key unique (organization_id, athlete_id, post_id)`, 'posts_post_athlete_key_ready'],
    [`alter table ${P} drop constraint pilot_family_thread_posts_athlete_fk,
        add constraint pilot_family_thread_posts_athlete_fk foreign key (organization_id, athlete_id)
          references pilot.athletes(organization_id, athlete_id)`, 'posts_athlete_fk_ready'],
    [`alter table ${P} drop constraint pilot_family_thread_posts_thread_fk,
        add constraint pilot_family_thread_posts_thread_fk foreign key (organization_id, thread_id, athlete_id)
          references ${P}(organization_id, post_id, athlete_id)`, 'posts_thread_fk_ready'],
    [`alter table ${P} drop constraint pilot_family_thread_posts_thread_fk,
        add constraint pilot_family_thread_posts_thread_fk foreign key (organization_id, thread_id, athlete_id)
          references ${P}(organization_id, post_id, athlete_id) on delete cascade deferrable initially deferred`, 'posts_thread_fk_ready'],
    [`alter table ${P} drop constraint family_thread_posts_author_account_id_fkey,
        add constraint family_thread_posts_author_account_id_fkey foreign key (author_account_id)
          references pilot.accounts(account_id) on delete cascade`, 'posts_author_fk_set_null'],
    [`alter table ${P} drop constraint family_thread_posts_organization_id_fkey,
        add constraint family_thread_posts_organization_id_fkey foreign key (organization_id)
          references pilot.organizations(organization_id)`, 'posts_organization_fk_ready'],
    [`alter table ${P} drop constraint pilot_family_thread_posts_role_check,
        add constraint pilot_family_thread_posts_role_check check (author_role in ('parent', 'coach', 'organization_admin', 'admin', 'athlete'))`, 'posts_role_check_ready'],
    [`alter table ${P} drop constraint pilot_family_thread_posts_opening_check,
        add constraint pilot_family_thread_posts_opening_check check (post_id <> thread_id or author_role in ('parent', 'coach'))`, 'posts_opening_check_ready'],
    [`alter table ${P} drop constraint pilot_family_thread_posts_text_check,
        add constraint pilot_family_thread_posts_text_check check (post_text ~ '[^[:space:]]' and length(post_text) <= 4000)`, 'posts_text_check_ready'],
    [`drop index pilot.idx_family_thread_posts_thread;
      create index idx_family_thread_posts_thread on ${P}(organization_id, thread_id)`, 'posts_thread_index_ready'],
    ['drop index pilot.idx_family_thread_posts_athlete', 'posts_athlete_index_ready'],
    [`drop index pilot.idx_family_thread_posts_author;
      create index idx_family_thread_posts_author on ${P}(organization_id, author_account_id)`, 'posts_author_index_ready'],
    [`alter table ${P} disable trigger trg_family_thread_posts_guard`, 'posts_guard_ready'],
    [`alter table ${R} alter column first_read_at drop default`, 'reads_columns_ready'],
    [`alter table ${R} drop constraint pilot_family_thread_reads_pkey,
        add constraint pilot_family_thread_reads_pkey unique (organization_id, post_id, reader_account_id)`, 'reads_primary_key_ready'],
    [`alter table ${R} drop constraint pilot_family_thread_reads_post_fk,
        add constraint pilot_family_thread_reads_post_fk foreign key (organization_id, post_id)
          references ${P}(organization_id, post_id)`, 'reads_post_fk_ready'],
    [`alter table ${R} drop constraint family_thread_reads_reader_account_id_fkey,
        add constraint family_thread_reads_reader_account_id_fkey foreign key (reader_account_id)
          references pilot.accounts(account_id)`, 'reads_reader_fk_cascade'],
    [`alter table ${R} drop constraint family_thread_reads_organization_id_fkey,
        add constraint family_thread_reads_organization_id_fkey foreign key (organization_id)
          references pilot.organizations(organization_id)`, 'reads_organization_fk_ready'],
    ['drop index pilot.idx_family_thread_reads_reader', 'reads_reader_index_ready'],
    [`alter table ${R} drop constraint pilot_family_thread_reads_role_check,
        add constraint pilot_family_thread_reads_role_check check (reader_role in ('parent', 'coach', 'organization_admin', 'admin', 'athlete'))`, 'reads_role_check_ready'],
    [`alter table ${R} enable replica trigger trg_family_thread_reads_guard`, 'reads_guard_ready'],
  ];

  test('every readiness column refuses an object of its name in another shape', async () => {
    const client = await freshDatabase('fthreads_shape');
    try {
      for (const [change, missing] of SWAPS) {
        const refusal = await applyRunner(client, change).then(() => null, (error: Error) => error.message);
        expect({ change, refused: refusal?.replace('FAMILY_THREADS_NOT_READY: ', '').split(', ') })
          .toEqual({ change, refused: expect.arrayContaining([missing]) });
      }
      // Every column but the two table checks (the empty-database test) has a swap of its own.
      expect(new Set(SWAPS.map(([, missing]) => missing))).toEqual(
        new Set(READINESS.filter((name) => !name.endsWith('_table_ready'))),
      );
      // Each refusal was rolled back: the migration's own shape still passes.
      await applyRunner(client, migrationSql);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce, naming every check', async () => {
    const client = await freshDatabase('fthreads_absent', 'none');
    try {
      await client.query('create schema pilot');
      await expect(applyRunner(client, 'select 1')).rejects.toThrow(`FAMILY_THREADS_NOT_READY: ${READINESS.join(', ')}`);
    } finally {
      await client.end();
    }
  });

  test('the release path: the runner creates both tables where they do not exist yet', async () => {
    const client = await freshDatabase('fthreads_release');
    try {
      await client.query(`drop table ${R}; drop table ${P};
        drop function pilot.family_thread_reads_guard(); drop function pilot.family_thread_posts_guard()`);
      await applyRunner(client, migrationSql);
      await post(client, { postId: THREAD });
      await post(client, { postId: REPLY, threadId: THREAD, author: COACH, role: 'coach' });
      await read(client, { postId: REPLY, reader: GUARDIAN, role: 'parent' });
      expect(await count(client, 'family_thread_posts')).toBe(2);
      expect(await count(client, 'family_thread_reads')).toBe(1);
    } finally {
      await client.end();
    }
  });
});
