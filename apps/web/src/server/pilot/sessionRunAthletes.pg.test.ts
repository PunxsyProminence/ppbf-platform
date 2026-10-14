// Real PostgreSQL-backed suite for audit finding F-067: who was in a session
// (sessionRunAthletes.ts), a staff note on an athlete in a session run
// (sessionStaffNotes.ts createRunStaffNote / listRunStaffNotes), and the gym's
// finished sessions (sessionScriptRuns.ts listSettledRunsForOrganization).
//
// What needs a real database to prove:
//
// 1. WHO MAY MARK. Only the coach delivering the run, only while it is live,
//    only staff with an active membership here, only an athlete of this gym.
//    Every refusal writes nothing.
// 2. A mark taken back keeps its row; marking again clears it; asking for the
//    state it already has writes nothing; every change is an audit event with
//    no shadow mirror.
// 3. WHO IS NAMED IN A READ. Only the athletes the caller is permitted, only
//    this gym's run, only marks that stand.
// 4. A RUN NOTE needs a standing mark, read under a lock: a mark being taken
//    back at the same moment is waited for, and the note is then refused.
// 5. A note stays when its mark is later taken back, and only its author
//    changes or removes it.
// 6. NOTHING ELSE IS WRITTEN: not the athlete's own session or check-in, not
//    any attendance table, and the attendance view gains no row.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

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

// Each transaction on a connection of its own, with a real BEGIN/COMMIT: the
// locking cases below need two transactions that can wait on each other.
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
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import type { ActorIdentity } from './access';
import type { PilotRole } from './contracts';
import { listPresentAthletes, setRunAthletePresent, staffPermittedAthleteIds } from './sessionRunAthletes';
import {
  finishSessionScriptRun,
  listSettledRunsForOrganization,
  startSessionScriptRun,
} from './sessionScriptRuns';
import {
  createRunStaffNote,
  listRunStaffNotes,
  removeOwnSessionStaffNote,
  updateOwnSessionStaffNote,
} from './sessionStaffNotes';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-run-presence-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_f067_presence';

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
  /** Three athletes of this gym: Ada, Ben and Cy. */
  ada: string;
  ben: string;
  cy: string;
}

function actor(organizationId: string, accountId: string, role: PilotRole): ActorIdentity {
  return { organizationId, accountId, role, athleteId: null };
}

