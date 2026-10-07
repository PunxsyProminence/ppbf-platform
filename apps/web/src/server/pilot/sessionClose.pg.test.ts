// Real PostgreSQL-backed contract test for the session-close migration
// (pilot.sessions.checked_out_at / close_method / last_activity_at /
// inactivity_minutes) and for the one writer that stamps them, upsertSession.
//
// What needs proving that reading the SQL or a mocked query cannot:
//
//   * the migration applies over the shipped sessions table (after the
//     session-RPE semantics and session-duration migrations, the order `all`
//     runs them in) and re-applies as a no-op through its own runner;
//   * every pre-existing row reads NULL in all four columns -- nothing is
//     backfilled from updated_at;
//   * the close vocabulary and the "how without when" / "auto without its
//     evidence" rules are DATABASE facts, not only application conventions;
//   * upsertSession stamps the SERVER clock and the caller's method on the one
//     write that flips completed_flag false -> true, leaves both alone on a
//     later write that keeps the row closed, clears all four when a row is
//     reopened, and never reads the client's updated_at for any of it;
//   * a create, even of an already-completed row, stamps nothing;
//   * both session-length readings the owner's open question chooses between
//     are computable from the stored columns of an auto-closed row.
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

import type { PilotSession } from './contracts';
import { getSessionById, upsertSession } from './entities';
import { validateSessionPayload } from './validation';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-close-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-session-close-migration.mjs');

// Applied in the order the `all` chain runs them: upsertSession writes
// rpe_method and duration_minutes, so both of their migrations come first.
const PREREQUISITE_MIGRATIONS = [
  'pilot_slice_postgres_session_rpe_semantics_migration.sql',
  'pilot_slice_postgres_session_duration_migration.sql',
];
const MIGRATION_FILE = 'pilot_slice_postgres_session_close_migration.sql';

const ORG_ID = 'org-session-close';
const COACH_ID = 'acct-session-close-coach';
const ATHLETE_ID = 'ath-session-close-1';
const SELF_REPORT = 'athlete_post_session_self_report';
const CLOSE_COLUMNS = ['checked_out_at', 'close_method', 'last_activity_at', 'inactivity_minutes'] as const;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let prerequisiteSql: string[];
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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

/** A database in the state production is in BEFORE this migration. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Close Athlete', '2000-01-01', '75', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  for (const sql of prerequisiteSql) {
    await client.query(sql);
  }
  return client;
}

function session(overrides: Partial<PilotSession> = {}): PilotSession {
  const now = new Date().toISOString();
  return {
    session_id: 'sess-1',
    athlete_id: ATHLETE_ID,
    date: now.slice(0, 10),
    rpe: null,
    rpe_method: 'UNKNOWN',
    notes: 'note',
    completed_flag: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

interface CloseRow {
  completed_flag: boolean;
  checked_out_at: Date | null;
  close_method: string | null;
  last_activity_at: Date | null;
  inactivity_minutes: number | null;
  updated_at: Date;
}

async function readClose(client: Client, sessionId: string): Promise<CloseRow> {
  const { rows } = await client.query<CloseRow>(
    `select completed_flag, checked_out_at, close_method, last_activity_at, inactivity_minutes, updated_at
     from pilot.sessions where organization_id = $1 and session_id = $2`,
    [ORG_ID, sessionId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** A raw row shaped like one the auto-close mechanism would write. */
