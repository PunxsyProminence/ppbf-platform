// Real PostgreSQL contract test for pilot_slice_postgres_family_message_replies_migration.sql
// (FC-02, the storage for a guardian's reply to a coach's note; issue #1542's track).
//
// What needs a real database to prove: that a reply binds to a real parent message of the same
// athlete in the same gym, and to nothing else; that it cannot be edited, while the purge's
// author null-out still goes through; that it dies with its note; that re-applying the file is a
// no-op; that the file holds nothing destructive; and that the runner's readiness assertion
// refuses a result it did not produce. Spins up the disposable local embedded Postgres the other
// migration suites use. It never connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-message-replies-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-family-message-replies-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_family_message_replies_migration.sql';

const ORG = 'org-replies';
const OTHER_ORG = 'org-replies-other';
const COACH = 'acct-replies-coach';
const GUARDIAN = 'acct-replies-guardian';
const ATHLETE = 'ATH-REPLIES-1';
const OTHER_ATHLETE = 'ATH-REPLIES-2';
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
     values ($1, 'coach', $3, 'microsoft'), ($2, 'parent', $3, 'microsoft')`,
    [COACH, GUARDIAN, ORG],
  );
  for (const [org, athleteId] of [[ORG, ATHLETE], [ORG, OTHER_ATHLETE], [OTHER_ORG, ATHLETE]] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Reply Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
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

function reply(client: Client, values: { org?: string; noteId?: string; athleteId?: string; text?: string; author?: string | null; role?: string } = {}) {
  const replyId = randomUUID();
  return client
    .query(
      `insert into pilot.family_message_replies
         (organization_id, reply_id, note_id, athlete_id, author_account_id, author_role, reply_text)
       values ($1, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
      [
        values.org ?? ORG,
        replyId,
        values.noteId ?? MESSAGE,
        values.athleteId ?? ATHLETE,
        values.author === undefined ? GUARDIAN : values.author,
        values.role ?? 'parent',
        values.text ?? 'Got it, thanks.',
      ],
    )
    .then(() => replyId);
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

describe('family message replies migration (FC-02)', () => {
  test('a reply to a parent message of that athlete is stored, and re-applying through the runner is a no-op', async () => {
    const client = await freshDatabase('fmr_store');
    try {
      const replyId = await reply(client);
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const rows = await client.query(
        'select reply_text, author_account_id, author_role from pilot.family_message_replies where reply_id = $1::uuid',
        [replyId],
      );
      expect(rows.rows).toEqual([{ reply_text: 'Got it, thanks.', author_account_id: GUARDIAN, author_role: 'parent' }]);
    } finally {
      await client.end();
    }
  });

  test('a reply binds only to a real note of the same athlete in the same gym', async () => {
    const client = await freshDatabase('fmr_fk');
    try {
      // An unknown note, and another gym's parent message named from this gym: the guard finds no
      // parent message in this gym, before the foreign key is reached.
      await expect(reply(client, { noteId: randomUUID() })).rejects.toThrow('FAMILY_MESSAGE_REPLY_NOT_TO_A_PARENT_MESSAGE');
      await expect(reply(client, { noteId: FOREIGN_MESSAGE })).rejects.toThrow('FAMILY_MESSAGE_REPLY_NOT_TO_A_PARENT_MESSAGE');
      // A real parent message of this gym, but naming another of its athletes: the three-column
      // foreign key is what refuses it (the guard checks the note, not the athlete).
      await expect(reply(client, { athleteId: OTHER_ATHLETE })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_family_message_replies_note_fk',
      });
    } finally {
      await client.end();
    }
  });

  test('only a parent message takes a reply, only a guardian writes one, and a blank or oversized one is refused', async () => {
    const client = await freshDatabase('fmr_checks');
    try {
      // Each refusal carries its own name, so it is never mistaken for the text check.
      await expect(reply(client, { noteId: OBSERVATION })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_message_replies_parent_message',
      });
      await expect(reply(client, { role: 'coach' })).rejects.toMatchObject({ code: '23514' });
      await expect(reply(client, { text: '   ' })).rejects.toMatchObject({ code: '23514' });
      // A reply born with no author is refused; only the purge may detach one later.
      await expect(reply(client, { author: null })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_family_message_replies_author_required',
      });
      await expect(reply(client, { text: 'x'.repeat(2001) })).rejects.toMatchObject({ code: '23514' });
      await expect(reply(client, { text: 'x'.repeat(2000) })).resolves.toEqual(expect.any(String));
    } finally {
      await client.end();
    }
  });

  test('append-only: what was said cannot be edited, but the purge can detach the author', async () => {
    const client = await freshDatabase('fmr_append_only');
    try {
      const replyId = await reply(client);
      for (const change of [
        "reply_text = 'Edited'",
        "created_at = now() - interval '1 day'",
        "author_role = 'coach'",
        `author_account_id = '${COACH}'`,
      ]) {
        await expect(
          client.query(`update pilot.family_message_replies set ${change} where reply_id = $1::uuid`, [replyId]),
        ).rejects.toThrow('FAMILY_MESSAGE_REPLY_IS_APPEND_ONLY');
      }

      // The guardian's account goes (D-9): the reply stays, detached, still a guardian's.
      await client.query('delete from pilot.accounts where account_id = $1', [GUARDIAN]);
      const rows = await client.query(
        'select reply_text, author_account_id, author_role from pilot.family_message_replies where reply_id = $1::uuid',
        [replyId],
      );
      expect(rows.rows).toEqual([{ reply_text: 'Got it, thanks.', author_account_id: null, author_role: 'parent' }]);
    } finally {
      await client.end();
    }
  });

  test('a reply is not deleted by hand, but dies with its note', async () => {
    const client = await freshDatabase('fmr_cascade');
    try {
      const replyId = await reply(client);
      await expect(
        client.query('delete from pilot.family_message_replies where reply_id = $1::uuid', [replyId]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_message_replies_no_delete' });

      await client.query('delete from pilot.coach_observations where organization_id = $1 and note_id = $2::uuid', [ORG, MESSAGE]);
      const left = await client.query('select count(*)::int as n from pilot.family_message_replies');
      expect(left.rows[0].n).toBe(0);
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
    const client = await freshDatabase('fmr_guard_disabled');
    try {
      await expect(
        applyRunner(client, 'alter table pilot.family_message_replies disable trigger trg_family_message_replies_guard'),
      ).rejects.toThrow('FAMILY_MESSAGE_REPLIES_NOT_READY: guard_ready');
      await expect(
        applyRunner(client, 'alter table pilot.family_message_replies enable replica trigger trg_family_message_replies_guard'),
      ).rejects.toThrow('FAMILY_MESSAGE_REPLIES_NOT_READY: guard_ready');
    } finally {
      await client.end();
    }
  });

  test("the runner refuses a result it did not produce", async () => {
    // An empty database: "applying" a statement that creates nothing must not commit.
    const client = await freshDatabase('fmr_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('FAMILY_MESSAGE_REPLIES_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
