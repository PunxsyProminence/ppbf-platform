// Real PostgreSQL-backed test for the session-staff-notes migration and for
// sessionStaffNotes.ts on top of it. './db' is mocked to route into the
// embedded server (the athleteMinorLimits.pg.test.ts pattern; withTransaction
// runs a real BEGIN/COMMIT/ROLLBACK), so the module's real SQL -- and
// access.ts's and audit.ts's -- runs against real rows.
//
// What needs a real database to prove:
//   * the migration creates the table from nothing, re-applies as a no-op,
//     does not alter pilot.sessions, and the runner refuses a database it
//     never reached, or one with any guard missing or loosened;
//   * the role and note guards are DATABASE refusals, and a note cannot name
//     a session or an athlete of another gym;
//   * a note for a session that is not that athlete's is refused before any
//     row is written (the module's check inside the transaction);
//   * only the author changes or removes a note; the UPDATE's own WHERE
//     refuses anyone else even when called directly;
//   * the audit row commits with the note and rolls back with it;
//   * only staff with an ACTIVE membership here, who reach the athlete through
//     assertActorCanAccessAthlete, may read or write -- each near-miss refused;
//     the athlete and their guardian read nothing;
//   * one gym never sees another's notes for the same session id.
//
// Disposable, local-only embedded Postgres. It NEVER connects to production
// or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

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
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

import * as accessModule from './access';
import type { ActorIdentity } from './access';
import * as auditModule from './audit';
import type { PilotRole } from './contracts';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import {
  createSessionStaffNote,
  listSessionStaffNotes,
  removeOwnSessionStaffNote,
  updateOwnSessionStaffNote,
} from './sessionStaffNotes';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-staff-notes-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_session_staff_notes_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-session-staff-notes-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-notes';
const OTHER_ORG_ID = 'org-notes-elsewhere';
const ADMIN_ID = 'acct-notes-admin';
const OTHER_ADMIN_ID = 'acct-notes-other-admin';
const COACH_ID = 'acct-notes-coach'; // coach of record for ATHLETE, SECOND here
const SECOND_COACH_ID = 'acct-notes-coach-2'; // coach of record for SECOND only
const LAPSED_COACH_ID = 'acct-notes-lapsed'; // membership here deactivated
const VISITING_COACH_ID = 'acct-notes-visiting'; // home elsewhere, member here, coverage on ATHLETE_ID only
const UNASSIGNED_COACH_ID = 'acct-notes-unassigned'; // active coach here, reaches nobody
const ATHLETE_ACCOUNT_ID = 'acct-notes-athlete';
const PARENT_ACCOUNT_ID = 'acct-notes-parent'; // linked guardian of ATHLETE_ID
const VOLUNTEER_ACCOUNT_ID = 'acct-notes-volunteer';
const ATHLETE_ID = 'ath-notes-1';
const SECOND_ATHLETE_ID = 'ath-notes-2';
const OTHER_ATHLETE_ID = 'ath-notes-other'; // the other gym's
const SESSION_ID = 'sess-notes-1'; // ATHLETE_ID's, here
const SECOND_SESSION_ID = 'sess-notes-2'; // SECOND_ATHLETE_ID's, here
// The same session id in BOTH gyms (pilot.sessions' key is composite); the other gym's is OTHER_ATHLETE_ID's.
const SHARED_SESSION_ID = 'sess-notes-shared';

function actorFor(
  accountId: string,
  role: PilotRole,
  organizationId: string = ORG_ID,
  athleteId: string | null = null,
): ActorIdentity {
  return { accountId, role, organizationId, athleteId };
}

const ADMIN = actorFor(ADMIN_ID, 'organization_admin');
const OTHER_ADMIN = actorFor(OTHER_ADMIN_ID, 'organization_admin', OTHER_ORG_ID);
const COACH = actorFor(COACH_ID, 'coach');
const SECOND_COACH = actorFor(SECOND_COACH_ID, 'coach');
const LAPSED_COACH = actorFor(LAPSED_COACH_ID, 'coach');
const VISITING_COACH = actorFor(VISITING_COACH_ID, 'coach');
const UNASSIGNED_COACH = actorFor(UNASSIGNED_COACH_ID, 'coach');
const ATHLETE = actorFor(ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, ATHLETE_ID);
const GUARDIAN = actorFor(PARENT_ACCOUNT_ID, 'parent');
const VOLUNTEER = actorFor(VOLUNTEER_ACCOUNT_ID, 'volunteer');
const PLATFORM_OWNER = actorFor('acct-notes-owner', 'platform_owner');
const BOARD = actorFor('acct-notes-board', 'board');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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

