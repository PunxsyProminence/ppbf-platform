// Real PostgreSQL-backed contract test for the session-duration migration
// (pilot.sessions.duration_minutes) and for the code that only works on top of
// it: upsertSession storing the athlete's minutes, and the coach rollup
// computing session load (session RPE x minutes) without storing it.
//
// What needs proving that reading the SQL or a mocked query cannot:
//
//   * the migration applies over the shipped sessions table (after the
//     session-RPE semantics migration, the order `all` runs them in) and
//     re-applies as a no-op through its own runner;
//   * every pre-existing row reads NULL -- nothing is backfilled;
//   * 1..300 is a DATABASE fact, not only an application convention;
//   * an update that omits duration_minutes keeps the stored value, null
//     clears it, and a number sets it;
//   * avg_session_load is real arithmetic over ONLY athlete post-session
//     self-reports that carry minutes: UNKNOWN-method rows (possibly the old
//     readiness slider) and rows without minutes never enter it, and no
//     qualifying session is null, not 0.
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
import { getPerformanceRollup } from './performanceAnalytics';
import { validateSessionPayload } from './validation';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-duration-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-session-duration-migration.mjs');

// Applied in the order the `all` chain runs them. The rollup also reads
// readiness, activity_log and the progression tables, so those are applied
// too; the session-duration migration comes last.
const PREREQUISITE_MIGRATIONS = [
  'pilot_slice_postgres_progression_migration.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_readiness_provenance_migration.sql',
  'pilot_slice_postgres_session_rpe_semantics_migration.sql',
];
const MIGRATION_FILE = 'pilot_slice_postgres_session_duration_migration.sql';

const ORG_ID = 'org-session-duration';
const COACH_ID = 'acct-session-duration-coach';
const ATHLETE_ID = 'ath-session-duration-1';
const OTHER_ATHLETE_ID = 'ath-session-duration-2';
const SELF_REPORT = 'athlete_post_session_self_report';

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
  for (const athleteId of [ATHLETE_ID, OTHER_ATHLETE_ID]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Duration Athlete', '2000-01-01', '75', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [ORG_ID, athleteId, COACH_ID],
    );
  }
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