/**
 * A fresh gym: two coaches and an organization admin, each with an active
 * membership in its role, and three athletes. Athlete ids repeat across gyms on
 * purpose -- the organization is the boundary.
 */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-f067-${label}-${gymCount}`;
  const coachId = `coach@${organizationId}`;
  const otherCoachId = `coach2@${organizationId}`;
  const adminId = `admin@${organizationId}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  for (const [accountId, role] of [[coachId, 'coach'], [otherCoachId, 'coach'], [adminId, 'organization_admin']]) {
    await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, $2, $3)`, [
      accountId,
      role,
      organizationId,
    ]);
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
  return {
    organizationId,
    coach: actor(organizationId, coachId, 'coach'),
    otherCoach: actor(organizationId, otherCoachId, 'coach'),
    admin: actor(organizationId, adminId, 'organization_admin'),
    ada: 'athlete-ada',
    ben: 'athlete-ben',
    cy: 'athlete-cy',
  };
}

/** A plain session, live, delivered by this coach. */
async function liveRun(gym: Gym, by: ActorIdentity = gym.coach): Promise<string> {
  const run = await startSessionScriptRun(gym.organizationId, by.accountId, {});
  return run.run_id;
}

function mark(by: ActorIdentity, runId: string, athleteId: string, present = true) {
  return setRunAthletePresent({ actor: by, runId, athleteId, present });
}

async function marks(gym: Gym, runId: string) {
  const { rows } = await client.query<{ athlete_id: string; by: string; role: string; removed: boolean; removed_by: string | null }>(
    `select athlete_id, marked_by_account_id as by, marked_by_role as role, removed_at is not null as removed,
            removed_by_account_id as removed_by
       from pilot.session_run_athletes where organization_id = $1 and run_id = $2 order by athlete_id`,
    [gym.organizationId, runId],
  );
  return rows;
}

async function auditOf(gym: Gym, entityType: string) {
  const { rows } = await client.query<{ event_type: string; actor_account_id: string; entity_id: string; details: Record<string, unknown> }>(
    `select event_type, actor_account_id, entity_id, details from pilot.audit_events
      where organization_id = $1 and entity_type = $2 order by audit_id`,
    [gym.organizationId, entityType],
  );
  return rows;
}

/** Everything F-067 must NOT write, counted for one gym. */
async function elsewhere(gym: Gym) {
  const { rows } = await client.query(
    `select (select count(*)::int from pilot.sessions where organization_id = $1) as sessions,
            (select count(*)::int from pilot.athlete_check_ins where organization_id = $1) as check_ins,
            (select count(*)::int from pilot.attendance where organization_id = $1) as attendance,
            (select count(*)::int from pilot.scheduler_attendance where organization_id = $1) as scheduler_attendance,
            (select count(*)::int from pilot.activity_log where organization_id = $1) as activity_log,
            (select count(*)::int from pilot.attendance_reconciled where organization_id = $1) as reconciled,
            (select count(*)::int from pilot.shadow_events where organization_id = $1) as shadow_events`,
    [gym.organizationId],
  );
  return rows[0];
}

async function refusal(action: Promise<unknown>): Promise<{ name: string; message: string; status?: number; code?: string }> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught as { name: string; message: string; status?: number; code?: string },
  );
  if (!error) throw new Error('expected a refusal, and the call succeeded');
  return { name: error.name, message: error.message, status: error.status, code: error.code };
}

const NOT_PERMITTED = { name: 'ForbiddenError', status: 403, code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' };

/**
 * Soft-deletes an athlete on a SECOND connection and holds it open (not committed), runs `write`,
 * checks that the write is WAITING on that delete rather than already answered, then commits the
 * delete and returns how the write ended. The reach check runs before the write's transaction and
 * reads the athlete as still live; only a check inside the transaction can see the delete.
 */
async function writeWhileAthleteIsBeingDeleted<T>(organizationId: string, athleteId: string, write: () => Promise<T>) {
  const deleting = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await deleting.connect();
  try {
    await deleting.query('BEGIN');
    await deleting.query(
      `update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`,
      [organizationId, athleteId],
    );
    const writing = write().then(
      (result) => ({ result, error: null as unknown }),
      (error: unknown) => ({ result: null as T | null, error }),
    );
    const early = await Promise.race([writing, new Promise((resolve) => setTimeout(() => resolve('waiting'), 750))]);
    expect(early).toBe('waiting');
    await deleting.query('COMMIT');
    return await writing;
  } finally {
    await deleting.query('ROLLBACK').catch(() => {});
    await deleting.end();
  }
}
const NOT_PRESENT = { name: 'ConflictError', status: 409, code: 'SESSION_STAFF_NOTE_ATHLETE_NOT_PRESENT' };

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
  // The whole schema production runs, the session-run-athletes migration included.
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

describe('marking who is in a session', () => {
  test('the delivering coach marks athletes present in a live plain session, and nothing else is written', async () => {
    const gym = await newGym('mark');
    const runId = await liveRun(gym);
    const before = await elsewhere(gym);

    expect(await mark(gym.coach, runId, gym.ada)).toEqual({ outcome: 'marked' });
    expect(await mark(gym.coach, runId, gym.ben)).toEqual({ outcome: 'marked' });
    // Asked again, nothing is written.
    expect(await mark(gym.coach, runId, gym.ada)).toEqual({ outcome: 'unchanged' });

    expect(await marks(gym, runId)).toEqual([
      { athlete_id: gym.ada, by: gym.coach.accountId, role: 'coach', removed: false, removed_by: null },
      { athlete_id: gym.ben, by: gym.coach.accountId, role: 'coach', removed: false, removed_by: null },
    ]);
    expect(await auditOf(gym, 'session_run_athlete')).toEqual([
      { event_type: 'create', actor_account_id: gym.coach.accountId, entity_id: `${runId}:${gym.ada}`, details: { run_id: runId, athlete_id: gym.ada, present: true } },
      { event_type: 'create', actor_account_id: gym.coach.accountId, entity_id: `${runId}:${gym.ben}`, details: { run_id: runId, athlete_id: gym.ben, present: true } },
    ]);
    // Not the athlete's own session or check-in, not any attendance table, no attendance row,
    // and no shadow event an athlete or guardian could read.
    expect(await elsewhere(gym)).toEqual(before);
  });

  test('a mark taken back keeps its row; marking again clears it; each change is on the audit trail', async () => {
    const gym = await newGym('take-back');
    const runId = await liveRun(gym);
    await mark(gym.coach, runId, gym.ada);

    expect(await mark(gym.coach, runId, gym.ada, false)).toEqual({ outcome: 'unmarked' });
    expect(await marks(gym, runId)).toEqual([
      { athlete_id: gym.ada, by: gym.coach.accountId, role: 'coach', removed: true, removed_by: gym.coach.accountId },
    ]);
    // Taking back a mark that is not standing, or was never made, writes nothing.
    expect(await mark(gym.coach, runId, gym.ada, false)).toEqual({ outcome: 'unchanged' });
    expect(await mark(gym.coach, runId, gym.ben, false)).toEqual({ outcome: 'unchanged' });

    expect(await mark(gym.coach, runId, gym.ada)).toEqual({ outcome: 'marked' });
    // The same row, standing again: one row per run and athlete.
    expect(await marks(gym, runId)).toEqual([
      { athlete_id: gym.ada, by: gym.coach.accountId, role: 'coach', removed: false, removed_by: null },
    ]);
    expect((await auditOf(gym, 'session_run_athlete')).map((event) => [event.event_type, event.details.present, event.details.remarked ?? false])).toEqual([
      ['create', true, false],
      ['update', false, false],
      ['update', true, true],
    ]);
  });

  test('only the coach delivering the run may mark, and only while it is live', async () => {
    const gym = await newGym('own-live');
    const runId = await liveRun(gym);

    // Another coach of the SAME gym, who reaches the athlete: the run reads as missing.
    expect(await refusal(mark(gym.otherCoach, runId, gym.ada))).toMatchObject({ message: 'SESSION_RUN_NOT_FOUND', status: 404 });
    // The gym's admin too: taking the register is the delivering coach's.
    expect(await refusal(mark(gym.admin, runId, gym.ada))).toMatchObject({ message: 'SESSION_RUN_NOT_FOUND', status: 404 });
    expect(await refusal(mark(gym.coach, 'ssrun-no-such-run', gym.ada))).toMatchObject({ message: 'SESSION_RUN_NOT_FOUND', status: 404 });
    expect(await marks(gym, runId)).toEqual([]);

    await mark(gym.coach, runId, gym.ada);
    await finishSessionScriptRun(gym.organizationId, gym.coach.accountId, runId, { runState: 'completed' });

    // Finished: neither a new mark nor a take-back changes the record.
    expect(await refusal(mark(gym.coach, runId, gym.ben))).toMatchObject({ message: 'SESSION_RUN_NOT_LIVE', status: 409 });
    expect(await refusal(mark(gym.coach, runId, gym.ada, false))).toMatchObject({ message: 'SESSION_RUN_NOT_LIVE', status: 409 });
    expect(await marks(gym, runId)).toEqual([
      { athlete_id: gym.ada, by: gym.coach.accountId, role: 'coach', removed: false, removed_by: null },
    ]);
  });

  test("another gym's athlete, a deleted athlete and an unknown athlete are one refusal; another gym's run is not found", async () => {
    const gym = await newGym('scope');
    const other = await newGym('scope-other');
    const runId = await liveRun(gym);
    const otherRunId = await liveRun(other);
    await client.query(`update pilot.athletes set athlete_id = 'athlete-only-there' where organization_id = $1 and athlete_id = $2`, [other.organizationId, other.cy]);
    await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [gym.organizationId, gym.cy]);

    for (const athleteId of ['athlete-only-there', gym.cy, 'athlete-nobody']) {
      expect(await refusal(mark(gym.coach, runId, athleteId))).toMatchObject(NOT_PERMITTED);
    }
    // This gym's coach and athlete, the other gym's run id.
    expect(await refusal(mark(gym.coach, otherRunId, gym.ada))).toMatchObject({ message: 'SESSION_RUN_NOT_FOUND', status: 404 });
    // A coach who works at BOTH gyms, delivering a session at the other one. Signed in here, that
    // run is still not this gym's: the run is looked up inside the organization, so it is not found
    // (rather than found, and then refused by the database with an error nobody can read).
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
      [gym.otherCoach.accountId, other.organizationId],
    );
    const theirRunThere = (await startSessionScriptRun(other.organizationId, gym.otherCoach.accountId, {})).run_id;
    expect(await refusal(mark(gym.otherCoach, theirRunThere, gym.ada))).toMatchObject({ message: 'SESSION_RUN_NOT_FOUND', status: 404 });
    // Signed in THERE, the same coach marks that gym's athlete in it.
    expect(await mark({ ...gym.otherCoach, organizationId: other.organizationId }, theirRunThere, other.ada)).toEqual({ outcome: 'marked' });
    expect(await marks(other, theirRunThere)).toHaveLength(1);
    expect(await marks(gym, runId)).toEqual([]);
    expect(await marks(other, otherRunId)).toEqual([]);
    expect(await auditOf(gym, 'session_run_athlete')).toEqual([]);
  });

  test('a role that is not staff here marks nobody: every non-staff role, and a coach whose membership was ended', async () => {
    const gym = await newGym('roles');
    const runId = await liveRun(gym);

    for (const role of ['athlete', 'parent', 'platform_owner', 'board', 'volunteer', 'staff'] as PilotRole[]) {
      // Even naming the delivering coach's own account id: the role decides first.
      expect(await refusal(mark({ ...gym.coach, role }, runId, gym.ada))).toMatchObject(NOT_PERMITTED);
    }
    await client.query(
      `update pilot.organization_memberships set active_flag = false where account_id = $1 and organization_id = $2`,
      [gym.coach.accountId, gym.organizationId],
    );
    expect(await refusal(mark(gym.coach, runId, gym.ada))).toMatchObject(NOT_PERMITTED);
    expect(await marks(gym, runId)).toEqual([]);
  });

  test('a scripted run holds marks as a plain one does', async () => {
    const gym = await newGym('scripted');
    await client.query(
      `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
      [gym.organizationId],
    );
    await client.query(
      `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, created_by_account_id)
       values ($1, 'scr-f067', 'scr-f067', 1, 'Tuesday juniors', $2)`,
      [gym.organizationId, gym.coach.accountId],
    );
    await client.query(
      `insert into pilot.session_script_blocks (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min, block_label, block_kind)
       values ($1, 'blk-f067', 'scr-f067', 1, 0, 10, 'Arrival', 'arrival')`,
      [gym.organizationId],
    );
    const run = await startSessionScriptRun(gym.organizationId, gym.coach.accountId, { scriptId: 'scr-f067' });

    expect(await mark(gym.coach, run.run_id, gym.ada)).toEqual({ outcome: 'marked' });
    expect((await listPresentAthletes(gym.organizationId, [run.run_id], [gym.ada])).map((row) => row.full_name)).toEqual(['Ada Reyes']);
  });

  test('a mark waits for the athlete being deleted at that moment, and is then refused (no mark, no audit)', async () => {
    const gym = await newGym('mark-delete-race');
    const runId = await liveRun(gym);

    const outcome = await writeWhileAthleteIsBeingDeleted(gym.organizationId, gym.ada, () => mark(gym.coach, runId, gym.ada));

    expect(outcome.result).toBeNull();
    expect(outcome.error).toMatchObject(NOT_PERMITTED);
    expect(await marks(gym, runId)).toEqual([]);
    expect(await auditOf(gym, 'session_run_athlete')).toEqual([]);
  });

  test('a mark waits for the session being ended at that moment, and is then refused', async () => {
    const gym = await newGym('mark-race');
    const runId = await liveRun(gym);

    // The session being ended, held open at the point where the run is settled but not committed.
    const finishing = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
    await finishing.connect();
    try {
      await finishing.query('BEGIN');
      await finishing.query(
        `update pilot.session_script_runs
            set run_state = 'completed', ended_at = clock_timestamp(), current_block_id = null, paused_at = null
          where organization_id = $1 and run_id = $2`,
        [gym.organizationId, runId],
      );

      const marking = mark(gym.coach, runId, gym.ada).then(
        (result) => ({ result, error: null as unknown }),
        (error: unknown) => ({ result: null, error }),
      );
      // It has to be waiting on the finish, not already answered: a read without the row lock
      // would still see the run live and write the mark onto a session that is over.
      const early = await Promise.race([marking, new Promise((resolve) => setTimeout(() => resolve('waiting'), 750))]);
      expect(early).toBe('waiting');

      await finishing.query('COMMIT');
      const outcome = await marking;

      expect(outcome.result).toBeNull();
      expect(outcome.error).toMatchObject({ message: 'SESSION_RUN_NOT_LIVE', status: 409 });
    } finally {
      await finishing.query('ROLLBACK').catch(() => {});
      await finishing.end();
    }
    expect(await marks(gym, runId)).toEqual([]);
    expect(await auditOf(gym, 'session_run_athlete')).toEqual([]);
  });
});

