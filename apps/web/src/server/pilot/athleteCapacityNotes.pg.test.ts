// Real PostgreSQL-backed test for the athlete-capacity-notes migration and for
// athleteCapacityNotes.ts on top of it. './db' is mocked to route into the
// embedded server (the athleteMinorLimits.pg.test.ts pattern; withTransaction
// runs a real BEGIN/COMMIT/ROLLBACK), so the module's real SQL -- and
// access.ts's, audit.ts's and achievements.ts's -- runs against real rows.
//
// What needs a real database to prove:
//   * the migration creates the table from nothing, re-applies as a no-op,
//     and the runner's readiness check refuses a database it never reached
//     or one with a guard dropped or loosened;
//   * a blank or over-long note and a non-staff author are DATABASE
//     refusals, and a note cannot name another gym's athlete;
//   * notes are history: newest first, a withdrawn note leaves the list but
//     not the table, only its author may withdraw it;
//   * the audit row commits with the note row and rolls back with it, and
//     never reaches the SHADOW feed;
//   * only staff with an ACTIVE membership here, who reach the athlete through
//     assertActorCanAccessAthlete, may read or write -- each near-miss
//     refused, and one gym never sees another's rows for the same athlete id;
//   * the author is shown by NAME, never by account id.
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
import { addCapacityNote, listCapacityNotes, readCapacityNotes, withdrawCapacityNote } from './athleteCapacityNotes';
import type { PilotRole } from './contracts';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-capacity-notes-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_capacity_notes_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-capacity-notes-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-capnotes';
const OTHER_ORG_ID = 'org-capnotes-elsewhere';
const ADMIN_ID = 'acct-capnotes-admin';
const OTHER_ADMIN_ID = 'acct-capnotes-other-admin';
const COACH_ID = 'acct-capnotes-coach'; // coach of record for ATHLETE, SECOND, SHARED here
const LAPSED_COACH_ID = 'acct-capnotes-lapsed'; // membership here deactivated
const VISITING_COACH_ID = 'acct-capnotes-visiting'; // home elsewhere, member here, coverage on ATHLETE_ID only
const UNASSIGNED_COACH_ID = 'acct-capnotes-unassigned'; // active coach here, reaches nobody
const ATHLETE_ACCOUNT_ID = 'acct-capnotes-athlete';
const PARENT_ACCOUNT_ID = 'acct-capnotes-parent'; // linked guardian of ATHLETE_ID
const VOLUNTEER_ACCOUNT_ID = 'acct-capnotes-volunteer';
const ATHLETE_ID = 'ath-capnotes-1';
const SECOND_ATHLETE_ID = 'ath-capnotes-2';
const OTHER_ATHLETE_ID = 'ath-capnotes-other'; // the other gym's
// The same athlete id in BOTH gyms (pilot.athletes' key is composite).
const SHARED_ATHLETE_ID = 'ath-capnotes-shared';
// Coach of record: the LAPSED coach. Only the membership check refuses them.
const THIRD_ATHLETE_ID = 'ath-capnotes-3';

// login_email, from which getCoachDisplayName derives the name shown.
const COACH_EMAIL = 'jason.neale@example.org'; // -> Coach Jason Neale
const ADMIN_EMAIL = 'gym-admin@example.org'; // -> Coach Gym Admin

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
const LAPSED_COACH = actorFor(LAPSED_COACH_ID, 'coach');
const VISITING_COACH = actorFor(VISITING_COACH_ID, 'coach');
const UNASSIGNED_COACH = actorFor(UNASSIGNED_COACH_ID, 'coach');
const ATHLETE = actorFor(ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, ATHLETE_ID);
const GUARDIAN = actorFor(PARENT_ACCOUNT_ID, 'parent');
const VOLUNTEER = actorFor(VOLUNTEER_ACCOUNT_ID, 'volunteer');
const PLATFORM_OWNER = actorFor('acct-capnotes-owner', 'platform_owner');
const BOARD = actorFor('acct-capnotes-board', 'board');

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

