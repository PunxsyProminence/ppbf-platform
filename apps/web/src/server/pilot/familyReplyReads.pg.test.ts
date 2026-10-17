// Real PostgreSQL contract test for pilot_slice_postgres_family_reply_reads_migration.sql
// (FC-09, the storage for when a staff member first saw a guardian's reply; issue #1542's track,
// lane L29).
//
// What needs a real database to prove: that a read binds to a real reply of the same gym, by a
// staff member who holds that role in that gym, and to nothing else; that one staff member's
// second look is the same row and keeps the first time; that two coaches are two reads; that a
// read is never changed or deleted by hand, but goes with its reply, its note, its athlete and
// its reader's account; that re-applying the file is a no-op; that the file holds nothing
// destructive; and that the runner's readiness assertion refuses a result it did not produce.
// Spins up the disposable local embedded Postgres the other migration suites use. It never
// connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-reply-reads-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-family-reply-reads-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_family_reply_reads_migration.sql';

const ORG = 'org-rreads';
const OTHER_ORG = 'org-rreads-other';
const COACH = 'acct-rreads-coach';
const SECOND_COACH = 'acct-rreads-coach-b';
const OFFICE = 'acct-rreads-office';
const VISITING_COACH = 'acct-rreads-visiting';
const LAPSED_COACH = 'acct-rreads-lapsed';
const OTHER_GYM_COACH = 'acct-rreads-other-coach';
const GUARDIAN = 'acct-rreads-guardian';
const ATHLETE = 'ATH-RREADS-1';
const MESSAGE = '11111111-1111-4111-8111-111111111111';
const FOREIGN_MESSAGE = '33333333-3333-4333-8333-333333333333';
const REPLY = '44444444-4444-4444-8444-444444444444';
const FOREIGN_REPLY = '55555555-5555-4555-8555-555555555555';

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

async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  if (schema === 'none') return client;

  // The whole schema in the `all` order, which now includes this migration.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $7, 'microsoft'), ($2, 'coach', $7, 'microsoft'), ($3, 'organization_admin', $7, 'microsoft'),
            ($4, 'coach', $8, 'microsoft'), ($5, 'coach', $8, 'microsoft'), ($6, 'parent', $7, 'microsoft'),
            ($9, 'coach', $8, 'microsoft')`,
    [COACH, SECOND_COACH, OFFICE, VISITING_COACH, LAPSED_COACH, GUARDIAN, ORG, OTHER_ORG, OTHER_GYM_COACH],
  );
  // Authority comes from an active seat in the gym, as sign-in grants it (auth.ts): the home
  // staff hold theirs; a coach whose home gym is the other one holds an active coach seat here,
  // and one whose seat here has ended.
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $6, 'coach', true), ($2, $6, 'coach', true), ($3, $6, 'organization_admin', true),
            ($4, $6, 'coach', true), ($5, $6, 'coach', false), ($7, $8, 'coach', true), ($9, $6, 'parent', true)`,
    [COACH, SECOND_COACH, OFFICE, VISITING_COACH, LAPSED_COACH, ORG, OTHER_GYM_COACH, OTHER_ORG, GUARDIAN],
  );
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Reply Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, ATHLETE, COACH],
    );
  }
  for (const [org, noteId] of [
    [ORG, MESSAGE],
    [OTHER_ORG, FOREIGN_MESSAGE],
  ] as const) {
    await client.query(
      `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
       values ($1, $2::uuid, $3, $4, 'parent_message', 'Bring gloves Thursday.')`,
      [org, noteId, ATHLETE, COACH],
    );
  }
  for (const [org, replyId, noteId] of [
    [ORG, REPLY, MESSAGE],
    [OTHER_ORG, FOREIGN_REPLY, FOREIGN_MESSAGE],
  ] as const) {
    await client.query(
      `insert into pilot.family_message_replies (organization_id, reply_id, note_id, athlete_id, author_account_id, author_role, reply_text)
       values ($1, $2::uuid, $3::uuid, $4, $5, 'parent', 'We will.')`,
      [org, replyId, noteId, ATHLETE, GUARDIAN],
    );
  }
  return client;
}

