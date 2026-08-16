// Real PostgreSQL-backed contract test for the attendance-precedence
// migration (CT-13).
//
// What needs proving that reading SQL cannot prove:
//
//   1. The view returns EXACTLY ONE row per athlete-day even when all three
//      source tables hold a row for that day. This is the whole ticket.
//   2. An athlete at two classes on one day is ONE attended day, not two --
//      the specific double-count CT-13 was filed about.
//   3. pilot.attendance's duplicate athlete-days (it has no unique constraint,
//      which is the underlying defect) collapse to one row.
//   4. Precedence actually holds: activity_log beats scheduler_attendance
//      beats attendance, and lower sources are never ADDED to the winner.
//   5. The scheduler day is resolved in the gym's timezone -- a class at 8pm
//      ET is that day, not the next one in UTC.
//   6. The migration re-applies as a no-op and neither legacy table loses a
//      single row.
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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-attendance-precedence-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_attendance_precedence_migration.sql';

const ORG_ID = 'org-attend';
const ADMIN_ID = 'acct-attend-admin';
const COACH_ID = 'acct-attend-coach';
const ATHLETE_ID = 'ath-attend-1';
const ATHLETE_TWO = 'ath-attend-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let activityLogSql: string;
let baseSchemaSql: string;

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
  await client.query(activityLogSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, 'organization_admin', $2, 'microsoft', true), ($3, 'coach', $2, 'microsoft', true)
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID],
  );
  for (const athleteId of [ATHLETE_ID, ATHLETE_TWO]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, '2012-01-01', '100', 'active', 'contact', true, $4, now(), now())
       on conflict do nothing`,
      [ORG_ID, athleteId, `Athlete ${athleteId}`, COACH_ID],
    );
  }
  await client.query(migrationSql);
  return client;
}

/** A class on a given gym-local day at a given gym-local hour. */
async function addClass(
  client: Client,
  classId: string,
  localDate: string,
  localTime = '17:00',
): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity,
        scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, $3,
             ($4 || ' ' || $5)::timestamp at time zone 'America/New_York',
             ($4 || ' ' || $5)::timestamp at time zone 'America/New_York' + interval '1 hour',
             'Main floor', 20, $6, $6, 'open')`,
    [ORG_ID, classId, `Class ${classId}`, localDate, localTime, COACH_ID],
  );
}

