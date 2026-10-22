// Real PostgreSQL-backed suite for D4 (OD-2026-10-21-002; details OD-2026-10-21-004): a live
// session tied to the scheduled class it is running, so a "here" tap also writes the class register
// (sessionRunClass.ts, sessionScriptRuns.ts start, sessionRunAthletes.ts setRunAthletePresent, the
// register statements in schedulerDb.ts).
//
// What needs a real database to prove:
//
// 1. TIE AT START. Only today's class (the gym's day), not cancelled, that the coach teaches,
//    schedules or covers (an organization admin: any); one live session per class. Every refusal
//    starts nothing.
// 2. A TAP ON A TIED SESSION. No register mark: Present (coach_override / admin_override, walk_in
//    if not signed up), and the session mark records which mark it created. Present already:
//    nothing. Absent or Excused: Present, and the previous status is returned (ruling 1). Class
//    cancelled since, or the coach no longer runs it: the session mark stands, the register is
//    skipped. A standing mark tapped again writes nothing, so a later register change wins.
// 3. AN UNTAP removes the register mark the tap created only if nobody changed it since, audited
//    (ruling 2); otherwise the mark stays. A flip is not undone.
// 4. ONE TRANSACTION: a register write that fails takes the session mark with it; a register
//    write held open elsewhere is waited for and answered by its committed status.
// 5. The per-day attendance view counts a tied tap once; an untied session writes no register
//    (OD-2026-10-13-016); a family check-in after the tap does not change the staff mark.
// 6. TIE OR UNTIE WHILE LIVE: tying copies the standing marks under the same rules; every
//    refusal changes nothing; untying keeps the register marks and lets go of them.
// 7. THE NO-SHOWS TAP (ruling 3) marks Absent exactly the signed-up athletes with no register mark
//    and no standing session mark, only when the coach asks, never on an untied session.
// 8. Today's classes for the start picker: the caller's own, not cancelled, today only.
//
// Spins up the same disposable, local-only embedded Postgres the other suites use. It NEVER
// connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
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

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

let activeClient: Client | null = null;
let activeConnectionString: string | null = null;

// Each transaction on a connection of its own, with a real BEGIN/COMMIT: the locking cases below
// need two transactions that can wait on each other.
jest.mock('./db', () => ({
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeConnectionString) throw new Error('test bug: no active embedded database');
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
import { ATTENDANCE_UPSERT_SQL, FAMILY_ATTENDANCE_UPSERT_SQL, attendanceUpsertParams } from './schedulerDb';
import { setRunAthletePresent } from './sessionRunAthletes';
import { describeRunClass, listTieableClasses, markSessionNoShowsAbsent, setSessionRunClass } from './sessionRunClass';
import { startSessionScriptRun } from './sessionScriptRuns';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-run-class-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_d4_session_class';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let client: Client;
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

interface Gym {
  organizationId: string;
  coach: ActorIdentity;
  otherCoach: ActorIdentity;
  admin: ActorIdentity;
  /** Today's class: taught by the coach; Ada and Ben signed up, Cy not. */
  klass: string;
  ada: string;
  ben: string;
  cy: string;
}

function actor(organizationId: string, accountId: string, role: PilotRole): ActorIdentity {
  return { organizationId, accountId, role, athleteId: null };
}

/** Today's class unless `startSql` says otherwise, taught by `coachId`. */
async function addClass(organizationId: string, classId: string, coachId: string, startSql = 'now()', status = 'open') {
  await client.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity,
        scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, 'Youth boxing', ${startSql}, ${startSql} + interval '1 hour', 'Main floor', 20, $3, $3, $4)`,
    [organizationId, classId, coachId, status],
  );
}

/** Two coaches and an organization admin, three athletes, today's class with two sign-ups. */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-d4-${label}-${gymCount}`;
  const coachId = `coach@${organizationId}`;
  const otherCoachId = `coach2@${organizationId}`;
  const adminId = `admin@${organizationId}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  for (const [accountId, role] of [[coachId, 'coach'], [otherCoachId, 'coach'], [adminId, 'organization_admin']]) {
    await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, $2, $3)`, [accountId, role, organizationId]);
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)`,
      [accountId, organizationId, role],
    );
  }
  for (const [athleteId, name] of [['athlete-ada', 'Ada Reyes'], ['athlete-ben', 'Ben Ortiz'], ['athlete-cy', 'Cy Marsh']]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1, $2, $3, '2012-01-01', '100', 'active', 'contact', true, $4, now(), now())`,
      [organizationId, athleteId, name, coachId],
    );
  }
  const klass = 'class-today';
  await addClass(organizationId, klass, coachId);
  for (const athleteId of ['athlete-ada', 'athlete-ben']) {
    await client.query(
      `insert into pilot.scheduler_registrations
         (organization_id, registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id, status)
       values ($1, $2, $3, $4, 'coach', $5, 'registered')`,
      [organizationId, `reg-${athleteId}`, klass, athleteId, coachId],
    );
  }
  return {
    organizationId,
    coach: actor(organizationId, coachId, 'coach'),
    otherCoach: actor(organizationId, otherCoachId, 'coach'),
    admin: actor(organizationId, adminId, 'organization_admin'),
    klass,
    ada: 'athlete-ada',
    ben: 'athlete-ben',
    cy: 'athlete-cy',
  };
}

