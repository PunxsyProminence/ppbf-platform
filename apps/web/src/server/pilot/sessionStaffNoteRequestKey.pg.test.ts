// Real PostgreSQL contract test for the session-staff-note request key (W4 item 7, the offline
// save queue; OD-2026-11-21-006): pilot_slice_postgres_session_staff_note_request_key_migration.sql,
// its runner, and createRunStaffNote / createSessionStaffNote (sessionStaffNotes.ts) on top of it.
//
// What needs a real database to prove:
//
// THE MIGRATION AND ITS RUNNER (the interventionExecutionRequestKey.pg.test.ts cases, on this
// table). A key names at most one note in a gym, and the same key in another gym is a different
// key; notes sent without a key are unlimited; a key is refused blank, all spaces or over 200
// characters, and 200 is kept as sent; a note written before the migration keeps NULL; the file
// holds nothing destructive, and a re-run leaves its check as it is; the runner's readiness check
// refuses a result it did not produce.
//
// THE MODULE. A resend of one key by the note's author, for the same run or session and the same
// athlete, is answered with the note the first send added: one row, one 'create' audit event --
// also after the note was edited (the text is not compared) or removed, and also when two sends
// of a new key race, where the unique index decides and the loser re-reads. Any other use of the
// key (another author, athlete, run or session) is refused and writes nothing. Without a key,
// every add is a new note, as before. The key is per gym.
//
// './db' is mocked to route into the embedded server: query/queryOne on one shared connection,
// and each withTransaction on a connection of its own with a real BEGIN/COMMIT (the
// sessionRunClass.pg.test.ts pattern), so two sends of one key are two real transactions meeting
// at the index. Disposable, local-only embedded Postgres; it NEVER connects to production or
// staging.

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

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let activeClient: Client | null = null;
let activeConnectionString: string | null = null;

/**
 * THE RACE. While set, every write waits here until `parties` sends have reached it, so each send
 * has already looked its key up and found nothing before any of them writes: the unique index, not
 * the lookup, decides which one lands. It opens anyway after a few seconds, so a send that never
 * arrives fails the test's own assertion instead of hanging it.
 */
interface WriteGate {
  parties: number;
  arrived: number;
  open: () => void;
  opened: Promise<void>;
}
let writeGate: WriteGate | null = null;

// Each transaction on a connection of its own, with a real BEGIN/COMMIT: the race case needs two
// transactions that can wait on each other at the index.
jest.mock('./db', () => ({
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeConnectionString) throw new Error('test bug: no active embedded database');
    const gate = writeGate;
    if (gate) {
      gate.arrived += 1;
      if (gate.arrived >= gate.parties) gate.open();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([gate.opened, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
      clearTimeout(timer);
    }
    const own = new Client({ connectionString: activeConnectionString });
    await own.connect();
    try {
      await own.query('BEGIN');
      try {
        const result = await fn({ query: (text: string, values: unknown[]) => own.query(text, values) });
        await own.query('COMMIT');
        return result;
      } catch (error) {
        await own.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      await own.end();
    }
  }),
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
}));

import type { ActorIdentity } from './access';
import type { PilotRole } from './contracts';
import {
  type AddedStaffNote,
  createRunStaffNote,
  createSessionStaffNote,
  listRunStaffNotes,
  listSessionStaffNotes,
  removeOwnSessionStaffNote,
  updateOwnSessionStaffNote,
} from './sessionStaffNotes';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-staff-note-request-key-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-session-staff-note-request-key-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_session_staff_note_request_key_migration.sql';
const INDEX = 'pilot_session_staff_notes_one_per_request_key';
const CHECK = 'pilot_session_staff_notes_request_key_check';
const NOT_READY = 'SESSION_STAFF_NOTE_REQUEST_KEY_NOT_READY';

// The full schema and the migration fixture are built once, into a template every database
// below is copied from.
const TEMPLATE_DB = 'sknkey_template';
const MODULE_DB = 'sknkey_module';