/** The full production schema, two gyms, every standing the access rule distinguishes. */
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
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
     values ($1, 'organization_admin', $10, 'microsoft', null, $13),
            ($2, 'coach',              $10, 'microsoft', null, $12),
            ($3, 'coach',              $10, 'microsoft', null, null),
            ($4, 'coach',              $11, 'microsoft', null, null),
            ($5, 'coach',              $10, 'microsoft', null, null),
            ($6, 'athlete',            $10, 'microsoft', $14, null),
            ($7, 'parent',             $10, 'microsoft', null, null),
            ($8, 'volunteer',          $10, 'microsoft', null, null),
            ($9, 'organization_admin', $11, 'microsoft', null, null)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID,
     ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID,
     ORG_ID, OTHER_ORG_ID, COACH_EMAIL, ADMIN_EMAIL, ATHLETE_ID],
  );

  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $10, 'organization_admin', true),
            ($2, $10, 'coach',              true),
            ($3, $10, 'coach',              false),
            ($4, $10, 'coach',              true),
            ($4, $11, 'coach',              true),
            ($5, $10, 'coach',              true),
            ($6, $10, 'athlete',            true),
            ($7, $10, 'parent',             true),
            ($8, $10, 'volunteer',          true),
            ($9, $11, 'organization_admin', true)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID,
     ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID,
     ORG_ID, OTHER_ORG_ID],
  );

  for (const [org, athleteId, coachId] of [
    [ORG_ID, ATHLETE_ID, COACH_ID],
    [ORG_ID, SECOND_ATHLETE_ID, COACH_ID],
    [ORG_ID, SHARED_ATHLETE_ID, COACH_ID],
    [ORG_ID, THIRD_ATHLETE_ID, LAPSED_COACH_ID],
    [OTHER_ORG_ID, OTHER_ATHLETE_ID, VISITING_COACH_ID],
    [OTHER_ORG_ID, SHARED_ATHLETE_ID, VISITING_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Capacity Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-capnotes-1', $2, 'Linked Guardian') on conflict do nothing`,
    [ORG_ID, PARENT_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-capnotes-1', $2, 'parent') on conflict do nothing`,
    [ORG_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.coach_coverage
       (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
     values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '8 hours')`,
    [ORG_ID, ATHLETE_ID, VISITING_COACH_ID, ADMIN_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.athlete_capacity_notes cascade');
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
    `insert into pilot.athlete_capacity_notes
       (organization_id, note_id, athlete_id, note, author_account_id, author_role)
     values ($1, gen_random_uuid(), $2, $3, $4, $5)`,
    [
      overrides.organization_id ?? ORG_ID,
      overrides.athlete_id ?? ATHLETE_ID,
      overrides.note ?? 'Held pace through all six rounds',
      overrides.author_account_id ?? COACH_ID,
      overrides.author_role ?? 'coach',
    ],
  );
}

async function noteCount(client: Client, { live = false } = {}): Promise<number> {
  const { rows } = await client.query(
    `select count(*)::int as n from pilot.athlete_capacity_notes ${live ? 'where deleted_at is null' : ''}`,
  );
  return rows[0].n;
}

async function auditRows(client: Client) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
       from pilot.audit_events where entity_type = 'athlete_capacity_note' order by created_at`,
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

describe('athlete capacity notes migration', () => {
  test('creates the table from nothing, and a re-apply leaves rows untouched', async () => {
    const client = await freshDatabase('capnotes_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.athlete_capacity_notes') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      await insertRaw(client);
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(`select note, author_role, deleted_at from pilot.athlete_capacity_notes`);
      expect(rows).toEqual([{ note: 'Held pace through all six rounds', author_role: 'coach', deleted_at: null }]);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('capnotes_not_ready', { preMigration: true });
    try {
      await expect(applyMutationFree(client)).rejects.toThrow(/ATHLETE_CAPACITY_NOTES_TABLE_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['the note check dropped', 'alter table pilot.athlete_capacity_notes drop constraint pilot_athlete_capacity_notes_note_check'],
    // Same words, looser predicate: the exact-text comparison is what refuses it.
    ['the note check loosened', `alter table pilot.athlete_capacity_notes drop constraint pilot_athlete_capacity_notes_note_check,
       add constraint pilot_athlete_capacity_notes_note_check check (length(note) <= 2000)`],
    ['the role check loosened', `alter table pilot.athlete_capacity_notes drop constraint pilot_athlete_capacity_notes_role_check,
       add constraint pilot_athlete_capacity_notes_role_check check (author_role in ('coach', 'organization_admin', 'admin', 'athlete'))`],
    ['the read index dropped', 'drop index pilot.idx_athlete_capacity_notes_athlete_seq'],
    ['the read index without its live-rows predicate', `drop index pilot.idx_athlete_capacity_notes_athlete_seq;
       create index idx_athlete_capacity_notes_athlete_seq on pilot.athlete_capacity_notes(organization_id, athlete_id, note_seq desc)`],
    ['the athlete foreign key dropped', 'alter table pilot.athlete_capacity_notes drop constraint pilot_athlete_capacity_notes_athlete_fk'],
    ['the athlete foreign key without cascade', `alter table pilot.athlete_capacity_notes drop constraint pilot_athlete_capacity_notes_athlete_fk,
       add constraint pilot_athlete_capacity_notes_athlete_fk foreign key (organization_id, athlete_id)
       references pilot.athletes(organization_id, athlete_id)`],
  ])('the runner refuses a table with %s, with everything else right', async (label, breakIt) => {
    const client = await freshDatabase(`capnotes_short_${label.replace(/[^a-z]+/g, '_')}`);
    try {
      await client.query(breakIt);
      await expect(applyMutationFree(client)).rejects.toThrow(/ATHLETE_CAPACITY_NOTES_TABLE_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test('the database refuses a blank note, a note over 2000 characters and a non-staff author', async () => {
    const client = await freshDatabase('capnotes_checks');
    try {
      await expect(insertRaw(client, { note: '' })).rejects.toThrow(/pilot_athlete_capacity_notes_note_check/);
      await expect(insertRaw(client, { note: '   ' })).rejects.toThrow(/pilot_athlete_capacity_notes_note_check/);
      // Tabs and line breaks alone are blank too (btrim's default strips spaces only).
      await expect(insertRaw(client, { note: '\t\n \r' })).rejects.toThrow(/pilot_athlete_capacity_notes_note_check/);
      await expect(insertRaw(client, { note: 'x'.repeat(2001) })).rejects.toThrow(/pilot_athlete_capacity_notes_note_check/);
      await expect(insertRaw(client, { author_role: 'athlete' })).rejects.toThrow(/pilot_athlete_capacity_notes_role_check/);
      await expect(insertRaw(client, { author_role: 'parent' })).rejects.toThrow(/pilot_athlete_capacity_notes_role_check/);
      await expect(insertRaw(client, { note: 'x'.repeat(2000) })).resolves.toBeDefined();
      await expect(insertRaw(client, { author_role: 'organization_admin', author_account_id: ADMIN_ID })).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  test('a note cannot name another gym\'s athlete, and goes with the athlete when the athlete is purged', async () => {
    const client = await freshDatabase('capnotes_fk');
    try {
      await expect(insertRaw(client, { athlete_id: OTHER_ATHLETE_ID })).rejects.toThrow(
        /pilot_athlete_capacity_notes_athlete_fk/,
      );
      await insertRaw(client, { athlete_id: SECOND_ATHLETE_ID });
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG_ID, SECOND_ATHLETE_ID]);
      expect(await noteCount(client)).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('athleteCapacityNotes.ts against real rows', () => {
  test('no notes reads as an empty list; the author is shown by NAME, never by account id', async () => {
    const client = await migratedDatabase('capnotes_names');
    try {
      expect(await listCapacityNotes(COACH, ATHLETE_ID)).toEqual([]);

      const byCoach = await addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: '  Held pace through all six rounds  ' });
      const byAdmin = await addCapacityNote({ actor: ADMIN, athleteId: ATHLETE_ID, note: 'Gassed after round three' });
      expect(byCoach).toMatchObject({
        athlete_id: ATHLETE_ID,
        note: 'Held pace through all six rounds',
        author_account_id: COACH_ID,
        author_role: 'coach',
        author_name: 'Coach Jason Neale',
      });
      expect(byAdmin).toMatchObject({ author_role: 'organization_admin', author_name: 'Coach Gym Admin' });

      const listed = await listCapacityNotes(ADMIN, ATHLETE_ID);
      expect(listed.map((row) => row.author_name)).toEqual(['Coach Gym Admin', 'Coach Jason Neale']);
      for (const row of listed) {
        expect(row.author_name).not.toContain(row.author_account_id);
        expect(row.author_name).not.toMatch(/acct-/);
      }
      // A note on one athlete says nothing about another.
      expect(await listCapacityNotes(COACH, SECOND_ATHLETE_ID)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('history: newest first, a withdrawn note leaves the list but not the table, and only its author withdraws it', async () => {
    const client = await migratedDatabase('capnotes_history');
    try {
      const first = await addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: 'First' });
      const second = await addCapacityNote({ actor: ADMIN, athleteId: ATHLETE_ID, note: 'Second' });
      const third = await addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: 'Third' });
      expect((await listCapacityNotes(COACH, ATHLETE_ID)).map((row) => row.note_id)).toEqual(
        [third.note_id, second.note_id, first.note_id],
      );

      // The admin did not write the coach's note: refused, nothing changes.
      await expect(withdrawCapacityNote({ actor: ADMIN, athleteId: ATHLETE_ID, noteId: first.note_id }))
        .rejects.toBeInstanceOf(ForbiddenError);
      // Nor may the coach withdraw the admin's: author only, both ways.
      await expect(withdrawCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, noteId: second.note_id }))
        .rejects.toBeInstanceOf(ForbiddenError);
      expect(await noteCount(client, { live: true })).toBe(3);

      await withdrawCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, noteId: first.note_id });
      expect((await listCapacityNotes(ADMIN, ATHLETE_ID)).map((row) => row.note_id)).toEqual(
        [third.note_id, second.note_id],
      );
      expect(await noteCount(client)).toBe(3);
      expect(await noteCount(client, { live: true })).toBe(2);
      const { rows } = await client.query(
        'select note, deleted_at from pilot.athlete_capacity_notes where note_id = $1',
        [first.note_id],
      );
      expect(rows[0].note).toBe('First');
      expect(rows[0].deleted_at).not.toBeNull();

      // Withdrawn already, or not this athlete's: not found, not "forbidden".
      await expect(withdrawCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, noteId: first.note_id }))
        .rejects.toBeInstanceOf(NotFoundError);
      await expect(withdrawCapacityNote({ actor: COACH, athleteId: SECOND_ATHLETE_ID, noteId: third.note_id }))
        .rejects.toBeInstanceOf(NotFoundError);
      expect(await noteCount(client, { live: true })).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('two notes with the same timestamp: the one written last is newest', async () => {
    const client = await migratedDatabase('capnotes_tie');
    try {
      for (const note of ['older', 'newer']) {
        await client.query(
          `insert into pilot.athlete_capacity_notes
             (organization_id, note_id, athlete_id, note, author_account_id, author_role, created_at)
           values ($1, gen_random_uuid(), $2, $3, $4, 'coach', '2026-10-08T12:00:00Z')`,
          [ORG_ID, ATHLETE_ID, note, COACH_ID],
        );
      }
      expect((await listCapacityNotes(COACH, ATHLETE_ID)).map((row) => row.note)).toEqual(['newer', 'older']);
    } finally {
      await client.end();
    }
  });

  test('past the newest 100 the read says older notes exist; at exactly 100 it says the list is complete', async () => {
    const client = await migratedDatabase('capnotes_older');
    try {
      await client.query(
        `insert into pilot.athlete_capacity_notes
           (organization_id, note_id, athlete_id, note, author_account_id, author_role)
         select $1, gen_random_uuid(), $2, 'Note ' || n, $3, 'coach' from generate_series(1, 101) n`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
      const over = await readCapacityNotes(COACH, ATHLETE_ID);
      expect(over.notes).toHaveLength(100);
      expect(over.olderNotes).toBe(true);
      expect(over.notes[0].note).toBe('Note 101');
      expect(over.notes[99].note).toBe('Note 2');
      expect(await listCapacityNotes(COACH, ATHLETE_ID)).toEqual(over.notes);

      // Withdrawn notes do not count: one withdrawal leaves exactly 100 live.
      await withdrawCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, noteId: over.notes[0].note_id });
      const exact = await readCapacityNotes(COACH, ATHLETE_ID);
      expect(exact.notes).toHaveLength(100);
      expect(exact.olderNotes).toBe(false);
      expect(exact.notes[99].note).toBe('Note 1');
    } finally {
      await client.end();
    }
  });

  test('every write leaves an audit row in the same transaction, naming the athlete and not the note text', async () => {
    const client = await migratedDatabase('capnotes_audit');
    try {
      const added = await addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: 'Held pace through all six rounds' });
      await withdrawCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, noteId: added.note_id });
      const rows = await auditRows(client);
      expect(rows).toEqual([
        {
          event_type: 'create',
          actor_account_id: COACH_ID,
          actor_role: 'coach',
          organization_id: ORG_ID,
          entity_id: added.note_id,
          details: { athlete_id: ATHLETE_ID },
        },
        {
          event_type: 'update',
          actor_account_id: COACH_ID,
          actor_role: 'coach',
          organization_id: ORG_ID,
          entity_id: added.note_id,
          details: { athlete_id: ATHLETE_ID, action: 'withdraw' },
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain('Held pace');
    } finally {
      await client.end();
    }
  });

  test('when the audit row cannot be written, the note row (or the withdrawal) is rolled back with it', async () => {
    const client = await migratedDatabase('capnotes_audit_rollback');
    try {
      jest.spyOn(auditModule, 'writePilotAuditEvent').mockRejectedValueOnce(new Error('audit insert failed'));
      await expect(addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: 'x' })).rejects.toThrow('audit insert failed');
      expect(await noteCount(client)).toBe(0);
      expect(await auditRows(client)).toEqual([]);

      // The connection is usable afterwards: the transaction was rolled back, not left open.
      const added = await addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: 'x' });
      expect(await auditRows(client)).toHaveLength(1);

      jest.spyOn(auditModule, 'writePilotAuditEvent').mockRejectedValueOnce(new Error('audit insert failed'));
      await expect(withdrawCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, noteId: added.note_id }))
        .rejects.toThrow('audit insert failed');
      expect(await noteCount(client, { live: true })).toBe(1);
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('one gym never sees another gym\'s rows for the same athlete id', async () => {
    const client = await migratedDatabase('capnotes_isolation');
    try {
      // This gym's row FIRST, the other gym's SECOND: the newest row across
      // both gyms belongs to the other gym, so a read that forgot the
      // organization would list it here.
      await insertRaw(client, { organization_id: ORG_ID, athlete_id: SHARED_ATHLETE_ID, note: 'here' });
      await insertRaw(client, { organization_id: OTHER_ORG_ID, athlete_id: SHARED_ATHLETE_ID, author_account_id: VISITING_COACH_ID, note: 'there' });

      expect((await listCapacityNotes(ADMIN, SHARED_ATHLETE_ID)).map((row) => row.note)).toEqual(['here']);
      expect((await listCapacityNotes(OTHER_ADMIN, SHARED_ATHLETE_ID)).map((row) => row.note)).toEqual(['there']);

      // Writing here lands here only -- and the other gym's read does not move.
      await addCapacityNote({ actor: COACH, athleteId: SHARED_ATHLETE_ID, note: 'here again' });
      const { rows } = await client.query(
        'select organization_id, note from pilot.athlete_capacity_notes order by note_seq',
      );
      expect(rows).toEqual([
        { organization_id: ORG_ID, note: 'here' },
        { organization_id: OTHER_ORG_ID, note: 'there' },
        { organization_id: ORG_ID, note: 'here again' },
      ]);
      expect((await listCapacityNotes(ADMIN, SHARED_ATHLETE_ID)).map((row) => row.note)).toEqual(['here again', 'here']);
      expect((await listCapacityNotes(OTHER_ADMIN, SHARED_ATHLETE_ID)).map((row) => row.note)).toEqual(['there']);

      // A withdrawal names this gym's row only: the other gym's note of the
      // same id-space is untouched even by its own author id.
      const { rows: otherIds } = await client.query(
        'select note_id from pilot.athlete_capacity_notes where organization_id = $1',
        [OTHER_ORG_ID],
      );
      await expect(withdrawCapacityNote({ actor: COACH, athleteId: SHARED_ATHLETE_ID, noteId: otherIds[0].note_id }))
        .rejects.toBeInstanceOf(NotFoundError);
      expect(await noteCount(client, { live: true })).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('a coach covering an athlete may write and read that athlete\'s notes, and only that one', async () => {
    const client = await migratedDatabase('capnotes_coverage');
    try {
      const row = await addCapacityNote({ actor: VISITING_COACH, athleteId: ATHLETE_ID, note: 'Covering today' });
      expect(row.author_role).toBe('coach');
      expect((await listCapacityNotes(VISITING_COACH, ATHLETE_ID)).map((r) => r.note_id)).toEqual([row.note_id]);
      await expect(listCapacityNotes(VISITING_COACH, SECOND_ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addCapacityNote({ actor: VISITING_COACH, athleteId: SECOND_ATHLETE_ID, note: 'x' }))
        .rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['an unassigned coach of the same gym', UNASSIGNED_COACH],
    ['a coach whose membership here lapsed', LAPSED_COACH],
    ['an admin of another gym', OTHER_ADMIN],
    ['the athlete themselves', ATHLETE],
    ['their linked guardian', GUARDIAN],
    ['a volunteer', VOLUNTEER],
    ['the platform owner', PLATFORM_OWNER],
    ['the board', BOARD],
  ])('%s may neither read, write nor withdraw a note', async (_label, actor) => {
    const client = await migratedDatabase(`capnotes_deny_${actor.accountId.replace(/[^a-z]/g, '_')}`);
    try {
      await insertRaw(client);
      const { rows } = await client.query('select note_id from pilot.athlete_capacity_notes');
      await expect(listCapacityNotes(actor, ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addCapacityNote({ actor, athleteId: ATHLETE_ID, note: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(withdrawCapacityNote({ actor, athleteId: ATHLETE_ID, noteId: rows[0].note_id }))
        .rejects.toBeInstanceOf(ForbiddenError);
      expect(await noteCount(client, { live: true })).toBe(1);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a coach of record whose membership here lapsed is refused -- the membership check alone does this', async () => {
    const client = await migratedDatabase('capnotes_lapsed_of_record');
    try {
      await insertRaw(client, { athlete_id: THIRD_ATHLETE_ID, author_account_id: LAPSED_COACH_ID });
      const { rows } = await client.query('select note_id from pilot.athlete_capacity_notes');
      await expect(listCapacityNotes(LAPSED_COACH, THIRD_ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addCapacityNote({ actor: LAPSED_COACH, athleteId: THIRD_ATHLETE_ID, note: 'x' }))
        .rejects.toBeInstanceOf(ForbiddenError);
      await expect(withdrawCapacityNote({ actor: LAPSED_COACH, athleteId: THIRD_ATHLETE_ID, noteId: rows[0].note_id }))
        .rejects.toBeInstanceOf(ForbiddenError);
      // The athlete is reachable for the gym's admin, so the refusal above is
      // the lapsed membership and not a missing athlete.
      expect(await listCapacityNotes(ADMIN, THIRD_ATHLETE_ID)).toHaveLength(1);
      expect(await noteCount(client, { live: true })).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the session role never widens reach: an account whose session says coach but whose membership here is a volunteer is refused', async () => {
    const client = await migratedDatabase('capnotes_session_role');
    try {
      // The membership row decides; a session claiming 'coach' for a
      // volunteer account reaches nothing.
      await expect(listCapacityNotes(actorFor(VOLUNTEER_ACCOUNT_ID, 'coach'), ATHLETE_ID))
        .rejects.toBeInstanceOf(ForbiddenError);
      await expect(listCapacityNotes(actorFor(VOLUNTEER_ACCOUNT_ID, 'organization_admin'), ATHLETE_ID))
        .rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await client.end();
    }
  });

  test('an outage while checking access is an error, never "not permitted"', async () => {
    const client = await migratedDatabase('capnotes_outage');
    jest
      .spyOn(accessModule, 'assertActorCanAccessAthlete')
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    try {
      const attempt = listCapacityNotes(COACH, ATHLETE_ID);
      await expect(attempt).rejects.toThrow('connection terminated unexpectedly');
      await expect(attempt).rejects.not.toBeInstanceOf(ForbiddenError);
    } finally {
      await client.end();
    }
  });

  test('a deleted athlete\'s notes are unreachable, even for their coach of record', async () => {
    const client = await migratedDatabase('capnotes_deleted');
    try {
      await insertRaw(client);
      await client.query(
        'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
        [ORG_ID, ATHLETE_ID],
      );
      await expect(listCapacityNotes(COACH, ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addCapacityNote({ actor: ADMIN, athleteId: ATHLETE_ID, note: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await client.end();
    }
  });

  test('the module refuses a blank or over-long note before touching the database', async () => {
    const client = await migratedDatabase('capnotes_shape');
    try {
      await expect(addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: '' })).rejects.toBeInstanceOf(ValidationError);
      await expect(addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: ' \t\n ' })).rejects.toBeInstanceOf(ValidationError);
      await expect(addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: 'x'.repeat(2001) })).rejects.toBeInstanceOf(ValidationError);
      // Padded text is measured after trimming.
      await expect(addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: `  ${'y'.repeat(2000)}  ` }))
        .resolves.toMatchObject({ note: 'y'.repeat(2000) });
      expect(await noteCount(client)).toBe(1);
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('the audit rows are not mirrored into the SHADOW event stream or telemetry', async () => {
    // /api/pilot/shadow/events admits athletes and guardians and ties rows to
    // the athlete through details.athlete_id; whether the family sees a
    // coach's capacity notes is undecided, so the audit row stays in the
    // audit table.
    const client = await migratedDatabase('capnotes_no_mirror');
    try {
      const added = await addCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, note: 'x' });
      await withdrawCapacityNote({ actor: COACH, athleteId: ATHLETE_ID, noteId: added.note_id });
      expect(await auditRows(client)).toHaveLength(2);
      const events = await client.query(
        "select count(*)::int as n from pilot.shadow_events where entity_type = 'athlete_capacity_note' or event_name like '%CAPACITY_NOTE%'",
      );
      expect(events.rows[0].n).toBe(0);
      const telemetry = await client.query(
        "select count(*)::int as n from pilot.shadow_telemetry_events where dimensions->>'entity_type' = 'athlete_capacity_note'",
      );
      expect(telemetry.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