function start(gym: Gym, by: ActorIdentity, classId: string | null = gym.klass) {
  return startSessionScriptRun(gym.organizationId, by.accountId, { classId, actorRole: by.role });
}

function tap(by: ActorIdentity, runId: string, athleteId: string, present = true) {
  return setRunAthletePresent({ actor: by, runId, athleteId, present });
}

/** The register row for one athlete in the gym's class, or undefined. */
async function register(gym: Gym, athleteId: string, classId = gym.klass) {
  const { rows } = await client.query(
    `select status, method, checked_in_by_role as role, checked_in_by_account_id as by, note, updated_at::text as updated_at
       from pilot.scheduler_attendance where organization_id = $1 and class_id = $2 and athlete_id = $3`,
    [gym.organizationId, classId, athleteId],
  );
  return rows[0] as { status: string; method: string; role: string; by: string; note: string; updated_at: string } | undefined;
}

async function pointer(gym: Gym, runId: string, athleteId: string) {
  const { rows } = await client.query(
    `select register_class_id, register_written_at::text as written_at, removed_at is not null as removed
       from pilot.session_run_athletes where organization_id = $1 and run_id = $2 and athlete_id = $3`,
    [gym.organizationId, runId, athleteId],
  );
  return rows[0] as { register_class_id: string | null; written_at: string | null; removed: boolean } | undefined;
}