describe('reading who was in a session', () => {
  test('names only the athletes the caller is permitted, only standing marks, only this gym', async () => {
    const gym = await newGym('read');
    const other = await newGym('read-other');
    const runId = await liveRun(gym);
    const otherRunId = await liveRun(other);
    await mark(gym.coach, runId, gym.ada);
    await mark(gym.coach, runId, gym.ben);
    await mark(gym.coach, runId, gym.cy);
    await mark(gym.coach, runId, gym.cy, false);
    await mark(other.coach, otherRunId, other.ada);

    const everyone = [gym.ada, gym.ben, gym.cy];
    // Cy's mark was taken back.
    expect((await listPresentAthletes(gym.organizationId, [runId], everyone)).map((row) => [row.athlete_id, row.full_name])).toEqual([
      [gym.ada, 'Ada Reyes'],
      [gym.ben, 'Ben Ortiz'],
    ]);
    // The permitted list IS the filter: an athlete outside it is not named, whatever the run holds.
    expect((await listPresentAthletes(gym.organizationId, [runId], [gym.ben])).map((row) => row.athlete_id)).toEqual([gym.ben]);
    expect(await listPresentAthletes(gym.organizationId, [runId], [])).toEqual([]);
    expect(await listPresentAthletes(gym.organizationId, [], everyone)).toEqual([]);
    // The other gym's run id, read from this gym: nobody, though the athlete ids are the same.
    expect(await listPresentAthletes(gym.organizationId, [otherRunId], everyone)).toEqual([]);
    expect((await listPresentAthletes(other.organizationId, [otherRunId], everyone)).map((row) => row.athlete_id)).toEqual([other.ada]);
  });

  test("a coach's permitted athletes are the gym's live athletes; an admin's the same; every other role none", async () => {
    const gym = await newGym('permitted');
    const other = await newGym('permitted-other');
    await client.query(`update pilot.athletes set athlete_id = 'athlete-only-there' where organization_id = $1 and athlete_id = $2`, [other.organizationId, other.ben]);
    await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [gym.organizationId, gym.cy]);

    expect((await staffPermittedAthleteIds(gym.coach)).sort()).toEqual([gym.ada, gym.ben]);
    // A coach who is NOT the coach of record for any of them: the whole gym all the same
    // (OD-2026-10-11-007). The "my athletes" roster would be empty here, and a coach who had just
    // marked Ada present could not see her in their own session.
    expect((await staffPermittedAthleteIds(gym.otherCoach)).sort()).toEqual([gym.ada, gym.ben]);
    // Never another gym's athlete.
    expect(await staffPermittedAthleteIds(gym.coach)).not.toContain('athlete-only-there');
    expect((await staffPermittedAthleteIds(gym.admin)).sort()).toEqual([gym.ada, gym.ben]);
    for (const role of ['athlete', 'parent', 'platform_owner', 'board', 'volunteer', 'staff'] as PilotRole[]) {
      expect(await staffPermittedAthleteIds({ ...gym.coach, role })).toEqual([]);
    }
    // Staff HERE is an active membership, as it is for a mark: a coach whose membership was ended
    // reads nobody, whatever role their session still carries.
    await client.query(
      `update pilot.organization_memberships set active_flag = false where account_id = $1 and organization_id = $2`,
      [gym.otherCoach.accountId, gym.organizationId],
    );
    expect(await staffPermittedAthleteIds(gym.otherCoach)).toEqual([]);
    expect((await staffPermittedAthleteIds(gym.coach)).sort()).toEqual([gym.ada, gym.ben]);
  });
});

