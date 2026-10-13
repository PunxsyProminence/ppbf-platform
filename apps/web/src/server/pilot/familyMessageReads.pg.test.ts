// Real PostgreSQL contract test for pilot_slice_postgres_family_message_reads_migration.sql
// (FC-04, the storage for when a guardian first opened a coach's message; issue #1542's track).
//
// What needs a real database to prove: that a read binds to a real parent message of the same
// athlete in the same gym, by a guardian, and to nothing else; that one guardian's second open is
// the same row and keeps the first time; that two guardians are two reads; that a read is never
// changed or deleted by hand, but goes with its note or its reader's account; that re-applying the
// file is a no-op; that the file holds nothing destructive; and that the runner's readiness
// assertion refuses a result it did not produce. Spins up the disposable local embedded Postgres
// the other migration suites use. It never connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-message-reads-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-family-message-reads-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_family_message_reads_migration.sql';

const ORG = 'org-reads';
const OTHER_ORG = 'org-reads-other';
const COACH = 'acct-reads-coach';
const GUARDIAN = 'acct-reads-guardian';
const SECOND_GUARDIAN = 'acct-reads-guardian-b';
const ATHLETE = 'ATH-READS-1';
const OTHER_ATHLETE = 'ATH-READS-2';
const MESSAGE = '11111111-1111-4111-8111-111111111111';
const OBSERVATION = '22222222-2222-4222-8222-222222222222';
const FOREIGN_MESSAGE = '33333333-3333-4333-8333-333333333333';

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
     values ($1, 'coach', $4, 'microsoft'), ($2, 'parent', $4, 'microsoft'), ($3, 'parent', $4, 'microsoft')`,
    [COACH, GUARDIAN, SECOND_GUARDIAN, ORG],
  );
  for (const [org, athleteId] of [[ORG, ATHLETE], [ORG, OTHER_ATHLETE], [OTHER_ORG, ATHLETE]] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Read Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, COACH],
    );
  }
  for (const [org, noteId, noteType] of [
    [ORG, MESSAGE, 'parent_message'],
    [ORG, OBSERVATION, 'coach_observation'],
    [OTHER_ORG, FOREIGN_MESSAGE, 'parent_message'],
  ] as const) {
    await client.query(
      `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
       values ($1, $2::uuid, $3, $4, $5, 'Bring gloves Thursday.')`,
      [org, noteId, ATHLETE, COACH, noteType],
    );
  }
  return client;
}

function read(
  client: Client,
  values: { org?: string; noteId?: string; athleteId?: string; reader?: string; role?: string } = {},
  onConflict = '',
) {
  return client.query(
    `insert into pilot.family_message_reads (organization_id, note_id, athlete_id, reader_account_id, reader_role)
     values ($1, $2::uuid, $3, $4, $5) ${onConflict}`,
    [
      values.org ?? ORG,
      values.noteId ?? MESSAGE,
      values.athleteId ?? ATHLETE,
      values.reader ?? GUARDIAN,
      values.role ?? 'parent',
    ],
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

describe('family message reads migration (FC-04)', () => {
  test('a read of a parent message is stored, and re-applying through the runner is a no-op', async () => {
    const client = await freshDatabase('fmread_store');
    try {
      await read(client);
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const rows = await client.query('select reader_account_id, reader_role, athlete_id from pilot.family_message_reads');
      expect(rows.rows).toEqual([{ reader_account_id: GUARDIAN, reader_role: 'parent', athlete_id: ATHLETE }]);
    } finally {
      await client.end();
    }
  });

  test('a second open by the same guardian is the same row and keeps the first time', async () => {
    const client = await freshDatabase('fmread_first');
    try {
      await read(client);
      const first = await client.query('select first_read_at from pilot.family_message_reads');
      // The plain insert is refused by the key; the write the application uses keeps the row.
      await expect(read(client)).rejects.toMatchObject({ code: '23505', constraint: 'pilot_family_message_reads_pkey' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await read(client, {}, 'on conflict (organization_id, note_id, reader_account_id) do nothing');

      const rows = await client.query('select first_read_at from pilot.family_message_reads');
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].first_read_at.toISOString()).toBe(first.rows[0].first_read_at.toISOString());
    } finally {
      await client.end();
    }
  });

  test('two guardians of one child are two reads', async () => {
    const client = await freshDatabase('fmread_two');
    try {
      await read(client);
      await read(client, { reader: SECOND_GUARDIAN });
      const rows = await client.query('select reader_account_id from pilot.family_message_reads order by reader_account_id');
      expect(rows.rows.map((row) => row.reader_account_id)).toEqual([GUARDIAN, SECOND_GUARDIAN].sort());
    } finally {
      await client.end();
    }
  });

  test('a read binds only to a real parent message of the same athlete in the same gym, by a guardian', async () => {
    const client = await freshDatabase('fmread_binds');
    try {
      // An unknown note, and another gym's parent message named from this gym: the guard finds no
      // parent message in this gym, before the foreign key is reached.
      await expect(read(client, { noteId: randomUUID() })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_message_reads_parent_message',
      });
      await expect(read(client, { noteId: FOREIGN_MESSAGE })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_message_reads_parent_message',
      });
      // A coach observation is not read on the family page.
      await expect(read(client, { noteId: OBSERVATION })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_message_reads_parent_message',
      });
      // A real parent message of this gym, but naming another of its athletes.
      await expect(read(client, { athleteId: OTHER_ATHLETE })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_family_message_reads_note_fk',
      });
      // Only a guardian's read, and only by a real account.
      await expect(read(client, { role: 'coach', reader: COACH })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_message_reads_role_check',
      });
      await expect(read(client, { reader: 'acct-nobody' })).rejects.toMatchObject({ code: '23503' });
      const left = await client.query('select count(*)::int as n from pilot.family_message_reads');
      expect(left.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a read is never changed', async () => {
    const client = await freshDatabase('fmread_unchanged');
    try {
      await read(client);
      for (const change of [
        "first_read_at = now() - interval '1 day'",
        "reader_role = 'parent'",
        `reader_account_id = '${SECOND_GUARDIAN}'`,
      ]) {
        await expect(client.query(`update pilot.family_message_reads set ${change}`)).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_family_message_reads_first_read_kept',
        });
      }
    } finally {
      await client.end();
    }
  });

  test('a read is not deleted by hand, but goes with its note, and with its reader', async () => {
    const client = await freshDatabase('fmread_cascade');
    try {
      await read(client);
      await read(client, { reader: SECOND_GUARDIAN });
      await expect(client.query('delete from pilot.family_message_reads')).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_message_reads_no_delete',
      });

      // The second guardian's account removed: their read goes, the first guardian's stays.
      await client.query('delete from pilot.accounts where account_id = $1', [SECOND_GUARDIAN]);
      const afterAccount = await client.query('select reader_account_id from pilot.family_message_reads');
      expect(afterAccount.rows.map((row) => row.reader_account_id)).toEqual([GUARDIAN]);

      await client.query('delete from pilot.coach_observations where organization_id = $1 and note_id = $2::uuid', [ORG, MESSAGE]);
      const afterNote = await client.query('select count(*)::int as n from pilot.family_message_reads');
      expect(afterNote.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|schema|function)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\balter\s+table\s+pilot\.coach_observations\b/);
  });

  test('the runner refuses a guard that is there by name but disabled, or replica-only', async () => {
    const client = await freshDatabase('fmread_guard_disabled');
    try {
      await expect(
        applyRunner(client, 'alter table pilot.family_message_reads disable trigger trg_family_message_reads_guard'),
      ).rejects.toThrow('FAMILY_MESSAGE_READS_NOT_READY: guard_ready');
      await expect(
        applyRunner(client, 'alter table pilot.family_message_reads enable replica trigger trg_family_message_reads_guard'),
      ).rejects.toThrow('FAMILY_MESSAGE_READS_NOT_READY: guard_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    // An empty database: "applying" a statement that creates nothing must not commit.
    const client = await freshDatabase('fmread_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('FAMILY_MESSAGE_READS_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
