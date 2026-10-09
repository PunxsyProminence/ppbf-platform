// Real PostgreSQL-backed test for the session auto-close mechanism
// (sessionAutoClose.ts), the behaviour half of OD-2026-10-06-024 Q4 with the
// activity definition from OD-2026-10-08-007 (O6 = A1, O7 = B1).
//
// What needs proving that a mocked query cannot:
//
//   * each of the eight ruled activity signals, saved for the athlete after
//     check-in, keeps an open session open past the window, and the session
//     then closes 20 minutes after THAT signal with last_activity_at = the
//     signal's time -- so dropping any one signal from the query fails here;
//   * with no signal at all the session closes at exactly 20 minutes from
//     check-in, and not one second before;
//   * a manual close is never overwritten, a reopened row is swept afresh,
//     another organization's stale session is left alone, and a second sweep
//     finds nothing (one audit row per close, ever);
//   * the athlete's typed minutes are untouched by the sweep;
//   * the dry run names exactly the rows the write then closes.
//
// Spins up the same disposable, local-only embedded Postgres the migration
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

let activeClient: Client | null = null;

function requireClient(): Client {
  if (!activeClient) throw new Error('test bug: no active embedded client');
  return activeClient;
}

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => (await requireClient().query(text, params)).rows),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => (await requireClient().query(text, params)).rows[0] ?? null),
  // The real withTransaction wraps a pooled client in BEGIN/COMMIT/ROLLBACK;
  // the embedded Client has the same query() surface, so the same wrapper
  // around it is the honest stand-in.
  withTransaction: jest.fn(async (fn: (client: Client) => Promise<unknown>) => {
    const client = requireClient();
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

import { upsertSession } from './entities';
import {
  SESSION_INACTIVITY_WINDOW_MINUTES,
  closeInactiveSessions,
  findInactiveSessions,
  runAutoCloseSweep,
} from './sessionAutoClose';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-autoclose-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

// Everything the sweep's statement reads, in the order the `all` chain applies
// them. scheduler_attendance, coach_observations, shadow_formula_observations
// and audit_events are in the base schema.
const MIGRATIONS = [
  'pilot_slice_postgres_progression_migration.sql',
  'pilot_slice_postgres_training_attempts_migration.sql',
  'pilot_slice_postgres_athlete_check_ins_migration.sql',
  'pilot_slice_postgres_session_rpe_semantics_migration.sql',
  'pilot_slice_postgres_session_duration_migration.sql',
  'pilot_slice_postgres_session_close_migration.sql',
];

const ORG_A = 'org-autoclose-a';
const ORG_B = 'org-autoclose-b';
const COACH_A = 'acct-autoclose-coach-a';
const COACH_B = 'acct-autoclose-coach-b';
const ATHLETE_A1 = 'ath-autoclose-a1';
const ATHLETE_A2 = 'ath-autoclose-a2';
const ATHLETE_B1 = 'ath-autoclose-b1';
const WINDOW = SESSION_INACTIVITY_WINDOW_MINUTES;

// A fixed clock. Every stamp below is relative to it, so nothing here depends
// on how long the embedded server takes to start.
const NOW = new Date('2026-10-08T19:00:00.000Z');
const minutesBefore = (minutes: number, from: Date = NOW) => new Date(from.getTime() - minutes * 60_000);
const minutesAfter = (minutes: number, from: Date = NOW) => new Date(from.getTime() + minutes * 60_000);

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let migrationSql: string[];

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  for (const sql of migrationSql) await client.query(sql);

  for (const [org, coach, athletes] of [
    [ORG_A, COACH_A, [ATHLETE_A1, ATHLETE_A2]],
    [ORG_B, COACH_B, [ATHLETE_B1]],
  ] as const) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
      [coach, org],
    );
    for (const athlete of athletes) {
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Auto Close', '2012-01-01', '60', 'active', 'contact', true, $3, now(), now())`,
        [org, athlete, coach],
      );
    }
  }
  activeClient = client;
  return client;
}