describe('a staff note on an athlete in a session run', () => {
  test('is written for an athlete marked present, by any coach or admin of the gym, live or after the session', async () => {
    const gym = await newGym('note');
    const runId = await liveRun(gym);
    await mark(gym.coach, runId, gym.ada);
    const before = await elsewhere(gym);

    const live = await createRunStaffNote({ actor: gym.coach, runId, athleteId: gym.ada, note: '  Hands dropped in round two.  ' });
    expect(live).toMatchObject({ run_id: runId, session_id: null, athlete_id: gym.ada, author_role: 'coach', note: 'Hands dropped in round two.' });
    await finishSessionScriptRun(gym.organizationId, gym.coach.accountId, runId, { runState: 'completed' });
    // Written up afterwards, by another coach of the gym and by the admin.
    await createRunStaffNote({ actor: gym.otherCoach, runId, athleteId: gym.ada, note: 'Good feet today.' });
    await createRunStaffNote({ actor: gym.admin, runId, athleteId: gym.ada, note: 'Spoke to the family after.' });

    const listed = await listRunStaffNotes(gym.otherCoach, runId, gym.ada);
    expect(listed.map((note) => [note.note, note.author_role, note.written_by_me])).toEqual([
      ['Hands dropped in round two.', 'coach', false],
      ['Good feet today.', 'coach', true],
      ['Spoke to the family after.', 'organization_admin', false],
    ]);
    // No account id leaves the module.
    expect(JSON.stringify(listed)).not.toContain(gym.coach.accountId);
    expect((await auditOf(gym, 'session_staff_note')).map((event) => [event.event_type, event.details])).toEqual([
      ['create', { run_id: runId, athlete_id: gym.ada }],
      ['create', { run_id: runId, athlete_id: gym.ada }],
      ['create', { run_id: runId, athlete_id: gym.ada }],
    ]);
    // Nothing in the athlete's own session or check-in, and no shadow event.
    expect(await elsewhere(gym)).toEqual(before);
  });

  test('is refused for an athlete not marked in that run, marked in another run, or whose mark was taken back', async () => {
    const gym = await newGym('note-refused');
    const other = await newGym('note-refused-other');
    const runId = await liveRun(gym);
    const otherRunId = await liveRun(other);
    await mark(gym.coach, runId, gym.ada);
    await mark(gym.coach, runId, gym.ben);
    await mark(gym.coach, runId, gym.ben, false);
    await mark(other.coach, otherRunId, other.ada);
    // An athlete who exists ONLY in the other gym, marked present in its run.
    await client.query(`update pilot.athletes set athlete_id = 'athlete-only-there' where organization_id = $1 and athlete_id = $2`, [other.organizationId, other.cy]);
    await mark(other.coach, otherRunId, 'athlete-only-there');
    const write = (runIdOf: string, athleteId: string) =>
      createRunStaffNote({ actor: gym.coach, runId: runIdOf, athleteId, note: 'x' });

    expect(await refusal(write(runId, gym.cy))).toMatchObject(NOT_PRESENT);
    expect(await refusal(write(runId, gym.ben))).toMatchObject(NOT_PRESENT);
    // The other gym's run, where an athlete of the same id IS marked.
    expect(await refusal(write(otherRunId, gym.ada))).toMatchObject(NOT_PRESENT);
    expect(await refusal(write('ssrun-no-such-run', gym.ada))).toMatchObject(NOT_PRESENT);
    // A coach of the other gym naming THIS gym's run. Athlete ids repeat across gyms, so they reach
    // their own athlete of that id, who is in no run of theirs by this id: not present.
    expect(await refusal(createRunStaffNote({ actor: other.coach, runId, athleteId: gym.ada, note: 'x' })))
      .toMatchObject(NOT_PRESENT);
    // An athlete who is only in the other gym, in the other gym's run where they ARE marked: this
    // gym's coach does not reach them at all, to write or to read. The notes module's one refusal.
    expect(await refusal(write(otherRunId, 'athlete-only-there')))
      .toMatchObject({ name: 'ForbiddenError', code: 'SESSION_STAFF_NOTE_NOT_PERMITTED' });
    expect(await refusal(listRunStaffNotes(gym.coach, otherRunId, 'athlete-only-there')))
      .toMatchObject({ name: 'ForbiddenError', code: 'SESSION_STAFF_NOTE_NOT_PERMITTED' });
    // And a role that is not staff.
    expect(await refusal(createRunStaffNote({ actor: { ...gym.coach, role: 'parent' }, runId, athleteId: gym.ada, note: 'x' })))
      .toMatchObject({ name: 'ForbiddenError', code: 'SESSION_STAFF_NOTE_NOT_PERMITTED' });
    expect(await refusal(listRunStaffNotes({ ...gym.coach, role: 'athlete' }, runId, gym.ada)))
      .toMatchObject({ name: 'ForbiddenError', code: 'SESSION_STAFF_NOTE_NOT_PERMITTED' });

    const { rows } = await client.query(`select count(*)::int as n from pilot.session_staff_notes where organization_id = any($1::text[])`, [[gym.organizationId, other.organizationId]]);
    expect(rows[0].n).toBe(0);
  });

  test('a note waits for the athlete being deleted at that moment, and is then refused (no note, no audit)', async () => {
    const gym = await newGym('note-delete-race');
    const runId = await liveRun(gym);
    await mark(gym.coach, runId, gym.ada);

    const outcome = await writeWhileAthleteIsBeingDeleted(gym.organizationId, gym.ada, () =>
      createRunStaffNote({ actor: gym.otherCoach, runId, athleteId: gym.ada, note: 'Written as the athlete was removed.' }));

    expect(outcome.result).toBeNull();
    expect(outcome.error).toMatchObject({ name: 'ForbiddenError', code: 'SESSION_STAFF_NOTE_NOT_PERMITTED' });
    const { rows } = await client.query(`select count(*)::int as n from pilot.session_staff_notes where organization_id = $1`, [gym.organizationId]);
    expect(rows[0].n).toBe(0);
    expect(await auditOf(gym, 'session_staff_note')).toEqual([]);
  });

  test('a note waits for a mark being taken back at that moment, and is then refused', async () => {
    const gym = await newGym('note-race');
    const runId = await liveRun(gym);
    await mark(gym.coach, runId, gym.ada);

    // The coach taking the mark back, held open at the point where the row is updated but not committed.
    const takingBack = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
    await takingBack.connect();
    try {
      await takingBack.query('BEGIN');
      await takingBack.query(
        `update pilot.session_run_athletes set removed_at = clock_timestamp(), removed_by_account_id = $4
          where organization_id = $1 and run_id = $2 and athlete_id = $3`,
        [gym.organizationId, runId, gym.ada, gym.coach.accountId],
      );

      const writing = createRunStaffNote({ actor: gym.otherCoach, runId, athleteId: gym.ada, note: 'Written as the mark came off.' }).then(
        (row) => ({ row, error: null as unknown }),
        (error: unknown) => ({ row: null, error }),
      );
      // It has to be waiting on the take-back, not already answered.
      const early = await Promise.race([writing, new Promise((resolve) => setTimeout(() => resolve('waiting'), 750))]);
      expect(early).toBe('waiting');

      await takingBack.query('COMMIT');
      const outcome = await writing;

      expect(outcome.row).toBeNull();
      expect(outcome.error).toMatchObject(NOT_PRESENT);
    } finally {
      await takingBack.query('ROLLBACK').catch(() => {});
      await takingBack.end();
    }
    const { rows } = await client.query(`select count(*)::int as n from pilot.session_staff_notes where organization_id = $1`, [gym.organizationId]);
    expect(rows[0].n).toBe(0);
  });

  test('stays when its mark is later taken back, and only its author changes or removes it', async () => {
    const gym = await newGym('note-stays');
    const runId = await liveRun(gym);
    await mark(gym.coach, runId, gym.ada);
    const written = await createRunStaffNote({ actor: gym.otherCoach, runId, athleteId: gym.ada, note: 'Kept.' });

    // The delivering coach takes the mark back. The other coach's note is not theirs to remove, and is not removed.
    await mark(gym.coach, runId, gym.ada, false);
    expect((await listRunStaffNotes(gym.coach, runId, gym.ada)).map((note) => note.note)).toEqual(['Kept.']);
    // But no NEW note while the mark is off.
    expect(await refusal(createRunStaffNote({ actor: gym.coach, runId, athleteId: gym.ada, note: 'x' }))).toMatchObject(NOT_PRESENT);

    expect(await refusal(updateOwnSessionStaffNote({ actor: gym.coach, noteId: written.note_id, note: 'Rewritten by someone else' })))
      .toMatchObject({ code: 'SESSION_STAFF_NOTE_AUTHOR_ONLY' });
    expect(await refusal(removeOwnSessionStaffNote({ actor: gym.admin, noteId: written.note_id })))
      .toMatchObject({ code: 'SESSION_STAFF_NOTE_AUTHOR_ONLY' });

    await updateOwnSessionStaffNote({ actor: gym.otherCoach, noteId: written.note_id, note: 'Kept, and corrected.' });
    expect((await listRunStaffNotes(gym.coach, runId, gym.ada)).map((note) => note.note)).toEqual(['Kept, and corrected.']);
    await removeOwnSessionStaffNote({ actor: gym.otherCoach, noteId: written.note_id });
    expect(await listRunStaffNotes(gym.coach, runId, gym.ada)).toEqual([]);
    // Removed, not deleted; and the audit rows say which run the note was on.
    const kept = await client.query(`select deleted_at is not null as removed from pilot.session_staff_notes where note_id = $1`, [written.note_id]);
    expect(kept.rows).toEqual([{ removed: true }]);
    expect((await auditOf(gym, 'session_staff_note')).map((event) => event.details)).toEqual([
      { run_id: runId, athlete_id: gym.ada },
      { run_id: runId, athlete_id: gym.ada },
      { run_id: runId, athlete_id: gym.ada, removed: true },
    ]);
  });

  test("is listed for its own run and athlete only", async () => {
    const gym = await newGym('note-list');
    const first = await liveRun(gym);
    await mark(gym.coach, first, gym.ada);
    await mark(gym.coach, first, gym.ben);
    await createRunStaffNote({ actor: gym.coach, runId: first, athleteId: gym.ada, note: 'Ada, first session.' });
    await createRunStaffNote({ actor: gym.coach, runId: first, athleteId: gym.ben, note: 'Ben, first session.' });
    await finishSessionScriptRun(gym.organizationId, gym.coach.accountId, first, { runState: 'completed' });
    const second = await liveRun(gym);
    await mark(gym.coach, second, gym.ada);
    await createRunStaffNote({ actor: gym.coach, runId: second, athleteId: gym.ada, note: 'Ada, second session.' });

    expect((await listRunStaffNotes(gym.coach, first, gym.ada)).map((note) => note.note)).toEqual(['Ada, first session.']);
    expect((await listRunStaffNotes(gym.coach, first, gym.ben)).map((note) => note.note)).toEqual(['Ben, first session.']);
    expect((await listRunStaffNotes(gym.coach, second, gym.ada)).map((note) => note.note)).toEqual(['Ada, second session.']);
    expect(await listRunStaffNotes(gym.coach, second, gym.ben)).toEqual([]);
  });
});