function read(
  client: Client,
  values: { org?: string; replyId?: string; reader?: string; role?: string } = {},
  onConflict = '',
) {
  return client.query(
    `insert into pilot.family_reply_reads (organization_id, reply_id, reader_account_id, reader_role)
     values ($1, $2::uuid, $3, $4) ${onConflict}`,
    [values.org ?? ORG, values.replyId ?? REPLY, values.reader ?? COACH, values.role ?? 'coach'],
  );
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

describe('family reply reads migration (FC-09)', () => {
  test('a coach read of a reply is stored, and re-applying through the runner is a no-op', async () => {
    const client = await freshDatabase('frread_store');
    try {
      await read(client);
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const rows = await client.query('select reader_account_id, reader_role, reply_id from pilot.family_reply_reads');
      expect(rows.rows).toEqual([{ reader_account_id: COACH, reader_role: 'coach', reply_id: REPLY }]);
    } finally {
      await client.end();
    }
  });

  test('a second look by the same coach is the same row and keeps the first time', async () => {
    const client = await freshDatabase('frread_first');
    try {
      await read(client);
      const first = await client.query('select first_read_at from pilot.family_reply_reads');
      await expect(read(client)).rejects.toMatchObject({ code: '23505', constraint: 'pilot_family_reply_reads_pkey' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await read(client, {}, 'on conflict (organization_id, reply_id, reader_account_id) do nothing');

      const rows = await client.query('select first_read_at from pilot.family_reply_reads');
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].first_read_at.toISOString()).toBe(first.rows[0].first_read_at.toISOString());
    } finally {
      await client.end();
    }
  });

  test('two coaches and the office are three reads: each staff member has their own seen state', async () => {
    const client = await freshDatabase('frread_each');
    try {
      await read(client);
      await read(client, { reader: SECOND_COACH });
      await read(client, { reader: OFFICE, role: 'organization_admin' });
      const rows = await client.query('select reader_account_id from pilot.family_reply_reads order by reader_account_id');
      expect(rows.rows.map((row) => row.reader_account_id)).toEqual([COACH, OFFICE, SECOND_COACH].sort());
    } finally {
      await client.end();
    }
  });

  test('a read binds only to a real reply of this gym', async () => {
    const client = await freshDatabase('frread_binds');
    try {
      await expect(read(client, { replyId: randomUUID() })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_family_reply_reads_reply_fk',
      });
      // Another gym's reply named from this gym.
      await expect(read(client, { replyId: FOREIGN_REPLY })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_family_reply_reads_reply_fk',
      });
      const left = await client.query('select count(*)::int as n from pilot.family_reply_reads');
      expect(left.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('only staff read here, and only staff who hold that role in this gym', async () => {
    const client = await freshDatabase('frread_who');
    try {
      // A guardian is not a reader of this table (their reads are family_message_reads).
      await expect(read(client, { reader: GUARDIAN, role: 'parent' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_reply_reads_role_check',
      });
      // A coach of the other gym naming this gym's reply.
      await expect(read(client, { reader: OTHER_GYM_COACH })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_reply_reads_reader_of_this_gym',
      });
      // A coach of this gym written as its office: the role is not theirs.
      await expect(read(client, { role: 'organization_admin' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_reply_reads_reader_of_this_gym',
      });
      // A seat here that has ended.
      await expect(read(client, { reader: LAPSED_COACH })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_reply_reads_reader_of_this_gym',
      });
      // A guardian written as a coach.
      await expect(read(client, { reader: GUARDIAN })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_reply_reads_reader_of_this_gym',
      });
      await expect(read(client, { reader: 'acct-nobody' })).rejects.toMatchObject({ code: '23514' });
      const none = await client.query('select count(*)::int as n from pilot.family_reply_reads');
      expect(none.rows[0].n).toBe(0);

      // A home coach with no seat in the gym, a coach switched off, and a deleted one.
      const HOME_ONLY = 'acct-rreads-home-only';
      await client.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`, [HOME_ONLY, ORG]);
      await expect(read(client, { reader: HOME_ONLY })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_reply_reads_reader_of_this_gym',
      });
      await client.query('update pilot.accounts set active_flag = false where account_id = $1', [SECOND_COACH]);
      await expect(read(client, { reader: SECOND_COACH })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_reply_reads_reader_of_this_gym',
      });
      await client.query('update pilot.accounts set active_flag = true, deleted_at = now() where account_id = $1', [SECOND_COACH]);
      await expect(read(client, { reader: SECOND_COACH })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_reply_reads_reader_of_this_gym',
      });

      // A coach from elsewhere with an active coach seat in this gym reads here.
      await read(client, { reader: VISITING_COACH });
      const rows = await client.query('select reader_account_id from pilot.family_reply_reads');
      expect(rows.rows.map((row) => row.reader_account_id)).toEqual([VISITING_COACH]);
    } finally {
      await client.end();
    }
  });

  test('a read is never changed', async () => {
    const client = await freshDatabase('frread_unchanged');
    try {
      await read(client);
      for (const change of [
        "first_read_at = now() - interval '1 day'",
        "reader_role = 'coach'",
        `reader_account_id = '${SECOND_COACH}'`,
      ]) {
        await expect(client.query(`update pilot.family_reply_reads set ${change}`)).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_family_reply_reads_first_read_kept',
        });
      }
    } finally {
      await client.end();
    }
  });

  test('a read is not deleted by hand, but goes with its reader, its reply and its athlete', async () => {
    const client = await freshDatabase('frread_cascade');
    try {
      await read(client);
      await read(client, { reader: SECOND_COACH });
      await expect(client.query('delete from pilot.family_reply_reads')).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_reply_reads_no_delete',
      });

      // The second coach's account removed: their read goes, the first coach's stays.
      await client.query('delete from pilot.accounts where account_id = $1', [SECOND_COACH]);
      const afterAccount = await client.query('select reader_account_id from pilot.family_reply_reads');
      expect(afterAccount.rows.map((row) => row.reader_account_id)).toEqual([COACH]);

      // The athlete removed: the note, its reply and the read go with it.
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE]);
      const afterAthlete = await client.query('select count(*)::int as n from pilot.family_reply_reads');
      expect(afterAthlete.rows[0].n).toBe(0);
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
  });

  test('the runner refuses a guard that is there by name but disabled, or replica-only', async () => {
    const client = await freshDatabase('frread_guard_disabled');
    try {
      await expect(
        applyRunner(client, 'alter table pilot.family_reply_reads disable trigger trg_family_reply_reads_guard'),
      ).rejects.toThrow('FAMILY_REPLY_READS_NOT_READY: guard_ready');
      await expect(
        applyRunner(client, 'alter table pilot.family_reply_reads enable replica trigger trg_family_reply_reads_guard'),
      ).rejects.toThrow('FAMILY_REPLY_READS_NOT_READY: guard_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a pre-existing table whose role check of that name admits guardians', async () => {
    const client = await freshDatabase('frread_role_wide');
    try {
      // The file's if-not-exists keeps a table built earlier with a wider check of the same
      // name, so only readiness can say it is wrong.
      await client.query('drop table pilot.family_reply_reads');
      await client.query(`
        create table pilot.family_reply_reads (
          organization_id text not null references pilot.organizations(organization_id) on delete cascade,
          reply_id uuid not null,
          reader_account_id text not null references pilot.accounts(account_id) on delete cascade,
          reader_role text not null,
          first_read_at timestamptz not null default now(),
          constraint pilot_family_reply_reads_pkey primary key (organization_id, reply_id, reader_account_id),
          constraint pilot_family_reply_reads_reply_fk
            foreign key (organization_id, reply_id)
            references pilot.family_message_replies(organization_id, reply_id) on delete cascade,
          constraint pilot_family_reply_reads_role_check
            check (reader_role in ('coach', 'organization_admin', 'admin', 'parent'))
        )`);

      await expect(applyRunner(client, migrationSql)).rejects.toThrow('FAMILY_REPLY_READS_NOT_READY: role_check_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a reply key without the cascade', async () => {
    const client = await freshDatabase('frread_reply_key');
    try {
      await client.query('alter table pilot.family_reply_reads drop constraint pilot_family_reply_reads_reply_fk');
      await client.query(`
        alter table pilot.family_reply_reads add constraint pilot_family_reply_reads_reply_fk
          foreign key (organization_id, reply_id)
          references pilot.family_message_replies(organization_id, reply_id) on delete restrict`);

      await expect(applyRunner(client, migrationSql)).rejects.toThrow('FAMILY_REPLY_READS_NOT_READY: reply_fk_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    // An empty database: "applying" a statement that creates nothing must not commit.
    const client = await freshDatabase('frread_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('FAMILY_REPLY_READS_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