async function markClass(
  client: Client,
  classId: string,
  athleteId: string,
  status: 'present' | 'absent' | 'excused',
): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method,
        checked_in_by_role, checked_in_by_account_id, checked_in_at)
     values ($1, $2, $3, $4, $5, 'coach_override', 'coach', $6, now())`,
    [ORG_ID, `sa-${classId}-${athleteId}`, classId, athleteId, status, COACH_ID],
  );
}

async function addLegacyAttendance(
  client: Client,
  athleteId: string,
  date: string,
  status: string,
): Promise<void> {
  await client.query(
    `insert into pilot.attendance (organization_id, attendance_id, athlete_id, attendance_date, status)
     values ($1, gen_random_uuid(), $2, $3::date, $4)`,
    [ORG_ID, athleteId, date, status],
  );
}

async function addActivityLog(
  client: Client,
  athleteId: string,
  occurredOn: string,
  status: 'present' | 'absent' | 'excused',
  domain = 'boxing_training',
): Promise<void> {
  await client.query(
    `insert into pilot.activity_log
       (organization_id, activity_id, person_account_id, athlete_id, activity_domain,
        activity_type, occurred_on, duration_minutes, attendance_status, capture_method,
        recorded_by_role, recorded_by_account_id)
     values ($1, $2, $3, $4, $5, 'technical_session', $6::date, 60, $7, 'coach_override',
             'coach', $3)`,
    [ORG_ID, `al-${athleteId}-${occurredOn}-${domain}`, COACH_ID, athleteId, domain, occurredOn, status],
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
  activityLogSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_activity_log_migration.sql'),
    'utf8',
  );
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

describe('attendance precedence view', () => {
  test('THE TICKET: two classes on one day is ONE attended day, not two', async () => {
    const client = await freshDatabase('attend_two_classes');
    try {
      await addClass(client, 'c-morning', '2026-03-10', '09:00');
      await addClass(client, 'c-evening', '2026-03-10', '18:00');
      await markClass(client, 'c-morning', ATHLETE_ID, 'present');
      await markClass(client, 'c-evening', ATHLETE_ID, 'present');

      // Two class marks exist...
      const rawMarks = await client.query(
        `select count(*)::int as n from pilot.scheduler_attendance
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(rawMarks.rows[0].n).toBe(2);

      // ...and they are ONE attended day.
      const reconciled = await client.query(
        `select attendance_date::text as attendance_date, status, source, class_marks_that_day
         from pilot.attendance_reconciled
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(reconciled.rows).toEqual([{
        attendance_date: '2026-03-10',
        status: 'present',
        source: 'scheduler_attendance',
        class_marks_that_day: 2,
      }]);
    } finally {
      await client.end();
    }
  });

  test('all three sources on one day still yields exactly one row, and the highest wins outright', async () => {
    const client = await freshDatabase('attend_all_three');
    try {
      await addClass(client, 'c-1', '2026-03-11', '17:00');
      await markClass(client, 'c-1', ATHLETE_ID, 'absent');
      await addLegacyAttendance(client, ATHLETE_ID, '2026-03-11', 'absent');
      await addActivityLog(client, ATHLETE_ID, '2026-03-11', 'present');

      const rows = await client.query(
        `select status, source, contributing_sources
         from pilot.attendance_reconciled
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );

      // One row, not three. activity_log wins; the other two are NOT added.
      expect(rows.rows).toEqual([{
        status: 'present',
        source: 'activity_log',
        contributing_sources: 3,
      }]);
    } finally {
      await client.end();
    }
  });

  test('duplicate rows in pilot.attendance -- the table with no unique constraint -- collapse to one day', async () => {
    const client = await freshDatabase('attend_legacy_dupes');
    try {
      // The underlying defect: nothing stops this.
      await addLegacyAttendance(client, ATHLETE_ID, '2026-03-12', 'present');
      await addLegacyAttendance(client, ATHLETE_ID, '2026-03-12', 'present');
      await addLegacyAttendance(client, ATHLETE_ID, '2026-03-12', 'Present');

      const raw = await client.query(
        `select count(*)::int as n from pilot.attendance
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(raw.rows[0].n).toBe(3);

      const rows = await client.query(
        `select attendance_date::text as attendance_date, status, source
         from pilot.attendance_reconciled
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );
      // Three rows in, one day out -- and mixed-case 'Present' still reads as present.
      expect(rows.rows).toEqual([{
        attendance_date: '2026-03-12',
        status: 'present',
        source: 'attendance',
      }]);
    } finally {
      await client.end();
    }
  });

  test('legacy "late" counts as a day attended; an unknown status never becomes a presence claim', async () => {
    const client = await freshDatabase('attend_legacy_vocab');
    try {
      await addLegacyAttendance(client, ATHLETE_ID, '2026-03-13', 'late');
      await addLegacyAttendance(client, ATHLETE_TWO, '2026-03-13', 'whatever-someone-typed');

      const rows = await client.query(
        `select athlete_id, status from pilot.attendance_reconciled
         where organization_id = $1 order by athlete_id`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([
        { athlete_id: ATHLETE_ID, status: 'present' },
        { athlete_id: ATHLETE_TWO, status: 'absent' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a late-evening class belongs to its gym-local day, not the next UTC day', async () => {
    const client = await freshDatabase('attend_timezone');
    try {
      // 20:00 America/New_York on 2026-03-14 is 00:00 UTC on 2026-03-15.
      // Taking ::date in UTC would file this under the 15th.
      await addClass(client, 'c-late', '2026-03-14', '20:00');
      await markClass(client, 'c-late', ATHLETE_ID, 'present');

      const rows = await client.query(
        `select attendance_date::text as attendance_date
         from pilot.attendance_reconciled
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(rows.rows).toEqual([{ attendance_date: '2026-03-14' }]);
    } finally {
      await client.end();
    }
  });

  test('non-boxing activity_log domains never enter attendance through this door', async () => {
    const client = await freshDatabase('attend_domains');
    try {
      // Community service is real recorded hours, but it is not gym attendance.
      // Verifier columns are required for that domain by the table's own check.
      await client.query(
        `insert into pilot.activity_log
           (organization_id, activity_id, person_account_id, athlete_id, activity_domain,
            activity_type, occurred_on, duration_minutes, attendance_status, capture_method,
            recorded_by_role, recorded_by_account_id, verified_by_account_id, verified_at)
         values ($1, 'al-service', $2, $3, 'community_service', 'cleanup', '2026-03-15'::date,
                 120, 'present', 'supervisor_entry', 'coach', $2, $2, now())`,
        [ORG_ID, COACH_ID, ATHLETE_ID],
      );

      const rows = await client.query(
        `select count(*)::int as n from pilot.attendance_reconciled
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('one row per athlete-day holds across a mixed multi-athlete, multi-day set', async () => {
    const client = await freshDatabase('attend_invariant');
    try {
      await addClass(client, 'c-a', '2026-03-16', '09:00');
      await addClass(client, 'c-b', '2026-03-16', '18:00');
      await addClass(client, 'c-c', '2026-03-17', '17:00');

      for (const athleteId of [ATHLETE_ID, ATHLETE_TWO]) {
        await markClass(client, 'c-a', athleteId, 'present');
        await markClass(client, 'c-b', athleteId, 'present');
        await markClass(client, 'c-c', athleteId, 'absent');
        await addLegacyAttendance(client, athleteId, '2026-03-16', 'present');
        await addLegacyAttendance(client, athleteId, '2026-03-16', 'present');
      }
      await addActivityLog(client, ATHLETE_ID, '2026-03-17', 'present');

      // The invariant the whole ticket reduces to.
      const dupes = await client.query(
        `select organization_id, athlete_id, attendance_date, count(*)::int as n
         from pilot.attendance_reconciled
         group by organization_id, athlete_id, attendance_date
         having count(*) > 1`,
      );
      expect(dupes.rows).toEqual([]);

      // Athlete one: 16th present via scheduler, 17th present via activity_log
      // (which outranks the scheduler's 'absent' mark for that day).
      const one = await client.query(
        `select attendance_date::text as attendance_date, status, source
         from pilot.attendance_reconciled
         where organization_id = $1 and athlete_id = $2
         order by attendance_date`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(one.rows).toEqual([
        { attendance_date: '2026-03-16', status: 'present', source: 'scheduler_attendance' },
        { attendance_date: '2026-03-17', status: 'present', source: 'activity_log' },
      ]);

      // Athlete two has no activity_log row, so the scheduler's absent stands.
      const two = await client.query(
        `select attendance_date::text as attendance_date, status, source
         from pilot.attendance_reconciled
         where organization_id = $1 and athlete_id = $2
         order by attendance_date`,
        [ORG_ID, ATHLETE_TWO],
      );
      expect(two.rows).toEqual([
        { attendance_date: '2026-03-16', status: 'present', source: 'scheduler_attendance' },
        { attendance_date: '2026-03-17', status: 'absent', source: 'scheduler_attendance' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('re-applying the migration is a no-op and neither legacy table loses a row', async () => {
    const client = await freshDatabase('attend_reapply');
    try {
      await addClass(client, 'c-1', '2026-03-18', '17:00');
      await markClass(client, 'c-1', ATHLETE_ID, 'present');
      await addLegacyAttendance(client, ATHLETE_ID, '2026-03-18', 'present');

      const before = await client.query(
        `select
           (select count(*)::int from pilot.attendance) as legacy_rows,
           (select count(*)::int from pilot.scheduler_attendance) as scheduler_rows`,
      );

      await client.query(migrationSql);
      await client.query(migrationSql);

      const after = await client.query(
        `select
           (select count(*)::int from pilot.attendance) as legacy_rows,
           (select count(*)::int from pilot.scheduler_attendance) as scheduler_rows`,
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect(after.rows[0].legacy_rows).toBe(1);
      expect(after.rows[0].scheduler_rows).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('pilot.attendance still accepts duplicate athlete-days -- no constraint was retrofitted', async () => {
    const client = await freshDatabase('attend_no_retrofit');
    try {
      // Deliberate. Adding a unique index would fail against real production
      // duplicates and could only be made to pass by deleting real records.
      // The view de-duplicates on read; the table is left exactly as it was.
      await addLegacyAttendance(client, ATHLETE_ID, '2026-03-19', 'present');
      await expect(
        addLegacyAttendance(client, ATHLETE_ID, '2026-03-19', 'present'),
      ).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });
});