/** A staff register mark written directly, as the scheduler's register tap would. */
async function staffMark(gym: Gym, athleteId: string, status: string, method = 'coach_override', note = '') {
  await client.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role,
        checked_in_by_account_id, note, checked_in_at, updated_at)
     values ($1, gen_random_uuid()::text, $2, $3, $4, $5, $6, $7, $8, now(), now())
     on conflict (organization_id, class_id, athlete_id) do update
       set status = excluded.status, method = excluded.method, checked_in_by_role = excluded.checked_in_by_role,
           checked_in_by_account_id = excluded.checked_in_by_account_id, note = excluded.note,
           updated_at = clock_timestamp()`,
    [gym.organizationId, gym.klass, athleteId, status, method, method === 'self' ? 'athlete' : 'coach',
      method === 'self' ? athleteId : gym.otherCoach.accountId, note],
  );
}

async function registerAudit(gym: Gym) {
  const { rows } = await client.query<{ event_type: string; entity_id: string; details: Record<string, unknown> }>(
    `select event_type, entity_id, details from pilot.audit_events
      where organization_id = $1 and entity_type = 'scheduler_attendance' order by audit_id`,
    [gym.organizationId],
  );
  return rows;
}

async function refusal(action: Promise<unknown>): Promise<{ name: string; message: string; status?: number }> {
  const error = await action.then(() => null, (caught: unknown) => caught as { name: string; message: string; status?: number });
  if (!error) throw new Error('expected a refusal, and the call succeeded');
  return { name: error.name, message: error.message, status: error.status };
}

async function liveRuns(gym: Gym) {
  const { rows } = await client.query(
    `select delivered_by_account_id as by, class_id from pilot.session_script_runs
      where organization_id = $1 and run_state = 'in_progress' order by delivered_by_account_id`,
    [gym.organizationId],
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;

  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  await adminClient.query(`drop database if exists ${DATABASE_NAME}`);
  await adminClient.query(`create database ${DATABASE_NAME}`);
  await adminClient.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  // The whole schema production runs, the session-run-class migration included.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  activeClient = client;
  activeConnectionString = connectionStringFor(DATABASE_NAME);
});

afterAll(async () => {
  activeClient = null;
  activeConnectionString = null;
  await client?.end().catch(() => {});
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

describe('tying a session to a class at start', () => {
  test('the class\'s coach ties a plain session to today\'s class; an untied start is unchanged', async () => {
    const gym = await newGym('start');
    const run = await start(gym, gym.coach);
    expect(run.class_id).toBe(gym.klass);
    const untied = await start(gym, gym.otherCoach, null);
    expect(untied.class_id).toBeNull();
  });

  test('refused, starting nothing: another coach\'s class, cancelled, not today, unknown, another gym\'s', async () => {
    const gym = await newGym('refuse');
    const other = await newGym('refuse-other');
    await addClass(gym.organizationId, 'class-cancelled', gym.coach.accountId, 'now()', 'cancelled');
    await addClass(gym.organizationId, 'class-yesterday', gym.coach.accountId, "now() - interval '2 days'");
    await addClass(gym.organizationId, 'class-tomorrow', gym.coach.accountId, "now() + interval '2 days'");
    await addClass(other.organizationId, 'class-other-gym', gym.coach.accountId);

    expect(await refusal(start(gym, gym.otherCoach))).toMatchObject({ message: 'SESSION_CLASS_NOT_YOURS', status: 403 });
    expect(await refusal(start(gym, gym.coach, 'class-cancelled'))).toMatchObject({ message: 'SESSION_CLASS_CANCELLED', status: 409 });
    expect(await refusal(start(gym, gym.coach, 'class-yesterday'))).toMatchObject({ message: 'SESSION_CLASS_NOT_TODAY', status: 409 });
    expect(await refusal(start(gym, gym.coach, 'class-tomorrow'))).toMatchObject({ message: 'SESSION_CLASS_NOT_TODAY', status: 409 });
    expect(await refusal(start(gym, gym.coach, 'no-such-class'))).toMatchObject({ message: 'SESSION_CLASS_NOT_FOUND', status: 404 });
    // A class of another gym, even one naming this coach, is not found from this gym.
    expect(await refusal(start(gym, gym.coach, 'class-other-gym'))).toMatchObject({ message: 'SESSION_CLASS_NOT_FOUND', status: 404 });
    expect(await liveRuns(gym)).toEqual([]);
  });

  test('the cover coach and an organization admin may tie it', async () => {
    const gym = await newGym('cover');
    await client.query(
      `update pilot.scheduler_classes set covering_coach_account_id = $3 where organization_id = $1 and class_id = $2`,
      [gym.organizationId, gym.klass, gym.otherCoach.accountId],
    );
    expect((await start(gym, gym.otherCoach)).class_id).toBe(gym.klass);
    await addClass(gym.organizationId, 'class-admin', gym.coach.accountId);
    expect((await start(gym, gym.admin, 'class-admin')).class_id).toBe('class-admin');
  });

  test('one live session per class: a second is refused, and the class frees up when the first ends', async () => {
    const gym = await newGym('one-live');
    await client.query(
      `update pilot.scheduler_classes set covering_coach_account_id = $3 where organization_id = $1 and class_id = $2`,
      [gym.organizationId, gym.klass, gym.otherCoach.accountId],
    );
    const first = await start(gym, gym.coach);
    expect(await refusal(start(gym, gym.otherCoach))).toMatchObject({ message: 'SESSION_CLASS_ALREADY_LIVE', status: 409 });
    expect(await liveRuns(gym)).toEqual([{ by: gym.coach.accountId, class_id: gym.klass }]);
    await client.query(
      `update pilot.session_script_runs set run_state = 'completed', ended_at = now() where organization_id = $1 and run_id = $2`,
      [gym.organizationId, first.run_id],
    );
    expect((await start(gym, gym.otherCoach)).class_id).toBe(gym.klass);
  });
});

describe('a "here" tap on a tied session writes the class register', () => {
  test('no register mark: Present, by the coach, walk-in when not signed up; the session mark records it', async () => {
    const gym = await newGym('create');
    const { run_id: runId } = await start(gym, gym.coach);

    expect(await tap(gym.coach, runId, gym.ada)).toEqual({ outcome: 'marked', register: { effect: 'created' } });
    expect(await tap(gym.coach, runId, gym.cy)).toEqual({ outcome: 'marked', register: { effect: 'created' } });

    const ada = await register(gym, gym.ada);
    expect(ada).toMatchObject({ status: 'present', method: 'coach_override', role: 'coach', by: gym.coach.accountId, note: '' });
    expect(await register(gym, gym.cy)).toMatchObject({ status: 'present', method: 'walk_in' });
    // The pointer names the class and the register mark's updated_at exactly as written.
    const ptr = await pointer(gym, runId, gym.ada);
    expect(ptr?.register_class_id).toBe(gym.klass);
    expect(new Date(String(ptr?.written_at)).getTime()).toBe(new Date(String(ada?.updated_at)).getTime());
    expect(await registerAudit(gym)).toEqual([
      expect.objectContaining({ event_type: 'create', entity_id: `${gym.klass}:${gym.ada}`,
        details: { via: 'session_run', run_id: runId, class_id: gym.klass, athlete_id: gym.ada, effect: 'created' } }),
      expect.objectContaining({ event_type: 'create', entity_id: `${gym.klass}:${gym.cy}` }),
    ]);
    // Counted once on the per-day view, from the register.
    const day = await client.query(
      `select source from pilot.attendance_reconciled where organization_id = $1 and athlete_id = $2`,
      [gym.organizationId, gym.ada],
    );
    expect(day.rows).toEqual([{ source: 'scheduler_attendance' }]);
  });

  test('an organization admin\'s own tied session marks admin_override', async () => {
    const gym = await newGym('admin');
    const { run_id: runId } = await start(gym, gym.admin);
    expect(await tap(gym.admin, runId, gym.ada)).toEqual({ outcome: 'marked', register: { effect: 'created' } });
    expect(await register(gym, gym.ada)).toMatchObject({ method: 'admin_override', role: 'organization_admin' });
  });

  test('Present already (the athlete\'s own check-in): nothing written; Absent or Excused: Present, and what it was', async () => {
    const gym = await newGym('flip');
    await staffMark(gym, gym.ada, 'present', 'self');
    await staffMark(gym, gym.ben, 'absent', 'coach_override', 'Called in sick');
    await staffMark(gym, gym.cy, 'excused');
    const adaBefore = await register(gym, gym.ada);
    const { run_id: runId } = await start(gym, gym.coach);

    expect(await tap(gym.coach, runId, gym.ada)).toEqual({ outcome: 'marked', register: { effect: 'already_present' } });
    expect(await register(gym, gym.ada)).toEqual(adaBefore);
    expect(await tap(gym.coach, runId, gym.ben)).toEqual({ outcome: 'marked', register: { effect: 'flipped', previous_status: 'absent' } });
    expect(await tap(gym.coach, runId, gym.cy)).toEqual({ outcome: 'marked', register: { effect: 'flipped', previous_status: 'excused' } });
    // Present now, by this coach; the note another coach wrote is kept, never erased unseen.
    expect(await register(gym, gym.ben)).toMatchObject({ status: 'present', method: 'coach_override', by: gym.coach.accountId, note: 'Called in sick' });
    // Neither a flip nor an existing Present is the tap's to undo.
    for (const athlete of [gym.ada, gym.ben, gym.cy]) {
      expect(await pointer(gym, runId, athlete)).toMatchObject({ register_class_id: null, written_at: null });
    }
    // The flips are audited with what they were; nothing was written for Ada.
    expect((await registerAudit(gym)).map((row) => [row.event_type, row.details.effect, row.details.previous_status])).toEqual([
      ['update', 'flipped', 'absent'],
      ['update', 'flipped', 'excused'],
    ]);
  });

  test('a later register change wins: a standing mark tapped again writes nothing', async () => {
    const gym = await newGym('later');
    const { run_id: runId } = await start(gym, gym.coach);
    await tap(gym.coach, runId, gym.ada);
    await staffMark(gym, gym.ada, 'absent');
    expect(await tap(gym.coach, runId, gym.ada)).toEqual({ outcome: 'unchanged' });
    expect(await register(gym, gym.ada)).toMatchObject({ status: 'absent' });
  });

  test('class cancelled since, or the coach no longer runs it: the session mark stands, the register is skipped', async () => {
    const gym = await newGym('skip');
    const { run_id: runId } = await start(gym, gym.coach);
    await client.query(`update pilot.scheduler_classes set status = 'cancelled' where organization_id = $1 and class_id = $2`, [gym.organizationId, gym.klass]);
    expect(await tap(gym.coach, runId, gym.ada)).toEqual({ outcome: 'marked', register: { effect: 'skipped', reason: 'class_cancelled' } });
    await client.query(
      `update pilot.scheduler_classes set status = 'open', coach_account_id = $3, scheduled_by_account_id = $3
        where organization_id = $1 and class_id = $2`,
      [gym.organizationId, gym.klass, gym.otherCoach.accountId],
    );
    expect(await tap(gym.coach, runId, gym.ben)).toEqual({ outcome: 'marked', register: { effect: 'skipped', reason: 'not_your_class' } });
    expect(await register(gym, gym.ada)).toBeUndefined();
    expect(await register(gym, gym.ben)).toBeUndefined();
    expect(await pointer(gym, runId, gym.ada)).toMatchObject({ removed: false, register_class_id: null });
    // Nothing was written, so nothing is audited on the register, and an untap leaves it alone.
    expect(await registerAudit(gym)).toEqual([]);
    expect(await tap(gym.coach, runId, gym.ada, false)).toEqual({ outcome: 'unmarked', register: { effect: 'unchanged' } });
  });

  test('an untied session writes no register (OD-2026-10-13-016)', async () => {
    const gym = await newGym('untied');
    const { run_id: runId } = await start(gym, gym.coach, null);
    expect(await tap(gym.coach, runId, gym.ada)).toEqual({ outcome: 'marked' });
    expect(await register(gym, gym.ada)).toBeUndefined();
  });

  test('a family check-in after the tap does not change the coach\'s mark', async () => {
    const gym = await newGym('family');
    const { run_id: runId } = await start(gym, gym.coach);
    await tap(gym.coach, runId, gym.ada);
    const before = await register(gym, gym.ada);
    const family = await client.query(FAMILY_ATTENDANCE_UPSERT_SQL, [
      gym.organizationId, 'att-family', gym.klass, gym.ada, 'present', 'self', 'athlete', gym.ada, '',
      new Date().toISOString(), new Date().toISOString(),
    ]);
    expect(family.rows).toEqual([]);
    expect(await register(gym, gym.ada)).toEqual(before);
  });
});

describe('an untap on a tied session', () => {
  test('removes the register mark the tap created, if untouched, audited; a re-tap creates it again', async () => {
    const gym = await newGym('undo');
    const { run_id: runId } = await start(gym, gym.coach);
    await tap(gym.coach, runId, gym.ada);
    expect(await tap(gym.coach, runId, gym.ada, false)).toEqual({ outcome: 'unmarked', register: { effect: 'removed' } });
    expect(await register(gym, gym.ada)).toBeUndefined();
    expect(await pointer(gym, runId, gym.ada)).toMatchObject({ removed: true, register_class_id: null, written_at: null });
    expect((await registerAudit(gym)).map((row) => [row.event_type, row.details.effect])).toEqual([
      ['create', 'created'],
      ['update', 'removed'],
    ]);
    expect(await tap(gym.coach, runId, gym.ada)).toEqual({ outcome: 'marked', register: { effect: 'created' } });
    expect((await pointer(gym, runId, gym.ada))?.register_class_id).toBe(gym.klass);
  });

  test('keeps a register mark somebody changed since, and lets go of it', async () => {
    const gym = await newGym('kept');
    const { run_id: runId } = await start(gym, gym.coach);
    await tap(gym.coach, runId, gym.ada);
    await tap(gym.coach, runId, gym.ben);
    // Ada re-marked on the register by another coach; Ben set Absent there.
    await staffMark(gym, gym.ada, 'present');
    await staffMark(gym, gym.ben, 'absent');
    expect(await tap(gym.coach, runId, gym.ada, false)).toEqual({ outcome: 'unmarked', register: { effect: 'kept' } });
    expect(await tap(gym.coach, runId, gym.ben, false)).toEqual({ outcome: 'unmarked', register: { effect: 'kept' } });
    expect(await register(gym, gym.ada)).toMatchObject({ status: 'present', by: gym.otherCoach.accountId });
    expect(await register(gym, gym.ben)).toMatchObject({ status: 'absent' });
    expect(await pointer(gym, runId, gym.ada)).toMatchObject({ register_class_id: null });
  });

  test('does not undo a flip: the register stays Present', async () => {
    const gym = await newGym('flip-undo');
    await staffMark(gym, gym.ada, 'absent');
    const { run_id: runId } = await start(gym, gym.coach);
    await tap(gym.coach, runId, gym.ada);
    expect(await tap(gym.coach, runId, gym.ada, false)).toEqual({ outcome: 'unmarked', register: { effect: 'unchanged' } });
    expect(await register(gym, gym.ada)).toMatchObject({ status: 'present' });
  });

  test('keeps it when the same coach has since re-marked it Present on the register itself', async () => {
    const gym = await newGym('same-coach');
    const { run_id: runId } = await start(gym, gym.coach);
    await tap(gym.coach, runId, gym.ada);
    // The scheduler's own register write, by the same coach, same status and method: only the time moves.
    const later = new Date(Date.now() + 1000).toISOString();
    await client.query(ATTENDANCE_UPSERT_SQL, attendanceUpsertParams(gym.organizationId, [{
      attendance_id: 'att-register-tap', class_id: gym.klass, athlete_id: gym.ada, status: 'present',
      method: 'coach_override', checked_in_by_role: 'coach', checked_in_by_account_id: gym.coach.accountId,
      note: '', checked_in_at: later, updated_at: later,
    }]));
    expect(await tap(gym.coach, runId, gym.ada, false)).toEqual({ outcome: 'unmarked', register: { effect: 'kept' } });
    expect(await register(gym, gym.ada)).toMatchObject({ status: 'present', by: gym.coach.accountId });
  });
});

describe('one transaction', () => {
  test('a register write that fails takes the session mark with it', async () => {
    const gym = await newGym('rollback');
    const { run_id: runId } = await start(gym, gym.coach);
    const name = `d4_refuse_${gymCount}`;
    await client.query(
      `alter table pilot.scheduler_attendance add constraint ${name}
         check (not (organization_id = '${gym.organizationId}' and athlete_id = 'athlete-ada')) not valid`,
    );
    try {
      await expect(tap(gym.coach, runId, gym.ada)).rejects.toThrow(new RegExp(name));
    } finally {
      await client.query(`alter table pilot.scheduler_attendance drop constraint ${name}`);
    }
    expect(await pointer(gym, runId, gym.ada)).toBeUndefined();
    expect(await registerAudit(gym)).toEqual([]);
  });

  test('a register mark being written elsewhere is waited for, then answered by its committed status', async () => {
    const gym = await newGym('race');
    const { run_id: runId } = await start(gym, gym.coach);
    const other = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        `insert into pilot.scheduler_attendance
           (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role,
            checked_in_by_account_id, checked_in_at, updated_at)
         values ($1, 'att-race', $2, $3, 'absent', 'coach_override', 'coach', $4, now(), now())`,
        [gym.organizationId, gym.klass, gym.ada, gym.otherCoach.accountId],
      );
      const tapping = tap(gym.coach, runId, gym.ada);
      const early = await Promise.race([tapping.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 750))]);
      expect(early).toBe('waiting');
      await other.query('COMMIT');
      expect(await tapping).toEqual({ outcome: 'marked', register: { effect: 'flipped', previous_status: 'absent' } });
    } finally {
      await other.query('ROLLBACK').catch(() => {});
      await other.end();
    }
    expect(await register(gym, gym.ada)).toMatchObject({ status: 'present' });
  });
});

describe('tying or untying a live session', () => {
  test('tying mid-session copies the standing marks to the register under the same rules', async () => {
    const gym = await newGym('tie-live');
    await staffMark(gym, gym.ben, 'absent');
    const { run_id: runId } = await start(gym, gym.coach, null);
    await tap(gym.coach, runId, gym.ada);
    await tap(gym.coach, runId, gym.ben);
    expect(await register(gym, gym.ada)).toBeUndefined();

    expect(await setSessionRunClass(gym.coach, runId, gym.klass)).toEqual({
      class_id: gym.klass,
      copied: [
        { athlete_id: gym.ada, effect: 'created' },
        { athlete_id: gym.ben, effect: 'flipped', previous_status: 'absent' },
      ],
    });
    expect(await liveRuns(gym)).toEqual([{ by: gym.coach.accountId, class_id: gym.klass }]);
    expect(await register(gym, gym.ada)).toMatchObject({ status: 'present', method: 'coach_override' });
    expect((await pointer(gym, runId, gym.ada))?.register_class_id).toBe(gym.klass);
    // Tying again to the same class changes nothing.
    expect(await setSessionRunClass(gym.coach, runId, gym.klass)).toEqual({ class_id: gym.klass, copied: [] });
  });

  test('refused, changing nothing: another coach\'s class, cancelled, not today, held by another live session', async () => {
    const gym = await newGym('tie-refuse');
    await addClass(gym.organizationId, 'class-cancelled', gym.coach.accountId, 'now()', 'cancelled');
    await addClass(gym.organizationId, 'class-yesterday', gym.coach.accountId, "now() - interval '2 days'");
    await addClass(gym.organizationId, 'class-other', gym.otherCoach.accountId);
    await addClass(gym.organizationId, 'class-held', gym.coach.accountId);
    await client.query(
      `update pilot.scheduler_classes set covering_coach_account_id = $2 where organization_id = $1 and class_id = 'class-held'`,
      [gym.organizationId, gym.otherCoach.accountId],
    );
    await start(gym, gym.otherCoach, 'class-held');
    const { run_id: runId } = await start(gym, gym.coach, null);
    await tap(gym.coach, runId, gym.ada);

    expect(await refusal(setSessionRunClass(gym.coach, runId, 'class-other'))).toMatchObject({ message: 'SESSION_CLASS_NOT_YOURS', status: 403 });
    expect(await refusal(setSessionRunClass(gym.coach, runId, 'class-cancelled'))).toMatchObject({ message: 'SESSION_CLASS_CANCELLED' });
    expect(await refusal(setSessionRunClass(gym.coach, runId, 'class-yesterday'))).toMatchObject({ message: 'SESSION_CLASS_NOT_TODAY' });
    expect(await refusal(setSessionRunClass(gym.coach, runId, 'class-held'))).toMatchObject({ message: 'SESSION_CLASS_ALREADY_LIVE', status: 409 });
    // Another coach's run reads like a missing one; nobody else's register was written.
    expect(await refusal(setSessionRunClass(gym.otherCoach, runId, gym.klass))).toMatchObject({ message: 'SESSION_RUN_NOT_FOUND', status: 404 });
    expect((await liveRuns(gym)).find((row) => row.by === gym.coach.accountId)).toEqual({ by: gym.coach.accountId, class_id: null });
    expect(await register(gym, gym.ada, 'class-held')).toBeUndefined();
  });

  test('untying keeps the register marks and lets go of them; retying copies to the new class only', async () => {
    const gym = await newGym('untie');
    await addClass(gym.organizationId, 'class-second', gym.coach.accountId);
    const { run_id: runId } = await start(gym, gym.coach);
    await tap(gym.coach, runId, gym.ada);

    expect(await setSessionRunClass(gym.coach, runId, null)).toEqual({ class_id: null, copied: [] });
    expect(await register(gym, gym.ada)).toMatchObject({ status: 'present' });
    expect(await pointer(gym, runId, gym.ada)).toMatchObject({ register_class_id: null, written_at: null });
    // Untied: an untap is session detail only, and the register keeps the mark.
    expect(await tap(gym.coach, runId, gym.ada, false)).toEqual({ outcome: 'unmarked' });
    expect(await register(gym, gym.ada)).toMatchObject({ status: 'present' });

    await tap(gym.coach, runId, gym.ben);
    expect(await setSessionRunClass(gym.coach, runId, 'class-second')).toEqual({
      class_id: 'class-second',
      copied: [{ athlete_id: gym.ben, effect: 'created' }],
    });
    expect(await register(gym, gym.ben, 'class-second')).toMatchObject({ status: 'present', method: 'walk_in' });
    expect(await register(gym, gym.ben)).toBeUndefined();
  });

  test('a finished session cannot be tied', async () => {
    const gym = await newGym('tie-finished');
    const { run_id: runId } = await start(gym, gym.coach, null);
    await client.query(
      `update pilot.session_script_runs set run_state = 'completed', ended_at = now() where organization_id = $1 and run_id = $2`,
      [gym.organizationId, runId],
    );
    expect(await refusal(setSessionRunClass(gym.coach, runId, gym.klass))).toMatchObject({ message: 'SESSION_RUN_NOT_LIVE', status: 409 });
  });
});

describe('the End Session no-shows tap (ruling 3)', () => {
  test('marks Absent every signed-up athlete with no mark, and nobody else; asked again, nobody', async () => {
    const gym = await newGym('no-shows');
    // Dee and Eve signed up too: Dee checked herself in, Eve did not come.
    for (const [athleteId, name] of [['athlete-dee', 'Dee Park'], ['athlete-eve', 'Eve Stone']]) {
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
            coach_id, created_at, updated_at)
         values ($1, $2, $3, '2012-01-01', '100', 'active', 'contact', true, $4, now(), now())`,
        [gym.organizationId, athleteId, name, gym.coach.accountId],
      );
      await client.query(
        `insert into pilot.scheduler_registrations
           (organization_id, registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id, status)
         values ($1, $2, $3, $4, 'coach', $5, 'registered')`,
        [gym.organizationId, `reg-${athleteId}`, gym.klass, athleteId, gym.coach.accountId],
      );
    }
    await staffMark(gym, 'athlete-dee', 'present', 'self');
    const { run_id: runId } = await start(gym, gym.coach);
    await tap(gym.coach, runId, gym.ada);
    await tap(gym.coach, runId, gym.cy);
    // Ada is here on the session, but her register mark has gone: the tap still skips her.
    await client.query(`delete from pilot.scheduler_attendance where organization_id = $1 and athlete_id = $2`, [gym.organizationId, gym.ada]);

    expect((await describeRunClass(gym.organizationId, runId, gym.klass))?.no_shows).toBe(2);
    expect(await markSessionNoShowsAbsent(gym.coach, runId)).toEqual({ marked: [gym.ben, 'athlete-eve'] });
    expect(await register(gym, gym.ben)).toMatchObject({ status: 'absent', method: 'coach_override', by: gym.coach.accountId });
    expect(await register(gym, 'athlete-eve')).toMatchObject({ status: 'absent' });
    expect(await register(gym, 'athlete-dee')).toMatchObject({ status: 'present', method: 'self' });
    expect(await register(gym, gym.ada)).toBeUndefined();
    expect(await register(gym, gym.cy)).toMatchObject({ status: 'present', method: 'walk_in' });
    expect((await registerAudit(gym)).filter((row) => row.details.effect === 'no_show_absent').map((row) => row.entity_id))
      .toEqual([`${gym.klass}:${gym.ben}`, `${gym.klass}:athlete-eve`]);

    expect((await describeRunClass(gym.organizationId, runId, gym.klass))?.no_shows).toBe(0);
    expect(await markSessionNoShowsAbsent(gym.coach, runId)).toEqual({ marked: [] });
  });

  test('refused on an untied session, a cancelled class, and another coach\'s run', async () => {
    const gym = await newGym('no-shows-refuse');
    const { run_id: untied } = await start(gym, gym.otherCoach, null);
    expect(await refusal(markSessionNoShowsAbsent(gym.otherCoach, untied))).toMatchObject({ message: 'SESSION_RUN_NOT_TIED', status: 409 });
    const { run_id: runId } = await start(gym, gym.coach);
    expect(await refusal(markSessionNoShowsAbsent(gym.otherCoach, runId))).toMatchObject({ message: 'SESSION_RUN_NOT_FOUND', status: 404 });
    await client.query(`update pilot.scheduler_classes set status = 'cancelled' where organization_id = $1 and class_id = $2`, [gym.organizationId, gym.klass]);
    expect(await refusal(markSessionNoShowsAbsent(gym.coach, runId))).toMatchObject({ message: 'SESSION_CLASS_CANCELLED', status: 409 });
    expect(await register(gym, gym.ben)).toBeUndefined();
  });
});

describe('today\'s classes a session can be tied to', () => {
  test('a coach sees today\'s classes they run, not cancelled ones, other days or others\' classes; an admin sees all of today\'s', async () => {
    const gym = await newGym('list');
    await addClass(gym.organizationId, 'class-cancelled', gym.coach.accountId, 'now()', 'cancelled');
    await addClass(gym.organizationId, 'class-yesterday', gym.coach.accountId, "now() - interval '2 days'");
    await addClass(gym.organizationId, 'class-other', gym.otherCoach.accountId);
    await start(gym, gym.otherCoach, 'class-other');

    expect((await listTieableClasses(gym.coach)).map((item) => [item.class_id, item.held_by_other_session]))
      .toEqual([[gym.klass, false]]);
    expect((await listTieableClasses(gym.admin)).map((item) => [item.class_id, item.held_by_other_session]).sort())
      .toEqual([['class-other', true], [gym.klass, false]].sort());
    expect((await listTieableClasses(gym.otherCoach)).map((item) => [item.class_id, item.held_by_other_session]))
      .toEqual([['class-other', false]]);
  });
});