// The migration fixture: two gyms, each with a coach, an athlete and that athlete's session.
const ORG = 'org-sknkey';
const OTHER_ORG = 'org-sknkey-other';
const COACH = 'acct-sknkey-coach';
const OTHER_COACH = 'acct-sknkey-other-coach';
const ATHLETE = 'ath-sknkey-1';
const SESSION = 'sess-sknkey-1';

type Apply = (client: Client, sql: string) => Promise<void>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyRunner: Apply;
let migrationSql: string;
let moduleClient: Client;
let gymCount = 0;

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

async function adminQuery(statements: string[]): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    for (const statement of statements) await admin.query(statement);
  } finally {
    await admin.end();
  }
}

/** The whole schema in the `all` order (this migration last), and the migration fixture. */
async function buildTemplate(): Promise<void> {
  await adminQuery([`drop database if exists ${TEMPLATE_DB} with (force)`, `create database ${TEMPLATE_DB}`]);
  const client = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await client.connect();
  try {
    await applyFullSchema(client, { infraDir: INFRA_DIR });
    for (const [org, coach] of [[ORG, COACH], [OTHER_ORG, OTHER_COACH]]) {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
        [org],
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
        [coach, org],
      );
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
            coach_id, created_at, updated_at)
         values ($1, $2, 'Key Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
        [org, ATHLETE, coach],
      );
      await client.query(
        `insert into pilot.sessions
           (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
         values ($1, $2, $3, current_date, 5, 'UNKNOWN', 'the athlete''s own words', false, now(), now())`,
        [org, SESSION, ATHLETE],
      );
    }
  } finally {
    await client.end();
  }
}

/** A database copied from the template, or an empty one. */
async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  await adminQuery([
    `drop database if exists ${name} with (force)`,
    schema === 'full' ? `create database ${name} template ${TEMPLATE_DB}` : `create database ${name}`,
  ]);
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** Adds one note on the fixture session, with the given key (or none). */
async function insertNote(client: Client, org: string, requestKey: string | null): Promise<string> {
  const noteId = randomUUID();
  await client.query(
    `insert into pilot.session_staff_notes
       (organization_id, note_id, session_id, athlete_id, author_account_id, author_role, note, request_key)
     values ($1, $2, $3, $4, $5, 'coach', 'Hands dropped in round two.', $6)`,
    [org, noteId, SESSION, ATHLETE, org === ORG ? COACH : OTHER_COACH, requestKey],
  );
  return noteId;
}

async function dbRefusal(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error('expected the write to be refused');
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  await buildTemplate();
  moduleClient = await freshDatabase(MODULE_DB);
  activeClient = moduleClient;
  activeConnectionString = connectionStringFor(MODULE_DB);
});

afterEach(() => {
  writeGate = null;
});