/** The full production schema, two gyms, every standing the access rule distinguishes, three sessions. */
async function freshDatabase(name: string, { preMigration = false } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }

  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1, 'organization_admin', $11, 'microsoft', null),
            ($2, 'coach',              $11, 'microsoft', null),
            ($3, 'coach',              $11, 'microsoft', null),
            ($4, 'coach',              $12, 'microsoft', null),
            ($5, 'coach',              $11, 'microsoft', null),
            ($6, 'athlete',            $11, 'microsoft', $13),
            ($7, 'parent',             $11, 'microsoft', null),
            ($8, 'volunteer',          $11, 'microsoft', null),
            ($9, 'organization_admin', $12, 'microsoft', null),
            ($10, 'coach',             $11, 'microsoft', null)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID,
     ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID, SECOND_COACH_ID,
     ORG_ID, OTHER_ORG_ID, ATHLETE_ID],
  );

  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $11, 'organization_admin', true),
            ($2, $11, 'coach',              true),
            ($3, $11, 'coach',              false),
            ($4, $11, 'coach',              true),
            ($4, $12, 'coach',              true),
            ($5, $11, 'coach',              true),
            ($6, $11, 'athlete',            true),
            ($7, $11, 'parent',             true),
            ($8, $11, 'volunteer',          true),
            ($9, $12, 'organization_admin', true),
            ($10, $11, 'coach',             true)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID,
     ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID, SECOND_COACH_ID,
     ORG_ID, OTHER_ORG_ID],
  );

  for (const [org, athleteId, coachId] of [
    [ORG_ID, ATHLETE_ID, COACH_ID],
    [ORG_ID, SECOND_ATHLETE_ID, SECOND_COACH_ID],
    [OTHER_ORG_ID, OTHER_ATHLETE_ID, VISITING_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Notes Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  for (const [org, sessionId, athleteId] of [
    [ORG_ID, SESSION_ID, ATHLETE_ID],
    [ORG_ID, SECOND_SESSION_ID, SECOND_ATHLETE_ID],
    [ORG_ID, SHARED_SESSION_ID, ATHLETE_ID],
    [OTHER_ORG_ID, SHARED_SESSION_ID, OTHER_ATHLETE_ID],
  ] as const) {
    await client.query(
      `insert into pilot.sessions
         (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
       values ($1, $2, $3, current_date, 5, 'UNKNOWN', 'the athlete''s own words', false, now(), now())
       on conflict do nothing`,
      [org, sessionId, athleteId],
    );
  }

  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-notes-1', $2, 'Linked Guardian') on conflict do nothing`,
    [ORG_ID, PARENT_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-notes-1', $2, 'parent') on conflict do nothing`,
    [ORG_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.coach_coverage
       (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
     values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '8 hours')`,
    [ORG_ID, ATHLETE_ID, VISITING_COACH_ID, ADMIN_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.session_staff_notes cascade');
  }
  return client;
}

/** The runner's transaction with no SQL to apply: readiness alone decides. */
function applyMutationFree(client: Client): Promise<void> {
  return applyMigrationTransaction(client, 'select 1');
}

async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  activeClient = client;
  return client;
}

function insertRaw(client: Client, overrides: Record<string, unknown> = {}) {
  return client.query(
    `insert into pilot.session_staff_notes
       (organization_id, note_id, session_id, athlete_id, author_account_id, author_role, note)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6)
     returning note_id`,
    [
      overrides.organization_id ?? ORG_ID,
      overrides.session_id ?? SESSION_ID,
      overrides.athlete_id ?? ATHLETE_ID,
      overrides.author_account_id ?? COACH_ID,
      overrides.author_role ?? 'coach',
      overrides.note ?? 'Worked the jab; left hand drops on the way back.',
    ],
  );
}

async function allRows(client: Client) {
  const { rows } = await client.query(
    `select organization_id, session_id, athlete_id, author_account_id, note, deleted_at is not null as removed
       from pilot.session_staff_notes order by created_at, note_id`,
  );
  return rows;
}

async function auditRows(client: Client) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
       from pilot.audit_events where entity_type = 'session_staff_note' order by created_at`,
  );
  return rows;
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

  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
});

afterEach(() => {
  activeClient = null;
  jest.restoreAllMocks();
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

describe('session staff notes migration', () => {
  test('creates the table from nothing, re-applies as a no-op, and leaves pilot.sessions as it was', async () => {
    const client = await freshDatabase('notes_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.session_staff_notes') as t`);
      expect(before.rows[0].t).toBeNull();
      const sessionsBefore = await client.query(
        `select conname from pg_constraint where conrelid = 'pilot.sessions'::regclass order by conname`,
      );

      await applyMigrationTransaction(client, migrationSql);
      await insertRaw(client);
      await applyMigrationTransaction(client, migrationSql);

      expect(await allRows(client)).toEqual([
        { organization_id: ORG_ID, session_id: SESSION_ID, athlete_id: ATHLETE_ID, author_account_id: COACH_ID,
          note: 'Worked the jab; left hand drops on the way back.', removed: false },
      ]);
      const sessionsAfter = await client.query(
        `select conname from pg_constraint where conrelid = 'pilot.sessions'::regclass order by conname`,
      );
      expect(sessionsAfter.rows).toEqual(sessionsBefore.rows);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('notes_not_ready', { preMigration: true });
    try {
      await expect(applyMutationFree(client)).rejects.toThrow(/SESSION_STAFF_NOTES_TABLE_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['the note check dropped', 'alter table pilot.session_staff_notes drop constraint pilot_session_staff_notes_note_check'],
    // Same words, no cap: the exact-text comparison is what refuses it.
    ['the note check loosened', `alter table pilot.session_staff_notes drop constraint pilot_session_staff_notes_note_check,
       add constraint pilot_session_staff_notes_note_check check (length(btrim(note, E' \\t\\r\\n')) > 0)`],
    ['the role check loosened', `alter table pilot.session_staff_notes drop constraint pilot_session_staff_notes_role_check,
       add constraint pilot_session_staff_notes_role_check check (author_role in ('coach', 'organization_admin', 'admin', 'athlete'))`],
    ['the read index dropped', 'drop index pilot.idx_session_staff_notes_session'],
    ['the session foreign key dropped', 'alter table pilot.session_staff_notes drop constraint pilot_session_staff_notes_session_fk'],
    ['the session foreign key without cascade', `alter table pilot.session_staff_notes drop constraint pilot_session_staff_notes_session_fk,
       add constraint pilot_session_staff_notes_session_fk foreign key (organization_id, session_id)
       references pilot.sessions(organization_id, session_id)`],
    ['the athlete foreign key dropped', 'alter table pilot.session_staff_notes drop constraint pilot_session_staff_notes_athlete_fk'],
  ])('the runner refuses a table with %s, with everything else right', async (label, breakIt) => {
    const client = await freshDatabase(`notes_short_${label.replace(/[^a-z]+/g, '_')}`);
    try {
      await client.query(breakIt);
      await expect(applyMutationFree(client)).rejects.toThrow(/SESSION_STAFF_NOTES_TABLE_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test('the database refuses a blank note, a note over 2000 characters, a non-staff author and an unknown author', async () => {
    const client = await freshDatabase('notes_checks');
    try {
      await expect(insertRaw(client, { note: '   ' })).rejects.toThrow(/pilot_session_staff_notes_note_check/);
      await expect(insertRaw(client, { note: '\t\n \r' })).rejects.toThrow(/pilot_session_staff_notes_note_check/);
      await expect(insertRaw(client, { note: 'x'.repeat(2001) })).rejects.toThrow(/pilot_session_staff_notes_note_check/);
      await expect(insertRaw(client, { author_role: 'athlete' })).rejects.toThrow(/pilot_session_staff_notes_role_check/);
      await expect(insertRaw(client, { author_account_id: 'acct-nobody' })).rejects.toThrow(/author_account_id_fkey/);
      await expect(insertRaw(client, { note: 'x'.repeat(2000) })).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  test("a note cannot name another gym's session or athlete, and goes when the session or athlete goes", async () => {
    const client = await freshDatabase('notes_fk');
    try {
      await expect(insertRaw(client, { session_id: 'sess-nowhere' })).rejects.toThrow(/pilot_session_staff_notes_session_fk/);
      await expect(insertRaw(client, { athlete_id: OTHER_ATHLETE_ID })).rejects.toThrow(/pilot_session_staff_notes_athlete_fk/);
      // The other gym's session id exists, but not in THIS gym's key space.
      await expect(
        insertRaw(client, { organization_id: ORG_ID, session_id: SHARED_SESSION_ID, athlete_id: OTHER_ATHLETE_ID }),
      ).rejects.toThrow(/pilot_session_staff_notes_athlete_fk/);

      await insertRaw(client, { session_id: SECOND_SESSION_ID, athlete_id: SECOND_ATHLETE_ID, author_account_id: SECOND_COACH_ID });
      await client.query('delete from pilot.sessions where organization_id = $1 and session_id = $2', [ORG_ID, SECOND_SESSION_ID]);
      expect(await allRows(client)).toEqual([]);

      await insertRaw(client);
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG_ID, ATHLETE_ID]);
      expect(await allRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe('sessionStaffNotes.ts against real rows', () => {
  test('a coach adds two notes of their own to a session; both read back oldest first, with author and role', async () => {
    const client = await migratedDatabase('notes_create');
    try {
      expect(await listSessionStaffNotes(COACH, SESSION_ID, ATHLETE_ID)).toEqual([]);
      const first = await createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: '  Before: tight shoulders, keep it light.  ' });
      expect(first).toMatchObject({
        session_id: SESSION_ID,
        athlete_id: ATHLETE_ID,
        author_account_id: COACH_ID,
        author_role: 'coach',
        note: 'Before: tight shoulders, keep it light.',
      });
      const second = await createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'After: moved well, no complaints.' });
      const admin = await createSessionStaffNote({ actor: ADMIN, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'Parent asked about Saturday.' });
      expect(admin.author_role).toBe('organization_admin');

      const listed = await listSessionStaffNotes(ADMIN, SESSION_ID, ATHLETE_ID);
      expect(listed.map((row) => row.note_id)).toEqual([first.note_id, second.note_id, admin.note_id]);
      // The list never carries an account id; it says whether the reader wrote each note.
      const firstShown: Record<string, unknown> = { ...first, written_by_me: false };
      delete firstShown.author_account_id;
      expect(listed[0]).toEqual(firstShown);
      expect(listed.map((row) => row.written_by_me)).toEqual([false, false, true]);
      expect(listed.some((row) => 'author_account_id' in row)).toBe(false);
      expect((await listSessionStaffNotes(COACH, SESSION_ID, ATHLETE_ID)).map((row) => row.written_by_me)).toEqual([true, true, false]);

      // The athlete's own note on the session is untouched.
      const { rows } = await client.query('select notes from pilot.sessions where organization_id = $1 and session_id = $2', [ORG_ID, SESSION_ID]);
      expect(rows[0].notes).toBe("the athlete's own words");
    } finally {
      await client.end();
    }
  });

  test('the module refuses a blank or over-long note before touching the database', async () => {
    const client = await migratedDatabase('notes_shape');
    try {
      await expect(createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: ' \n ' })).rejects.toBeInstanceOf(ValidationError);
      await expect(createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'x'.repeat(2001) })).rejects.toBeInstanceOf(ValidationError);
      // A request body with no text (or a non-string) is a refusal, not a crash.
      await expect(createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: undefined as unknown as string })).rejects.toBeInstanceOf(ValidationError);
      await expect(createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 42 as unknown as string })).rejects.toBeInstanceOf(ValidationError);
      expect(await allRows(client)).toEqual([]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test("a session that is not that athlete's is refused inside the transaction, and nothing is written", async () => {
    const client = await migratedDatabase('notes_mismatch');
    try {
      // SECOND_SESSION_ID belongs to SECOND_ATHLETE_ID; the admin reaches both athletes, so only the pairing refuses.
      await expect(
        createSessionStaffNote({ actor: ADMIN, sessionId: SECOND_SESSION_ID, athleteId: ATHLETE_ID, note: 'wrong pairing' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createSessionStaffNote({ actor: ADMIN, sessionId: 'sess-nowhere', athleteId: ATHLETE_ID, note: 'no session' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(listSessionStaffNotes(ADMIN, SECOND_SESSION_ID, ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundError);
      expect(await allRows(client)).toEqual([]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('only the author changes or removes a note; a removed note leaves the list but keeps its row', async () => {
    const client = await migratedDatabase('notes_author_only');
    try {
      const mine = await createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'first words' });
      const theirs = await createSessionStaffNote({ actor: ADMIN, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'admin words' });

      // The admin reaches the athlete and sees the coach's note, but may not change it.
      await expect(updateOwnSessionStaffNote({ actor: ADMIN, noteId: mine.note_id, note: 'rewritten by admin' })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeOwnSessionStaffNote({ actor: ADMIN, noteId: mine.note_id })).rejects.toBeInstanceOf(ForbiddenError);
      // The covering coach reaches the athlete too; same refusal.
      await expect(updateOwnSessionStaffNote({ actor: VISITING_COACH, noteId: theirs.note_id, note: 'x' })).rejects.toBeInstanceOf(ForbiddenError);

      const changed = await updateOwnSessionStaffNote({ actor: COACH, noteId: mine.note_id, note: '  second words  ' });
      expect(changed).toMatchObject({ note_id: mine.note_id, note: 'second words', author_account_id: COACH_ID });
      expect(new Date(changed.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(mine.updated_at).getTime());

      await removeOwnSessionStaffNote({ actor: ADMIN, noteId: theirs.note_id });
      expect((await listSessionStaffNotes(COACH, SESSION_ID, ATHLETE_ID)).map((row) => row.note_id)).toEqual([mine.note_id]);
      await expect(updateOwnSessionStaffNote({ actor: ADMIN, noteId: theirs.note_id, note: 'back again' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(removeOwnSessionStaffNote({ actor: ADMIN, noteId: theirs.note_id })).rejects.toBeInstanceOf(NotFoundError);

      expect(await allRows(client)).toEqual([
        { organization_id: ORG_ID, session_id: SESSION_ID, athlete_id: ATHLETE_ID, author_account_id: COACH_ID, note: 'second words', removed: false },
        { organization_id: ORG_ID, session_id: SESSION_ID, athlete_id: ATHLETE_ID, author_account_id: ADMIN_ID, note: 'admin words', removed: true },
      ]);
    } finally {
      await client.end();
    }
  });

  test("the UPDATE itself refuses another author: the admin's change and removal of the coach's note write nothing", async () => {
    const client = await migratedDatabase('notes_update_where');
    try {
      const mine = await createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'first words' });
      // The module runs the UPDATE first and names the refusal only after it
      // matched nothing, so this goes through the module's own WHERE.
      await expect(updateOwnSessionStaffNote({ actor: ADMIN, noteId: mine.note_id, note: 'rewritten' })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeOwnSessionStaffNote({ actor: ADMIN, noteId: mine.note_id })).rejects.toBeInstanceOf(ForbiddenError);
      expect(await allRows(client)).toEqual([
        { organization_id: ORG_ID, session_id: SESSION_ID, athlete_id: ATHLETE_ID, author_account_id: COACH_ID, note: 'first words', removed: false },
      ]);
      expect((await auditRows(client)).map((row) => row.event_type)).toEqual(['create']);
    } finally {
      await client.end();
    }
  });

  test("a session moved to another athlete does not carry the first athlete's staff notes with it", async () => {
    const client = await migratedDatabase('notes_moved_session');
    try {
      await createSessionStaffNote({ actor: ADMIN, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'about the first athlete' });
      await client.query('update pilot.sessions set athlete_id = $3 where organization_id = $1 and session_id = $2', [ORG_ID, SESSION_ID, SECOND_ATHLETE_ID]);
      expect(await listSessionStaffNotes(ADMIN, SESSION_ID, SECOND_ATHLETE_ID)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a session with more notes than the list holds shows the newest ones, oldest of those first', async () => {
    const client = await migratedDatabase('notes_list_limit');
    try {
      await client.query(
        `insert into pilot.session_staff_notes
           (organization_id, note_id, session_id, athlete_id, author_account_id, author_role, note, created_at, updated_at)
         select $1, gen_random_uuid(), $2, $3, $4, 'coach', 'n' || i, now() - make_interval(secs => 200 - i), now() - make_interval(secs => 200 - i)
           from generate_series(1, 101) as i`,
        [ORG_ID, SESSION_ID, ATHLETE_ID, COACH_ID],
      );
      const listed = (await listSessionStaffNotes(COACH, SESSION_ID, ATHLETE_ID)).map((row) => row.note);
      expect(listed).toHaveLength(100);
      expect(listed[0]).toBe('n2');
      expect(listed[99]).toBe('n101');
    } finally {
      await client.end();
    }
  });

  test('every write leaves an audit row in the same transaction, naming the session and athlete and not the text', async () => {
    const client = await migratedDatabase('notes_audit');
    try {
      const created = await createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'SECRETWORDS one' });
      await updateOwnSessionStaffNote({ actor: COACH, noteId: created.note_id, note: 'SECRETWORDS two' });
      await removeOwnSessionStaffNote({ actor: COACH, noteId: created.note_id });
      const rows = await auditRows(client);
      expect(rows).toEqual([
        { event_type: 'create', actor_account_id: COACH_ID, actor_role: 'coach', organization_id: ORG_ID, entity_id: created.note_id,
          details: { session_id: SESSION_ID, athlete_id: ATHLETE_ID } },
        { event_type: 'update', actor_account_id: COACH_ID, actor_role: 'coach', organization_id: ORG_ID, entity_id: created.note_id,
          details: { session_id: SESSION_ID, athlete_id: ATHLETE_ID } },
        { event_type: 'update', actor_account_id: COACH_ID, actor_role: 'coach', organization_id: ORG_ID, entity_id: created.note_id,
          details: { session_id: SESSION_ID, athlete_id: ATHLETE_ID, removed: true } },
      ]);
      expect(JSON.stringify(rows)).not.toContain('SECRETWORDS');
      // No SHADOW mirror: the athlete and guardians read shadow_events.
      const shadow = await client.query(`select count(*)::int as n from pilot.shadow_events where entity_type = 'session_staff_note'`);
      expect(shadow.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('when the audit row cannot be written, the note is rolled back with it', async () => {
    const client = await migratedDatabase('notes_audit_rollback');
    jest.spyOn(auditModule, 'writePilotAuditEvent').mockRejectedValueOnce(new Error('audit insert failed'));
    try {
      await expect(createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'lost' })).rejects.toThrow('audit insert failed');
      expect(await allRows(client)).toEqual([]);
      expect(await auditRows(client)).toEqual([]);
      const after = await createSessionStaffNote({ actor: COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'kept' });
      expect(after.note).toBe('kept');
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('one gym never sees another gym\'s notes for the same session id', async () => {
    const client = await migratedDatabase('notes_isolation');
    try {
      await insertRaw(client, { organization_id: ORG_ID, session_id: SHARED_SESSION_ID, athlete_id: ATHLETE_ID, note: 'here' });
      await insertRaw(client, { organization_id: OTHER_ORG_ID, session_id: SHARED_SESSION_ID, athlete_id: OTHER_ATHLETE_ID, author_account_id: VISITING_COACH_ID, note: 'there' });

      expect((await listSessionStaffNotes(ADMIN, SHARED_SESSION_ID, ATHLETE_ID)).map((row) => row.note)).toEqual(['here']);
      expect((await listSessionStaffNotes(OTHER_ADMIN, SHARED_SESSION_ID, OTHER_ATHLETE_ID)).map((row) => row.note)).toEqual(['there']);
      // Naming the other gym's athlete from here is a refusal, not a leak.
      await expect(listSessionStaffNotes(ADMIN, SHARED_SESSION_ID, OTHER_ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);

      const there = (await listSessionStaffNotes(OTHER_ADMIN, SHARED_SESSION_ID, OTHER_ATHLETE_ID))[0];
      await expect(updateOwnSessionStaffNote({ actor: ADMIN, noteId: there.note_id, note: 'reach across' })).rejects.toBeInstanceOf(NotFoundError);
      await createSessionStaffNote({ actor: COACH, sessionId: SHARED_SESSION_ID, athleteId: ATHLETE_ID, note: 'here too' });
      expect((await listSessionStaffNotes(OTHER_ADMIN, SHARED_SESSION_ID, OTHER_ATHLETE_ID)).map((row) => row.note)).toEqual(['there']);
    } finally {
      await client.end();
    }
  });

  test("a coach covering an athlete may write and read that athlete's session notes, and only that one", async () => {
    const client = await migratedDatabase('notes_coverage');
    try {
      const row = await createSessionStaffNote({ actor: VISITING_COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'covering today' });
      expect(row.author_role).toBe('coach');
      expect((await listSessionStaffNotes(VISITING_COACH, SESSION_ID, ATHLETE_ID)).map((r) => r.note_id)).toEqual([row.note_id]);
      await expect(listSessionStaffNotes(VISITING_COACH, SECOND_SESSION_ID, SECOND_ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        createSessionStaffNote({ actor: VISITING_COACH, sessionId: SECOND_SESSION_ID, athleteId: SECOND_ATHLETE_ID, note: 'not mine' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['an unassigned coach of the same gym', UNASSIGNED_COACH],
    ["another athlete's coach", SECOND_COACH],
    ['a coach whose membership here lapsed', LAPSED_COACH],
    ['an admin of another gym', OTHER_ADMIN],
    ['the athlete themselves', ATHLETE],
    ['their linked guardian', GUARDIAN],
    ['a volunteer', VOLUNTEER],
    ['the platform owner', PLATFORM_OWNER],
    ['the board', BOARD],
  ])('%s may neither read nor write staff notes on the session', async (_label, actor) => {
    const client = await migratedDatabase(`notes_deny_${actor.accountId.replace(/[^a-z]/g, '_')}`);
    try {
      const { rows } = await insertRaw(client);
      const noteId = rows[0].note_id as string;
      await expect(listSessionStaffNotes(actor, SESSION_ID, ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createSessionStaffNote({ actor, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'mine?' })).rejects.toBeInstanceOf(ForbiddenError);
      // An edit by someone outside this gym looks the note up in THEIR gym's
      // key space and finds nothing (404); everyone inside it is refused (403).
      const editRefusal = actor.organizationId === ORG_ID ? ForbiddenError : NotFoundError;
      await expect(updateOwnSessionStaffNote({ actor, noteId, note: 'mine?' })).rejects.toBeInstanceOf(editRefusal);
      await expect(removeOwnSessionStaffNote({ actor, noteId })).rejects.toBeInstanceOf(editRefusal);
      expect(await allRows(client)).toHaveLength(1);
      expect((await allRows(client))[0].removed).toBe(false);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('an author who no longer reaches the athlete cannot edit their old note either', async () => {
    const client = await migratedDatabase('notes_lost_reach');
    try {
      const row = await createSessionStaffNote({ actor: VISITING_COACH, sessionId: SESSION_ID, athleteId: ATHLETE_ID, note: 'while covering' });
      await client.query('delete from pilot.coach_coverage where organization_id = $1 and covering_coach_id = $2', [ORG_ID, VISITING_COACH_ID]);
      await expect(updateOwnSessionStaffNote({ actor: VISITING_COACH, noteId: row.note_id, note: 'later' })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeOwnSessionStaffNote({ actor: VISITING_COACH, noteId: row.note_id })).rejects.toBeInstanceOf(ForbiddenError);
      expect((await allRows(client))[0]).toMatchObject({ note: 'while covering', removed: false });
    } finally {
      await client.end();
    }
  });

  test('an outage while checking access is an error, never "not permitted"', async () => {
    const client = await migratedDatabase('notes_outage');
    jest.spyOn(accessModule, 'assertActorCanAccessAthlete').mockRejectedValueOnce(new Error('connection terminated'));
    try {
      await expect(listSessionStaffNotes(COACH, SESSION_ID, ATHLETE_ID)).rejects.toThrow('connection terminated');
    } finally {
      await client.end();
    }
  });
});