describe("the gym's finished sessions", () => {
  test('are the settled runs, plain and scripted, newest first, with their end notes; live runs and other gyms are left out', async () => {
    const gym = await newGym('finished');
    const other = await newGym('finished-other');
    const plain = await liveRun(gym);
    await finishSessionScriptRun(gym.organizationId, gym.coach.accountId, plain, {
      runState: 'completed',
      athletesPresent: 2,
      whatWorked: 'The jab round.',
      whatDidNot: 'Too long on the bags.',
      deviationNote: 'Finished early.',
    });
    await client.query(
      `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
      [gym.organizationId],
    );
    await client.query(
      `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, created_by_account_id)
       values ($1, 'scr-f067-fin', 'scr-f067-fin', 1, 'Tuesday juniors', $2)`,
      [gym.organizationId, gym.coach.accountId],
    );
    await client.query(
      `insert into pilot.session_script_blocks (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min, block_label, block_kind)
       values ($1, 'blk-f067-fin', 'scr-f067-fin', 1, 0, 10, 'Arrival', 'arrival')`,
      [gym.organizationId],
    );
    const scripted = (await startSessionScriptRun(gym.organizationId, gym.coach.accountId, { scriptId: 'scr-f067-fin' })).run_id;
    await finishSessionScriptRun(gym.organizationId, gym.coach.accountId, scripted, { runState: 'completed' });
    // A row from before live delivery (no run_state; always from a plan, pilot_ssrun_plain_has_state):
    // reached through its plan, not listed here.
    const legacy = (await startSessionScriptRun(gym.organizationId, gym.coach.accountId, { scriptId: 'scr-f067-fin' })).run_id;
    await finishSessionScriptRun(gym.organizationId, gym.coach.accountId, legacy, { runState: 'completed' });
    await client.query(`update pilot.session_script_runs set run_state = null where run_id = $1`, [legacy]);
    const abandoned = await liveRun(gym, gym.otherCoach);
    await finishSessionScriptRun(gym.organizationId, gym.otherCoach.accountId, abandoned, { runState: 'abandoned' });
    await liveRun(gym);
    const elsewhereRun = await liveRun(other);
    await finishSessionScriptRun(other.organizationId, other.coach.accountId, elsewhereRun, { runState: 'completed' });
    // Make the order certain: the plain one started and ended an hour earlier.
    await client.query(
      `update pilot.session_script_runs set started_at = started_at - interval '1 hour', ended_at = ended_at - interval '1 hour' where run_id = $1`,
      [plain],
    );
    await client.query(
      `update pilot.session_script_runs set started_at = started_at - interval '2 hours', ended_at = ended_at - interval '2 hours' where run_id = $1`,
      [scripted],
    );

    const finished = await listSettledRunsForOrganization(gym.organizationId);

    expect(finished.map((run) => [run.run_id, run.run_state, run.script_id, run.script_name, run.delivered_by_account_id])).toEqual([
      [abandoned, 'abandoned', null, null, gym.otherCoach.accountId],
      [plain, 'completed', null, null, gym.coach.accountId],
      [scripted, 'completed', 'scr-f067-fin', 'Tuesday juniors', gym.coach.accountId],
    ]);
    // The limit is the newest N.
    expect((await listSettledRunsForOrganization(gym.organizationId, 2)).map((run) => run.run_id)).toEqual([abandoned, plain]);
    expect(finished[1]).toMatchObject({
      athletes_present: 2,
      what_worked: 'The jab round.',
      what_did_not: 'Too long on the bags.',
      deviation_note: 'Finished early.',
    });
  });
});