function insertAutoClosed(
  client: Client,
  sessionId: string,
  values: { checked_out_at: string | null; close_method: string | null; last_activity_at: string | null; inactivity_minutes: number | null },
) {
  return client.query(
    `insert into pilot.sessions
       (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at,
        checked_out_at, close_method, last_activity_at, inactivity_minutes)
     values ($1, $2, $3, current_date, null, 'UNKNOWN', 'n', true, '2026-10-06T18:00:00Z', now(), $4, $5, $6, $7)`,
    [ORG_ID, sessionId, ATHLETE_ID, values.checked_out_at, values.close_method, values.last_activity_at, values.inactivity_minutes],
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  prerequisiteSql = await Promise.all(
    PREREQUISITE_MIGRATIONS.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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

afterEach(() => {
  activeClient = null;
});

describe('session close migration', () => {
  test('the runner refuses a database the migration has not reached', async () => {
    const client = await freshDatabase('close_refuse');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('SESSION_CLOSE_NOT_READY');
    } finally {
      await client.end();
    }
  });

  // The migration skips a constraint whose NAME already exists, so the
  // runner's readiness check is what catches one with the wrong vocabulary.
  test('the runner refuses a same-named vocabulary constraint missing a method', async () => {
    const client = await freshDatabase('close_wrong_vocabulary');
    try {
      await client.query(`alter table pilot.sessions add column close_method text null`);
      await client.query(
        `alter table pilot.sessions add constraint pilot_sessions_close_method_check
           check (close_method is null or close_method in ('athlete_check_out', 'staff_check_out'))`,
      );
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow('SESSION_CLOSE_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a checked_out_at that carries a default', async () => {
    const client = await freshDatabase('close_default');
    try {
      await client.query(`alter table pilot.sessions add column checked_out_at timestamptz null default now()`);
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow('SESSION_CLOSE_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test('applies over existing rows, backfills nothing, and re-applies as a no-op', async () => {
    const client = await freshDatabase('close_apply');
    try {
      // A completed pre-migration row: updated_at is all it has, and it stays
      // the only thing it has.
      await client.query(
        `insert into pilot.sessions
           (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
         values ($1, 'old-1', $2, current_date, 8, 'UNKNOWN', 'n', true, now() - interval '2 hours', now() - interval '1 hour')`,
        [ORG_ID, ATHLETE_ID],
      );

      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch.
      await applyMigrationTransaction(client, migrationSql);

      const { rows: columns } = await client.query(
        `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
         where table_schema = 'pilot' and table_name = 'sessions'
           and column_name = any($1::text[])
         order by column_name`,
        [[...CLOSE_COLUMNS]],
      );
      expect(columns).toEqual([
        { column_name: 'checked_out_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
        { column_name: 'close_method', data_type: 'text', is_nullable: 'YES', column_default: null },
        { column_name: 'inactivity_minutes', data_type: 'integer', is_nullable: 'YES', column_default: null },
        { column_name: 'last_activity_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      ]);

      const row = await readClose(client, 'old-1');
      expect(row.completed_flag).toBe(true);
      expect(row.checked_out_at).toBeNull();
      expect(row.close_method).toBeNull();
      expect(row.last_activity_at).toBeNull();
      expect(row.inactivity_minutes).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the vocabulary and the close-record rules are database facts', async () => {
    const client = await freshDatabase('close_rules');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const at = '2026-10-06T19:20:00Z';
      const last = '2026-10-06T19:00:00Z';

      // Accepted: each method with its evidence; an auto-close with both; all null.
      await insertAutoClosed(client, 'ok-athlete', { checked_out_at: at, close_method: 'athlete_check_out', last_activity_at: null, inactivity_minutes: null });
      await insertAutoClosed(client, 'ok-staff', { checked_out_at: at, close_method: 'staff_check_out', last_activity_at: null, inactivity_minutes: null });
      await insertAutoClosed(client, 'ok-auto', { checked_out_at: at, close_method: 'auto_inactivity', last_activity_at: last, inactivity_minutes: 20 });
      await insertAutoClosed(client, 'ok-when-only', { checked_out_at: at, close_method: null, last_activity_at: null, inactivity_minutes: null });
      await insertAutoClosed(client, 'ok-null', { checked_out_at: null, close_method: null, last_activity_at: null, inactivity_minutes: null });

      // Refused: a method outside the vocabulary.
      await expect(insertAutoClosed(client, 'bad-vocab', { checked_out_at: at, close_method: 'timeout', last_activity_at: null, inactivity_minutes: null }))
        .rejects.toMatchObject({ code: '23514' });
      // Refused: HOW without WHEN.
      await expect(insertAutoClosed(client, 'bad-how-no-when', { checked_out_at: null, close_method: 'athlete_check_out', last_activity_at: null, inactivity_minutes: null }))
        .rejects.toMatchObject({ code: '23514' });
      // Refused: an auto-close without its evidence, either half.
      await expect(insertAutoClosed(client, 'bad-auto-no-last', { checked_out_at: at, close_method: 'auto_inactivity', last_activity_at: null, inactivity_minutes: 20 }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertAutoClosed(client, 'bad-auto-no-window', { checked_out_at: at, close_method: 'auto_inactivity', last_activity_at: last, inactivity_minutes: null }))
        .rejects.toMatchObject({ code: '23514' });
      // Refused: a window outside 1..1440.
      for (const minutes of [0, 1441]) {
        await expect(insertAutoClosed(client, `bad-window-${minutes}`, { checked_out_at: at, close_method: 'auto_inactivity', last_activity_at: last, inactivity_minutes: minutes }))
          .rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await client.end();
    }
  });
});

describe('upsertSession stamps the close record on the completed transition', () => {
  // The client's updated_at is pinned far in the past on every write below,
  // so a checked_out_at near the real clock proves the stamp is the server's.
  const CLIENT_STAMP = '2020-01-01T00:00:00.000Z';

  test("the athlete's check-out stamps now() and athlete_check_out; staff edits leave it; reopening clears it", async () => {
    const client = await freshDatabase('close_upsert_athlete');
    try {
      await applyMigrationTransaction(client, migrationSql);
      activeClient = client;

      // Check-in: open, nothing stamped.
      await upsertSession(ORG_ID, session({ created_at: CLIENT_STAMP, updated_at: CLIENT_STAMP }), { mode: 'create' }, { closedBy: 'athlete' });
      let row = await readClose(client, 'sess-1');
      expect(row.completed_flag).toBe(false);
      for (const column of CLOSE_COLUMNS) expect(row[column]).toBeNull();

      // A note shared while open (completed_flag still false): still nothing.
      await upsertSession(
        ORG_ID,
        session({ notes: 'shared', created_at: CLIENT_STAMP, updated_at: CLIENT_STAMP }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID, noteWriter: true },
        { closedBy: 'athlete' },
      );
      row = await readClose(client, 'sess-1');
      for (const column of CLOSE_COLUMNS) expect(row[column]).toBeNull();

      // Check-out, as the update route runs it: through the validator, with
      // the athlete's effort and minutes, and the role's method.
      const before = Date.now();
      const checkOutBody = JSON.parse(JSON.stringify(session({
        rpe: 7, rpe_method: SELF_REPORT, completed_flag: true, duration_minutes: 45,
        created_at: CLIENT_STAMP, updated_at: CLIENT_STAMP,
      })));
      await upsertSession(ORG_ID, validateSessionPayload(checkOutBody), { mode: 'update', expectedAthleteId: ATHLETE_ID, noteWriter: true }, { closedBy: 'athlete' });
      row = await readClose(client, 'sess-1');
      expect(row.completed_flag).toBe(true);
      expect(row.close_method).toBe('athlete_check_out');
      expect(row.checked_out_at).not.toBeNull();
      const checkedOutMs = row.checked_out_at!.getTime();
      // Server clock, not the client's 2020 stamp.
      expect(checkedOutMs).toBeGreaterThanOrEqual(before - 1000);
      expect(checkedOutMs).toBeLessThanOrEqual(Date.now() + 1000);
      expect(row.updated_at.toISOString()).toBe(CLIENT_STAMP);
      expect(row.last_activity_at).toBeNull();
      expect(row.inactivity_minutes).toBeNull();

      // A later STAFF write that keeps it completed (a coach correcting the
      // effort; staff may not change the note text, OD-2026-10-06-025 ruling
      // 4, so the stored note is sent back unchanged) moves updated_at -- the
      // old proxy -- but neither the time nor the method.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await upsertSession(
        ORG_ID,
        session({ rpe: 8, rpe_method: SELF_REPORT, completed_flag: true, created_at: CLIENT_STAMP, updated_at: '2021-01-01T00:00:00.000Z' }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID, noteWriter: false },
        { closedBy: 'staff' },
      );
      row = await readClose(client, 'sess-1');
      expect(row.updated_at.toISOString()).toBe('2021-01-01T00:00:00.000Z');
      expect(row.checked_out_at!.getTime()).toBe(checkedOutMs);
      expect(row.close_method).toBe('athlete_check_out');

      // Reopened: the row describes its current state, so all four clear.
      await upsertSession(
        ORG_ID,
        session({ completed_flag: false, created_at: CLIENT_STAMP, updated_at: CLIENT_STAMP }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID, noteWriter: true },
        { closedBy: 'athlete' },
      );
      row = await readClose(client, 'sess-1');
      expect(row.completed_flag).toBe(false);
      for (const column of CLOSE_COLUMNS) expect(row[column]).toBeNull();

      // Closed again: a fresh stamp, later than the first.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await upsertSession(
        ORG_ID,
        session({ rpe: 6, rpe_method: SELF_REPORT, completed_flag: true, created_at: CLIENT_STAMP, updated_at: CLIENT_STAMP }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID, noteWriter: true },
        { closedBy: 'athlete' },
      );
      row = await readClose(client, 'sess-1');
      expect(row.checked_out_at!.getTime()).toBeGreaterThan(checkedOutMs);
      expect(row.close_method).toBe('athlete_check_out');

      // The read path carries the record back typed.
      const record = await getSessionById(ORG_ID, 'sess-1');
      expect(record?.close_method).toBe('athlete_check_out');
      expect(record?.checked_out_at).not.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a coach completing a session records staff_check_out; a caller with no role recorded leaves the method null', async () => {
    const client = await freshDatabase('close_upsert_staff');
    try {
      await applyMigrationTransaction(client, migrationSql);
      activeClient = client;

      await upsertSession(ORG_ID, session({ session_id: 'by-coach' }), { mode: 'create' });
      await upsertSession(
        ORG_ID,
        session({ session_id: 'by-coach', completed_flag: true }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID, noteWriter: false },
        { closedBy: 'staff' },
      );
      let row = await readClose(client, 'by-coach');
      expect(row.close_method).toBe('staff_check_out');
      expect(row.checked_out_at).not.toBeNull();

      // An older caller that passes no options: the close is still stamped,
      // its method honestly unrecorded, and the database accepts that shape.
      await upsertSession(ORG_ID, session({ session_id: 'by-unknown' }), { mode: 'create' });
      await upsertSession(
        ORG_ID,
        session({ session_id: 'by-unknown', completed_flag: true }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID, noteWriter: true },
      );
      row = await readClose(client, 'by-unknown');
      expect(row.close_method).toBeNull();
      expect(row.checked_out_at).not.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a row created already completed gets no close record', async () => {
    const client = await freshDatabase('close_create_completed');
    try {
      await applyMigrationTransaction(client, migrationSql);
      activeClient = client;

      await upsertSession(
        ORG_ID,
        session({ session_id: 'past', completed_flag: true, rpe: 5, rpe_method: SELF_REPORT }),
        { mode: 'create' },
        { closedBy: 'staff' },
      );
      const row = await readClose(client, 'past');
      expect(row.completed_flag).toBe(true);
      for (const column of CLOSE_COLUMNS) expect(row[column]).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('session length is computed on read, never stored', () => {
  test('both readings of an auto-closed row come from the stored columns, and no length column exists', async () => {
    const client = await freshDatabase('close_length');
    try {
      await applyMigrationTransaction(client, migrationSql);

      // Checked in 18:00, last activity 19:00, closed by the rule at 19:20.
      await insertAutoClosed(client, 'auto-1', {
        checked_out_at: '2026-10-06T19:20:00Z',
        close_method: 'auto_inactivity',
        last_activity_at: '2026-10-06T19:00:00Z',
        inactivity_minutes: 20,
      });

      const { rows } = await client.query<{ idle_included: number; idle_excluded: number; window_matches: boolean }>(
        `select
           (extract(epoch from (checked_out_at - created_at)) / 60)::int as idle_included,
           (extract(epoch from (last_activity_at - created_at)) / 60)::int as idle_excluded,
           checked_out_at = last_activity_at + make_interval(mins => inactivity_minutes) as window_matches
         from pilot.sessions where session_id = 'auto-1'`,
      );
      expect(rows).toEqual([{ idle_included: 80, idle_excluded: 60, window_matches: true }]);

      const { rows: columns } = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'sessions'
           and (column_name like '%length%' or column_name like '%elapsed%')`,
      );
      expect(columns).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