afterAll(async () => {
  activeClient = null;
  activeConnectionString = null;
  await moduleClient?.end().catch(() => {});
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

describe('session staff note request key migration', () => {
  test('a key names at most one note in a gym; re-applying through the runner keeps it so', async () => {
    const client = await freshDatabase('sknkey_one_per_gym');
    try {
      const key = randomUUID();
      const first = await insertNote(client, ORG, key);
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const second = await dbRefusal(insertNote(client, ORG, key));
      expect(second.code).toBe('23505');
      expect(second.constraint).toBe(INDEX);

      const rows = await client.query(
        'select note_id from pilot.session_staff_notes where organization_id = $1 and request_key = $2',
        [ORG, key],
      );
      expect(rows.rows).toEqual([{ note_id: first }]);
    } finally {
      await client.end();
    }
  });

  test('the same key in another gym is a different key', async () => {
    const client = await freshDatabase('sknkey_other_gym');
    try {
      const key = randomUUID();
      await insertNote(client, ORG, key);
      await insertNote(client, OTHER_ORG, key);
      const count = await client.query('select count(*)::int as n from pilot.session_staff_notes where request_key = $1', [key]);
      expect(count.rows[0].n).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('notes sent without a key are unlimited', async () => {
    const client = await freshDatabase('sknkey_no_key');
    try {
      await insertNote(client, ORG, null);
      await insertNote(client, ORG, null);
      await insertNote(client, ORG, null);
      const count = await client.query(
        'select count(*)::int as n from pilot.session_staff_notes where organization_id = $1 and request_key is null',
        [ORG],
      );
      expect(count.rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('a key is refused blank, all spaces, or over 200 characters; 200 is kept as sent', async () => {
    const client = await freshDatabase('sknkey_limits');
    try {
      for (const bad of ['', '   ', 'k'.repeat(201)]) {
        const refused = await dbRefusal(insertNote(client, ORG, bad));
        expect(refused.code).toBe('23514');
        expect(refused.constraint).toBe(CHECK);
      }
      const longest = ` ${'k'.repeat(198)} `;
      const noteId = await insertNote(client, ORG, longest);
      const row = await client.query(
        'select request_key from pilot.session_staff_notes where organization_id = $1 and note_id = $2',
        [ORG, noteId],
      );
      expect(row.rows[0].request_key).toBe(longest);
    } finally {
      await client.end();
    }
  });

  test('a note written before the migration keeps a NULL key', async () => {
    const client = await freshDatabase('sknkey_before');
    try {
      // The table as it stood before this file: the column (and with it the check and the index)
      // is not there.
      await client.query('alter table pilot.session_staff_notes drop column request_key');
      const noteId = randomUUID();
      await client.query(
        `insert into pilot.session_staff_notes
           (organization_id, note_id, session_id, athlete_id, author_account_id, author_role, note)
         values ($1, $2, $3, $4, $5, 'coach', 'Written before the key existed.')`,
        [ORG, noteId, SESSION, ATHLETE, COACH],
      );

      await applyRunner(client, migrationSql);

      const row = await client.query(
        'select request_key from pilot.session_staff_notes where organization_id = $1 and note_id = $2',
        [ORG, noteId],
      );
      expect(row.rows).toEqual([{ request_key: null }]);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive and adds its check only when this table has none of that name', () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\bupdate\s+pilot\./);
    // A re-run (the `all` chain) must not re-validate the check under an exclusive lock.
    expect(sql).toMatch(new RegExp(
      `if not exists \\(\\s*select 1 from pg_constraint\\s+where conname = '${CHECK}'\\s+`
      + `and conrelid = to_regclass\\('pilot\\.session_staff_notes'\\)`,
    ));
  });

  test('a re-run leaves the check as it is; the runner refuses a same-named check with a wider rule', async () => {
    const client = await freshDatabase('sknkey_check_wide');
    try {
      const checkOid = () => client.query(
        `select oid from pg_constraint where conname = $1 and conrelid = to_regclass('pilot.session_staff_notes')`,
        [CHECK],
      );
      const before = await checkOid();
      expect(before.rows).toHaveLength(1);
      await applyRunner(client, migrationSql);
      expect((await checkOid()).rows).toEqual(before.rows);

      await client.query(`alter table pilot.session_staff_notes drop constraint ${CHECK}`);
      await client.query(
        `alter table pilot.session_staff_notes add constraint ${CHECK} check (request_key is null or length(request_key) <= 2000)`,
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow(`${NOT_READY}: check_ready`);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named index that is not unique', async () => {
    const client = await freshDatabase('sknkey_index_plain');
    try {
      // The file's if-not-exists keeps an index built earlier under this name, so only readiness
      // can say it is wrong.
      await client.query(`drop index pilot.${INDEX}`);
      await client.query(
        `create index ${INDEX} on pilot.session_staff_notes(organization_id, request_key) where request_key is not null`,
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow(`${NOT_READY}: index_ready`);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named unique index over the key alone, or without the partial predicate', async () => {
    const client = await freshDatabase('sknkey_index_shape');
    try {
      await client.query(`drop index pilot.${INDEX}`);
      await client.query(`create unique index ${INDEX} on pilot.session_staff_notes(request_key) where request_key is not null`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow(`${NOT_READY}: index_ready`);

      await client.query(`drop index pilot.${INDEX}`);
      await client.query(`create unique index ${INDEX} on pilot.session_staff_notes(organization_id, request_key)`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow(`${NOT_READY}: index_ready`);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result without the check', async () => {
    const client = await freshDatabase('sknkey_check_missing');
    try {
      await expect(
        applyRunner(client, `alter table pilot.session_staff_notes drop constraint ${CHECK}`),
      ).rejects.toThrow(`${NOT_READY}: check_ready`);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a pre-existing request_key column that is NOT NULL', async () => {
    const client = await freshDatabase('sknkey_column_not_null');
    try {
      await client.query('alter table pilot.session_staff_notes drop column request_key');
      await client.query(`alter table pilot.session_staff_notes add column request_key text not null default 'k'`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow(`${NOT_READY}: column_ready`);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a pre-existing request_key column with a default', async () => {
    const client = await freshDatabase('sknkey_column_default');
    try {
      await client.query('alter table pilot.session_staff_notes drop column request_key');
      await client.query(`alter table pilot.session_staff_notes add column request_key text default 'k'`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow(`${NOT_READY}: column_ready`);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    // An empty database: "applying" a statement that creates nothing must not commit.
    const client = await freshDatabase('sknkey_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow(NOT_READY);
    } finally {
      await client.end();
    }
  });
});

/* ------------------------------------------------------------------ the module -- */

type Subject = 'run' | 'session';
const SUBJECTS: Subject[] = ['run', 'session'];

interface Gym {
  organizationId: string;
  coach: ActorIdentity;
  /** Another coach of this gym, who reaches every athlete here too (OD-2026-10-11-007). */
  otherCoach: ActorIdentity;
  ada: string;
  ben: string;
  /** Two live runs (one per coach), Ada and Ben marked present in both. */
  runs: [string, string];
  /** Two sessions of each athlete's own, by athlete. */
  sessions: Record<string, [string, string]>;
}

function actor(organizationId: string, accountId: string, role: PilotRole): ActorIdentity {
  return { organizationId, accountId, role, athleteId: null };
}

/** A fresh gym in the module database. Athlete and session ids repeat across gyms on purpose. */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-sknkey-${label}-${gymCount}`;
  const coachId = `coach@${organizationId}`;
  const otherCoachId = `coach2@${organizationId}`;
  const db = moduleClient;
  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  for (const accountId of [coachId, otherCoachId]) {
    await db.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [accountId, organizationId]);
    await db.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
      [accountId, organizationId],
    );
  }
  const ada = 'athlete-ada';
  const ben = 'athlete-ben';
  const sessions: Record<string, [string, string]> = {};
  for (const [athleteId, name] of [[ada, 'Ada Reyes'], [ben, 'Ben Ortiz']]) {
    await db.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1, $2, $3, '2012-01-01', '100', 'active', 'contact', true, $4, now(), now())`,
      [organizationId, athleteId, name, coachId],
    );
    sessions[athleteId] = [`sess-${athleteId}-1`, `sess-${athleteId}-2`];
    for (const sessionId of sessions[athleteId]) {
      await db.query(
        `insert into pilot.sessions
           (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
         values ($1, $2, $3, current_date, 5, 'UNKNOWN', 'the athlete''s own words', false, now(), now())`,
        [organizationId, sessionId, athleteId],
      );
    }
  }
  // One live run per coach may exist (pilot_ssrun_one_live_per_coach), so each coach delivers one.
  const runs: [string, string] = [`run-${randomUUID()}`, `run-${randomUUID()}`];
  for (const [runId, deliveredBy] of [[runs[0], coachId], [runs[1], otherCoachId]]) {
    await db.query(
      `insert into pilot.session_script_runs
         (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
          run_state, started_at, ended_at, paused_seconds)
       values ($1, $2, null, null, $3, current_date, 'in_progress', now() - interval '20 minutes', null, 0)`,
      [organizationId, runId, deliveredBy],
    );
    for (const athleteId of [ada, ben]) {
      await db.query(
        `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
         values ($1, $2, $3, $4, 'coach')`,
        [organizationId, runId, athleteId, deliveredBy],
      );
    }
  }
  return {
    organizationId,
    coach: actor(organizationId, coachId, 'coach'),
    otherCoach: actor(organizationId, otherCoachId, 'coach'),
    ada,
    ben,
    runs,
    sessions,
  };
}

interface Send {
  by?: ActorIdentity;
  athleteId?: string;
  /** The gym's second run, or the athlete's second session. */
  second?: boolean;
  note?: string;
  requestKey?: string | null;
}

/** One "Add note" on a run or on a session, by the gym's coach about Ada unless told otherwise. */
function send(gym: Gym, subject: Subject, s: Send = {}): Promise<AddedStaffNote> {
  const by = s.by ?? gym.coach;
  const athleteId = s.athleteId ?? gym.ada;
  const note = s.note ?? 'Hands dropped in round two.';
  const which = s.second ? 1 : 0;
  if (subject === 'run') {
    return createRunStaffNote({ actor: by, runId: gym.runs[which], athleteId, note, requestKey: s.requestKey });
  }
  return createSessionStaffNote({ actor: by, sessionId: gym.sessions[athleteId][which], athleteId, note, requestKey: s.requestKey });
}

/** Every note row of this gym, removed ones included. */
async function notesOf(gym: Gym) {
  const { rows } = await moduleClient.query<{ note_id: string; request_key: string | null; note: string; removed: boolean }>(
    `select note_id, request_key, note, deleted_at is not null as removed
       from pilot.session_staff_notes where organization_id = $1 order by created_at, note_id`,
    [gym.organizationId],
  );
  return rows;
}

/** The note ids of this gym's staff-note 'create' audit events, in order. */
async function createAudits(gym: Gym): Promise<string[]> {
  const { rows } = await moduleClient.query<{ entity_id: string }>(
    `select entity_id from pilot.audit_events
      where organization_id = $1 and entity_type = 'session_staff_note' and event_type = 'create'
      order by audit_id`,
    [gym.organizationId],
  );
  return rows.map((row) => row.entity_id);
}

async function refusal(action: Promise<unknown>): Promise<{ name: string; status?: number; code?: string }> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught as { name: string; status?: number; code?: string },
  );
  if (!error) throw new Error('expected a refusal, and the call succeeded');
  return { name: error.name, status: error.status, code: error.code };
}

const REUSED = { name: 'ConflictError', status: 409, code: 'SESSION_STAFF_NOTE_REQUEST_KEY_REUSED' };

describe('one tap, one staff note (createRunStaffNote / createSessionStaffNote with a request key)', () => {
  test.each(SUBJECTS)('on a %s: the same key sent again by its author for the same athlete returns the first note, written and audited once', async (subject) => {
    const gym = await newGym(`once-${subject}`);
    const key = randomUUID();
    const first = await send(gym, subject, { requestKey: key });
    expect(first.replayed).toBeUndefined();

    const again = await send(gym, subject, { requestKey: key });
    expect(again).toEqual({ ...first, replayed: true });

    expect(await notesOf(gym)).toEqual([
      { note_id: first.note_id, request_key: key, note: 'Hands dropped in round two.', removed: false },
    ]);
    expect(await createAudits(gym)).toEqual([first.note_id]);
  });

  test.each(SUBJECTS)('on a %s: sent twice without a key, it is two notes, as before, and neither has a key', async (subject) => {
    const gym = await newGym(`nokey-${subject}`);
    const one = await send(gym, subject);
    const two = await send(gym, subject, { requestKey: null });
    expect(one.note_id).not.toBe(two.note_id);
    expect(one.replayed).toBeUndefined();
    expect(two.replayed).toBeUndefined();

    const rows = await notesOf(gym);
    expect(rows.map((row) => row.note_id).sort()).toEqual([one.note_id, two.note_id].sort());
    expect(rows.map((row) => row.request_key)).toEqual([null, null]);
    expect((await createAudits(gym)).sort()).toEqual([one.note_id, two.note_id].sort());
  });

  test.each(SUBJECTS)('on a %s: the same key sent by another coach who reaches the athlete is refused and writes nothing', async (subject) => {
    const gym = await newGym(`author-${subject}`);
    const key = randomUUID();
    const first = await send(gym, subject, { requestKey: key });

    expect(await refusal(send(gym, subject, { by: gym.otherCoach, requestKey: key }))).toEqual(REUSED);
    expect((await notesOf(gym)).map((row) => row.note_id)).toEqual([first.note_id]);
    expect(await createAudits(gym)).toEqual([first.note_id]);

    // The refusal is the key's: the same add from that coach, with a key of its own, is written.
    const own = await send(gym, subject, { by: gym.otherCoach, requestKey: randomUUID() });
    expect(own.author_account_id).toBe(gym.otherCoach.accountId);
    expect(await notesOf(gym)).toHaveLength(2);
  });

  test.each<[Subject, string, (gym: Gym, key: string) => Promise<AddedStaffNote>]>([
    ['run', 'another athlete in the same run', (gym, key) => send(gym, 'run', { athleteId: gym.ben, requestKey: key })],
    ['run', 'the same athlete in another run', (gym, key) => send(gym, 'run', { second: true, requestKey: key })],
    ['run', 'a session of the same athlete', (gym, key) => send(gym, 'session', { requestKey: key })],
    ['session', 'another athlete, on their own session', (gym, key) => send(gym, 'session', { athleteId: gym.ben, requestKey: key })],
    ['session', 'another session of the same athlete', (gym, key) => send(gym, 'session', { second: true, requestKey: key })],
    ['session', 'a run the same athlete is marked in', (gym, key) => send(gym, 'run', { requestKey: key })],
  ])('a key first used on a %s, sent again by the same author for %s, is refused and writes nothing', async (subject, _label, resend) => {
    const gym = await newGym(`elsewhere-${subject}`);
    const key = randomUUID();
    const first = await send(gym, subject, { requestKey: key });

    expect(await refusal(resend(gym, key))).toEqual(REUSED);
    expect((await notesOf(gym)).map((row) => row.note_id)).toEqual([first.note_id]);
    expect(await createAudits(gym)).toEqual([first.note_id]);

    // The refusal is the key's: the same add with a key of its own is written.
    const own = await resend(gym, randomUUID());
    expect(own.replayed).toBeUndefined();
    expect(await notesOf(gym)).toHaveLength(2);
  });

  test('a key first used on a session, sent again for the same session after it was moved to another athlete, is refused', async () => {
    // A session can be moved to another athlete; its earlier notes stay about the first one. The
    // session is the same, so only the athlete tells the two sends apart.
    const gym = await newGym('moved-session');
    const key = randomUUID();
    const [sessionId] = gym.sessions[gym.ada];
    const first = await send(gym, 'session', { requestKey: key });
    await moduleClient.query(
      'update pilot.sessions set athlete_id = $3 where organization_id = $1 and session_id = $2',
      [gym.organizationId, sessionId, gym.ben],
    );

    const resend = (requestKey: string) => createSessionStaffNote({
      actor: gym.coach, sessionId, athleteId: gym.ben, note: 'Hands dropped in round two.', requestKey,
    });
    expect(await refusal(resend(key))).toEqual(REUSED);
    expect((await notesOf(gym)).map((row) => row.note_id)).toEqual([first.note_id]);
    expect(await createAudits(gym)).toEqual([first.note_id]);

    const own = await resend(randomUUID());
    expect(own.athlete_id).toBe(gym.ben);
  });

  test.each(SUBJECTS)('on a %s: a resend after its author edited the note returns the note as it stands now; the text is not compared', async (subject) => {
    const gym = await newGym(`edited-${subject}`);
    const key = randomUUID();
    const first = await send(gym, subject, { requestKey: key, note: 'Hands dropped in round two.' });
    const edited = await updateOwnSessionStaffNote({
      actor: gym.coach, noteId: first.note_id, note: 'Hands dropped in rounds two and three.',
    });

    // The queued resend carries the text as first sent.
    const again = await send(gym, subject, { requestKey: key, note: 'Hands dropped in round two.' });
    expect(again).toEqual({ ...edited, replayed: true });
    const otherText = await send(gym, subject, { requestKey: key, note: 'Something else entirely.' });
    expect(otherText).toEqual({ ...edited, replayed: true });

    expect(await notesOf(gym)).toEqual([
      { note_id: first.note_id, request_key: key, note: 'Hands dropped in rounds two and three.', removed: false },
    ]);
    expect(await createAudits(gym)).toEqual([first.note_id]);
  });

  test.each(SUBJECTS)('on a %s: a resend after its author removed the note returns that note and does not add it back', async (subject) => {
    const gym = await newGym(`removed-${subject}`);
    const key = randomUUID();
    const first = await send(gym, subject, { requestKey: key });
    await removeOwnSessionStaffNote({ actor: gym.coach, noteId: first.note_id });

    const again = await send(gym, subject, { requestKey: key });
    expect(again.note_id).toBe(first.note_id);
    expect(again.replayed).toBe(true);

    expect(await notesOf(gym)).toEqual([
      { note_id: first.note_id, request_key: key, note: 'Hands dropped in round two.', removed: true },
    ]);
    expect(await createAudits(gym)).toEqual([first.note_id]);
    const listed = subject === 'run'
      ? await listRunStaffNotes(gym.coach, gym.runs[0], gym.ada)
      : await listSessionStaffNotes(gym.coach, gym.sessions[gym.ada][0], gym.ada);
    expect(listed).toEqual([]);
  });

  test.each(SUBJECTS)('on a %s: two sends of one new key at the same moment add one note, and both are answered with it', async (subject) => {
    const gym = await newGym(`race-${subject}`);
    const key = randomUUID();
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    const gate: WriteGate = { parties: 2, arrived: 0, open, opened };
    writeGate = gate;
    let answers: AddedStaffNote[];
    try {
      answers = await Promise.all([send(gym, subject, { requestKey: key }), send(gym, subject, { requestKey: key })]);
    } finally {
      writeGate = null;
    }

    // Both sends looked the key up, found nothing, and went on to write: the index decided.
    expect(gate.arrived).toBe(2);
    const [a, b] = answers;
    expect(a.note_id).toBe(b.note_id);
    expect([a.replayed, b.replayed].filter((replayed) => replayed === true)).toHaveLength(1);

    expect(await notesOf(gym)).toEqual([
      { note_id: a.note_id, request_key: key, note: 'Hands dropped in round two.', removed: false },
    ]);
    expect(await createAudits(gym)).toEqual([a.note_id]);
  });

  test.each(SUBJECTS)('on a %s: the same key in another gym is a different key', async (subject) => {
    const here = await newGym(`here-${subject}`);
    const there = await newGym(`there-${subject}`);
    const key = randomUUID();
    const mine = await send(here, subject, { requestKey: key });
    const theirs = await send(there, subject, { requestKey: key });

    expect(theirs.replayed).toBeUndefined();
    expect(theirs.note_id).not.toBe(mine.note_id);
    expect(await notesOf(here)).toEqual([
      { note_id: mine.note_id, request_key: key, note: 'Hands dropped in round two.', removed: false },
    ]);
    expect(await notesOf(there)).toEqual([
      { note_id: theirs.note_id, request_key: key, note: 'Hands dropped in round two.', removed: false },
    ]);
    expect(await createAudits(there)).toEqual([theirs.note_id]);
  });
});