/** An OPEN session checked in at `createdAt`; updated_at = created_at as the check-in write leaves it. */
async function checkIn(client: Client, org: string, athleteId: string, sessionId: string, createdAt: Date, extra: { duration_minutes?: number } = {}) {
  await client.query(
    `insert into pilot.sessions
       (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at, duration_minutes)
     values ($1, $2, $3, $4::date, null, 'UNKNOWN', '', false, $5::timestamptz, $5::timestamptz, $6)`,
    [org, sessionId, athleteId, createdAt.toISOString().slice(0, 10), createdAt, extra.duration_minutes ?? null],
  );
}

interface SessionRow {
  completed_flag: boolean;
  checked_out_at: Date | null;
  close_method: string | null;
  last_activity_at: Date | null;
  inactivity_minutes: number | null;
  updated_at: Date;
  duration_minutes: number | null;
}

async function readSession(client: Client, org: string, sessionId: string): Promise<SessionRow> {
  const { rows } = await client.query<SessionRow>(
    `select completed_flag, checked_out_at, close_method, last_activity_at, inactivity_minutes, updated_at, duration_minutes
       from pilot.sessions where organization_id = $1 and session_id = $2`,
    [org, sessionId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function autoCloseAuditRows(client: Client, org: string, sessionId: string) {
  const { rows } = await client.query<{ actor_account_id: string | null; actor_role: string | null; details: Record<string, unknown> }>(
    `select actor_account_id, actor_role, details from pilot.audit_events
      where organization_id = $1 and entity_type = 'session' and entity_id = $2
        and details->>'close_method' = 'auto_inactivity'
      order by audit_id`,
    [org, sessionId],
  );
  return rows;
}

function expectOpen(row: SessionRow) {
  expect(row.completed_flag).toBe(false);
  expect(row.checked_out_at).toBeNull();
  expect(row.close_method).toBeNull();
}

function expectAutoClosed(row: SessionRow, lastActivity: Date) {
  expect(row.completed_flag).toBe(true);
  expect(row.close_method).toBe('auto_inactivity');
  expect(row.inactivity_minutes).toBe(WINDOW);
  expect(row.last_activity_at?.toISOString()).toBe(lastActivity.toISOString());
  expect(row.checked_out_at?.toISOString()).toBe(minutesAfter(WINDOW, lastActivity).toISOString());
}

/**
 * The eight ruled signals, each as "save this for the athlete at `at`". The
 * stamps a client may send (completed_at, attempted_at, observed_at,
 * checked_in_at) are set EARLIER than the save stamp on purpose, so a signal
 * that only read the client's stamp would place the activity in the wrong
 * place and fail the assertion on last_activity_at.
 */
const SIGNALS: ReadonlyArray<{ name: string; save: (client: Client, org: string, athleteId: string, coach: string, at: Date, tag: string) => Promise<void> }> = [
  {
    name: '1 own session note (updated_at on the open row)',
    save: async (client, org, athleteId, _coach, at, tag) => {
      await client.query(
        `update pilot.sessions set notes = 'shared', updated_at = $3::timestamptz where organization_id = $1 and session_id = $2`,
        [org, `sess-${tag}`, at],
      );
    },
  },
  {
    name: '2 wellness check-in',
    save: async (client, org, athleteId, _coach, at, tag) => {
      await client.query(
        `insert into pilot.athlete_check_ins (organization_id, check_in_id, athlete_id, checked_in_on, created_at)
         values ($1, $2, $3, $4::date, $5::timestamptz)`,
        [org, `chk-${tag}`, athleteId, at.toISOString().slice(0, 10), at],
      );
    },
  },
  {
    name: '3 drill completion',
    save: async (client, org, athleteId, coach, at, tag) => {
      await client.query(
        `insert into pilot.progression_gaps (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
         values ($1, $2, $3, $4, 'technique', 'jab', 'coach')`,
        [`gap-${tag}`, org, athleteId, coach],
      );
      await client.query(
        `insert into pilot.drill_assignments (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id, drill_name, drill_description)
         values ($1, $2, $3, $4, $5, 'Jab ladder', 'ten rounds')`,
        [`asg-${tag}`, org, `gap-${tag}`, athleteId, coach],
      );
      await client.query(
        `insert into pilot.assignment_completions (completion_id, organization_id, assignment_id, athlete_id, completed_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5::timestamptz - interval '3 minutes', $5::timestamptz, $5::timestamptz)`,
        [`cmp-${tag}`, org, `asg-${tag}`, athleteId, at],
      );
    },
  },
  {
    name: '4 training attempt',
    save: async (client, org, athleteId, coach, at, tag) => {
      await client.query(
        `insert into pilot.training_attempts
           (organization_id, attempt_id, athlete_id, metric_kind, achieved_value, attempted_at, recorded_by_account_id, created_at)
         values ($1, $2, $3, 'reps', 12, $4::timestamptz - interval '3 minutes', $5, $4::timestamptz)`,
        [org, `att-${tag}`, athleteId, at, coach],
      );
    },
  },
  {
    name: '5 pain report / observation',
    save: async (client, org, athleteId, _coach, at, tag) => {
      await client.query(
        `insert into pilot.shadow_formula_observations
           (observation_id, organization_id, athlete_id, context_id, observation_kind, unit, observed_at,
            source_type, source_quality, source_reference_id, idempotency_key, created_at)
         values ($1, $2, $3, 'ctx', 'pain_report', 'score', $4::timestamptz - interval '3 minutes', 'athlete', 'moderate', 'ref', $1, $4::timestamptz)`,
        [`obs-${tag}`, org, athleteId, at],
      );
    },
  },
  {
    name: '6 class check-in',
    save: async (client, org, athleteId, coach, at, tag) => {
      await client.query(
        `insert into pilot.scheduler_classes
           (organization_id, class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id, coach_account_id, status)
         values ($1, $2, 'Open floor', $3::timestamptz, $3::timestamptz + interval '1 hour', 'Gym', 20, $4, $4, 'open')`,
        [org, `cls-${tag}`, at, coach],
      );
      await client.query(
        `insert into pilot.scheduler_attendance
           (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role, checked_in_by_account_id, checked_in_at, updated_at)
         values ($1, $2, $3, $4, 'present', 'self', 'athlete', $4, $5::timestamptz - interval '3 minutes', $5::timestamptz)`,
        [org, `atd-${tag}`, `cls-${tag}`, athleteId, at],
      );
    },
  },
  {
    name: '7 coach note on the athlete',
    save: async (client, org, athleteId, coach, at) => {
      await client.query(
        `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text, created_at, updated_at)
         values ($1, gen_random_uuid(), $2, $3, 'technique', 'good guard', $4::timestamptz, $4::timestamptz)`,
        [org, athleteId, coach, at],
      );
    },
  },
  {
    name: '8 any audited write naming the athlete',
    save: async (client, org, athleteId, coach, at, tag) => {
      await client.query(
        `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details, created_at)
         values ('update', $1, 'coach', $2, 'goal', $3, jsonb_build_object('athlete_id', $4::text), $5::timestamptz)`,
        [coach, org, `goal-${tag}`, athleteId, at],
      );
    },
  },
];

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
  migrationSql = await Promise.all(MIGRATIONS.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')));
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

describe('each ruled activity signal keeps the session open, then dates its close', () => {
  test.each(SIGNALS.map((signal, index) => [signal.name, signal, index] as const))(
    '%s',
    async (_name, signal, index) => {
      const tag = `sig${index + 1}`;
      const client = await freshDatabase(`autoclose_${tag}`);
      try {
        // Checked in 45 minutes ago; the signal was saved 10 minutes ago.
        const checkedInAt = minutesBefore(45);
        const signalAt = minutesBefore(10);
        await checkIn(client, ORG_A, ATHLETE_A1, `sess-${tag}`, checkedInAt);
        await signal.save(client, ORG_A, ATHLETE_A1, COACH_A, signalAt, tag);

        // 45 minutes since check-in, but only 10 since the signal: open.
        expect(await findInactiveSessions(ORG_A, { now: NOW })).toEqual([]);
        expect(await closeInactiveSessions(ORG_A, { now: NOW, trigger: 'sessions_list' })).toEqual([]);
        expectOpen(await readSession(client, ORG_A, `sess-${tag}`));

        // 20 minutes after the signal: closed, dated from the SIGNAL, not the check-in.
        const later = minutesAfter(WINDOW, signalAt);
        const closed = await closeInactiveSessions(ORG_A, { now: later, trigger: 'sessions_list' });
        expect(closed.map((row) => row.session_id)).toEqual([`sess-${tag}`]);
        expectAutoClosed(await readSession(client, ORG_A, `sess-${tag}`), signalAt);
      } finally {
        await client.end();
      }
    },
  );
});

describe('the window', () => {
  test('with no signal the session closes at exactly 20 minutes from check-in, not a second earlier', async () => {
    const client = await freshDatabase('autoclose_window');
    try {
      const checkedInAt = minutesBefore(WINDOW);
      await checkIn(client, ORG_A, ATHLETE_A1, 'sess-w', checkedInAt);

      const oneSecondEarly = new Date(NOW.getTime() - 1000);
      expect(await closeInactiveSessions(ORG_A, { now: oneSecondEarly, trigger: 'scheduled' })).toEqual([]);
      expectOpen(await readSession(client, ORG_A, 'sess-w'));

      const closed = await closeInactiveSessions(ORG_A, { now: NOW, trigger: 'scheduled' });
      expect(closed).toHaveLength(1);
      const row = await readSession(client, ORG_A, 'sess-w');
      expectAutoClosed(row, checkedInAt);
      // B1: the stored span is check-in to last activity (zero here), and the
      // close instant is 20 minutes later. Both stay on the row.
      expect(row.checked_out_at?.toISOString()).toBe(NOW.toISOString());
      expect(row.updated_at.toISOString()).toBe(NOW.toISOString());
    } finally {
      await client.end();
    }
  });

  test('a future-dated save never closes before 20 minutes after its stamp, and the row never claims a future close', async () => {
    const client = await freshDatabase('autoclose_future');
    try {
      // A note published with a client clock 10 hours ahead.
      await checkIn(client, ORG_A, ATHLETE_A1, 'sess-f', minutesBefore(60));
      const futureStamp = minutesAfter(600);
      await client.query(
        `update pilot.sessions set updated_at = $3::timestamptz where organization_id = $1 and session_id = $2`,
        [ORG_A, 'sess-f', futureStamp],
      );
      // Capped at the sweep's own clock, the signal reads "just now" on every
      // sweep until the stamp is past, so the session stays open...
      expect(await closeInactiveSessions(ORG_A, { now: NOW, trigger: 'scheduled' })).toEqual([]);
      expect(await closeInactiveSessions(ORG_A, { now: minutesAfter(600 + WINDOW - 1), trigger: 'scheduled' })).toEqual([]);
      // ...and closes 20 minutes after the stamp, with nothing on the row
      // later than the sweep that wrote it.
      const sweepAt = minutesAfter(600 + WINDOW);
      expect(await closeInactiveSessions(ORG_A, { now: sweepAt, trigger: 'scheduled' })).toHaveLength(1);
      const row = await readSession(client, ORG_A, 'sess-f');
      expectAutoClosed(row, futureStamp);
      expect(row.checked_out_at!.getTime()).toBeLessThanOrEqual(sweepAt.getTime());
    } finally {
      await client.end();
    }
  });

  test('the window must be an integer within the migration CHECK', async () => {
    await expect(findInactiveSessions(ORG_A, { windowMinutes: 0 })).rejects.toThrow('INVALID_INACTIVITY_WINDOW');
    await expect(findInactiveSessions(ORG_A, { windowMinutes: 1441 })).rejects.toThrow('INVALID_INACTIVITY_WINDOW');
    await expect(findInactiveSessions(ORG_A, { windowMinutes: 2.5 })).rejects.toThrow('INVALID_INACTIVITY_WINDOW');
  });
});

describe('what the sweep leaves alone', () => {
  test('a manual close is never overwritten; the typed minutes survive; another organization is not swept', async () => {
    const client = await freshDatabase('autoclose_leave');
    try {
      // A1: stale and open, with typed minutes from an earlier (odd) write.
      await checkIn(client, ORG_A, ATHLETE_A1, 'sess-stale', minutesBefore(90), { duration_minutes: 55 });
      // A2: checked out by the athlete an hour ago.
      await checkIn(client, ORG_A, ATHLETE_A2, 'sess-manual', minutesBefore(90));
      await client.query(
        `update pilot.sessions set completed_flag = true, checked_out_at = $3::timestamptz, close_method = 'athlete_check_out', duration_minutes = 40
          where organization_id = $1 and session_id = $2`,
        [ORG_A, 'sess-manual', minutesBefore(60)],
      );
      // B1: just as stale, in the other organization.
      await checkIn(client, ORG_B, ATHLETE_B1, 'sess-other-org', minutesBefore(90));

      const closed = await closeInactiveSessions(ORG_A, { now: NOW, trigger: 'sessions_list' });
      expect(closed.map((row) => row.session_id)).toEqual(['sess-stale']);

      const stale = await readSession(client, ORG_A, 'sess-stale');
      expectAutoClosed(stale, minutesBefore(90));
      expect(stale.duration_minutes).toBe(55);

      const manual = await readSession(client, ORG_A, 'sess-manual');
      expect(manual.close_method).toBe('athlete_check_out');
      expect(manual.checked_out_at?.toISOString()).toBe(minutesBefore(60).toISOString());
      expect(manual.last_activity_at).toBeNull();
      expect(manual.duration_minutes).toBe(40);

      expectOpen(await readSession(client, ORG_B, 'sess-other-org'));
      expect(await autoCloseAuditRows(client, ORG_B, 'sess-other-org')).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a second sweep finds nothing: one close, one audit row, ever', async () => {
    const client = await freshDatabase('autoclose_once');
    try {
      await checkIn(client, ORG_A, ATHLETE_A1, 'sess-once', minutesBefore(30));
      expect(await closeInactiveSessions(ORG_A, { now: NOW, trigger: 'scheduled' })).toHaveLength(1);
      expect(await closeInactiveSessions(ORG_A, { now: NOW, trigger: 'scheduled' })).toEqual([]);
      expect(await closeInactiveSessions(ORG_A, { now: minutesAfter(120), trigger: 'sessions_list' })).toEqual([]);

      const audits = await autoCloseAuditRows(client, ORG_A, 'sess-once');
      expect(audits).toHaveLength(1);
      expect(audits[0].actor_account_id).toBeNull();
      expect(audits[0].actor_role).toBeNull();
      expect(audits[0].details).toEqual({
        athlete_id: ATHLETE_A1,
        close_method: 'auto_inactivity',
        trigger: 'scheduled',
        inactivity_minutes: WINDOW,
        last_activity_at: minutesBefore(30).toISOString(),
        checked_out_at: minutesBefore(10).toISOString(),
      });
    } finally {
      await client.end();
    }
  });

  test('a reopened row is swept afresh from its new activity', async () => {
    const client = await freshDatabase('autoclose_reopen');
    try {
      const checkedInAt = minutesBefore(60);
      await checkIn(client, ORG_A, ATHLETE_A1, 'sess-re', checkedInAt);
      expect(await closeInactiveSessions(ORG_A, { now: NOW, trigger: 'scheduled' })).toHaveLength(1);
      // The close's own audit row names the athlete (signal 8) and carries
      // the server's real clock, which is nowhere near this test's pinned
      // timeline. Re-stamp it to the sweep that wrote it so the rest of the
      // test reads as the production timeline would.
      await client.query(
        `update pilot.audit_events set created_at = $2::timestamptz where organization_id = $1 and details->>'close_method' = 'auto_inactivity'`,
        [ORG_A, NOW],
      );

      // The athlete reopens it (completed_flag back to false) through the
      // store, which clears the close record; that write is itself activity.
      const reopenedAt = minutesAfter(5);
      await upsertSession(
        ORG_A,
        {
          session_id: 'sess-re',
          athlete_id: ATHLETE_A1,
          date: checkedInAt.toISOString().slice(0, 10),
          rpe: null,
          rpe_method: 'UNKNOWN',
          notes: 'back',
          completed_flag: false,
          created_at: checkedInAt.toISOString(),
          updated_at: reopenedAt.toISOString(),
        },
        { mode: 'update', expectedAthleteId: ATHLETE_A1, noteWriter: true },
        { closedBy: 'athlete' },
      );
      const reopened = await readSession(client, ORG_A, 'sess-re');
      expectOpen(reopened);
      expect(reopened.last_activity_at).toBeNull();
      expect(reopened.inactivity_minutes).toBeNull();

      expect(await closeInactiveSessions(ORG_A, { now: minutesAfter(10), trigger: 'scheduled' })).toEqual([]);
      expect(await closeInactiveSessions(ORG_A, { now: minutesAfter(5 + WINDOW), trigger: 'scheduled' })).toHaveLength(1);
      expectAutoClosed(await readSession(client, ORG_A, 'sess-re'), reopenedAt);
      expect(await autoCloseAuditRows(client, ORG_A, 'sess-re')).toHaveLength(2);
    } finally {
      await client.end();
    }
  });

  test('the scheduled run covers every organization: dry run counts, apply closes, and the summary carries no ids', async () => {
    const client = await freshDatabase('autoclose_scheduled');
    try {
      await checkIn(client, ORG_A, ATHLETE_A1, 'sess-s1', minutesBefore(40));
      await checkIn(client, ORG_A, ATHLETE_A2, 'sess-s2', minutesBefore(5));
      await checkIn(client, ORG_B, ATHLETE_B1, 'sess-s3', minutesBefore(25));

      const dry = await runAutoCloseSweep({ apply: false, now: NOW });
      expect(dry).toEqual({
        mode: 'dry_run',
        window_minutes: WINDOW,
        organizations: 2,
        sessions: 2,
        per_organization: [
          { organization_id: ORG_A, sessions: 1 },
          { organization_id: ORG_B, sessions: 1 },
        ],
      });
      expectOpen(await readSession(client, ORG_A, 'sess-s1'));
      expectOpen(await readSession(client, ORG_B, 'sess-s3'));

      const applied = await runAutoCloseSweep({ apply: true, now: NOW });
      expect(applied).toEqual({ ...dry, mode: 'applied' });
      expect(JSON.stringify(applied)).not.toMatch(/sess-|ath-/);
      expectAutoClosed(await readSession(client, ORG_A, 'sess-s1'), minutesBefore(40));
      expectAutoClosed(await readSession(client, ORG_B, 'sess-s3'), minutesBefore(25));
      expectOpen(await readSession(client, ORG_A, 'sess-s2'));
      expect((await autoCloseAuditRows(client, ORG_B, 'sess-s3'))[0]?.details).toMatchObject({ trigger: 'scheduled' });

      expect(await runAutoCloseSweep({ apply: true, now: NOW })).toMatchObject({ sessions: 0 });
    } finally {
      await client.end();
    }
  });

  test('the dry run names exactly what the write then closes', async () => {
    const client = await freshDatabase('autoclose_dryrun');
    try {
      await checkIn(client, ORG_A, ATHLETE_A1, 'sess-d1', minutesBefore(40));
      await checkIn(client, ORG_A, ATHLETE_A2, 'sess-d2', minutesBefore(5));

      const preview = await findInactiveSessions(ORG_A, { now: NOW });
      expect(preview.map((row) => row.session_id)).toEqual(['sess-d1']);
      expectOpen(await readSession(client, ORG_A, 'sess-d1'));

      const closed = await closeInactiveSessions(ORG_A, { now: NOW, trigger: 'scheduled' });
      expect(closed.map((row) => [row.session_id, row.last_activity_at.toISOString()])).toEqual(
        preview.map((row) => [row.session_id, row.last_activity_at.toISOString()]),
      );
      expectOpen(await readSession(client, ORG_A, 'sess-d2'));
    } finally {
      await client.end();
    }
  });
});