function insertRaw(
  client: Client,
  sessionId: string,
  values: { rpe: number | null; rpe_method: string; duration_minutes?: number | null; athlete_id?: string },
) {
  return client.query(
    `insert into pilot.sessions
       (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at, duration_minutes)
     values ($1, $2, $3, current_date, $4, $5, 'n', true, now(), now(), $6)`,
    [ORG_ID, sessionId, values.athlete_id ?? ATHLETE_ID, values.rpe, values.rpe_method, values.duration_minutes ?? null],
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

describe('session duration migration', () => {
  test('the runner refuses a database the migration has not reached', async () => {
    const client = await freshDatabase('duration_refuse');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('SESSION_DURATION_NOT_READY');
    } finally {
      await client.end();
    }
  });

  // The migration skips a constraint whose NAME already exists, so the
  // runner's readiness check is what catches one with the wrong bounds.
  test('the runner refuses a same-named constraint with the wrong bounds', async () => {
    const client = await freshDatabase('duration_wrong_bounds');
    try {
      await client.query(`alter table pilot.sessions add column duration_minutes integer null`);
      await client.query(
        `alter table pilot.sessions add constraint pilot_sessions_duration_minutes_range
           check (duration_minutes is null or duration_minutes between 10 and 3000)`,
      );
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow('SESSION_DURATION_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a column that carries a default', async () => {
    const client = await freshDatabase('duration_default');
    try {
      await client.query(`alter table pilot.sessions add column duration_minutes integer null default 60`);
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow('SESSION_DURATION_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test('applies over existing rows, backfills nothing, and re-applies as a no-op', async () => {
    const client = await freshDatabase('duration_apply');
    try {
      await client.query(
        `insert into pilot.sessions
           (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
         values ($1, 'old-1', $2, current_date, 8, 'UNKNOWN', 'n', true, now(), now())`,
        [ORG_ID, ATHLETE_ID],
      );

      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch.
      await applyMigrationTransaction(client, migrationSql);

      const { rows: columns } = await client.query(
        `select data_type, is_nullable, column_default
         from information_schema.columns
         where table_schema = 'pilot' and table_name = 'sessions' and column_name = 'duration_minutes'`,
      );
      expect(columns).toEqual([{ data_type: 'integer', is_nullable: 'YES', column_default: null }]);

      const { rows } = await client.query(
        `select duration_minutes, rpe::float8 as rpe from pilot.sessions where session_id = 'old-1'`,
      );
      expect(rows).toEqual([{ duration_minutes: null, rpe: 8 }]);
    } finally {
      await client.end();
    }
  });

  test('1..300 and null are the only values the database accepts', async () => {
    const client = await freshDatabase('duration_bounds');
    try {
      await applyMigrationTransaction(client, migrationSql);

      for (const [index, minutes] of [1, 300, null].entries()) {
        await insertRaw(client, `ok-${index}`, { rpe: null, rpe_method: 'UNKNOWN', duration_minutes: minutes });
      }
      for (const minutes of [0, 301, -5]) {
        await expect(insertRaw(client, `bad-${minutes}`, { rpe: null, rpe_method: 'UNKNOWN', duration_minutes: minutes }))
          .rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await client.end();
    }
  });
});

describe("upsertSession stores the athlete's minutes", () => {
  async function readMinutes(sessionId: string): Promise<number | null | undefined> {
    return (await getSessionById(ORG_ID, sessionId))?.duration_minutes;
  }

  test('create stores none; check-out sets; an update that omits the key keeps it; null clears; a number sets', async () => {
    const client = await freshDatabase('duration_upsert');
    try {
      await applyMigrationTransaction(client, migrationSql);
      activeClient = client;

      // Check-in: no minutes key at all -> NULL.
      await upsertSession(ORG_ID, session(), { mode: 'create' });
      expect(await readMinutes('sess-1')).toBeNull();

      // Check-out with minutes.
      await upsertSession(
        ORG_ID,
        session({ rpe: 7, rpe_method: SELF_REPORT, completed_flag: true, duration_minutes: 45 }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID },
      );
      expect(await readMinutes('sess-1')).toBe(45);

      // A later writer that predates the field (note publication, cached
      // client) omits the key: the stored minutes survive.
      await upsertSession(
        ORG_ID,
        session({ rpe: 7, rpe_method: SELF_REPORT, completed_flag: true, notes: 'edited' }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID },
      );
      expect(await readMinutes('sess-1')).toBe(45);

      // An explicit null is "not given" and clears it; a number replaces it.
      await upsertSession(
        ORG_ID,
        session({ rpe: 7, rpe_method: SELF_REPORT, completed_flag: true, duration_minutes: null }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID },
      );
      expect(await readMinutes('sess-1')).toBeNull();
      await upsertSession(
        ORG_ID,
        session({ rpe: 7, rpe_method: SELF_REPORT, completed_flag: true, duration_minutes: 60 }),
        { mode: 'update', expectedAthleteId: ATHLETE_ID },
      );
      expect(await readMinutes('sess-1')).toBe(60);

      // The same through the validator, as the routes run it: a JSON body
      // with no duration_minutes key (a note publication) keeps the minutes.
      const noteBody = JSON.parse(JSON.stringify(session({ rpe: 7, rpe_method: SELF_REPORT, notes: 'shared' })));
      expect('duration_minutes' in noteBody).toBe(false);
      await upsertSession(ORG_ID, validateSessionPayload(noteBody), { mode: 'update', expectedAthleteId: ATHLETE_ID });
      expect(await readMinutes('sess-1')).toBe(60);
      const checkOutBody = JSON.parse(JSON.stringify(session({ rpe: 7, rpe_method: SELF_REPORT, completed_flag: true, duration_minutes: 90 })));
      await upsertSession(ORG_ID, validateSessionPayload(checkOutBody), { mode: 'update', expectedAthleteId: ATHLETE_ID });
      expect(await readMinutes('sess-1')).toBe(90);

      // Create with minutes stores them too.
      await upsertSession(ORG_ID, session({ session_id: 'sess-2', duration_minutes: 30 }), { mode: 'create' });
      expect(await readMinutes('sess-2')).toBe(30);
    } finally {
      await client.end();
    }
  });
});

describe('the coach rollup computes session load and never stores it', () => {
  test('averages RPE x minutes over self-reported sessions that have minutes, and nothing else', async () => {
    const client = await freshDatabase('duration_rollup');
    try {
      await applyMigrationTransaction(client, migrationSql);
      activeClient = client;

      // Qualifying: 7 x 60 = 420 and 5 x 30 = 150 -> average 285 over 2.
      await insertRaw(client, 'q-1', { rpe: 7, rpe_method: SELF_REPORT, duration_minutes: 60 });
      await insertRaw(client, 'q-2', { rpe: 5, rpe_method: SELF_REPORT, duration_minutes: 30 });
      // Excluded: UNKNOWN provenance (maybe the old readiness slider), even with minutes.
      await insertRaw(client, 'x-unknown', { rpe: 9, rpe_method: 'UNKNOWN', duration_minutes: 120 });
      // Excluded: a rated session with no minutes is not zero load.
      await insertRaw(client, 'x-no-minutes', { rpe: 8, rpe_method: SELF_REPORT, duration_minutes: null });
      // Excluded: minutes with no rating.
      await insertRaw(client, 'x-no-rpe', { rpe: null, rpe_method: 'UNKNOWN', duration_minutes: 90 });
      // The other athlete has a session, but it does not qualify.
      await insertRaw(client, 'o-1', { rpe: 6, rpe_method: SELF_REPORT, duration_minutes: null, athlete_id: OTHER_ATHLETE_ID });

      const rows = await getPerformanceRollup(ORG_ID, [ATHLETE_ID, OTHER_ATHLETE_ID], 28);
      const mine = rows.find((row) => row.athlete_id === ATHLETE_ID);
      const other = rows.find((row) => row.athlete_id === OTHER_ATHLETE_ID);

      expect(mine?.avg_session_load).toBe(285);
      expect(mine?.session_load_count).toBe(2);
      // The load filter does not touch the session counts: five real sessions.
      expect(mine?.sessions_total).toBe(5);
      expect(other?.avg_session_load).toBeNull();
      expect(other?.session_load_count).toBe(0);
      expect(other?.sessions_total).toBe(1);

      // Nothing derived was written to the table.
      const { rows: columns } = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'sessions' and column_name like '%load%'`,
      );
      expect(columns).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
